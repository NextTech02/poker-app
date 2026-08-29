"""Cadastro de organizações (clientes do SaaS).

Onboarding B2B: a NextHub cadastra o clube e convida o dono por e-mail. Não é
auto-cadastro público — quem acessa é apenas o `platform_admin`.

A criação em si é feita pela função `provision_organization` no banco, que roda
tudo numa transação (org + grupos + staff admin + moeda + caixa geral + rake +
formas de pagamento). Assim um cliente nunca nasce pela metade.
"""
import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Literal, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from app.auth.jwt import get_current_user
from app.config import get_settings
from app.database.supabase_client import supabase_admin
from app.utils.erros import conflito, erro_http, nao_encontrado, recusado, sem_permissao

router = APIRouter(prefix="/organizations", tags=["organizations"])
settings = get_settings()

# Texto de erro de TERCEIRO (Supabase, Postgres) nao vai para a tela do cliente:
# vem em ingles, cita nome de constraint e as vezes o e-mail de outra pessoa. Ele
# fica so aqui no log, onde o suporte le; a tela recebe codigo + frase nossa.
logger = logging.getLogger(__name__)


def require_platform_admin(user: dict = Depends(get_current_user)) -> dict:
    """Só a NextHub cadastra clientes.

    A checagem é no SERVIDOR, a partir do claim assinado — esconder o menu no
    frontend não é segurança, qualquer um poderia chamar a API na mão.
    """
    if user.get("platform_admin") is not True:
        raise sem_permissao(
            "apenas_platform_admin",
            "Apenas administradores da plataforma podem cadastrar organizações.",
        )
    return user


class OrganizationCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    slug: Optional[str] = Field(None, max_length=60)
    admin_name: str = Field(..., min_length=2, max_length=120)
    admin_email: EmailStr
    currency: str = Field("BRL", min_length=3, max_length=3)
    # Idioma do clube. Nao e so a interface: o provisionamento grava os nomes
    # dos cargos e das formas de pagamento NESTE idioma, direto no banco. Antes
    # sempre saiam em portugues, e um clube colombiano abria a tela de
    # Funcionarios lendo "Caixa / Operacao de caixa".
    language: Literal["pt-BR", "en-US", "es-ES"] = "pt-BR"
    plan: str = Field("free", max_length=30)


class OrganizationOut(BaseModel):
    id: str
    name: str
    slug: str
    admin_email: str
    invite_sent: bool
    invite_error: Optional[str] = None


