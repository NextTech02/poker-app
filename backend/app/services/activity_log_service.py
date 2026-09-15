"""Log de acessos e atividade (tabela activity_logs).

A tabela tem duas famílias de linha:
  - acessos (login / logout / org.switch), gravados AQUI pelo backend;
  - auditoria de dados (<tabela>.insert|update|delete), gravada pela trigger
    `log_activity()` no banco — o backend só lê.

Tudo passa pela service_role (`supabase_admin`): a tabela não tem política de
RLS de propósito, para que ninguém consiga ler ou apagar a própria auditoria
pelo navegador. Em troca, CADA leitura aqui filtra pela organização explicitamente.

Regra de ouro: registrar nunca pode quebrar a operação. Todo erro de escrita
vira WARNING no log e some — um login que falha por causa do log de login seria
o pior resultado possível.
"""
import logging
import threading
from collections import OrderedDict
from datetime import datetime
from typing import Optional

from fastapi import Request

from app.database.supabase_client import supabase_admin

logger = logging.getLogger(__name__)

# Sessões cujo login já foi registrado por ESTE processo. É só um atalho para
# não tentar inserir a cada requisição: quem garante uma linha por sessão de
# verdade é o índice único parcial (o cache é por worker e some no restart).
_seen: "OrderedDict[str, None]" = OrderedDict()
_seen_lock = threading.Lock()
_SEEN_MAX = 5000


def _iso_end_of_day(date_str: str) -> str:
    return datetime.fromisoformat(date_str).replace(hour=23, minute=59, second=59).isoformat()


class ActivityLogService:
    EVENT_LOGIN = "login"
    EVENT_LOGOUT = "logout"
    EVENT_ORG_SWITCH = "org.switch"

    # ── Contexto da requisição ─────────────────────────────────────────────
    @staticmethod
    def client_ip(request: Optional[Request]) -> Optional[str]:
        """IP de quem chamou. Em produção o backend fica atrás do Cloudflare
        Tunnel, então `request.client.host` é o túnel — o IP real vem no
        `CF-Connecting-IP` (ou, em outro proxy, no primeiro `X-Forwarded-For`)."""
        if request is None:
            return None
        ip = request.headers.get("cf-connecting-ip")
        if not ip:
            forwarded = request.headers.get("x-forwarded-for") or ""
            ip = forwarded.split(",")[0].strip()
        if not ip and request.client:
            ip = request.client.host
        return (ip or None) and ip[:64]

    @staticmethod
    def user_agent(request: Optional[Request]) -> Optional[str]:
        if request is None:
            return None
        ua = request.headers.get("user-agent")
        return ua[:300] if ua else None

    # ── Escrita ────────────────────────────────────────────────────────────
    @staticmethod
    def touch_session(payload: dict, request: Optional[Request]) -> None:
        """Primeira requisição de uma sessão => linha de `login`.

        O login em si acontece no Supabase Auth, fora do backend; o que o
        backend vê é o primeiro token de cada sessão (claim `session_id`, que
        o refresh preserva). Registrar aqui, e não no frontend, é o que impede
        um cliente da API de entrar sem deixar rastro.
        """
        sid = payload.get("session_id")
        if not sid:
            return
        with _seen_lock:
            if sid in _seen:
                _seen.move_to_end(sid)
                return
            _seen[sid] = None
            while len(_seen) > _SEEN_MAX:
                _seen.popitem(last=False)
        ActivityLogService.record(
            ActivityLogService.EVENT_LOGIN, payload, request=request, session_id=sid
        )

    @staticmethod
    def record(
        event_type: str,
        payload: dict,
        *,
        request: Optional[Request] = None,
        organization_id: Optional[str] = None,
        session_id: Optional[str] = None,
        entity_table: Optional[str] = None,
        entity_id: Optional[str] = None,
        entity_label: Optional[str] = None,
        changes: Optional[dict] = None,
    ) -> None:
        """Grava um evento em nome do usuário do `payload` (claims do JWT)."""
        row = {
            "organization_id": organization_id or payload.get("organization_id"),
            "auth_user_id": payload.get("sub"),
            "user_email": payload.get("email"),
            "event_type": event_type,
            "session_id": session_id or payload.get("session_id"),
            "ip": ActivityLogService.client_ip(request),
            "user_agent": ActivityLogService.user_agent(request),
            "entity_table": entity_table,
            "entity_id": entity_id,
            "entity_label": entity_label,
            "changes": changes,
        }
        try:
            supabase_admin.table("activity_logs").insert(row).execute()
        except Exception as exc:  # noqa: BLE001 — registrar nunca derruba a operação
            # 23505 = outro worker (ou este, antes do restart) já gravou o login
            # desta sessão. É o caminho esperado, não um problema.
            if getattr(exc, "code", None) == "23505" or "duplicate key" in str(exc):
                return
            logger.warning("activity log falhou (%s): %s", event_type, exc)

    # ── Leitura ────────────────────────────────────────────────────────────
    @staticmethod
    def list(
        organization_id: str,
        *,
        user_id: Optional[str] = None,
        event_type: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        page: int = 1,
        page_size: int = 50,
    ) -> dict:
        """Página de eventos de UMA organização, do mais recente ao mais antigo.

        `event_type` aceita o valor exato ('login') ou o prefixo de uma tabela
        ('tournaments.*' => insert/update/delete dela).
        """
        q = (
            supabase_admin.table("activity_logs")
            .select("*", count="exact")
            .eq("organization_id", organization_id)
        )
        if user_id:
            q = q.eq("auth_user_id", user_id)
        if event_type:
            if event_type.endswith(".*"):
                q = q.like("event_type", f"{event_type[:-1]}%")
            else:
                q = q.eq("event_type", event_type)
        if date_from:
            q = q.gte("created_at", f"{date_from}T00:00:00")
        if date_to:
            q = q.lte("created_at", _iso_end_of_day(date_to))

        offset = (page - 1) * page_size
        res = q.order("created_at", desc=True).range(offset, offset + page_size - 1).execute()
        items = res.data or []
        total = res.count if getattr(res, "count", None) is not None else len(items)
        return {"items": items, "total": total, "page": page, "page_size": page_size}
