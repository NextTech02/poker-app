"""Cadastro de organizações (clientes do SaaS).

Onboarding B2B: a NextHub cadastra o clube e convida o dono por e-mail. Não é
auto-cadastro público — quem acessa é apenas o `platform_admin`.

A criação em si é feita pela função `provision_organization` no banco, que roda
tudo numa transação (org + grupos + staff admin + moeda + caixa geral + rake +
formas de pagamento). Assim um cliente nunca nasce pela metade.
"""
import re
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


@router.get("", dependencies=[Depends(require_platform_admin)])
def list_organizations():
    """Lista as organizações com uma contagem básica de uso."""
    orgs = supabase_admin.table("organizations").select("*").order("created_at").execute().data or []
    staff = supabase_admin.table("staff").select("organization_id, active").execute().data or []
    counts: dict = {}
    for s in staff:
        counts[s["organization_id"]] = counts.get(s["organization_id"], 0) + 1
    for o in orgs:
        o["staff_count"] = counts.get(o["id"], 0)
    return orgs


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
                "data": {"organization_name": data.name},
                "redirect_to": settings.frontend_url.rstrip("/") + "/login",
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
