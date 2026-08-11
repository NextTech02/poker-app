from fastapi import APIRouter, HTTPException, status, Depends
from typing import List, Dict
from app.services.ranking_service import RankingService
from app.auth import get_current_user

router = APIRouter(prefix="/rankings", tags=["rankings"])


@router.get("/tournament/{tournament_id}", response_model=List[Dict])
def get_tournament_rankings(
    tournament_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get current rankings for a tournament"""
    try:
        return RankingService.get_tournament_rankings(tournament_id)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error fetching rankings: {str(e)}"
        )


@router.post("/tournament/{tournament_id}/recalculate", response_model=List[Dict])
def recalculate_rankings(
    tournament_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Manually recalculate rankings for a tournament"""
    try:
        return RankingService.calculate_rankings(tournament_id)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error recalculating rankings: {str(e)}"
        )


@router.delete("/tournament-player/{tournament_player_id}/ranking", status_code=status.HTTP_204_NO_CONTENT)
def remove_player_from_ranking(
    tournament_player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """
    Remove a player from ranking (used for rebuy after elimination).
    Automatically recalculates remaining rankings.
    """
    # O 404 fica FORA do try: dentro dele, o `except Exception` abaixo
    # capturava o próprio HTTPException (que é uma Exception) e o reescrevia
    # como 500 — remover alguém que não está no ranking devolvia "erro do
    # servidor" em vez de "não encontrado".
    try:
        success = RankingService.remove_from_ranking(tournament_player_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error removing from ranking: {str(e)}"
        )

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Player ranking not found"
        )
