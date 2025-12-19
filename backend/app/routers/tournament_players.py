from fastapi import APIRouter, Depends, HTTPException, status
from typing import List
from app.models.tournament_player import (
    TournamentPlayerCreate,
    TournamentPlayerUpdate,
    TournamentPlayer,
    TournamentPlayerDetail
)
from app.services.tournament_player_service import TournamentPlayerService
from app.auth.jwt import get_current_user

router = APIRouter(prefix="/tournament-players", tags=["tournament-players"])


@router.post("", response_model=TournamentPlayerDetail, status_code=status.HTTP_201_CREATED)
def register_player(
    registration: TournamentPlayerCreate,
    current_user: dict = Depends(get_current_user)
):
    """Register a player for a tournament"""
    user_id = current_user.get("sub")
    try:
        return TournamentPlayerService.register_player(registration, user_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )


@router.post("/{tournament_player_id}/rebuy", response_model=TournamentPlayer)
def add_rebuy(
    tournament_player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Add a rebuy for a tournament player"""
    user_id = current_user.get("sub")
    try:
        return TournamentPlayerService.add_rebuy(tournament_player_id, user_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )


@router.post("/{tournament_player_id}/addon", response_model=TournamentPlayer)
def add_addon(
    tournament_player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Add an add-on for a tournament player"""
    user_id = current_user.get("sub")
    try:
        return TournamentPlayerService.add_addon(tournament_player_id, user_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )


@router.get("/tournament/{tournament_id}", response_model=List[TournamentPlayerDetail])
def get_tournament_players(
    tournament_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get all players in a tournament"""
    return TournamentPlayerService.get_tournament_players(tournament_id)


@router.patch("/{tournament_player_id}", response_model=TournamentPlayer)
def update_tournament_player(
    tournament_player_id: str,
    update_data: TournamentPlayerUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update tournament player (position, prize, status, etc.)"""
    result = TournamentPlayerService.update_tournament_player(tournament_player_id, update_data)
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament player not found"
        )
    return result


@router.post("/{tournament_player_id}/eliminate", response_model=TournamentPlayer)
def eliminate_player(
    tournament_player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Eliminate a player from the tournament (mark as eliminated)"""
    user_id = current_user.get("sub")
    try:
        return TournamentPlayerService.eliminate_player(tournament_player_id, user_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
