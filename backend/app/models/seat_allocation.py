from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class SeatAllocationBase(BaseModel):
    tournament_id: str = Field(..., description="Tournament ID")
    tournament_day_id: Optional[str] = Field(None, description="Tournament Day ID (day-scoped allocations)")
    player_id: str = Field(..., description="Player ID")
    table_id: str = Field(..., description="Table ID")
    seat_number: int = Field(..., gt=0, le=10, description="Seat number at the table (1-10)")


class SeatAllocationCreate(BaseModel):
    player_id: str = Field(..., description="Player ID")
    table_id: str = Field(..., description="Table ID")
    seat_number: int = Field(..., gt=0, le=10, description="Seat number at the table (1-10)")


class SeatAllocationUpdate(BaseModel):
    table_id: Optional[str] = Field(None, description="Table ID")
    seat_number: Optional[int] = Field(None, gt=0, le=10, description="Seat number at the table (1-10)")


class SeatAllocation(SeatAllocationBase):
    id: str
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class SeatAllocationWithDetails(SeatAllocation):
    """Seat allocation with player and table details"""
    player_name: str
    table_number: int
    tournament_name: str
    day_name: Optional[str] = None
