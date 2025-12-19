from fastapi import APIRouter, Depends, status
from typing import List
from app.models.transaction import TransactionCreate, TransactionDetail
from app.services.transaction_service import TransactionService
from app.auth.jwt import get_current_user

router = APIRouter(prefix="/transactions", tags=["transactions"])


@router.post("", response_model=TransactionDetail, status_code=status.HTTP_201_CREATED)
def create_transaction(
    transaction: TransactionCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new transaction (buy-in, rebuy, addon, prize)"""
    user_id = current_user.get("sub")
    return TransactionService.create_transaction(transaction, user_id)


@router.get("", response_model=List[TransactionDetail])
def get_transactions(current_user: dict = Depends(get_current_user)):
    """Get all transactions"""
    return TransactionService.get_transactions()


@router.get("/tournament/{tournament_id}", response_model=List[TransactionDetail])
def get_tournament_transactions(
    tournament_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get transactions for a specific tournament"""
    return TransactionService.get_transactions_by_tournament(tournament_id)


@router.get("/player/{player_id}", response_model=List[TransactionDetail])
def get_player_transactions(
    player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get transactions for a specific player"""
    return TransactionService.get_transactions_by_player(player_id)
