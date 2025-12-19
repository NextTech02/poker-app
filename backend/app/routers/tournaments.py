from fastapi import APIRouter, Depends, HTTPException, status
from typing import List, Optional
from app.models.tournament import TournamentCreate, TournamentUpdate, Tournament
from app.services.tournament_service import TournamentService
from app.auth.jwt import get_current_user

router = APIRouter(prefix="/tournaments", tags=["tournaments"])


@router.post("", response_model=Tournament, status_code=status.HTTP_201_CREATED)
def create_tournament(
    tournament: TournamentCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new tournament"""
    user_id = current_user.get("sub")
    return TournamentService.create_tournament(tournament, user_id)


@router.get("", response_model=List[Tournament])
def get_tournaments(status: Optional[str] = None, stage_id: Optional[str] = None):
    """Get all tournaments, optionally filtered by status (comma-separated) or stage_id"""
    return TournamentService.get_tournaments(status, stage_id)


@router.get("/{tournament_id}", response_model=Tournament)
def get_tournament(tournament_id: str):
    """Get a specific tournament by ID"""
    tournament = TournamentService.get_tournament(tournament_id)
    if not tournament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )
    return tournament


@router.patch("/{tournament_id}", response_model=Tournament)
def update_tournament(
    tournament_id: str,
    tournament_data: TournamentUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update a tournament"""
    tournament = TournamentService.update_tournament(tournament_id, tournament_data)
    if not tournament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )
    return tournament


@router.delete("/{tournament_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tournament(
    tournament_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Delete a tournament"""
    success = TournamentService.delete_tournament(tournament_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )
