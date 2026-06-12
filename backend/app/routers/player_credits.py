from fastapi import APIRouter, HTTPException, Depends, Query
from typing import List, Optional
from app.models.player_credit import (
    PlayerCreditCreate,
    PlayerCreditResponse,
    CreditSettlementRequest,
    CreditTransactionResponse,
    PlayerBalanceSummary,
    PlayerStatementEntry,
)
from app.services.player_credit_service import PlayerCreditService
from app.auth.jwt import get_current_user
from app.dependencies import get_stage_id_optional

router = APIRouter(prefix="/player-credits", tags=["player-credits"])


# ================================================
# Credit Management
# ================================================

@router.post("", response_model=PlayerCreditResponse)
def grant_credit(data: PlayerCreditCreate, user=Depends(get_current_user)):
    try:
        return PlayerCreditService.grant_credit(data, user["id"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("", response_model=List[PlayerCreditResponse])
def get_all_credits(
    status: Optional[str] = None,
    sponsor_id: Optional[str] = None,
    stage_id: str = Depends(get_stage_id_optional),
    user=Depends(get_current_user),
):
    return PlayerCreditService.get_all_credits(
        status=status, stage_id=stage_id, sponsor_id=sponsor_id
    )


@router.get("/{credit_id}", response_model=PlayerCreditResponse)
def get_credit(credit_id: str, user=Depends(get_current_user)):
    credit = PlayerCreditService.get_credit(credit_id)
    if not credit:
        raise HTTPException(status_code=404, detail="Crédito não encontrado")
    return credit


@router.get("/{credit_id}/transactions", response_model=List[CreditTransactionResponse])
def get_credit_transactions(credit_id: str, user=Depends(get_current_user)):
    return PlayerCreditService.get_credit_transactions(credit_id)


@router.post("/{credit_id}/settle", response_model=PlayerCreditResponse)
def settle_credit(
    credit_id: str,
    data: CreditSettlementRequest,
    user=Depends(get_current_user),
):
    try:
        return PlayerCreditService.settle_sponsor_payment(credit_id, data, user["id"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{credit_id}/cancel", response_model=PlayerCreditResponse)
def cancel_credit(credit_id: str, user=Depends(get_current_user)):
    try:
        return PlayerCreditService.cancel_credit(credit_id, user["id"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ================================================
# Player-specific endpoints
# ================================================

@router.get("/player/{player_id}/credits", response_model=List[PlayerCreditResponse])
def get_player_credits(
    player_id: str,
    status: Optional[str] = None,
    stage_id: str = Depends(get_stage_id_optional),
    user=Depends(get_current_user),
):
    return PlayerCreditService.get_player_credits(
        player_id, status=status, stage_id=stage_id
    )


@router.get("/player/{player_id}/balance")
def get_player_balance(
    player_id: str,
    stage_id: str = Depends(get_stage_id_optional),
    user=Depends(get_current_user),
):
    available = PlayerCreditService.get_player_available_credit(player_id, stage_id=stage_id)
    return {"player_id": player_id, "available_credit": available}


@router.get("/player/{player_id}/summary", response_model=PlayerBalanceSummary)
def get_player_summary(player_id: str, user=Depends(get_current_user)):
    return PlayerCreditService.get_player_balance_summary(player_id)


@router.get("/player/{player_id}/statement", response_model=List[PlayerStatementEntry])
def get_player_statement(
    player_id: str,
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    type: Optional[str] = Query(None),
    tournament_id: Optional[str] = Query(None),
    user=Depends(get_current_user),
):
    return PlayerCreditService.get_player_statement(
        player_id,
        date_from=date_from,
        date_to=date_to,
        category=category,
        type_filter=type,
        tournament_id=tournament_id,
    )