def _slugify(value: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return re.sub(r"-{2,}", "-", s)[:60] or "org"


@router.get("/plans", dependencies=[Depends(require_platform_admin)])
def list_plans():
    """Catálogo de planos e seus limites (para o seletor e a exibição)."""
    return supabase_admin.table("plans").select("*").order("sort_order").execute().data or []


@router.get("", dependencies=[Depends(require_platform_admin)])
def list_organizations():
    """Lista as organizações com plano, limites e uso básico (usuários)."""
    orgs = supabase_admin.table("organizations").select("*").order("created_at").execute().data or []
    staff = supabase_admin.table("staff").select("organization_id, active").execute().data or []
    total: dict = {}
    active: dict = {}
    for s in staff:
        oid = s["organization_id"]
        total[oid] = total.get(oid, 0) + 1
        if s.get("active"):
            active[oid] = active.get(oid, 0) + 1

    plans = {p["code"]: p for p in (supabase_admin.table("plans").select("*").execute().data or [])}
    for o in orgs:
        p = plans.get(o.get("plan_code")) or {}
        o["staff_count"] = total.get(o["id"], 0)            # total (drill-down)
        o["active_users"] = active.get(o["id"], 0)          # ativos (limite)
        o["plan_name"] = p.get("name")
        # Limite efetivo de usuários: override por org vence o do plano.
        o["max_users"] = (
            o["max_users_override"] if o.get("max_users_override") is not None
            else p.get("max_users")
        )
        o["max_tournaments_month"] = p.get("max_tournaments_month")
        o["max_tables_tournament"] = p.get("max_tables_tournament")
        o["max_clients"] = p.get("max_clients")
    return orgs


@router.get("/{org_id}/staff", dependencies=[Depends(require_platform_admin)])
def list_organization_staff(org_id: str):
    """Lista os funcionários de uma organização, para o platform_admin inspecionar.

    Usa o cliente admin (bypassa RLS): o `StaffService` normal é escopado à org
    ATIVA do usuário via RLS, então nunca enxergaria os funcionários de outro
    clube. Aqui a autorização é o `require_platform_admin` — só a NextHub chega.
    Read-only: gerência (editar/desativar) continua sendo do admin de cada clube.
    """
    org = supabase_admin.table("organizations").select("id, name").eq("id", org_id).execute()
    if not org.data:
        raise nao_encontrado("organizacao_nao_encontrada", "Organização não encontrada.")

    rows = (
        supabase_admin.table("staff")
        .select("id, name, email, active, created_at, permission_group_id, permission_groups(name)")
        .eq("organization_id", org_id)
        .order("name")
        .execute()
        .data
        or []
    )
    staff = []
    for s in rows:
        group = s.pop("permission_groups", None) or {}
        s["permission_group_name"] = group.get("name")
        staff.append(s)
    return staff


@router.get("/{org_id}/usage", dependencies=[Depends(require_platform_admin)])
def organization_usage(org_id: str):
    """Uso atual vs limite: usuários ativos, clientes e torneios do mês."""
    active_users = len(
        supabase_admin.table("staff").select("id")
        .eq("organization_id", org_id).eq("active", True).execute().data or []
    )
    clients = (
        supabase_admin.table("players").select("id", count="exact")
        .eq("organization_id", org_id).execute().count or 0
    )
    month_start = datetime.now(timezone.utc).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    ).isoformat()
    tournaments_month = (
        supabase_admin.table("tournaments").select("id", count="exact")
        .eq("organization_id", org_id).gte("created_at", month_start).execute().count or 0
    )
    return {
        "active_users": active_users,
        "clients": clients,
        "tournaments_month": tournaments_month,
    }


class OrganizationPlanUpdate(BaseModel):
    plan_code: str = Field(..., max_length=30)
    max_users_override: Optional[int] = Field(None, ge=0)
    reset_trial: bool = False


