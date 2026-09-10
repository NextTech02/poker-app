import logging
from typing import List, Optional
from datetime import datetime, timezone
from app.database import supabase
from app.database.supabase_client import supabase_admin
from app.config import get_settings
from app.utils.erros import ErroDeNegocio
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
    'cashier', 'cashier_players', 'cashier_tickets',
    # Emissão de ticket em LOTE: operação de dono, não de caixa (ver
    # db/migrations/database_migration_ticket_master_permission.sql).
    'cashier_tickets.master', 'prizes',
    'prizes_release', 'financial', 'reports', 'general_cash', 'rankings',
    'blinds', 'tables', 'broadcast', 'employees',
    'cashbox.operate', 'cashbox.admin',
    'sangi',
    # Módulo de cash game. Ter a chave não basta: o clube precisa ter o módulo
    # contratado (org_modules) — ver app/auth/modules.py.
    'cash.operate', 'cash.tables', 'cash.day', 'cash.reports', 'cash.admin',
]

# Permissions that imply the staff member can have their own cashbox
CASHBOX_OPERATING_PERMISSIONS = ('cashbox.operate', 'cashbox.admin', 'cashier', 'cashier_players')


def _has_cashbox_permission(permissions: list) -> bool:
    return any(p in (permissions or []) for p in CASHBOX_OPERATING_PERMISSIONS)

settings = get_settings()


logger = logging.getLogger(__name__)


