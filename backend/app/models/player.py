from pydantic import BaseModel, Field, EmailStr
from typing import Optional, Literal
from datetime import datetime


class PlayerBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="Full name (required)")
    email: EmailStr = Field(..., description="Email address (required, unique)")
    phone: str = Field(..., min_length=1, max_length=50, description="Phone number with country code (required)")
    nationality: str = Field(..., min_length=1, max_length=100, description="Nationality/Country (required)")
    document_type: Literal['passport', 'national_id', 'driver_license'] = Field(..., description="Type of identification document")
    document_number: str = Field(..., min_length=1, max_length=100, description="Document number (required)")
    nickname: Optional[str] = Field(None, max_length=100, description="Player nickname (optional)")
    notes: Optional[str] = Field(None, description="Additional notes (optional)")


class PlayerCreate(PlayerBase):
    # Offline: id gerado no cliente (vira o PK; idempotência no replay).
    client_id: Optional[str] = Field(default=None, description="Client-generated player id (offline)")


class PlayerUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(None, max_length=50)
    nationality: Optional[str] = Field(None, max_length=100)
    document_type: Optional[Literal['passport', 'national_id', 'driver_license']] = None
    document_number: Optional[str] = Field(None, max_length=100)
    nickname: Optional[str] = Field(None, max_length=100)
    notes: Optional[str] = None


class Player(PlayerBase):
    id: str
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class PlayerStats(BaseModel):
    """Player statistics from view"""
    id: str
    name: str
    nickname: Optional[str] = None
    tournaments_played: int = 0
    total_buy_ins: int = 0
    total_rebuys: int = 0
    total_addons: int = 0
    total_spent: float = 0.0
    total_prizes: float = 0.0
    net_profit: float = 0.0
    first_places: int = 0
    top_3_finishes: int = 0
    avg_position: Optional[float] = None

    class Config:
        from_attributes = True
