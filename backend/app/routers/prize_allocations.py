from fastapi import APIRouter, Depends, status
from typing import List, Optional
from uuid import UUID
from decimal import Decimal
from pydantic import BaseModel

from ..auth.jwt import get_current_user
from ..models.prize_allocation import (
    PrizeAllocationCreate,
    PrizeRangeCreate,
    PrizeAllocationUpdate,
    PrizeAllocationResponse,
    PrizeAllocationBulkCreate,
    PrizePayoutRequest,
    PrizeSummary
)
from ..services.prize_allocation_service import PrizeAllocationService

router = APIRouter(prefix="/tournaments", tags=["Prize Allocations"])


class GuaranteedPrizeUpdate(BaseModel):
    guaranteed_prize: Decimal


class ReleaseUpdate(BaseModel):
    released: bool = True


class ReservedPrizeUpdate(BaseModel):
    reserved_prize_percentage: Decimal
    reserved_purpose: Optional[str] = None  # 'ranking' | 'staff' | None


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


@router.post("/{tournament_id}/prizes/range", response_model=List[PrizeAllocationResponse], status_code=status.HTTP_201_CREATED)
def create_prize_range(
    tournament_id: UUID,
    faixa: PrizeRangeCreate,
    current_user: dict = Depends(get_current_user)
):
    """Cria uma FAIXA de colocações (ex.: 7 a 9) com o mesmo prêmio: uma
    linha por posição, numa inserção só. Qualquer posição já ocupada recusa
    o lote inteiro (400 `posicao_de_premio_duplicada`, com `posicoes`)."""
    return PrizeAllocationService.create_range(tournament_id, faixa)


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


@router.get("/{tournament_id}/prizes/pool")
def get_prize_pool(
    tournament_id: UUID,
    current_user: dict = Depends(get_current_user)
):
    """Get prize pool breakdown for a tournament"""
    return PrizeAllocationService.get_tournament_prize_pool(tournament_id)


@router.post("/{tournament_id}/prizes/{allocation_id}/pay", response_model=PrizeAllocationResponse)
def pay_prize(
    tournament_id: UUID,
    allocation_id: UUID,
    payout: PrizePayoutRequest,
    current_user: dict = Depends(get_current_user)
):
    """
    Process prize payout with financial integration.
    - Validates prize pool limit and general cash balance.
    - Deducts from general cash register.
    - Creates transaction record.
    - Marks allocation as paid with document info.
    """
    return PrizeAllocationService.pay_prize(
        tournament_id, allocation_id, payout, user_id=current_user.get("sub")
    )


@router.patch("/{tournament_id}/guaranteed-prize", response_model=dict)
def update_guaranteed_prize(
    tournament_id: UUID,
    data: GuaranteedPrizeUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update the guaranteed prize for a tournament"""
    return PrizeAllocationService.update_guaranteed_prize(tournament_id, data.guaranteed_prize)


@router.patch("/{tournament_id}/prizes/{allocation_id}/release", response_model=PrizeAllocationResponse)
def release_prize_allocation(
    tournament_id: UUID,
    allocation_id: UUID,
    data: ReleaseUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Release (or revoke release of) a prize for payment (feature 4.3: aba de liberação)."""
    return PrizeAllocationService.set_released(
        tournament_id, allocation_id, data.released, user_id=current_user.get("sub")
    )


@router.patch("/{tournament_id}/reserved-prize", response_model=dict)
def update_reserved_prize(
    tournament_id: UUID,
    data: ReservedPrizeUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update reserved prize % and purpose for a tournament (feature 4.1)."""
    return PrizeAllocationService.update_reserved_config(
        tournament_id, data.reserved_prize_percentage, data.reserved_purpose
    )
