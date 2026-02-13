from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from enum import Enum


class TournamentPlayerStatus(str, Enum):
    registered = "registered"
    active = "active"
    eliminated = "eliminated"
    winner = "winner"


class TournamentPlayerBase(BaseModel):
    tournament_id: str
    player_id: str
    buy_in_count: int = Field(default=1, ge=0)
    rebuy_count: int = Field(default=0, ge=0)
    addon_count: int = Field(default=0, ge=0)
    total_buy_in_amount: float = Field(default=0, ge=0)
    total_rebuy_amount: float = Field(default=0, ge=0)
    total_addon_amount: float = Field(default=0, ge=0)
    total_chips: int = Field(default=0, ge=0)
    notes: Optional[str] = None


class TournamentPlayerCreate(BaseModel):
    """Create a player entry in a tournament day"""
    tournament_id: str
    tournament_day_id: Optional[str] = None  # Required for day-based tournaments
    player_id: str
    buy_in_count: int = Field(default=1, ge=1)
    notes: Optional[str] = None


class TournamentPlayerUpdate(BaseModel):
    """Update tournament player entry"""
    rebuy_count: Optional[int] = None
    addon_count: Optional[int] = None
    final_position: Optional[int] = None
    prize_won: Optional[float] = None
    status: Optional[TournamentPlayerStatus] = None
    notes: Optional[str] = None
    final_chip_count: Optional[int] = None  # Chips at end of day


class TournamentPlayer(TournamentPlayerBase):
    id: str
    tournament_day_id: Optional[str] = None
    total_spent: float
    final_position: Optional[int] = None
    prize_won: float = 0.0
    eliminated_at: Optional[datetime] = None
    status: TournamentPlayerStatus
    registered_at: datetime
    # Qualifying days support
    final_chip_count: Optional[int] = None  # Chips at end of day
    qualified_from_day_id: Optional[str] = None  # Which day player qualified from
    is_qualified_entry: bool = False  # True if entry via qualification (no buy-in)

    class Config:
        from_attributes = True


class TournamentPlayerDetail(TournamentPlayer):
    """Tournament player with player details"""
    player_name: str
    player_nickname: Optional[str] = None
    tournament_name: str
    qualified_from_day_name: Optional[str] = None  # Name of qualifying day
