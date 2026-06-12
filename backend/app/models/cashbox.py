from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime
from enum import Enum


class CashboxStatus(str, Enum):
    closed = "closed"
    open = "open"
    archived = "archived"


class CashboxTransactionType(str, Enum):
    buy_in = "buy_in"
    rebuy = "rebuy"
    addon = "addon"
    prize = "prize"
    supply = "supply"
    sangria = "sangria"
    adjustment = "adjustment"


# ────────────────────────────────────────────────
# Cashbox
# ────────────────────────────────────────────────

class CashboxResponse(BaseModel):
    id: str
    staff_id: str
    stage_id: str
    status: CashboxStatus
    current_balance: float
    current_session_id: Optional[str] = None
    last_opened_at: Optional[datetime] = None
    last_closed_at: Optional[datetime] = None
    archived_at: Optional[datetime] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    # Joined
    staff_name: Optional[str] = None
    staff_email: Optional[str] = None
    stage_name: Optional[str] = None

    class Config:
        from_attributes = True


# ────────────────────────────────────────────────
# Sessions
# ────────────────────────────────────────────────

class CashboxCreate(BaseModel):
    """Manually ensure a cashbox exists for a staff member in the current stage
    (idempotent — returns the existing one if already present)."""
    staff_id: str


class CashboxOpen(BaseModel):
    """Open a cashbox with a counted initial balance."""
    initial_balance: float = Field(default=0.0, ge=0)
    notes: Optional[str] = Field(default=None, max_length=500)


class CashboxClose(BaseModel):
    """Close the current session. `actual_final_balance` is the physical
    count; the service computes the difference vs expected and (if non-zero)
    records an `adjustment` cashbox_transaction."""
    actual_final_balance: float = Field(..., ge=0)
    notes: Optional[str] = Field(default=None, max_length=500)


class CashboxSessionResponse(BaseModel):
    id: str
    cashbox_id: str
    opened_at: datetime
    opened_by: Optional[str] = None
    initial_balance: float
    closed_at: Optional[datetime] = None
    closed_by: Optional[str] = None
    expected_final_balance: Optional[float] = None
    actual_final_balance: Optional[float] = None
    difference: Optional[float] = None
    notes: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# ────────────────────────────────────────────────
# Movements (admin operations)
# ────────────────────────────────────────────────

class CashboxSupply(BaseModel):
    """Add money to a cashbox. Requires `cashbox.admin` permission."""
    amount: float = Field(..., gt=0)
    notes: Optional[str] = Field(default=None, max_length=500)


class CashboxSangria(BaseModel):
    """Withdraw money from a cashbox. Requires `cashbox.admin` permission.
    Unlike the stage-level sangria, this does NOT compute rake — it just
    moves money out of the operator's till to another destination."""
    amount: float = Field(..., gt=0)
    notes: Optional[str] = Field(default=None, max_length=500)


class CashboxTransactionResponse(BaseModel):
    id: str
    cashbox_id: str
    session_id: Optional[str] = None
    type: CashboxTransactionType
    amount: float
    signed_amount: float
    transaction_id: Optional[str] = None
    performed_by: Optional[str] = None
    notes: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# ────────────────────────────────────────────────
# Aggregated views
# ────────────────────────────────────────────────

class CashboxSummary(BaseModel):
    """Per-cashbox aggregate over a period for the demonstrativo screen."""
    cashbox_id: str
    staff_name: Optional[str] = None
    stage_name: Optional[str] = None
    status: CashboxStatus
    initial_balance: float = 0.0
    total_supply: float = 0.0
    total_sangria: float = 0.0
    total_buy_ins: float = 0.0
    buy_in_count: int = 0
    total_rebuys: float = 0.0
    rebuy_count: int = 0
    total_addons: float = 0.0
    addon_count: int = 0
    total_prizes_paid: float = 0.0
    prize_count: int = 0
    total_adjustments: float = 0.0
    expected_balance: float = 0.0
    current_balance: float = 0.0


class CashboxAggregatedSummary(BaseModel):
    """Aggregate across many cashboxes (admin demonstrativo)."""
    cashboxes: List[CashboxSummary] = []
    grand_total_balance: float = 0.0
    grand_total_buy_ins: float = 0.0
    grand_total_prizes: float = 0.0
    grand_total_supply: float = 0.0
    grand_total_sangria: float = 0.0


# ────────────────────────────────────────────────
# Demonstrativo (session-based reconciliation)
# ────────────────────────────────────────────────

class CashboxSessionReport(BaseModel):
    """One open→close cycle = one full reconciliation row. Within a session the
    invariant `current_balance == SUM(signed_amount)` holds, so expected vs
    actual reconciles (unlike a cross-session aggregate)."""
    session_id: str
    cashbox_id: str
    staff_name: Optional[str] = None
    stage_name: Optional[str] = None
    opened_at: datetime
    closed_at: Optional[datetime] = None
    is_open: bool = False
    initial_balance: float = 0.0
    total_supply: float = 0.0          # additional supplies (excludes opening balance)
    total_sangria: float = 0.0
    total_buy_ins: float = 0.0
    buy_in_count: int = 0
    total_rebuys: float = 0.0
    rebuy_count: int = 0
    total_addons: float = 0.0
    addon_count: int = 0
    total_prizes_paid: float = 0.0
    prize_count: int = 0
    total_adjustments: float = 0.0
    expected_balance: float = 0.0
    actual_balance: Optional[float] = None   # counted (closed) or live balance (open)
    difference: Optional[float] = None        # actual - expected (None while no count)


class CashboxDemonstrativo(BaseModel):
    """Session-based demonstrativo across cashboxes, filterable by period and
    employee. Each session row reconciles; grand totals sum the rows."""
    sessions: List[CashboxSessionReport] = []
    grand_initial: float = 0.0
    grand_supply: float = 0.0
    grand_sangria: float = 0.0
    grand_buy_ins: float = 0.0
    grand_prizes: float = 0.0
    grand_adjustments: float = 0.0
    grand_expected: float = 0.0
    grand_actual: float = 0.0
    grand_difference: float = 0.0
    open_session_count: int = 0
