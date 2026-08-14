from fastapi import APIRouter, HTTPException, Depends, Query
from typing import List, Optional
from app.models.satellite_ticket import (
    TicketBulkCreate,
    TicketBulkResult,
    TicketCreate,
    TicketResponse,
    TicketRedeem,
    TicketSummary,
    TicketTransfer,
    TicketTransferEntry,
)
from app.services.satellite_ticket_service import SatelliteTicketService
from app.auth.jwt import get_current_user
from app.auth.permissions import require_permission
from app.dependencies import get_stage_id_optional, get_org_id_optional

router = APIRouter(prefix="/satellite-tickets", tags=["satellite-tickets"])

# Quem opera ticket no dia a dia. Antes bastava um JWT válido: esconder o botão
# no frontend não impedia ninguém de chamar a API e emitir uma entrada paga.
TICKET_PERMS = ("cashier_tickets", "cashier", "employees")

# Emitir em LOTE é operação de dono: um erro multiplica o prejuízo por 40 e o
# caixa não desfaz sozinho. `employees` entra junto porque é o que o grupo
# 'Admin' já tem hoje — assim o dono não fica trancado antes do backfill da
# migração database_migration_ticket_master_permission.sql.
MASTER_PERMS = ("cashier_tickets.master", "employees")


# ── Create Ticket ──

@router.post(
    "",
    response_model=TicketResponse,
    responses={
        400: {
            "description": (
                "Não dá para emitir o ticket: torneio alvo, dia alvo ou jogador não "
                "encontrado, ou o dia informado não pertence ao torneio alvo."
            )
        },
    },
)
def create_ticket(data: TicketCreate, user=Depends(require_permission(*TICKET_PERMS))):
    try:
        return SatelliteTicketService.create_ticket(data, user.get("id") or user["sub"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/bulk", response_model=TicketBulkResult)
def create_tickets_bulk(
    data: TicketBulkCreate,
    user=Depends(require_permission(*MASTER_PERMS)),
):
    """Emite a mesma vaga para vários jogadores de uma vez (só o 'master')."""
    try:
        return SatelliteTicketService.create_tickets_bulk(data, user.get("id") or user["sub"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Query Tickets ──

@router.get("/summary", response_model=TicketSummary)
def get_summary(
    stage_id: str = Depends(get_stage_id_optional),
    user=Depends(get_current_user),
):
    return SatelliteTicketService.get_summary(stage_id=stage_id)


@router.get("", response_model=List[TicketResponse])
def get_all_tickets(
    status: Optional[str] = None,
    target_tournament_id: Optional[str] = None,
    player_id: Optional[str] = None,
    stage_id: str = Depends(get_stage_id_optional),
    user=Depends(get_current_user),
):
    return SatelliteTicketService.get_all_tickets(
        stage_id=stage_id,
        status=status,
        target_tournament_id=target_tournament_id,
        player_id=player_id,
    )


@router.get("/available", response_model=List[TicketResponse])
def get_available_tickets(
    target_tournament_id: Optional[str] = Query(None),
    user=Depends(get_current_user),
):
    return SatelliteTicketService.get_available_tickets(
        target_tournament_id=target_tournament_id,
    )


@router.get("/{ticket_id}", response_model=TicketResponse)
def get_ticket(ticket_id: str, user=Depends(get_current_user)):
    ticket = SatelliteTicketService.get_ticket(ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket não encontrado")
    return ticket


@router.get("/{ticket_id}/transfers", response_model=List[TicketTransferEntry])
def list_transfers(ticket_id: str, user=Depends(get_current_user)):
    return SatelliteTicketService.list_transfers(ticket_id)


# ── Redeem, Transfer & Cancel ──

@router.post("/{ticket_id}/redeem")
def redeem_ticket(
    ticket_id: str,
    data: TicketRedeem,
    user=Depends(require_permission(*TICKET_PERMS)),
):
    try:
        return SatelliteTicketService.redeem_ticket(ticket_id, data.funded_by, user.get("id") or user["sub"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post(
    "/{ticket_id}/transfer",
    response_model=TicketResponse,
    responses={
        400: {
            "description": (
                "Transferência recusada: ticket não encontrado, já resgatado, jogador "
                "de destino não informado/inexistente ou igual ao dono atual. Quando é "
                "venda (amount > 0), também 400 se não houver etapa selecionada ou "
                "organização vinculada para lançar a venda no caixa."
            )
        },
    },
)
def transfer_ticket(
    ticket_id: str,
    data: TicketTransfer,
    user=Depends(require_permission(*TICKET_PERMS)),
    org_id: Optional[str] = Depends(get_org_id_optional),
    stage_id: Optional[str] = Depends(get_stage_id_optional),
):
    """Transfere (amount = 0) ou vende (amount > 0) o ticket para outro jogador."""
    try:
        return SatelliteTicketService.transfer_ticket(
            ticket_id, data, user.get("id") or user["sub"],
            org_id=org_id, stage_id=stage_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{ticket_id}/cancel", response_model=TicketResponse)
def cancel_ticket(ticket_id: str, user=Depends(require_permission(*TICKET_PERMS))):
    try:
        return SatelliteTicketService.cancel_ticket(ticket_id, user.get("id") or user["sub"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
