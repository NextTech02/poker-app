from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class TableBase(BaseModel):
    tournament_id: str = Field(..., description="Tournament ID")
    table_number: int = Field(..., gt=0, description="Table number")
    seats: int = Field(..., gt=0, le=10, description="Number of seats at this table (max 10)")
    status: str = Field(default='active', description="Table status: active, broken, closed")


class TableCreate(BaseModel):
    table_number: int = Field(..., gt=0, description="Table number")
    seats: int = Field(..., gt=0, le=10, description="Number of seats at this table (max 10)")


class TableUpdate(BaseModel):
    table_number: Optional[int] = Field(None, gt=0)
    seats: Optional[int] = Field(None, gt=0, le=10)
    status: Optional[str] = None


class Table(TableBase):
    id: str
    occupied_seats: int = Field(default=0, description="Number of occupied seats")
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class TableWithPlayers(Table):
    """Table with player information"""
    players: list = Field(default_factory=list, description="List of players at this table")

    class Config:
        from_attributes = True
