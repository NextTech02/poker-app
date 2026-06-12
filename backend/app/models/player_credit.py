from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime


class PlayerCreditCreate(BaseModel):
    player_id: str
    sponsor_id: str
    amount: float = Field(..., gt=0)
    stage_id: Optional[str] = None
    notes: Optional[str] = None


class PlayerCreditResponse(BaseModel):
    id: str
    player_id: str
    sponsor_id: str
    stage_id: Optional[str] = None
    original_amount: float
    remaining_amount: float
    used_amount: float
    status: str
    prize_deduction_amount: float = 0
    sponsor_owes: float = 0
    notes: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    settled_at: Optional[datetime] = None
    # Joined fields
    player_name: Optional[str] = None
    player_nickname: Optional[str] = None
    sponsor_name: Optional[str] = None

    class Config:
        from_attributes = True


class CreditSettlementRequest(BaseModel):
    amount: float = Field(..., gt=0)
    notes: Optional[str] = None


class CreditTransactionResponse(BaseModel):
    id: str
    credit_id: str
    player_id: str
    tournament_id: Optional[str] = None
    tournament_day_id: Optional[str] = None
    type: str
    amount: float
    balance_after: float
    notes: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime
    # Joined fields
    tournament_name: Optional[str] = None
    sponsor_name: Optional[str] = None

    class Config:
        from_attributes = True


class PlayerBalanceSummary(BaseModel):
    player_id: str
    player_name: Optional[str] = None
    total_credits_received: float = 0
    total_credits_used: float = 0
    total_credits_remaining: float = 0
    total_prize_deductions: float = 0
    total_sponsor_owes: float = 0


class PlayerStatementEntry(BaseModel):
    id: str
    date: datetime
    category: str  # 'credit' or 'transaction'
    type: str
    amount: float
    tournament_name: Optional[str] = None
    tournament_day_name: Optional[str] = None
    sponsor_name: Optional[str] = None
    payment_source: Optional[str] = None
    notes: Optional[str] = None

    class Config:
        from_attributes = True


class PlayerStatementFilter(BaseModel):
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    category: Optional[str] = None  # 'credit', 'transaction'
    type: Optional[str] = None
    tournament_id: Optional[str] = None
