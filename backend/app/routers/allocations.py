from fastapi import APIRouter, HTTPException, status, Depends
from typing import List, Dict
from app.models.seat_allocation import SeatAllocationCreate, SeatAllocationUpdate, SeatAllocationWithDetails
from app.services.allocation_service import AllocationService
from app.auth import get_current_user

router = APIRouter(prefix="/allocations", tags=["allocations"])


@router.post("/tournament/{tournament_id}/auto", response_model=SeatAllocationWithDetails, status_code=status.HTTP_201_CREATED)
def auto_allocate_player(
    tournament_id: str,
    player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Automatically allocate a player to an available seat"""
    try:
        return AllocationService.auto_allocate_player(tournament_id, player_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error allocating player: {str(e)}"
        )


@router.post("/tournament/{tournament_id}/manual", response_model=SeatAllocationWithDetails, status_code=status.HTTP_201_CREATED)
def manual_allocate_player(
    tournament_id: str,
    allocation_data: SeatAllocationCreate,
    current_user: dict = Depends(get_current_user)
):
    """Manually allocate a player to a specific seat"""
    try:
        return AllocationService.manual_allocate_player(
            tournament_id,
            allocation_data.player_id,
            allocation_data.table_id,
            allocation_data.seat_number
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error allocating player: {str(e)}"
        )


@router.get("/tournament/{tournament_id}", response_model=List[Dict])
def get_tournament_allocations(
    tournament_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get all seat allocations for a tournament"""
    return AllocationService.get_tournament_allocations(tournament_id)


@router.get("/tournament/{tournament_id}/unallocated", response_model=List[Dict])
def get_unallocated_players(
    tournament_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get list of players not yet allocated to seats"""
    return AllocationService.get_unallocated_players(tournament_id)


@router.get("/table/{table_id}")
def get_table_allocations(
    table_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get all allocations for a specific table"""
    return AllocationService.get_table_allocations(table_id)


@router.patch("/{allocation_id}", response_model=SeatAllocationWithDetails)
def update_allocation(
    allocation_id: str,
    update_data: SeatAllocationUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update a seat allocation (move player)"""
    try:
        return AllocationService.update_allocation(allocation_id, update_data)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.delete("/{allocation_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_allocation(
    allocation_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Remove a seat allocation"""
    success = AllocationService.remove_allocation(allocation_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Allocation not found"
        )


@router.get("/{allocation_id}", response_model=SeatAllocationWithDetails)
def get_allocation_details(
    allocation_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get detailed information about a specific allocation"""
    try:
        return AllocationService.get_allocation_with_details(allocation_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
