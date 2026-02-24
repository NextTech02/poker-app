from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from enum import Enum


class TournamentDayStatus(str, Enum):
    pending = "pending"
    active = "active"
    completed = "completed"
    cancelled = "cancelled"


class DayType(str, Enum):
    regular = "regular"      # Standalone day
    qualifying = "qualifying"  # Advances survivors to another day
    final = "final"          # Receives qualified players from other days


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

    # Day type for qualifying structure
    day_type: DayType = Field(default=DayType.regular, description="Type: regular, qualifying, or final")
    qualifies_to_day_id: Optional[str] = Field(None, description="For qualifying days, the day that survivors advance to")

    # Financial configuration
    buy_in: float = Field(..., ge=0)
    rebuy_amount: Optional[float] = Field(None, gt=0)
    addon_amount: Optional[float] = Field(None, gt=0)
    rake_percentage: float = Field(default=0, ge=0, le=100, description="Percentage that goes to house (0-100)")

    # Player limits
    max_players: int = Field(..., gt=0)

    # Chip configuration
    starting_chips: int = Field(default=10000, ge=0)
    rebuy_chips: int = Field(default=10000, ge=0)
    addon_chips: int = Field(default=10000, ge=0)

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
    allocation_mode: str = Field(default='balanced', description="Auto-allocation algorithm: balanced, sequential, or random_balanced")

    # Table lock
    tables_locked: bool = Field(default=False, description="When true, new buy-ins skip auto-allocation (players become alternates)")

    # Currency
    currency: str = Field(default='BRL', description="Currency code used in this day (BRL, USD, EUR, etc.)")

    # Date/time
    tournament_date: Optional[datetime] = None

    # Broadcast settings (per-day)
    broadcast_language: str = Field(default='pt-BR', description="Display language for broadcast screen (pt-BR, en, es)")
    broadcast_bg_color: Optional[str] = Field(default="#0a0e13")
    broadcast_bg_image_url: Optional[str] = Field(default=None)
    broadcast_display_name: Optional[str] = Field(default=None)
    broadcast_font_size: int = Field(default=100, ge=50, le=200)
    broadcast_prize_size: int = Field(default=100, ge=50, le=300, description="Font size % for prize ticker bar")
    broadcast_prizepool_label_color: str = Field(default='#ffffff')
    broadcast_prizepool_value_color: str = Field(default='#ffffff')
    broadcast_prizepool_size: int = Field(default=100, ge=50, le=300)
    # Per-element colors
    broadcast_timer_color: str = Field(default='#d4af37')
    broadcast_title_color: str = Field(default='#d4af37')
    broadcast_blinds_label_color: str = Field(default='#d4af37')
    broadcast_blinds_value_color: str = Field(default='#ffffff')
    broadcast_ante_label_color: str = Field(default='#d4af37')
    broadcast_ante_value_color: str = Field(default='#d4af37')
    broadcast_next_label_color: str = Field(default='#d4af37')
    broadcast_next_value_color: str = Field(default='#9ca3af')
    broadcast_sidebar_label_color: str = Field(default='#9ca3af')
    broadcast_sidebar_value_color: str = Field(default='#d4af37')
    broadcast_show_logo: bool = Field(default=True)
    broadcast_show_title: bool = Field(default=True)
    broadcast_show_prizepool: bool = Field(default=True)
    broadcast_show_level: bool = Field(default=True)
    broadcast_show_players: bool = Field(default=True)
    broadcast_show_interval: bool = Field(default=True)
    broadcast_show_timer: bool = Field(default=True)
    broadcast_show_blinds: bool = Field(default=True)
    broadcast_show_ante: bool = Field(default=True)
    broadcast_show_next_blind: bool = Field(default=True)
    broadcast_show_prizes: bool = Field(default=True)
    broadcast_show_chipcount: bool = Field(default=True)
    broadcast_show_average: bool = Field(default=True)

    # Break screen settings (separate configurable layout shown during breaks)
    broadcast_break_layout: Optional[str] = Field(default='split')
    broadcast_break_bg_color: Optional[str] = Field(default='#0a0e13')
    broadcast_break_bg_image_url: Optional[str] = Field(default=None)
    broadcast_break_youtube_url: Optional[str] = Field(default=None)
    broadcast_break_show_video: bool = Field(default=True)
    broadcast_break_show_next_level: bool = Field(default=True)
    broadcast_break_show_players: bool = Field(default=True)
    broadcast_break_show_chipcount: bool = Field(default=True)
    broadcast_break_show_average: bool = Field(default=True)
    broadcast_break_overlay_opacity: int = Field(default=70, ge=0, le=100)
    broadcast_break_font_size: int = Field(default=100, ge=50, le=300, description="Font size % for break screen info panel")
    broadcast_break_timer_color: Optional[str] = Field(default='#d4af37')
    broadcast_break_label_color: Optional[str] = Field(default='#9ca3af')
    broadcast_break_value_color: Optional[str] = Field(default='#d4af37')
    broadcast_break_title_color: Optional[str] = Field(default='#ffffff')


