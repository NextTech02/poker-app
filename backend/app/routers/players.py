from fastapi import APIRouter, Depends, HTTPException, status, Query
from typing import List, Optional
from app.models.player import PlayerCreate, PlayerUpdate, Player, PlayerStats
from app.services.player_service import PlayerService
from app.auth.jwt import get_current_user

router = APIRouter(prefix="/players", tags=["players"])


@router.post("", response_model=Player, status_code=status.HTTP_201_CREATED)
def create_player(
    player: PlayerCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new player"""
    return PlayerService.create_player(player)


@router.get("", response_model=List[Player])
def get_players(
    search: Optional[str] = Query(None, description="Search by name or nickname"),
    current_user: dict = Depends(get_current_user)
):
    """Get all players, optionally filtered by search term"""
    return PlayerService.get_players(search)


@router.get("/statistics", response_model=List[PlayerStats])
def get_player_statistics(
    player_id: Optional[str] = Query(None, description="Filter by player ID"),
    current_user: dict = Depends(get_current_user)
):
    """Get player statistics"""
    return PlayerService.get_player_statistics(player_id)


@router.get("/{player_id}", response_model=Player)
def get_player(
    player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get a specific player by ID"""
    player = PlayerService.get_player(player_id)
    if not player:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Player not found"
        )
    return player


@router.patch("/{player_id}", response_model=Player)
def update_player(
    player_id: str,
    player_data: PlayerUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update a player"""
    player = PlayerService.update_player(player_id, player_data)
    if not player:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Player not found"
        )
    return player


@router.delete("/{player_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_player(
    player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Delete a player"""
    success = PlayerService.delete_player(player_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Player not found"
        )
