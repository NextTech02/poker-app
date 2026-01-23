from fastapi import APIRouter, Depends, status
from typing import List
from uuid import UUID
from decimal import Decimal
from pydantic import BaseModel

from ..auth.jwt import get_current_user
from ..models.prize_allocation import (
    PrizeAllocationCreate,
    PrizeAllocationUpdate,
    PrizeAllocationResponse,
    PrizeAllocationBulkCreate,
    PrizeSummary
)
from ..services.prize_allocation_service import PrizeAllocationService

router = APIRouter(prefix="/tournaments", tags=["Prize Allocations"])


class GuaranteedPrizeUpdate(BaseModel):
    guaranteed_prize: Decimal


@router.get("/{tournament_id}/prizes/summary", response_model=PrizeSummary)
def get_prize_summary(
    tournament_id: UUID,
    current_user: dict = Depends(get_current_user)
):
    """
    Get complete prize summary for a tournament including:
    - Guaranteed prize
    - Total entries (buy-ins + rebuys + addons from ALL days)
    - Rake percentage (average from all days)
    - Player pool (80% of entries)
    - Available prize pool (max of guaranteed and player pool)
    - Total allocated
    - Remaining balance
    - List of all allocations
    """
    return PrizeAllocationService.get_prize_summary(tournament_id)


@router.get("/{tournament_id}/prizes", response_model=List[PrizeAllocationResponse])
def get_prize_allocations(
    tournament_id: UUID,
    current_user: dict = Depends(get_current_user)
):
    """Get all prize allocations for a tournament"""
    return PrizeAllocationService.get_allocations(tournament_id)


@router.post("/{tournament_id}/prizes", response_model=PrizeAllocationResponse, status_code=status.HTTP_201_CREATED)
def create_prize_allocation(
    tournament_id: UUID,
    allocation: PrizeAllocationCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new prize allocation for a specific position"""
    return PrizeAllocationService.create_allocation(tournament_id, allocation)


@router.post("/{tournament_id}/prizes/bulk", response_model=List[PrizeAllocationResponse], status_code=status.HTTP_201_CREATED)
def bulk_create_prize_allocations(
    tournament_id: UUID,
    bulk: PrizeAllocationBulkCreate,
    current_user: dict = Depends(get_current_user)
):
    """
    Bulk create/replace prize allocations for a tournament.
    This will delete all existing allocations and create new ones.
    """
    return PrizeAllocationService.bulk_create_allocations(tournament_id, bulk.allocations)


@router.patch("/{tournament_id}/prizes/{allocation_id}", response_model=PrizeAllocationResponse)
def update_prize_allocation(
    tournament_id: UUID,
    allocation_id: UUID,
    update: PrizeAllocationUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update an existing prize allocation"""
    return PrizeAllocationService.update_allocation(tournament_id, allocation_id, update)


@router.delete("/{tournament_id}/prizes/{allocation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_prize_allocation(
    tournament_id: UUID,
    allocation_id: UUID,
    current_user: dict = Depends(get_current_user)
):
    """Delete a prize allocation"""
    PrizeAllocationService.delete_allocation(tournament_id, allocation_id)
    return None


@router.patch("/{tournament_id}/guaranteed-prize", response_model=dict)
def update_guaranteed_prize(
    tournament_id: UUID,
    data: GuaranteedPrizeUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update the guaranteed prize for a tournament"""
    return PrizeAllocationService.update_guaranteed_prize(tournament_id, data.guaranteed_prize)
