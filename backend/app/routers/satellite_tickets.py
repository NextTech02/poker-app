from fastapi import APIRouter, HTTPException, Depends, Query
from typing import List, Optional
from app.models.satellite_ticket import (
    TicketCreate,
    TicketResponse,
    TicketRedeem,
    TicketSummary,
)
from app.services.satellite_ticket_service import SatelliteTicketService
from app.auth.jwt import get_current_user
from app.dependencies import get_stage_id_optional

router = APIRouter(prefix="/satellite-tickets", tags=["satellite-tickets"])


# ── Create Ticket ──

@router.post("", response_model=TicketResponse)
def create_ticket(data: TicketCreate, user=Depends(get_current_user)):
    try:
        return SatelliteTicketService.create_ticket(data, user.get("id") or user["sub"])
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
    stage_id: str = Depends(get_stage_id_optional),
    user=Depends(get_current_user),
):
    return SatelliteTicketService.get_all_tickets(
        stage_id=stage_id,
        status=status,
        target_tournament_id=target_tournament_id,
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


# ── Redeem & Cancel ──

@router.post("/{ticket_id}/redeem")
def redeem_ticket(ticket_id: str, data: TicketRedeem, user=Depends(get_current_user)):
    try:
        return SatelliteTicketService.redeem_ticket(ticket_id, data.funded_by, user.get("id") or user["sub"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{ticket_id}/cancel", response_model=TicketResponse)
def cancel_ticket(ticket_id: str, user=Depends(get_current_user)):
    try:
        return SatelliteTicketService.cancel_ticket(ticket_id, user.get("id") or user["sub"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
