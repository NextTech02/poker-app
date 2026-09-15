"""Log de acessos e atividade da organização do usuário.

Leitura: permissão `access_log` (concedida ao grupo Admin de cada clube no
backfill; o clube pode dar ou tirar pela tela de Funcionários). O log mostra o
que cada funcionário fez — não é assunto de quem só opera o caixa. A org vem do
claim do JWT, nunca de parâmetro. O platform_admin consulta qualquer org por
`GET /organizations/{org_id}/activity-logs`.
"""
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request, Response

from app.auth.jwt import get_current_user
from app.auth.permissions import require_permission
from app.dependencies import get_org_id
from app.services.activity_log_service import ActivityLogService

router = APIRouter(prefix="/activity-logs", tags=["activity-logs"])

# Os filtros viram trechos de query no PostgREST; validar o formato aqui é o
# que impede um valor estranho de virar 500 (ou pior) lá.
EVENT_TYPE_PATTERN = r"^[a-z_]+(\.[a-z_*]+)?$"
DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"


@router.get("", dependencies=[Depends(require_permission("access_log"))])
def list_activity_logs(
    org_id: str = Depends(get_org_id),
    user_id: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None, pattern=EVENT_TYPE_PATTERN),
    date_from: Optional[str] = Query(None, pattern=DATE_PATTERN),
    date_to: Optional[str] = Query(None, pattern=DATE_PATTERN),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
):
    return ActivityLogService.list(
        org_id,
        user_id=user_id,
        event_type=event_type,
        date_from=date_from,
        date_to=date_to,
        page=page,
        page_size=page_size,
    )


@router.post("/logout", status_code=204)
def register_logout(request: Request, current_user: dict = Depends(get_current_user)):
    """Chamado pelo frontend logo antes de encerrar a sessão no Supabase.

    É "melhor esforço": fechar a aba não passa por aqui, então a ausência de
    logout não quer dizer que a pessoa continua dentro."""
    ActivityLogService.record(ActivityLogService.EVENT_LOGOUT, current_user, request=request)
    return Response(status_code=204)
