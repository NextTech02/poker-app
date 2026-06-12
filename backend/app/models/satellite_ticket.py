from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class TicketCreate(BaseModel):
    """New simplified flow: ticket is bound to a player + target tournament + day.
    The value is derived server-side from the target day's buy_in.
    `won_at` is a free-text label of where the ticket was won (may be an
    external platform such as PokerStars / GGPoker). `funded_by` is who is
    financially responsible for honoring the ticket value."""
    player_id: str
    target_tournament_id: str
    target_tournament_day_id: str
    won_at: str = Field(..., min_length=1, max_length=200)
    funded_by: str = Field(..., min_length=1, max_length=120)
    stage_id: Optional[str] = None


class TicketResponse(BaseModel):
    id: str
    # satellite_name kept optional for backward compatibility with legacy tickets
    satellite_name: Optional[str] = None
    target_tournament_id: str
    target_tournament_day_id: Optional[str] = None
    player_id: Optional[str] = None
    ticket_value: float
    status: str
    redeemed_at: Optional[datetime] = None
    redeemed_tournament_player_id: Optional[str] = None
    funded_by: Optional[str] = None
    won_at: Optional[str] = None
    stage_id: Optional[str] = None
    notes: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    # Joined
    player_name: Optional[str] = None
    player_nickname: Optional[str] = None
    target_tournament_name: Optional[str] = None
    target_day_name: Optional[str] = None

    class Config:
        from_attributes = True


class TicketRedeem(BaseModel):
    """Redeems a ticket. The player and funder are already attached at
    creation time; `funded_by` here is only needed for legacy tickets that
    were created before the funder became a creation-time field."""
    funded_by: Optional[str] = Field(default=None, max_length=120)


class TicketSummary(BaseModel):
    total_available: int = 0
    total_redeemed: int = 0
    total_cancelled: int = 0
