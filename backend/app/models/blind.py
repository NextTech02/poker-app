from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from uuid import UUID


class BlindBase(BaseModel):
    level: int = Field(..., gt=0, description="Blind level number (must be positive)")
    small_blind: int = Field(..., gt=0, description="Small blind amount (must be positive)")
    big_blind: int = Field(..., gt=0, description="Big blind amount (must be positive)")
    ante: int = Field(default=0, ge=0, description="Ante amount (0 or positive)")
    duration: int = Field(default=15, gt=0, description="Duration in minutes (must be positive)")


class BlindCreateRequest(BlindBase):
    """Request model for creating a blind (tournament_id comes from URL)"""
    pass


class BlindCreate(BlindBase):
    """Internal model for blind creation with tournament_id"""
    tournament_id: UUID = Field(..., description="UUID of the tournament")


class BlindUpdate(BaseModel):
    level: Optional[int] = Field(None, gt=0, description="Blind level number")
    small_blind: Optional[int] = Field(None, gt=0, description="Small blind amount")
    big_blind: Optional[int] = Field(None, gt=0, description="Big blind amount")
    ante: Optional[int] = Field(None, ge=0, description="Ante amount")
    duration: Optional[int] = Field(None, gt=0, description="Duration in minutes")


class BlindResponse(BlindBase):
    id: UUID
    tournament_id: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