class TournamentDayCreate(TournamentDayBase):
    """Model for creating a new tournament day"""
    pass


class TournamentDayUpdate(BaseModel):
    """Model for updating an existing tournament day"""
    day_name: Optional[str] = Field(None, min_length=1, max_length=255)
    day_number: Optional[int] = Field(None, gt=0)
    status: Optional[TournamentDayStatus] = None
    buy_in: Optional[float] = Field(None, ge=0)
    rebuy_amount: Optional[float] = Field(None, ge=0)
    addon_amount: Optional[float] = Field(None, ge=0)
    rake_percentage: Optional[float] = Field(None, ge=0, le=100)
    max_players: Optional[int] = Field(None, gt=0)
    starting_chips: Optional[int] = Field(None, ge=0)
    rebuy_chips: Optional[int] = Field(None, ge=0)
    addon_chips: Optional[int] = Field(None, ge=0)
    blind_duration: Optional[int] = Field(None, gt=0)
    initial_small_blind: Optional[int] = Field(None, gt=0)
    initial_big_blind: Optional[int] = Field(None, gt=0)
    blind_increase_type: Optional[BlindIncreaseType] = None
    bb_ante_start_level: Optional[int] = Field(None, gt=0)
    rebuy_level_limit: Optional[int] = None
    break_interval: Optional[int] = Field(None, gt=0)
    break_duration: Optional[int] = Field(None, gt=0)
    allocation_type: Optional[AllocationType] = None
    allocation_mode: Optional[str] = Field(None, description="Auto-allocation algorithm: balanced, sequential, or random_balanced")
    tables_locked: Optional[bool] = None
    currency: Optional[str] = None
    tournament_date: Optional[datetime] = None
    day_type: Optional[DayType] = None
    qualifies_to_day_id: Optional[str] = None

    # Broadcast settings
    broadcast_language: Optional[str] = None
    broadcast_bg_color: Optional[str] = None
    broadcast_bg_image_url: Optional[str] = None
    broadcast_display_name: Optional[str] = None
    broadcast_font_size: Optional[int] = Field(None, ge=50, le=200)
    broadcast_prize_size: Optional[int] = Field(None, ge=50, le=300)
    broadcast_prizepool_label_color: Optional[str] = None
    broadcast_prizepool_value_color: Optional[str] = None
    broadcast_prizepool_size: Optional[int] = Field(None, ge=50, le=300)
    broadcast_timer_color: Optional[str] = None
    broadcast_title_color: Optional[str] = None
    broadcast_blinds_label_color: Optional[str] = None
    broadcast_blinds_value_color: Optional[str] = None
    broadcast_ante_label_color: Optional[str] = None
    broadcast_ante_value_color: Optional[str] = None
    broadcast_next_label_color: Optional[str] = None
    broadcast_next_value_color: Optional[str] = None
    broadcast_sidebar_label_color: Optional[str] = None
    broadcast_sidebar_value_color: Optional[str] = None
    broadcast_show_logo: Optional[bool] = None
    broadcast_show_title: Optional[bool] = None
    broadcast_show_prizepool: Optional[bool] = None
    broadcast_show_level: Optional[bool] = None
    broadcast_show_players: Optional[bool] = None
    broadcast_show_interval: Optional[bool] = None
    broadcast_show_timer: Optional[bool] = None
    broadcast_show_blinds: Optional[bool] = None
    broadcast_show_ante: Optional[bool] = None
    broadcast_show_next_blind: Optional[bool] = None
    broadcast_show_prizes: Optional[bool] = None
    broadcast_show_chipcount: Optional[bool] = None
    broadcast_show_average: Optional[bool] = None

    # Break screen settings
    broadcast_break_layout: Optional[str] = None
    broadcast_break_bg_color: Optional[str] = None
    broadcast_break_bg_image_url: Optional[str] = None
    broadcast_break_youtube_url: Optional[str] = None
    broadcast_break_show_video: Optional[bool] = None
    broadcast_break_show_next_level: Optional[bool] = None
    broadcast_break_show_players: Optional[bool] = None
    broadcast_break_show_chipcount: Optional[bool] = None
    broadcast_break_show_average: Optional[bool] = None
    broadcast_break_overlay_opacity: Optional[int] = Field(None, ge=0, le=100)
    broadcast_break_font_size: Optional[int] = Field(None, ge=50, le=300)
    broadcast_break_timer_color: Optional[str] = None
    broadcast_break_label_color: Optional[str] = None
    broadcast_break_value_color: Optional[str] = None
    broadcast_break_title_color: Optional[str] = None


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

    # Timer control fields
    current_level: int = 1
    elapsed_time: int = 0
    is_paused: bool = False
    timer_started_at: Optional[datetime] = None
    manual_time_adjustment: int = 0

    # Elimination counter
    eliminations_count: int = 0

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
    day_type: DayType = DayType.regular
    qualifies_to_day_id: Optional[str] = None

    # Timer control fields
    current_level: int = 1
    elapsed_time: int = 0
    is_paused: bool = False
    timer_started_at: Optional[datetime] = None
    manual_time_adjustment: int = 0

    class Config:
        from_attributes = True


