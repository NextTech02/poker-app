from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime


# ── Consignment (header) ──

class ConsignmentRelease(BaseModel):
    """Cashier releases a chip value to a sangi (opens a consignment)."""
    sangi_staff_id: str
    released_amount: float = Field(..., gt=0)
    stage_id: Optional[str] = None  # falls back to X-Stage-ID header
    notes: Optional[str] = None


class ConsignmentReconcile(BaseModel):
    notes: Optional[str] = None


class SaleResponse(BaseModel):
    id: str
    consignment_id: str
    amount: float
    buyer_player_id: str
    buyer_player_name: Optional[str] = None
    sold_by: Optional[str] = None
    notes: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ConsignmentResponse(BaseModel):
    id: str
    sangi_staff_id: str
    sangi_name: Optional[str] = None
    stage_id: str
    released_amount: float
    total_sold: float = 0.0
    remaining: float = 0.0          # released_amount - total_sold (chips still out)
    divergence: Optional[float] = None  # set at reconcile
    status: str = 'open'
    opened_at: datetime
    reconciled_at: Optional[datetime] = None
    notes: Optional[str] = None
    created_at: datetime
    sales: List[SaleResponse] = []

    class Config:
        from_attributes = True


# ── Sale ──

class SaleCreate(BaseModel):
    """Sangi registers a sale: amount + buyer (registered player)."""
    amount: float = Field(..., gt=0)
    buyer_player_id: str
    notes: Optional[str] = None
