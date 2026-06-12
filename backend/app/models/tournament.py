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


class BroadcastSettings(BaseModel):
    """Broadcast display settings for tournament"""
    bg_color: Optional[str] = Field(default="#0a0e13", description="Background color (hex)")
    bg_image_url: Optional[str] = Field(default=None, description="Background image URL")
    display_name: Optional[str] = Field(default=None, description="Custom display name")
    show_logo: bool = Field(default=True, description="Show logo")
    show_title: bool = Field(default=True, description="Show tournament title")
    show_prizepool: bool = Field(default=True, description="Show prizepool")
    show_level: bool = Field(default=True, description="Show blind level")
    show_players: bool = Field(default=True, description="Show player count")
    show_interval: bool = Field(default=True, description="Show interval until break")
    show_timer: bool = Field(default=True, description="Show countdown timer")
    show_blinds: bool = Field(default=True, description="Show current blinds")
    show_ante: bool = Field(default=True, description="Show ante value")
    show_next_blind: bool = Field(default=True, description="Show next blind")
    font_size: int = Field(default=100, ge=50, le=200, description="Font size percentage (50-200)")


class TournamentBase(BaseModel):
    """Simplified tournament model - just a container for tournament days"""
    name: str = Field(..., min_length=1, max_length=255, description="Tournament name (e.g., 'Torneio de Sexta')")
    stage_id: Optional[str] = Field(None, description="Stage/Etapa ID")
    sponsor_id: Optional[str] = Field(None, description="Sponsor/Patrocinador ID")
    has_qualifying: bool = Field(default=False, description="Whether this tournament has qualifying days leading to a final")
    is_satellite: bool = Field(default=False, description="Whether this is a satellite tournament that awards tickets")


class TournamentCreate(TournamentBase):
    pass


class TournamentUpdate(BaseModel):
    """Update model for simplified tournament"""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    stage_id: Optional[str] = None
    sponsor_id: Optional[str] = Field(None, description="Sponsor/Patrocinador ID (null clears it)")
    has_qualifying: Optional[bool] = None
    is_satellite: Optional[bool] = None
    # Broadcast settings
    broadcast_bg_color: Optional[str] = Field(default=None, description="Background color (hex)")
    broadcast_bg_image_url: Optional[str] = Field(default=None, description="Background image URL")
    broadcast_display_name: Optional[str] = Field(default=None, description="Custom display name")
    broadcast_show_logo: Optional[bool] = Field(default=None, description="Show logo")
    broadcast_show_title: Optional[bool] = Field(default=None, description="Show tournament title")
    broadcast_show_prizepool: Optional[bool] = Field(default=None, description="Show prizepool")
    broadcast_show_level: Optional[bool] = Field(default=None, description="Show blind level")
    broadcast_show_players: Optional[bool] = Field(default=None, description="Show player count")
    broadcast_show_interval: Optional[bool] = Field(default=None, description="Show interval until break")
    broadcast_show_timer: Optional[bool] = Field(default=None, description="Show countdown timer")
    broadcast_show_blinds: Optional[bool] = Field(default=None, description="Show current blinds")
    broadcast_show_ante: Optional[bool] = Field(default=None, description="Show ante value")
    broadcast_show_next_blind: Optional[bool] = Field(default=None, description="Show next blind")
    broadcast_font_size: Optional[int] = Field(default=None, ge=50, le=200, description="Font size percentage (50-200)")


class Tournament(TournamentBase):
    """Complete tournament model - simplified to be just a container"""
    id: str
    created_by: str
    created_at: datetime
    updated_at: Optional[datetime] = None
    status: str = "pending"
    guaranteed_prize: float = 0.0
    sponsor_id: Optional[str] = None
    sponsor_name: Optional[str] = None  # joined from sponsors table
    # Broadcast settings
    broadcast_bg_color: Optional[str] = "#0a0e13"
    broadcast_bg_image_url: Optional[str] = None
    broadcast_display_name: Optional[str] = None
    broadcast_show_logo: bool = True
    broadcast_show_title: bool = True
    broadcast_show_prizepool: bool = True
    broadcast_show_level: bool = True
    broadcast_show_players: bool = True
    broadcast_show_interval: bool = True
    broadcast_show_timer: bool = True
    broadcast_show_blinds: bool = True
    broadcast_show_ante: bool = True
    broadcast_show_next_blind: bool = True
    broadcast_font_size: int = 100

    class Config:
        from_attributes = True


class TournamentSummary(BaseModel):
    """Tournament summary with aggregated statistics from all days"""
    id: str
    name: str
    stage_id: Optional[str] = None
    sponsor_id: Optional[str] = None
    sponsor_name: Optional[str] = None  # joined from sponsors table
    has_qualifying: bool = False
    is_satellite: bool = False
    status: Optional[str] = "pending"  # A2: campo incluído para exibição de badges no frontend
    total_entries: int = 0  # Aggregated from all days (buy-ins + rebuys)
    total_days: int = 0  # Number of tournament days
    created_by: str
    created_at: datetime
    # Broadcast settings
    broadcast_bg_color: Optional[str] = "#0a0e13"
    broadcast_bg_image_url: Optional[str] = None
    broadcast_display_name: Optional[str] = None
    broadcast_show_logo: bool = True
    broadcast_show_title: bool = True
    broadcast_show_prizepool: bool = True
    broadcast_show_level: bool = True
    broadcast_show_players: bool = True
    broadcast_show_interval: bool = True
    broadcast_show_timer: bool = True
    broadcast_show_blinds: bool = True
    broadcast_show_ante: bool = True
    broadcast_show_next_blind: bool = True
    broadcast_font_size: int = 100

    class Config:
        from_attributes = True
