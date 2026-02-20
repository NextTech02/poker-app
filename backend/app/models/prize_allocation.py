from pydantic import BaseModel, Field
from typing import Optional, Literal
from datetime import datetime
from uuid import UUID
from decimal import Decimal

DocumentType = Literal['passport', 'national_id', 'driver_license']


class PrizeAllocationBase(BaseModel):
    position: int = Field(..., gt=0, description="Finishing position (1 = winner)")
    prize_amount: Decimal = Field(..., ge=0, description="Prize amount for this position")


class PrizeAllocationCreate(PrizeAllocationBase):
    """Request model for creating a prize allocation"""
    pass


class PrizeAllocationUpdate(BaseModel):
    position: Optional[int] = Field(None, gt=0)
    prize_amount: Optional[Decimal] = Field(None, ge=0)
    player_id: Optional[UUID] = None
    paid: Optional[bool] = None


class PrizePayoutRequest(BaseModel):
    """Request model for processing a prize payout with document verification"""
    player_id: UUID
    document_type: DocumentType
    document_number: str = Field(..., min_length=1, max_length=100)
    paid_by: Optional[str] = Field(None, max_length=255, description="Name of staff processing payment")


class PrizeAllocationResponse(BaseModel):
    id: UUID
    tournament_id: UUID
    position: int
    prize_amount: Decimal
    player_id: Optional[UUID] = None
    player_name: Optional[str] = None  # Joined from players table
    paid: bool = False
    paid_at: Optional[datetime] = None
    document_type: Optional[str] = None
    document_number: Optional[str] = None
    paid_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class PrizeAllocationBulkCreate(BaseModel):
    """Request model for bulk creating prize allocations"""
    allocations: list[PrizeAllocationCreate]


class PrizeSummary(BaseModel):
    """Summary of prize pool for a tournament (sum of all days)"""
    tournament_id: UUID
    guaranteed_prize: Decimal = Decimal("0")
    total_entries: Decimal = Decimal("0")  # Total buy-ins + rebuys + addons from ALL days
    rake_percentage: Decimal = Decimal("20")  # Default 20% (average of non-final days)
    player_pool: Decimal = Decimal("0")  # entries after rake
    available_prize_pool: Decimal = Decimal("0")  # guaranteed + player_pool
    total_allocated: Decimal = Decimal("0")  # Sum of all prize allocations
    remaining_balance: Decimal = Decimal("0")  # available - allocated
    allocations: list[PrizeAllocationResponse] = []
    has_qualifying_days: bool = False  # True if tournament has qualifying structure
