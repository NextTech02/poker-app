from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from enum import Enum


class TournamentStatus(str, Enum):
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


class TournamentBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    stage_id: Optional[str] = Field(None, description="Stage/Etapa ID")
    buy_in: float = Field(..., gt=0)
    rebuy_amount: Optional[float] = Field(None, gt=0)
    addon_amount: Optional[float] = Field(None, gt=0)
    max_players: int = Field(..., gt=0)
    blind_duration: int = Field(default=15, gt=0)
    starting_chips: int = Field(default=10000, gt=0)
    rebuy_chips: int = Field(default=10000, gt=0)
    addon_chips: int = Field(default=10000, gt=0)
    tournament_date: Optional[datetime] = None
    rebuy_level_limit: Optional[int] = Field(None, description="Maximum blind level where rebuys are allowed (NULL = unlimited)")
    rake_percentage: float = Field(default=0, ge=0, le=100, description="Percentage of entries that goes to the house (0-100). Rest goes to prize pool.")
    # Blind structure configuration
    initial_small_blind: int = Field(default=50, gt=0)
    initial_big_blind: int = Field(default=100, gt=0)
    blind_increase_type: BlindIncreaseType = Field(default=BlindIncreaseType.double)
    bb_ante_start_level: int = Field(default=3, gt=0)
    break_interval: int = Field(default=60, gt=0)  # Minutes between breaks
    break_duration: int = Field(default=10, gt=0)  # Duration of breaks in minutes
    allocation_type: AllocationType = Field(default=AllocationType.automatic, description="Player allocation type: automatic or manual")


class TournamentCreate(TournamentBase):
    pass


class TournamentUpdate(BaseModel):
    name: Optional[str] = None
    stage_id: Optional[str] = None
    status: Optional[TournamentStatus] = None
    buy_in: Optional[float] = None
    rebuy_amount: Optional[float] = None
    addon_amount: Optional[float] = None
    max_players: Optional[int] = None
    tournament_date: Optional[datetime] = None
    rebuy_level_limit: Optional[int] = Field(None, description="Maximum blind level where rebuys are allowed (NULL = unlimited)")


class Tournament(TournamentBase):
    id: str
    status: TournamentStatus
    registered_players: int = 0
    prize_pool: float = 0.0
    start_time: Optional[datetime] = None
    created_by: str
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class TournamentSummary(BaseModel):
    """Tournament with player statistics"""
    id: str
    name: str
    status: TournamentStatus
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