def _nao_encontrado() -> ErroDeNegocio:
    """Funcionário inexistente — ou de outra organização, que dá no mesmo."""
    return ErroDeNegocio(
        "funcionario_nao_encontrado", "Funcionário não encontrado.", status=404
    )


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
            raise ErroDeNegocio(
                "nenhum_campo_para_atualizar", "Nenhum campo para atualizar"
            )
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
    def _estado_do_convite(de_outro_clube: bool, criamos_o_usuario: bool) -> str:
        """Em que estado o vínculo nasce — os três casos têm motivos diferentes.

        'pending'         a pessoa JÁ é membro de outro clube. Entra inativa e
                          aguardando: ninguém pode ser jogado dentro de um clube
                          sem saber. Ela aceita pelo OrgInviteModal, ou o admin
                          efetiva por POST /staff/{id}/confirm-invite.
        'awaiting_signup' a conta foi criada agora pelo convite e ainda não tem
                          senha. Nasce ATIVA de propósito: o Auth Hook exige
                          vínculo ativo para emitir o claim de organização, e sem
                          ele a pessoa não conclui o cadastro pelo link do e-mail.
        'accepted'        a conta já existia mas não serve a nenhum clube (conta
                          órfã de cadastro antigo). Não há de quem pedir
                          consentimento e não há cadastro a concluir — só entrar.
                          É o caso que antes prendia o convidado num laço sem
                          saída, porque o Excluir não apaga a conta do auth.
        """
        if de_outro_clube:
            return "pending"
        if criamos_o_usuario:
            return "awaiting_signup"
        return "accepted"

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

        O estado em que o vínculo nasce é decidido por UMA pergunta: "esta
        pessoa já é membro de outra organização?" (ver
        `_e_de_outra_organizacao`) — e não por "já existe conta com este
        e-mail?", que era a pergunta antiga e prendia contas órfãs num convite
        pendente para sempre.
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
                    # Limite e uso vão TAMBÉM como dados nomeados: a tela remonta
                    # a frase no idioma dela sem perder os números, que são o que
                    # dizem ao dono do clube quanto ele precisa liberar.
                    raise ErroDeNegocio(
                        "limite_de_usuarios_do_plano",
                        f"O plano atual permite {lim} usuário(s) e a organização já tem {atual}. "
                        "Altere o plano para convidar mais gente.",
                        status=409,
                        limite=lim,
                        atual=atual,
                    )
            except ValueError:
                raise
            except Exception:
                pass  # indisponível: o gatilho do banco ainda protege

        auth_user_id = None
        criamos_o_usuario = False
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
            # `exc` pode trazer host, chave e corpo da resposta do provedor —
            # nada disso ajuda quem está na tela, e parte é segredo. Fica no log.
            logger.error("Falha ao contatar o serviço de e-mail: %s", exc)
            raise ErroDeNegocio(
                "servico_de_email_indisponivel",
                "Não foi possível contatar o serviço de e-mail. Tente novamente em instantes.",
            )

        if resp.status_code in (200, 201):
            auth_user_id = resp.json().get("id")
            criamos_o_usuario = True
        elif resp.status_code == 429:
            raise ErroDeNegocio(
                "limite_de_envio_de_email",
                "Limite de envio de e-mails atingido. Aguarde alguns minutos e tente de novo.",
            )
        elif resp.status_code in (409, 422):
            # Já existe conta com este e-mail. Isso sozinho NÃO diz de quem ela
            # é: pode ser de alguém que trabalha em outro clube, ou uma conta
            # órfã de um cadastro antigo. Quem decide o estado do vínculo é a
            # checagem de vínculo logo abaixo, não este código HTTP.
            auth_user_id = StaffService._localiza_conta_por_email(base, headers, data.email)
            if not auth_user_id:
                raise ErroDeNegocio(
                    "email_ja_tem_conta",
                    "Já existe uma conta com este e-mail.",
                    status=409,
                    email=data.email,
                )
        else:
            detalhe = ""
            try:
                j = resp.json()
                detalhe = j.get("msg") or j.get("message") or ""
            except Exception:
                detalhe = resp.text[:160]
            # `detalhe` é a resposta do provedor de auth: inglês, JSON, e às
            # vezes o e-mail de outra pessoa. Vai só para o log.
            logger.error(
                "Convite recusado pelo serviço de auth (%s): %s", resp.status_code, detalhe
            )
            raise ErroDeNegocio(
                "falha_ao_enviar_convite",
                "Não foi possível enviar o convite. Confira o e-mail e tente de novo.",
            )

        if not auth_user_id:
            raise ErroDeNegocio(
                "acesso_do_funcionario_nao_criado",
                "Não foi possível criar o acesso deste funcionário.",
            )

        # `staff.name` é obrigatório no banco, mas quem informa o nome é o
        # próprio funcionário ao aceitar o convite. Até lá, vale a parte do
        # e-mail — a lista fica legível e a tela de cadastro sobrescreve depois.
        nome = (data.name or "").strip() or data.email.split("@")[0]

        # A PERGUNTA QUE DECIDE O ESTADO DO VÍNCULO.
        #
        # Antes era "existe conta no auth com este e-mail?" — e isso mandava
        # para 'pending' qualquer pessoa que já tivesse logado alguma vez,
        # inclusive uma conta ÓRFÃ sobrada de um cadastro antigo. O convite
        # ficava eternamente pendente, sem consentimento nenhum a proteger, e
        # excluir + convidar de novo reencontrava a mesma conta: um laço
        # fechado, sem saída pela tela.
        #
        # O 'pending' existe para PEDIR CONSENTIMENTO de quem já é de OUTRO
        # clube — ninguém pode ser jogado dentro de uma organização sem saber.
        # Então a pergunta certa é sobre o VÍNCULO, não sobre a conta.
        de_outro_clube = StaffService._e_de_outra_organizacao(auth_user_id, organization_id)

        # Já houve vínculo com este clube? A chave única (auth_user_id,
        # organization_id) impede uma segunda linha, então um funcionário
        # desativado nunca poderia ser readmitido — o cadastro morria com
        # "e-mail já cadastrado".
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
                    raise ErroDeNegocio(
                        "ja_e_membro_do_clube",
                        "Esta pessoa já faz parte da equipe deste clube.",
                        status=409,
                        email=data.email,
                    )
                # Readmissão segue o MESMO critério do convite novo: quem não
                # trabalha em outro clube volta direto como membro (o convite
                # partiu deste clube, não há terceiro a consultar); quem
                # trabalha volta como convite pendente e responde.
                volta = {
                    "invite_status": "pending" if de_outro_clube else "accepted",
                    "permission_group_id": data.permission_group_id,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                if not de_outro_clube:
                    volta["active"] = True
                try:
                    supabase.table("staff").update(volta).eq("id", linha["id"]).execute()
                except Exception as exc:
                    # O gatilho do plano dispara na virada false -> true.
                    if "PLANO_LIMITE" in str(exc):
                        raise ErroDeNegocio(
                            "limite_de_usuarios_do_plano",
                            "O plano atual não permite mais usuários ativos. "
                            "Altere o plano para readmitir esta pessoa.",
                            status=409,
                        )
                    logger.error("Falha ao readmitir o funcionário %s: %s", linha["id"], exc)
                    raise ErroDeNegocio(
                        "falha_ao_readmitir_funcionario",
                        "Não foi possível readmitir o funcionário.",
                    )

                readmitido = StaffService.get_staff(linha["id"])
                # Voltou como membro: precisa dos caixas das etapas ativas,
                # senão não consegue trabalhar hoje (mesmo tratamento do
                # cadastro direto e da efetivação pelo admin).
                if readmitido and readmitido.active and _has_cashbox_permission(readmitido.permissions):
                    from app.services.cashbox_service import CashboxService
                    try:
                        CashboxService.auto_create_for_staff(linha["id"])
                    except Exception:
                        pass  # best-effort: não bloqueia a readmissão
                return readmitido

        # Três estados, três motivos distintos:
        #
        # - de OUTRO clube  -> 'pending' + inativo: o vínculo só vale depois que
        #   a própria pessoa aceitar (OrgInviteModal) ou o admin efetivar.
        # - conta NOVA      -> 'awaiting_signup' + ATIVO: o Auth Hook exige
        #   vínculo ativo para emitir o claim de organização; sem ele a pessoa
        #   não conclui nem o cadastro pelo link do e-mail. O status é o que
        #   impede a lista de mostrá-la como membro efetivo.
        # - conta que existe mas não serve a nenhum clube (órfã) -> membro
        #   efetivo direto: não há de quem pedir consentimento, e deixá-la
        #   'pending' era exatamente o laço relatado. Ela já tem nome e senha,
        #   então basta entrar — não há cadastro a concluir.
        insert_data = {
            "auth_user_id": auth_user_id,
            "name": nome,
            "email": data.email,
            "permission_group_id": data.permission_group_id,
            "active": not de_outro_clube,
            "invite_status": StaffService._estado_do_convite(
                de_outro_clube, criamos_o_usuario
            ),
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
                raise ErroDeNegocio(
                    "limite_de_usuarios_do_plano",
                    "O plano atual não permite mais usuários.",
                    status=409,
                )
            if "staff_email" in txt or "duplicate key" in txt:
                # Diz DE QUEM é o e-mail repetido, como no cadastro de jogador:
                # "já existe" sem o e-mail manda o admin procurar às cegas.
                raise ErroDeNegocio(
                    "email_ja_cadastrado_na_organizacao",
                    "Este e-mail já está cadastrado nesta organização.",
                    status=409,
                    email=data.email,
                )
            # Texto do Postgres (constraint, coluna) só no log.
            logger.error("Falha ao cadastrar o funcionário %s: %s", data.email, txt)
            raise ErroDeNegocio(
                "falha_ao_cadastrar_funcionario",
                "Não foi possível cadastrar o funcionário.",
            )

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
    def _e_de_outra_organizacao(auth_user_id: str, organization_id: str = None) -> bool:
        """Esta pessoa já é membro de ALGUM outro clube?

        É a pergunta que autoriza o fluxo de consentimento. Ter conta no auth
        não responde nada: uma conta pode ser órfã, sobrada de um cadastro que
        nunca virou vínculo, e é dela que ninguém precisa pedir permissão.

        VÍNCULO INATIVO EM OUTRO CLUBE TAMBÉM CONTA como "é de outro clube":
        - a linha só existe porque alguém a contratou — é uma pessoa real, com
          senha própria, não uma conta órfã. Desativação costuma ser
          temporária (afastamento, suspensão), tanto que a readmissão é um
          caminho previsto aqui mesmo;
        - os erros não custam o mesmo. Pedir consentimento à toa custa um
          clique ("Efetivar convite"); pular o consentimento indevidamente
          coloca a pessoa dentro do clube, com permissões, sem desfazer.

        Usa `supabase_admin` de propósito: o client padrão roda COMO O USUÁRIO
        e o RLS só deixa ele enxergar a própria organização — a consulta
        voltaria vazia para todo mundo e a pergunta seria sempre respondida
        com "não".
        """
        if not auth_user_id:
            return False
        try:
            q = (
                supabase_admin.table("staff")
                .select("id, organization_id, active")
                .eq("auth_user_id", auth_user_id)
            )
            if organization_id:
                q = q.neq("organization_id", organization_id)
            r = q.limit(1).execute()
        except Exception:
            # Sem resposta do banco, escolhe o lado que não pode ser desfeito:
            # pede o consentimento. Hoje 'pending' tem saída pela tela
            # (Efetivar / Cancelar), então errar para este lado não prende
            # mais ninguém.
            return True
        return bool(r.data)

    @staticmethod
    def _localiza_conta_por_email(base: str, headers: dict, email: str) -> Optional[str]:
        """Procura a conta de acesso que JÁ existe com este e-mail.

        Pagina de verdade. A busca lia só a primeira página (200 contas), então
        num projeto maior o convite a alguém antigo morria em "Já existe uma
        conta com este e-mail" — sem nenhuma saída pela tela. Isso vale
        justamente para RECONVIDAR quem já foi convidado antes, que é o caminho
        de saída de um convite cancelado.
        """
        import httpx

        alvo = (email or "").lower()
        por_pagina = 200
        for pagina in range(1, 11):  # teto de 2.000 contas: evita varredura infinita
            try:
                r = httpx.get(
                    f"{base}/auth/v1/admin/users",
                    headers=headers,
                    params={"page": pagina, "per_page": por_pagina},
                    timeout=20,
                )
                usuarios = (r.json().get("users") or []) if r.status_code < 400 else []
            except Exception:
                return None
            for u in usuarios:
                if (u.get("email") or "").lower() == alvo:
                    return u.get("id")
            if len(usuarios) < por_pagina:
                return None  # acabou a lista
        return None

    @staticmethod
    def cancel_invite(staff_id: str, organization_id: str = None) -> dict:
        """Cancela um convite: a linha SAI da tabela de verdade.

        A tela chamava o DELETE genérico, que apenas DESATIVA. Como o convite
        de quem já tem conta nasce inativo, o clique não mudava nada visível e
        o `invite_status` seguia "pendente" para sempre — a pessoa ficava presa
        num estado sem saída, e a chave única (auth_user_id, organization_id)
        ainda travava um novo convite para o mesmo e-mail.

        Membro efetivo NÃO passa por aqui: desativar alguém achando que estava
        cancelando um convite é exatamente a confusão que causou o problema.
        """
        alvo = supabase.table("staff").select(
            "id, email, active, invite_status, auth_user_id, organization_id"
        ).eq("id", staff_id).execute()
        if not alvo.data:
            raise _nao_encontrado()
        linha = alvo.data[0]

        if organization_id and linha.get("organization_id") != organization_id:
            raise _nao_encontrado()

        estado = linha.get("invite_status")
        if estado not in ("pending", "awaiting_signup"):
            raise ErroDeNegocio(
                "sem_convite_a_cancelar",
                "Esta pessoa já faz parte da equipe — não há convite a cancelar. "
                "Use Desativar ou Excluir.",
                status=409,
            )

        StaffService._guard_no_open_cashbox(staff_id)
        StaffService._apaga_caixas_vazios(staff_id)

        r = supabase.table("staff").delete().eq("id", staff_id).execute()
        if not (r.data or []):
            raise ErroDeNegocio(
                "falha_ao_cancelar_convite", "Não foi possível cancelar o convite."
            )

        # Cadastro nunca concluído: a conta de acesso também sai. Deixá-la
        # criaria uma armadilha — no próximo convite o e-mail já existiria e a
        # pessoa cairia no fluxo de "aceitar convite", que exige entrar no
        # sistema... com uma senha que ela nunca chegou a definir.
        # Convite 'pending' é o contrário: desde `_e_de_outra_organizacao`,
        # 'pending' só nasce para quem TEM vínculo em outro clube — apagar a
        # conta derrubaria o acesso dela lá. (Antes, 'pending' também pegava
        # conta órfã; era essa conta preservada que fechava o laço no
        # reconvite.)
        conta_removida = False
        if estado == "awaiting_signup" and linha.get("auth_user_id"):
            try:
                import httpx
                base = settings.supabase_url.rstrip("/")
                d = httpx.delete(
                    f"{base}/auth/v1/admin/users/{linha['auth_user_id']}",
                    headers={
                        "apikey": settings.supabase_service_key,
                        "Authorization": f"Bearer {settings.supabase_service_key}",
                    },
                    timeout=15,
                )
                conta_removida = d.status_code < 300
            except Exception:
                pass  # o vínculo já saiu; a conta órfã é tratável depois

        return {
            "cancelled": True,
            "email": linha.get("email"),
            "invite_status": estado,
            "account_removed": conta_removida,
        }

    @staticmethod
    def _apaga_caixas_vazios(staff_id: str) -> None:
        """Tira os caixas VAZIOS do funcionário antes de apagar o vínculo.

        `cashboxes.staff_id` é ON DELETE RESTRICT e todo convidado com
        permissão de caixa recebe um caixa por etapa automaticamente, ainda no
        convite. Sem apagá-los antes, o Postgres RECUSA a exclusão e o
        cancelamento morre num erro genérico — é o segundo motivo pelo qual um
        convite ficava preso em "pendente".

        Caixa COM movimento não é apagado: aí a pessoa operou dinheiro, o caso
        deixou de ser convite e vira exclusão de funcionário, que preserva os
        livros.
        """
        caixas = supabase.table("cashboxes").select("id").eq("staff_id", staff_id).execute()
        ids = [c["id"] for c in (caixas.data or [])]
        if not ids:
            return

        sessoes = supabase.table("cashbox_sessions").select("id") \
            .in_("cashbox_id", ids).limit(1).execute()
        movimentos = supabase.table("cashbox_transactions").select("id") \
            .in_("cashbox_id", ids).limit(1).execute()
        if (sessoes.data or []) or (movimentos.data or []):
            raise ErroDeNegocio(
                "funcionario_com_movimento_de_caixa",
                "Este funcionário já movimentou caixa. Use Excluir, que preserva o histórico.",
                status=409,
            )

        supabase.table("cashboxes").delete().in_("id", ids).execute()

    @staticmethod
    def confirm_invite(staff_id: str, organization_id: str = None) -> Optional[StaffResponse]:
        """Efetiva o convite pelo ADMIN: o vínculo vira membro de fato.

        Sem isto, um convite 'pending' só podia virar 'accepted' se a própria
        pessoa entrasse no sistema e respondesse o modal. Quem foi convidada e
        não entra (ou trabalha só no outro clube) ficava presa nesse estado, e
        o admin não tinha NENHUMA saída pela tela.

        Não cria poder novo: quem convida é o admin do clube, que já cadastra
        funcionário do zero e escolhe o grupo de permissão. A pessoa continua
        podendo ser desativada ou excluída depois.

        Só vale para 'pending' (conta que já existe, com senha). 'awaiting_signup'
        é outro caso: a pessoa ainda não definiu senha, e marcá-la como membro
        não a faria entrar — o caminho lá é reenviar o convite.
        """
        alvo = supabase.table("staff").select(
            "id, name, email, invite_status, organization_id"
        ).eq("id", staff_id).execute()
        if not alvo.data:
            raise _nao_encontrado()
        linha = alvo.data[0]

        if organization_id and linha.get("organization_id") != organization_id:
            raise _nao_encontrado()

        estado = linha.get("invite_status")
        if estado == "accepted":
            raise ErroDeNegocio(
                "ja_e_membro_do_clube",
                "Esta pessoa já faz parte da equipe deste clube.",
                status=409,
                nome=linha.get("name"),
            )
        if estado == "awaiting_signup":
            raise ErroDeNegocio(
                "convite_aguardando_cadastro",
                "Esta pessoa ainda não definiu a senha. Use Reenviar para mandar "
                "outro link de cadastro.",
                status=409,
                nome=linha.get("name"),
            )

        # O gatilho do plano dispara AQUI (false -> true): a vaga é cobrada de
        # quem de fato entrou, igual ao aceite pela própria pessoa.
        try:
            r = supabase.table("staff").update({
                "active": True,
                "invite_status": "accepted",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", staff_id).execute()
        except Exception as exc:
            if "PLANO_LIMITE" in str(exc):
                raise ErroDeNegocio(
                    "limite_de_usuarios_do_plano",
                    "O plano atual não permite mais usuários ativos. "
                    "Altere o plano para efetivar este convite.",
                    status=409,
                )
            logger.error("Falha ao efetivar o convite %s: %s", staff_id, exc)
            raise ErroDeNegocio(
                "falha_ao_efetivar_convite", "Não foi possível efetivar o convite."
            )
        if not (r.data or []):
            raise ErroDeNegocio(
                "falha_ao_efetivar_convite", "Não foi possível efetivar o convite."
            )

        efetivado = StaffService.get_staff(staff_id)

        # Mesmo tratamento do cadastro direto: quem opera caixa precisa ter o
        # caixa criado nas etapas ativas, senão não consegue trabalhar hoje.
        if efetivado and _has_cashbox_permission(efetivado.permissions):
            from app.services.cashbox_service import CashboxService
            try:
                CashboxService.auto_create_for_staff(staff_id)
            except Exception:
                pass  # best-effort: não bloqueia a efetivação

        return efetivado

    @staticmethod
    def remove_from_org(staff_id: str, organization_id: str) -> dict:
        """Tira o funcionário do clube — e a conta de acesso, se for o último.

        Quem decide entre apagar e desativar é o banco (`remove_staff_member`),
        pelos dados: com histórico financeiro o registro é preservado, porque
        apagá-lo reescreveria resultados de etapas já apuradas.
        """
        import httpx

        if not organization_id:
            raise ErroDeNegocio(
                "conta_sem_organizacao",
                "Sua conta não está vinculada a nenhuma organização.",
                status=403,
            )

        StaffService._guard_no_open_cashbox(staff_id)

        try:
            r = supabase_admin.rpc(
                "remove_staff_member",
                {"p_org": organization_id, "p_staff": staff_id},
            ).execute()
        except Exception as exc:
            if "FUNCIONARIO_NAO_ENCONTRADO" in str(exc):
                raise _nao_encontrado()
            logger.error("Falha ao excluir o funcionário %s: %s", staff_id, exc)
            raise ErroDeNegocio(
                "falha_ao_excluir_funcionario", "Não foi possível excluir o funcionário."
            )

        res = r.data or {}

        # Conta de acesso: só sai se a pessoa não trabalha em mais nenhum clube.
        # Pode falhar de propósito — 15 tabelas apontam para `auth.users` com
        # NO ACTION, então quem já criou torneio, transação ou sangria não pode
        # ser apagado sem levar o histórico junto. Nesse caso a conta fica, mas
        # inofensiva: sem vínculo, ela não enxerga nenhuma organização.
        res["conta_removida"] = False
        if res.get("acao") == "removido" and res.get("ultima_organizacao") and res.get("auth_user_id"):
            try:
                base = settings.supabase_url.rstrip("/")
                d = httpx.delete(
                    f"{base}/auth/v1/admin/users/{res['auth_user_id']}",
                    headers={
                        "apikey": settings.supabase_service_key,
                        "Authorization": f"Bearer {settings.supabase_service_key}",
                    },
                    timeout=15,
                )
                res["conta_removida"] = d.status_code < 300
            except Exception:
                pass
        return res

    @staticmethod
    def resend_invite(staff_id: str, organization_id: str = None) -> dict:
        """Reenvia o link de cadastro para quem ainda não concluiu.

        Usa `/recover` e não `/invite`: a conta já existe, então o convite
        seria recusado com 422. O link de recuperação serve igual — a tela de
        cadastro decide o que pedir pelo `onboarded_at` da conta, não pelo tipo
        do link, então quem nunca concluiu continua informando nome e senha.
        """
        import httpx

        alvo = supabase.table("staff").select(
            "id, email, invite_status, organization_id"
        ).eq("id", staff_id).execute()
        if not alvo.data:
            raise _nao_encontrado()
        linha = alvo.data[0]

        if organization_id and linha.get("organization_id") != organization_id:
            raise _nao_encontrado()
        if linha.get("invite_status") == "accepted":
            raise ErroDeNegocio(
                "cadastro_ja_concluido",
                "Esta pessoa já concluiu o cadastro.",
                status=409,
            )

        base = settings.supabase_url.rstrip("/")
        r = httpx.post(
            f"{base}/auth/v1/recover",
            headers={
                "apikey": settings.supabase_service_key,
                "Authorization": f"Bearer {settings.supabase_service_key}",
                "Content-Type": "application/json",
            },
            json={
                "email": linha["email"],
                "redirect_to": settings.frontend_url.rstrip("/") + "/definir-senha",
            },
            timeout=20,
        )
        if r.status_code == 429:
            raise ErroDeNegocio(
                "limite_de_envio_de_email",
                "Muitos e-mails enviados. Aguarde alguns minutos e tente de novo.",
            )
        if r.status_code >= 400:
            logger.error(
                "Reenvio de convite recusado (%s): %s", r.status_code, r.text[:500]
            )
            raise ErroDeNegocio(
                "falha_ao_reenviar_convite", "Não foi possível reenviar o convite."
            )
        return {"sent": True, "email": linha["email"]}

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
            raise ErroDeNegocio(
                "nenhum_campo_para_atualizar", "Nenhum campo para atualizar"
            )
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
        """Recusa (ErroDeNegocio) se este funcionário tiver caixa aberto."""
        open_cb = supabase.table("cashboxes").select("id, current_balance, stage_id") \
            .eq("staff_id", staff_id).eq("status", "open").execute()
        if open_cb.data:
            row = open_cb.data[0]
            balance = float(row.get("current_balance") or 0)
            # O SALDO vai como dado nomeado: a frase é remontada na tela, no
            # idioma e na MOEDA do clube — o "R$" da reserva não serve para o
            # clube peruano nem para o colombiano.
            raise ErroDeNegocio(
                "funcionario_com_caixa_aberto",
                f"Funcionário tem caixa aberto com saldo de R$ {balance:.2f}. "
                f"Feche o caixa antes de desativar.",
                status=409,
                saldo=balance,
            )

    @staticmethod
    def delete_staff(staff_id: str) -> bool:
        """Desativa o funcionário (a conta de acesso continua existindo).

        Exceção: convite ainda não respondido é CANCELADO (a linha sai), porque
        desativar não serviria — a linha continuaria marcada como pendente, o
        convite seguiria aparecendo para o convidado e a chave única
        (auth_user_id, organization_id) impediria um novo convite depois.

        A regra do cancelamento mora em `cancel_invite`, que é o que a tela
        chama. Aqui só se delega: duas cópias da mesma regra foi como o
        cancelamento acabou divergindo do que a tela prometia.
        """
        StaffService._guard_no_open_cashbox(staff_id)

        atual = supabase.table("staff").select(
            "invite_status, auth_user_id"
        ).eq("id", staff_id).execute()
        linha = atual.data[0] if atual.data else {}
        estado = linha.get("invite_status")

        if estado in ("pending", "awaiting_signup"):
            StaffService.cancel_invite(staff_id)
            return True

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