class QualifyingDayStats(BaseModel):
    """Statistics for a single qualifying day"""
    day_id: str
    day_name: str
    day_number: int
    status: TournamentDayStatus

    # Player counts
    total_players: int = 0
    eliminated_players: int = 0
    qualified_players: int = 0

    # Entry counts
    total_buy_ins: int = 0
    total_rebuys: int = 0
    total_addons: int = 0
    total_entries: int = 0  # buy_ins + rebuys

    # Financial totals
    buy_in_amount: float = 0.0
    rebuy_amount: float = 0.0
    addon_amount: float = 0.0
    total_collected: float = 0.0
    prize_pool: float = 0.0


class FinalDayAggregatedStats(BaseModel):
    """Aggregated statistics for a final day from all qualifying days"""
    final_day_id: str
    final_day_name: str

    # Players in final day
    total_qualified_players: int = 0
    direct_buy_in_players: int = 0
    total_players: int = 0

    # Aggregated from all qualifying days
    qualifying_days: list[QualifyingDayStats] = []

    # Total aggregated stats from all qualifying days
    total_qualifying_buy_ins: int = 0
    total_qualifying_rebuys: int = 0
    total_qualifying_addons: int = 0
    total_qualifying_entries: int = 0

    # Financial totals from all qualifying days
    total_qualifying_buy_in_amount: float = 0.0
    total_qualifying_rebuy_amount: float = 0.0
    total_qualifying_addon_amount: float = 0.0
    total_qualifying_collected: float = 0.0
    total_qualifying_prize_pool: float = 0.0

    # Final day specific stats (direct buy-ins in final)
    final_day_buy_ins: int = 0
    final_day_rebuys: int = 0
    final_day_addons: int = 0
    final_day_collected: float = 0.0

    # Combined totals (qualifying + final day)
    combined_prize_pool: float = 0.0
    combined_total_collected: float = 0.0


# ================================================
# Timer Control Models
# ================================================

class TimerAdjustment(BaseModel):
    """Model for adjusting timer (add or subtract seconds)"""
    seconds: int = Field(..., description="Seconds to add (positive) or subtract (negative)")


class TimerStatus(BaseModel):
    """Current timer status for a tournament day"""
    day_id: str
    current_level: int = 1
    elapsed_time: int = 0  # Total elapsed time in seconds
    is_paused: bool = False
    timer_started_at: Optional[datetime] = None
    manual_time_adjustment: int = 0

    # Computed fields
    active_players: int = 0
    total_entries: int = 0

    class Config:
        from_attributes = True


class EliminationCountAdjust(BaseModel):
    """Adjust the eliminations counter (positive = add eliminations, negative = undo)"""
    count: int = Field(default=1, description="Number of eliminations to add (positive) or undo (negative)")
