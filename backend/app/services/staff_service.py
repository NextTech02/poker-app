from typing import List, Optional
from datetime import datetime, timezone
from app.database import supabase
from app.database.supabase_client import supabase_admin
from app.config import get_settings
from app.models.staff import (
    PermissionGroupCreate,
    PermissionGroupUpdate,
    PermissionGroupResponse,
    StaffCreate,
    StaffUpdate,
    StaffResponse,
    MyPermissions,
)

ALL_PERMISSIONS = [
    'dashboard', 'stages', 'tournaments', 'players',
    'cashier', 'cashier_players', 'cashier_tickets', 'prizes',
    'prizes_release', 'financial', 'reports', 'general_cash', 'rankings',
    'blinds', 'tables', 'broadcast', 'employees',
    'cashbox.operate', 'cashbox.admin',
    'sangi',
]

# Permissions that imply the staff member can have their own cashbox
CASHBOX_OPERATING_PERMISSIONS = ('cashbox.operate', 'cashbox.admin', 'cashier', 'cashier_players')


def _has_cashbox_permission(permissions: list) -> bool:
    return any(p in (permissions or []) for p in CASHBOX_OPERATING_PERMISSIONS)

settings = get_settings()


class StaffService:

    # ================================================
    # Permission Groups
    # ================================================

    @staticmethod
    def create_group(data: PermissionGroupCreate) -> PermissionGroupResponse:
        insert_data = {
            "name": data.name,
            "description": data.description,
            "permissions": data.permissions,
        }
        response = supabase.table("permission_groups").insert(insert_data).execute()
        return PermissionGroupResponse(**response.data[0])

    @staticmethod
    def get_groups() -> List[PermissionGroupResponse]:
        response = supabase.table("permission_groups").select("*") \
            .order("name").execute()
        return [PermissionGroupResponse(**g) for g in (response.data or [])]

    @staticmethod
    def get_group(group_id: str) -> Optional[PermissionGroupResponse]:
        response = supabase.table("permission_groups").select("*") \
            .eq("id", group_id).execute()
        if not response.data:
            return None
        return PermissionGroupResponse(**response.data[0])

    @staticmethod
    def update_group(group_id: str, data: PermissionGroupUpdate) -> Optional[PermissionGroupResponse]:
        update_data = data.model_dump(exclude_unset=True)
        if not update_data:
            raise ValueError("Nenhum campo para atualizar")
        update_data["updated_at"] = datetime.now(timezone.utc).isoformat()

        response = supabase.table("permission_groups").update(update_data) \
            .eq("id", group_id).execute()
        if not response.data:
            return None
        return PermissionGroupResponse(**response.data[0])

    @staticmethod
    def delete_group(group_id: str) -> bool:
        response = supabase.table("permission_groups").delete() \
            .eq("id", group_id).execute()
        return len(response.data) > 0

    # ================================================
    # Staff
    # ================================================

    @staticmethod
    def create_staff(data: StaffCreate, created_by: str, organization_id: str = None) -> StaffResponse:
        """Convida o funcionário por e-mail; ele define nome e senha.

        Antes, o admin digitava a senha do funcionário — ou seja, conhecia a
        senha de outra pessoa e precisava repassá-la por fora. Agora vale o
        mesmo caminho do convite do dono do clube: o Supabase cria a conta e
        manda o e-mail; a senha nunca passa por aqui.

        `organization_name` nos metadados é o que marca a conta como criada por
        convite — o app usa isso (com `onboarded_at`) para exigir o cadastro
        antes de liberar o sistema. Sem esse campo, o convidado entraria direto.
        """
        import httpx

        base = settings.supabase_url.rstrip("/")
        headers = {
            "apikey": settings.supabase_service_key,
            "Authorization": f"Bearer {settings.supabase_service_key}",
            "Content-Type": "application/json",
        }

        # Nome do clube: aparece no e-mail e liga o gate de cadastro.
        # Precisa ser `supabase_admin`: `organizations` tem RLS sem nenhuma
        # policy, então a consulta como usuário volta vazia e cairia no
        # genérico — o convidado receberia um e-mail sem o nome do clube.
        org_nome = "AceBlind"
        if organization_id:
            try:
                r = (
                    supabase_admin.table("organizations")
                    .select("name").eq("id", organization_id).limit(1).execute()
                )
                if r.data:
                    org_nome = r.data[0]["name"]
            except Exception:
                pass

        # Limite do plano ANTES de convidar. O convite cria a conta e dispara o
        # e-mail; se o gatilho `trg_enforce_staff_limit` recusasse a inserção
        # depois, sobraria um usuário órfão e uma pessoa convidada que não
        # consegue entrar.
        if organization_id:
            try:
                atual = (
                    supabase.table("staff").select("id", count="exact")
                    .eq("organization_id", organization_id).eq("active", True)
                    .limit(1).execute()
                ).count or 0
                lim = supabase.rpc(
                    "org_limit", {"p_org": organization_id, "p_kind": "users"}
                ).execute().data
                if isinstance(lim, int) and atual >= lim:
                    raise ValueError(
                        f"O plano atual permite {lim} usuário(s) e a organização já tem {atual}. "
                        "Altere o plano para convidar mais gente."
                    )
            except ValueError:
                raise
            except Exception:
                pass  # indisponível: o gatilho do banco ainda protege

        auth_user_id = None
        criamos_o_usuario = False
        ja_tem_conta = False
        try:
            resp = httpx.post(
                f"{base}/auth/v1/invite",
                headers=headers,
                json={
                    "email": data.email,
                    "data": {"organization_name": org_nome},
                    # Leva para a tela onde o funcionário define nome e senha.
                    # (a URL precisa estar na allowlist de Redirect URLs do Supabase)
                    "redirect_to": settings.frontend_url.rstrip("/") + "/definir-senha",
                },
                timeout=20,
            )
        except Exception as exc:
            raise ValueError(f"Falha ao contatar o serviço de e-mail: {exc}")

        if resp.status_code in (200, 201):
            auth_user_id = resp.json().get("id")
            criamos_o_usuario = True
        elif resp.status_code == 429:
            raise ValueError(
                "Limite de envio de e-mails atingido. Aguarde alguns minutos e tente de novo."
            )
        elif resp.status_code in (409, 422):
            # Já existe conta com este e-mail — alguém que trabalha em outro
            # clube. Ela NÃO refaz cadastro (já tem nome e senha), mas também
            # não pode ser jogada dentro do clube sem saber: o vínculo nasce
            # PENDENTE e ela aceita ou recusa ao entrar no sistema.
            ja_tem_conta = True
            found = httpx.get(
                f"{base}/auth/v1/admin/users",
                headers=headers, params={"page": 1, "per_page": 200}, timeout=20,
            )
            for u in (found.json().get("users") or []):
                if (u.get("email") or "").lower() == data.email.lower():
                    auth_user_id = u.get("id")
                    break
            if not auth_user_id:
                raise ValueError("Já existe uma conta com este e-mail.")
        else:
            detalhe = ""
            try:
                j = resp.json()
                detalhe = j.get("msg") or j.get("message") or ""
            except Exception:
                detalhe = resp.text[:160]
            raise ValueError(f"Não foi possível enviar o convite. {detalhe}".strip())

        if not auth_user_id:
            raise ValueError("Não foi possível criar o acesso deste funcionário.")

        # `staff.name` é obrigatório no banco, mas quem informa o nome é o
        # próprio funcionário ao aceitar o convite. Até lá, vale a parte do
        # e-mail — a lista fica legível e a tela de cadastro sobrescreve depois.
        nome = (data.name or "").strip() or data.email.split("@")[0]

        # Já houve vínculo com este clube? A chave única (auth_user_id,
        # organization_id) impede uma segunda linha, então um funcionário
        # desativado nunca poderia ser readmitido — o cadastro morria com
        # "e-mail já cadastrado". Aqui o vínculo antigo volta como convite
        # pendente, e a pessoa decide de novo.
        if organization_id:
            try:
                antigo = (
                    supabase.table("staff")
                    .select("id, active, invite_status")
                    .eq("auth_user_id", auth_user_id)
                    .eq("organization_id", organization_id)
                    .limit(1).execute()
                )
            except Exception:
                antigo = None
            if antigo and antigo.data:
                linha = antigo.data[0]
                if linha.get("active"):
                    raise ValueError("Esta pessoa já faz parte da equipe deste clube.")
                supabase.table("staff").update({
                    "invite_status": "pending",
                    "permission_group_id": data.permission_group_id,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", linha["id"]).execute()
                return StaffService.get_staff(linha["id"])

        # Conta nova: o e-mail de convite JÁ é o aceite — clicar no link e
        # definir a senha é a decisão dela. Conta que já existe: fica pendente
        # até responder, e nesse estado não ocupa vaga do plano (o gatilho de
        # limite só conta ativos).
        insert_data = {
            "auth_user_id": auth_user_id,
            "name": nome,
            "email": data.email,
            "permission_group_id": data.permission_group_id,
            "active": not ja_tem_conta,
            "invite_status": "pending" if ja_tem_conta else "accepted",
            "created_by": created_by,
        }

        try:
            response = supabase.table("staff").insert(insert_data).execute()
            staff = response.data[0]
        except Exception as exc:
            # Se a inserção falhar depois de o convite ter criado a conta,
            # desfaz o usuário: senão fica uma conta órfã no auth, que ninguém
            # vê pela interface e que impede reconvidar o mesmo e-mail.
            if criamos_o_usuario and auth_user_id:
                try:
                    httpx.delete(
                        f"{base}/auth/v1/admin/users/{auth_user_id}",
                        headers=headers, timeout=15,
                    )
                except Exception:
                    pass
            txt = str(exc)
            if "PLANO_LIMITE" in txt:
                raise ValueError("O plano atual não permite mais usuários.")
            if "staff_email" in txt or "duplicate key" in txt:
                raise ValueError("Este e-mail já está cadastrado nesta organização.")
            raise ValueError("Não foi possível cadastrar o funcionário.")

        # Get group info
        group_name = None
        permissions = []
        if staff.get("permission_group_id"):
            group = StaffService.get_group(staff["permission_group_id"])
            if group:
                group_name = group.name
                permissions = group.permissions

        # Auto-create cashboxes in every active stage if this staff has the permission
        if _has_cashbox_permission(permissions):
            from app.services.cashbox_service import CashboxService
            try:
                CashboxService.auto_create_for_staff(staff["id"])
            except Exception:
                pass  # auto-create is best-effort; failures shouldn't block staff creation

        return StaffResponse(
            **staff,
            permission_group_name=group_name,
            permissions=permissions,
        )

    @staticmethod
    def get_staff_list() -> List[StaffResponse]:
        response = supabase.table("staff").select(
            "*, permission_groups(name, permissions)"
        ).order("name").execute()

        results = []
        for item in (response.data or []):
            group = item.pop("permission_groups", {}) or {}
            results.append(StaffResponse(
                **item,
                permission_group_name=group.get("name"),
                permissions=group.get("permissions", []),
            ))
        return results

    @staticmethod
    def get_staff(staff_id: str) -> Optional[StaffResponse]:
        response = supabase.table("staff").select(
            "*, permission_groups(name, permissions)"
        ).eq("id", staff_id).execute()

        if not response.data:
            return None
        item = response.data[0]
        group = item.pop("permission_groups", {}) or {}
        return StaffResponse(
            **item,
            permission_group_name=group.get("name"),
            permissions=group.get("permissions", []),
        )

    @staticmethod
    def update_staff(staff_id: str, data: StaffUpdate) -> Optional[StaffResponse]:
        update_data = data.model_dump(exclude_unset=True)
        if not update_data:
            raise ValueError("Nenhum campo para atualizar")
        update_data["updated_at"] = datetime.now(timezone.utc).isoformat()

        # Block deactivation if there is an open cashbox with a non-zero balance
        if update_data.get("active") is False:
            StaffService._guard_no_open_cashbox(staff_id)

        response = supabase.table("staff").update(update_data) \
            .eq("id", staff_id).execute()
        if not response.data:
            return None

        # If permission group changed and the new group grants cashbox access,
        # ensure cashboxes exist in every active stage.
        if "permission_group_id" in update_data:
            updated = StaffService.get_staff(staff_id)
            if updated and _has_cashbox_permission(updated.permissions):
                from app.services.cashbox_service import CashboxService
                try:
                    CashboxService.auto_create_for_staff(staff_id)
                except Exception:
                    pass

        return StaffService.get_staff(staff_id)

    @staticmethod
    def _guard_no_open_cashbox(staff_id: str) -> None:
        """Raise ValueError if this staff has any open cashbox."""
        open_cb = supabase.table("cashboxes").select("id, current_balance, stage_id") \
            .eq("staff_id", staff_id).eq("status", "open").execute()
        if open_cb.data:
            row = open_cb.data[0]
            balance = float(row.get("current_balance") or 0)
            raise ValueError(
                f"Funcionário tem caixa aberto com saldo de R$ {balance:.2f}. "
                f"Feche o caixa antes de desativar."
            )

    @staticmethod
    def delete_staff(staff_id: str) -> bool:
        """Desativa o funcionário (a conta de acesso continua existindo).

        Exceção: convite ainda PENDENTE é apagado de verdade. Desativar não
        serviria — a linha continuaria marcada como pendente e o convite seguiria
        aparecendo para o convidado, além de travar a chave única
        (auth_user_id, organization_id) e impedir um novo convite depois.
        Convite pendente não tem histórico (nem caixa, nem pagamento), então
        remover é seguro.
        """
        StaffService._guard_no_open_cashbox(staff_id)

        atual = supabase.table("staff").select("invite_status").eq("id", staff_id).execute()
        if atual.data and atual.data[0].get("invite_status") == "pending":
            r = supabase.table("staff").delete().eq("id", staff_id).execute()
            return len(r.data or []) > 0

        response = supabase.table("staff").update({
            "active": False,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", staff_id).execute()
        return len(response.data) > 0

    # ================================================
    # My Permissions
    # ================================================

    @staticmethod
    def get_my_permissions(auth_user_id: str) -> MyPermissions:
        """Get permissions for the currently logged-in user"""
        response = supabase.table("staff").select(
            "*, permission_groups(name, permissions)"
        ).eq("auth_user_id", auth_user_id).execute()

        # No staff record: historically treated as super-admin ("original user").
        # That made ANY authenticated user without a staff row a super-admin — a
        # privilege-escalation default. We now pin admin to an explicit allowlist
        # of owner IDs (SUPER_ADMIN_USER_IDS). If the allowlist is empty (not yet
        # configured) we fall back to the old behavior with a warning so a deploy
        # that forgets the env var doesn't lock everyone out.
        if not response.data:
            from app.config import get_settings
            allow = get_settings().super_admin_ids
            if auth_user_id in allow:
                return MyPermissions(is_admin=True, permissions=ALL_PERMISSIONS, group_name="Admin")
            # FAIL-CLOSED: autenticado mas sem vínculo (sem staff e fora da
            # allowlist) => nenhum acesso. Antes, se a allowlist estivesse VAZIA
            # qualquer conta sem staff virava super-admin — um deploy que
            # esquecesse a env dava poder total a qualquer usuário. Num SaaS isso
            # seria fatal: o funcionário de um cliente viraria dono de tudo.
            return MyPermissions(is_admin=False, permissions=[], group_name=None)

        staff = response.data[0]

        if not staff.get("active"):
            return MyPermissions(is_admin=False, permissions=[], group_name=None)

        group = staff.get("permission_groups", {}) or {}
        permissions = group.get("permissions", [])
        group_name = group.get("name")

        return MyPermissions(
            is_admin=False,
            permissions=permissions,
            group_name=group_name,
        )
