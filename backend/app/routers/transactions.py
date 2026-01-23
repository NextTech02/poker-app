from fastapi import APIRouter, Depends, HTTPException, status
from typing import List, Optional
from app.models.transaction import TransactionCreate, TransactionDetail
from app.services.transaction_service import TransactionService
from app.services.tournament_service import TournamentService
from app.auth.jwt import get_current_user
from app.dependencies import get_stage_id_optional

router = APIRouter(prefix="/transactions", tags=["transactions"])


@router.post("", response_model=TransactionDetail, status_code=status.HTTP_201_CREATED)
def create_transaction(
    transaction: TransactionCreate,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Create a new transaction (buy-in, rebuy, addon, prize).
    If X-Stage-ID header is present, validates that tournament belongs to that stage.
    """
    user_id = current_user.get("sub")

    # Validate tournament belongs to stage if stage_id is provided
    if stage_id:
        tournament = TournamentService.get_tournament(transaction.tournament_id)
        if not tournament:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Tournament not found"
            )
        if tournament.stage_id != stage_id:
            raise HTTPException(
                status_code=403,
                detail="Cannot create transaction: tournament does not belong to the selected stage"
            )

    return TransactionService.create_transaction(transaction, user_id)


@router.get("", response_model=List[TransactionDetail])
def get_transactions(
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get all transactions.
    If X-Stage-ID header is present, returns only transactions from tournaments in that stage.
    """
    return TransactionService.get_transactions(stage_id=stage_id)


@router.get("/tournament/{tournament_id}", response_model=List[TransactionDetail])
def get_tournament_transactions(
    tournament_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get transactions for a specific tournament.
    If X-Stage-ID header is present, validates that tournament belongs to that stage.
    """
    # Validate tournament belongs to stage if stage_id is provided
    if stage_id:
        tournament = TournamentService.get_tournament(tournament_id)
        if not tournament:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Tournament not found"
            )
        if tournament.stage_id != stage_id:
            raise HTTPException(
                status_code=403,
                detail="Tournament does not belong to the selected stage"
            )

    return TransactionService.get_transactions_by_tournament(tournament_id)


@router.get("/player/{player_id}", response_model=List[TransactionDetail])
def get_player_transactions(
    player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get transactions for a specific player"""
    return TransactionService.get_transactions_by_player(player_id)
