"""Gera links de convite e de recuperação de senha SEM o Supabase enviar nada.

`POST /auth/v1/admin/generate_link` existe exatamente para isto: "generates an
email link for a specific action without sending it". Quem envia o e-mail é o
app (`email_service.py`), no idioma de quem pediu — o template global do
painel do Supabase não sabe em que língua cada destinatário lê.

Semântica do GoTrue em que os chamadores se apoiam:

- `type=invite`: cria o usuário se não existe; se já existe CONFIRMADO,
  responde 422 (`email_exists`) — a mesma recusa que `/auth/v1/invite` dava;
  se existe mas nunca confirmou, emite um token novo (200).
- `type=recovery`: exige usuário existente (404 se não há); o link, ao ser
  clicado, confirma o usuário e leva à tela de senha. É o mecanismo que o
  reenvio de convite já usava em produção via `/recover`.

O redirect leva sempre para /definir-senha, que decide entre "concluir o
cadastro" e "trocar a senha" pelo `onboarded_at` da conta, não pelo tipo do
link. A URL precisa estar na allowlist de Redirect URLs do Supabase; fora dela
o GoTrue ignora e usa o Site URL.

Exceções do `httpx` sobem de propósito: cada chamador já tem o próprio
mapeamento ("serviço de e-mail indisponível", etc.).
"""
from typing import Literal, NamedTuple, Optional

import httpx

from app.config import get_settings


class LinkGerado(NamedTuple):
    status: int
    user_id: Optional[str]
    link: Optional[str]
    texto: str          # corpo cru da resposta, só para log


def gerar_link(tipo: Literal["invite", "recovery"], email: str, data: Optional[dict] = None) -> LinkGerado:
    settings = get_settings()
    base = settings.supabase_url.rstrip("/")
    corpo = {
        "type": tipo,
        "email": email,
        "redirect_to": settings.frontend_url.rstrip("/") + "/definir-senha",
    }
    if data:
        corpo["data"] = data

    r = httpx.post(
        f"{base}/auth/v1/admin/generate_link",
        headers={
            "apikey": settings.supabase_service_key,
            "Authorization": f"Bearer {settings.supabase_service_key}",
            "Content-Type": "application/json",
        },
        json=corpo,
        timeout=20,
    )

    user_id = link = None
    if r.status_code in (200, 201):
        try:
            payload = r.json() or {}
        except Exception:
            payload = {}
        # O GoTrue já devolveu esse payload em dois formatos ao longo das
        # versões (campos do usuário na raiz, ou aninhados em `user` com o
        # link em `properties`). Aceitar os dois evita que uma atualização
        # do Supabase quebre convites e recuperação de senha.
        user_id = payload.get("id") or (payload.get("user") or {}).get("id")
        link = payload.get("action_link") or (payload.get("properties") or {}).get("action_link")

    texto = ""
    try:
        texto = (r.text or "")[:500]
    except Exception:
        pass
    return LinkGerado(status=r.status_code, user_id=user_id, link=link, texto=texto)
