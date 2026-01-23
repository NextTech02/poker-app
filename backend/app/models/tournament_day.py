from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from enum import Enum


class TournamentDayStatus(str, Enum):
    pending = "pending"
    active = "active"
    completed = "completed"
    cancelled = "cancelled"


class BlindIncreaseType(str, Enum):
    double = "double"
    triple = "triple"
    one_half = "1.5x"
    two_x = "2x"
    three_x = "3x"


class AllocationType(str, Enum):
    automatic = "automatic"
    manual = "manual"


class TournamentDayBase(BaseModel):
    """Base model for tournament day with configuration"""
    tournament_id: str = Field(..., description="Parent tournament ID")
    day_name: str = Field(..., min_length=1, max_length=255, description="Display name (e.g., 'Dia 1A', 'Dia 1B', 'Dia Final')")
    day_number: int = Field(default=1, gt=0, description="Sequential number for ordering")

    # Financial configuration
    buy_in: float = Field(..., gt=0)
    rebuy_amount: Optional[float] = Field(None, gt=0)
    addon_amount: Optional[float] = Field(None, gt=0)
    rake_percentage: float = Field(default=0, ge=0, le=100, description="Percentage that goes to house (0-100)")

    # Player limits
    max_players: int = Field(..., gt=0)

    # Chip configuration
    starting_chips: int = Field(default=10000, gt=0)
    rebuy_chips: int = Field(default=10000, gt=0)
    addon_chips: int = Field(default=10000, gt=0)

    # Blind structure
    blind_duration: int = Field(default=15, gt=0, description="Duration in minutes")
    initial_small_blind: int = Field(default=50, gt=0)
    initial_big_blind: int = Field(default=100, gt=0)
    blind_increase_type: BlindIncreaseType = Field(default=BlindIncreaseType.double)
    bb_ante_start_level: int = Field(default=3, gt=0, description="Level when BB ante starts")
    rebuy_level_limit: Optional[int] = Field(None, description="Max level for rebuys (NULL = unlimited)")

    # Break configuration
    break_interval: int = Field(default=60, gt=0, description="Minutes between breaks")
    break_duration: int = Field(default=10, gt=0, description="Break duration in minutes")

    # Allocation
    allocation_type: AllocationType = Field(default=AllocationType.automatic)

    # Date/time
    tournament_date: Optional[datetime] = None


class TournamentDayCreate(TournamentDayBase):
    """Model for creating a new tournament day"""
    pass


class TournamentDayUpdate(BaseModel):
    """Model for updating an existing tournament day"""
    day_name: Optional[str] = Field(None, min_length=1, max_length=255)
    day_number: Optional[int] = Field(None, gt=0)
    status: Optional[TournamentDayStatus] = None
    buy_in: Optional[float] = Field(None, gt=0)
    rebuy_amount: Optional[float] = Field(None, gt=0)
    addon_amount: Optional[float] = Field(None, gt=0)
    rake_percentage: Optional[float] = Field(None, ge=0, le=100)
    max_players: Optional[int] = Field(None, gt=0)
    starting_chips: Optional[int] = Field(None, gt=0)
    rebuy_chips: Optional[int] = Field(None, gt=0)
    addon_chips: Optional[int] = Field(None, gt=0)
    blind_duration: Optional[int] = Field(None, gt=0)
    initial_small_blind: Optional[int] = Field(None, gt=0)
    initial_big_blind: Optional[int] = Field(None, gt=0)
    blind_increase_type: Optional[BlindIncreaseType] = None
    bb_ante_start_level: Optional[int] = Field(None, gt=0)
    rebuy_level_limit: Optional[int] = None
    break_interval: Optional[int] = Field(None, gt=0)
    break_duration: Optional[int] = Field(None, gt=0)
    allocation_type: Optional[AllocationType] = None
    tournament_date: Optional[datetime] = None


class TournamentDay(TournamentDayBase):
    """Complete tournament day model with all fields"""
    id: str
    status: TournamentDayStatus = TournamentDayStatus.pending
    registered_players: int = 0
    total_entries: int = 0  # buy-ins + rebuys (addons not counted)
    prize_pool: float = 0.0
    start_time: Optional[datetime] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class TournamentDaySummary(BaseModel):
    """Tournament day with aggregated statistics"""
    id: str
    tournament_id: str
    day_name: str
    day_number: int
    status: TournamentDayStatus
    buy_in: float
    registered_players: int
    max_players: int
    prize_pool: float
    tournament_date: Optional[datetime]
    total_entries: int = 0
    total_buy_ins: int = 0
    total_rebuys: int = 0
    total_addons: int = 0
    created_at: datetime

    class Config:
        from_attributes = True