@router.patch("/{org_id}/plan", dependencies=[Depends(require_platform_admin)])
def update_organization_plan(org_id: str, data: OrganizationPlanUpdate):
    """Muda o plano de uma org (upgrade/downgrade) e o override de usuários.

    Não é retroativo: se o novo limite for menor que o uso atual, os registros
    existentes ficam — a org apenas não consegue criar mais até regularizar.
    Trial: ao entrar num plano com trial, recomputa `trial_ends_at`; num plano
    sem trial, limpa.
    """
    org = supabase_admin.table("organizations").select("id, plan_code").eq("id", org_id).execute()
    if not org.data:
        raise nao_encontrado("organizacao_nao_encontrada", "Organização não encontrada.")
    plan = supabase_admin.table("plans").select("*").eq("code", data.plan_code).execute()
    if not plan.data:
        # O código do plano vai TAMBÉM como dado nomeado: a tela remonta a frase
        # no idioma dela e ainda assim mostra qual plano foi recusado.
        raise recusado(
            "plano_invalido",
            f"Plano '{data.plan_code}' inválido.",
            plan_code=data.plan_code,
        )
    p = plan.data[0]

    update = {
        "plan_code": data.plan_code,
        "max_users_override": data.max_users_override,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    trial_days = p.get("trial_days")
    if trial_days is not None:
        changing_plan = org.data[0].get("plan_code") != data.plan_code
        if data.reset_trial or changing_plan:
            update["trial_ends_at"] = (
                datetime.now(timezone.utc) + timedelta(days=int(trial_days))
            ).isoformat()
    else:
        update["trial_ends_at"] = None  # plano sem trial

    res = supabase_admin.table("organizations").update(update).eq("id", org_id).execute()
    return (res.data or [{}])[0]


class OrganizationStatusUpdate(BaseModel):
    status: str = Field(..., pattern="^(active|suspended|cancelled)$")


@router.patch("/{org_id}/status", dependencies=[Depends(require_platform_admin)])
def update_organization_status(org_id: str, data: OrganizationStatusUpdate):
    """Suspende, cancela ou reativa uma organização.

    Não é cosmético: `current_org_id()` só devolve a organização quando ela está
    ATIVA, e todo o RLS depende dessa função. Suspender corta leitura e escrita
    de todos os usuários do clube na PRÓXIMA QUERY — não espera o token expirar.
    Reativar devolve o acesso na hora, sem precisar de novo login.
    """
    org = supabase_admin.table("organizations").select("id, name, status").eq("id", org_id).execute()
    if not org.data:
        raise nao_encontrado("organizacao_nao_encontrada", "Organização não encontrada.")

    updated = (
        supabase_admin.table("organizations")
        .update({"status": data.status})
        .eq("id", org_id)
        .execute()
    )
    return (updated.data or [{}])[0]


@router.delete("/{org_id}", dependencies=[Depends(require_platform_admin)])
def delete_organization(org_id: str):
    """Exclui DEFINITIVAMENTE uma organização e todos os seus dados.

    Só permitido para organização não-ativa: obriga a suspender antes, o que já
    corta o acesso e dá uma chance de perceber o engano. Irreversível.
    Não remove usuários do auth — com multi-org, a mesma pessoa pode pertencer
    a outro clube; apenas os vínculos (staff) desta organização somem.
    """
    try:
        result = supabase_admin.rpc("delete_organization", {"p_org": org_id}).execute()
        return result.data if not isinstance(result.data, list) else (result.data or [{}])[0]
    except Exception as exc:
        msg = str(exc)
        if "Suspenda" in msg:
            raise conflito(
                "organizacao_ativa_nao_pode_ser_excluida",
                "Suspenda a organização antes de excluí-la.",
            )
        if "não encontrada" in msg or "nao encontrada" in msg:
            raise nao_encontrado("organizacao_nao_encontrada", "Organização não encontrada.")
        # O texto do banco fica no LOG. Antes ele ia inteiro para a tela do
        # platform admin — em inglês, com nome de constraint, e sem lhe dizer
        # nada sobre o que fazer.
        logger.error("Falha ao excluir a organização %s: %s", org_id, msg)
        raise recusado(
            "falha_ao_excluir_organizacao",
            "Não foi possível excluir a organização. Consulte o suporte.",
        )


# ── Multi-organização: o mesmo usuário pode pertencer a vários clubes ────────

@router.get("/mine")
def my_organizations(current_user: dict = Depends(get_current_user)):
    """Organizações às quais o usuário logado pertence (para o seletor)."""
    res = supabase_admin.rpc("list_my_organizations", {"p_user": current_user.get("sub")}).execute()
    return res.data or []


# ── Convites pendentes ───────────────────────────────────────────────────────
# Quem já tem conta e é convidado por outro clube não refaz cadastro: só aceita
# ou recusa. Estas rotas são do USUÁRIO, não de uma organização — por isso não
# passam pelo escopo de org e filtram sempre pelo `sub` do token.

@router.get("/invites")
def my_invites(current_user: dict = Depends(get_current_user)):
    """Convites que este usuário ainda não respondeu."""
    res = supabase_admin.rpc(
        "list_my_pending_invites", {"p_user": current_user.get("sub")}
    ).execute()
    return res.data or []


@router.post("/invites/{staff_id}/accept")
def accept_invite(staff_id: str, current_user: dict = Depends(get_current_user)):
    """Aceita: o vínculo vira ativo. É aqui que a vaga do plano é ocupada."""
    try:
        res = supabase_admin.rpc(
            "accept_org_invite",
            {"p_user": current_user.get("sub"), "p_staff": staff_id},
        ).execute()
    except Exception as exc:
        msg = str(exc)
        if "PLANO_LIMITE_USUARIOS" in msg:
            raise conflito(
                "limite_de_usuarios_do_plano",
                "Este clube atingiu o limite de usuários do plano. Fale com o administrador.",
            )
        if "CONVITE_INVALIDO" in msg:
            raise nao_encontrado(
                "convite_ja_respondido", "Convite não encontrado ou já respondido."
            )
        logger.error("Falha ao aceitar o convite %s: %s", staff_id, msg)
        raise recusado("falha_ao_aceitar_convite", "Não foi possível aceitar o convite.")
    return res.data or {}


@router.post("/invites/{staff_id}/decline")
def decline_invite(staff_id: str, current_user: dict = Depends(get_current_user)):
    """Recusa: apaga o vínculo, para o clube poder convidar de novo depois."""
    res = supabase_admin.rpc(
        "decline_org_invite",
        {"p_user": current_user.get("sub"), "p_staff": staff_id},
    ).execute()
    if not res.data:
        raise nao_encontrado(
            "convite_ja_respondido", "Convite não encontrado ou já respondido."
        )
    return {"declined": True}


class SwitchOrgRequest(BaseModel):
    organization_id: str


@router.post("/switch")
def switch_organization(data: SwitchOrgRequest, current_user: dict = Depends(get_current_user)):
    """Troca a organização ativa do usuário.

    Grava a escolha; o CLAIM só muda no próximo token, então o frontend precisa
    chamar `supabase.auth.refreshSession()` depois. É de propósito: o RLS confia
    no claim assinado, não em nada que o cliente envie — aceitar a organização
    por header seria o mesmo buraco do X-Stage-ID.

    Quem autoriza é a função no banco, não esta rota:
    - usuário comum   -> exige vínculo ativo em `staff`;
    - platform_admin  -> pode entrar em qualquer organização ativa (é assim que
      o admin inspeciona o clube de um cliente vendo SÓ os dados dele).
    """
    is_admin = current_user.get("platform_admin") is True
    try:
        supabase_admin.rpc("set_active_organization", {
            "p_user": current_user.get("sub"),
            "p_org": data.organization_id,
        }).execute()
    except Exception as exc:
        # Dois códigos porque são duas situações diferentes para quem lê: o
        # platform admin PODE entrar em qualquer org ativa (se falhou, é a org
        # que não serve); o usuário comum é quem não tem vínculo.
        logger.info("Troca de organização recusada (%s): %s", data.organization_id, exc)
        if is_admin:
            raise sem_permissao(
                "organizacao_inexistente_ou_inativa", "Organização inexistente ou inativa."
            )
        raise sem_permissao(
            "sem_vinculo_com_a_organizacao", "Você não pertence a esta organização."
        )
    return {"organization_id": data.organization_id, "refresh_required": True}


@router.post("", response_model=OrganizationOut, status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_platform_admin)])
def create_organization(data: OrganizationCreate):
    """Cria a organização e convida o dono por e-mail.

    Ordem importa: primeiro o convite (cria o usuário no auth), depois o
    provisionamento — que exige um auth_user existente. Se o provisionamento
    falhar, o usuário criado é removido para não deixar lixo no auth.
    """
    slug = _slugify(data.slug or data.name)

    existing = supabase_admin.table("organizations").select("id").eq("slug", slug).execute()
    if existing.data:
        raise conflito(
            "slug_de_organizacao_em_uso",
            f"Já existe uma organização com o identificador '{slug}'.",
            slug=slug,
        )

    base = settings.supabase_url
    headers = {
        "apikey": settings.supabase_service_key,
        "Authorization": f"Bearer {settings.supabase_service_key}",
        "Content-Type": "application/json",
    }

    # 1) Convite: o Supabase cria o usuário e manda o e-mail para ele DEFINIR a
    #    própria senha. A senha nunca passa por nós.
    auth_user_id = None
    invite_sent = False
    invite_error = None
    try:
        # `redirect_to` define para onde o link do e-mail leva. Sem ele, o
        # Supabase cai no "Site URL" do dashboard — que apontava para localhost,
        # deixando o convite inútil para o cliente. Mandamos o FRONTEND_URL do
        # ambiente (em produção, o domínio real).
        # ⚠️ A URL também precisa estar na allowlist de Redirect URLs do
        # Supabase; fora dela, ele ignora e volta a usar o Site URL.
        r = httpx.post(
            f"{base}/auth/v1/invite",
            headers=headers,
            json={
                "email": data.admin_email,
                # `organization_name` marca a conta como criada por convite: o
                # app usa isso (com `onboarded_at`) para exigir a definicao da
                # senha antes de liberar o sistema. `full_name` pre-preenche o
                # campo de nome na tela de cadastro.
                "data": {"organization_name": data.name, "full_name": data.admin_name},
                # O convite leva para a tela onde o dono DEFINE a própria senha.
                # Apontar para /login fazia o link autenticar direto (a sessão
                # vem no fragmento da URL), sem o cliente escolher a senha.
                "redirect_to": settings.frontend_url.rstrip("/") + "/definir-senha",
            },
            timeout=20,
        )
        if r.status_code in (200, 201):
            auth_user_id = r.json().get("id")
            invite_sent = True
        elif r.status_code == 429:
            # Limite de envio de e-mail do Supabase (SMTP padrão manda pouquíssimos
            # por hora). Mensagem explícita: sem isso o operador só via "erro".
            raise recusado(
                "limite_de_envio_de_email",
                "Limite de envio de e-mails do Supabase atingido. Configure um SMTP "
                "próprio em Authentication → Emails para convidar clientes sem limite, "
                "ou aguarde e tente novamente.",
            )
        elif r.status_code in (409, 422):
            # Usuário já existe no auth — reaproveita (o provisionamento recusa
            # se ele já pertencer a alguma organização).
            found = httpx.get(
                f"{base}/auth/v1/admin/users",
                headers=headers, params={"page": 1, "per_page": 200}, timeout=20,
            )
            for u in (found.json().get("users") or []):
                if (u.get("email") or "").lower() == data.admin_email.lower():
                    auth_user_id = u.get("id")
                    break
            invite_error = "Usuário já existia no sistema; vinculado sem novo convite."
        else:
            # A resposta CRUA do serviço de auth ia para a tela: inglês, JSON e
            # nenhuma ação possível para quem lê. Fica no log.
            logger.error(
                "Convite do administrador recusado (%s): %s", r.status_code, r.text[:500]
            )
            raise recusado(
                "falha_ao_convidar_administrador",
                "Não foi possível convidar o administrador. Confira o e-mail e tente de novo.",
            )
    except HTTPException:
        raise
    except Exception as exc:
        # `exc` pode trazer host, token e corpo da resposta do provedor — log.
        logger.error("Falha ao contatar o serviço de e-mail: %s", exc)
        raise erro_http(
            503,
            "servico_de_email_indisponivel",
            "Não foi possível contatar o serviço de e-mail. Tente novamente em instantes.",
        )

    if not auth_user_id:
        raise recusado(
            "administrador_nao_obtido",
            "Não foi possível obter o usuário do administrador.",
        )

    # 2) Provisionamento atômico da organização
    try:
        result = supabase_admin.rpc("provision_organization", {
            "p_org_name": data.name,
            "p_org_slug": slug,
            "p_auth_user": auth_user_id,
            "p_admin_name": data.admin_name,
            "p_admin_email": data.admin_email,
            "p_currency": data.currency.upper(),
            "p_plan": data.plan,
            "p_language": data.language,
        }).execute()
        org_id = result.data if isinstance(result.data, str) else (result.data or [None])[0]
    except Exception as exc:
        # Rollback do convite: sem organização, o usuário criado agora é lixo.
        if invite_sent:
            try:
                httpx.delete(f"{base}/auth/v1/admin/users/{auth_user_id}", headers=headers, timeout=20)
            except Exception:
                pass
        # A mensagem do Postgres (constraint, função, coluna) fica no log.
        logger.error("Falha ao provisionar a organização '%s': %s", slug, exc)
        raise recusado(
            "falha_ao_provisionar_organizacao",
            "Não foi possível criar a organização. Consulte o suporte.",
        )

    return OrganizationOut(
        id=str(org_id), name=data.name, slug=slug,
        admin_email=data.admin_email, invite_sent=invite_sent, invite_error=invite_error,
    )
