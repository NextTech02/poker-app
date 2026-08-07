"""Cadastro de organizações (clientes do SaaS).

Onboarding B2B: a NextHub cadastra o clube e convida o dono por e-mail. Não é
auto-cadastro público — quem acessa é apenas o `platform_admin`.

A criação em si é feita pela função `provision_organization` no banco, que roda
tudo numa transação (org + grupos + staff admin + moeda + caixa geral + rake +
formas de pagamento). Assim um cliente nunca nasce pela metade.
"""
import re
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from app.auth.jwt import get_current_user
from app.config import get_settings
from app.database.supabase_client import supabase_admin

router = APIRouter(prefix="/organizations", tags=["organizations"])
settings = get_settings()


def require_platform_admin(user: dict = Depends(get_current_user)) -> dict:
    """Só a NextHub cadastra clientes.

    A checagem é no SERVIDOR, a partir do claim assinado — esconder o menu no
    frontend não é segurança, qualquer um poderia chamar a API na mão.
    """
    if user.get("platform_admin") is not True:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Apenas administradores da plataforma podem cadastrar organizações.",
        )
    return user


class OrganizationCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    slug: Optional[str] = Field(None, max_length=60)
    admin_name: str = Field(..., min_length=2, max_length=120)
    admin_email: EmailStr
    currency: str = Field("BRL", min_length=3, max_length=3)
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
        raise HTTPException(status_code=404, detail="Organização não encontrada.")

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
        raise HTTPException(status_code=404, detail="Organização não encontrada.")
    plan = supabase_admin.table("plans").select("*").eq("code", data.plan_code).execute()
    if not plan.data:
        raise HTTPException(status_code=400, detail=f"Plano '{data.plan_code}' inválido.")
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
        raise HTTPException(status_code=404, detail="Organização não encontrada.")

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
            raise HTTPException(status_code=409, detail="Suspenda a organização antes de excluí-la.")
        if "não encontrada" in msg or "nao encontrada" in msg:
            raise HTTPException(status_code=404, detail="Organização não encontrada.")
        raise HTTPException(status_code=400, detail=f"Falha ao excluir a organização: {msg}")


# ── Multi-organização: o mesmo usuário pode pertencer a vários clubes ────────

@router.get("/mine")
def my_organizations(current_user: dict = Depends(get_current_user)):
    """Organizações às quais o usuário logado pertence (para o seletor)."""
    res = supabase_admin.rpc("list_my_organizations", {"p_user": current_user.get("sub")}).execute()
    return res.data or []


class SwitchOrgRequest(BaseModel):
    organization_id: str


@router.post("/switch")
def switch_organization(data: SwitchOrgRequest, current_user: dict = Depends(get_current_user)):
    """Troca a organização ativa do usuário.

    Grava a escolha; o CLAIM só muda no próximo token, então o frontend precisa
    chamar `supabase.auth.refreshSession()` depois. É de propósito: o RLS confia
    no claim assinado, não em nada que o cliente envie — aceitar a organização
    por header seria o mesmo buraco do X-Stage-ID.

    A função no banco valida o vínculo: não dá para "trocar" para um clube do
    qual você não faz parte.
    """
    try:
        supabase_admin.rpc("set_active_organization", {
            "p_user": current_user.get("sub"),
            "p_org": data.organization_id,
        }).execute()
    except Exception as exc:
        raise HTTPException(status_code=403, detail="Você não pertence a esta organização.")
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
        raise HTTPException(status_code=409, detail=f"Já existe uma organização com o identificador '{slug}'.")

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
            raise HTTPException(
                status_code=400,
                detail=(
                    "Limite de envio de e-mails do Supabase atingido. Configure um SMTP "
                    "próprio em Authentication → Emails para convidar clientes sem limite, "
                    "ou aguarde e tente novamente."
                ),
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
            raise HTTPException(status_code=400, detail=f"Falha ao convidar o administrador: {r.text[:200]}")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Falha ao contatar o serviço de e-mail: {exc}")

    if not auth_user_id:
        raise HTTPException(status_code=400, detail="Não foi possível obter o usuário do administrador.")

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
        }).execute()
        org_id = result.data if isinstance(result.data, str) else (result.data or [None])[0]
    except Exception as exc:
        # Rollback do convite: sem organização, o usuário criado agora é lixo.
        if invite_sent:
            try:
                httpx.delete(f"{base}/auth/v1/admin/users/{auth_user_id}", headers=headers, timeout=20)
            except Exception:
                pass
        raise HTTPException(status_code=400, detail=f"Falha ao provisionar a organização: {exc}")

    return OrganizationOut(
        id=str(org_id), name=data.name, slug=slug,
        admin_email=data.admin_email, invite_sent=invite_sent, invite_error=invite_error,
    )
