from pydantic import BaseModel
from typing import List, Optional


class RevenueBreakdown(BaseModel):
    buy_ins: float = 0
    rebuys: float = 0
    addons: float = 0
    total: float = 0


class TournamentFinancial(BaseModel):
    tournament_id: str
    tournament_name: str
    players: int = 0
    buy_ins_count: int = 0
    rebuys_count: int = 0
    addons_count: int = 0
    revenue: float = 0
    prizes: float = 0
    net: float = 0


class TransactionEntry(BaseModel):
    id: str
    created_at: str
    tournament_name: Optional[str] = None
    player_name: Optional[str] = None
    type: str
    payment_source: Optional[str] = None
    amount: float


class FinancialSummary(BaseModel):
    revenue: RevenueBreakdown
    tickets_redeemed_value: float = 0
    gross_revenue: float = 0
    prizes: float = 0
    operational_result: float = 0
    rake: float = 0
    net_result: float = 0
    pending_credits: float = 0
    available_tickets: int = 0
    by_tournament: List[TournamentFinancial] = []
    transactions: List[TransactionEntry] = []
