from pydantic import BaseModel, Field
from typing import Optional, List


class LoyaltySettingsUpdate(BaseModel):
    enabled: Optional[bool] = None
    points_per_currency: Optional[float] = Field(None, ge=0)
    earn_on: Optional[List[str]] = None
    cashback_percent: Optional[float] = Field(None, ge=0, le=100)
    birthday_bonus_points: Optional[float] = Field(None, ge=0)
    birthday_credit: Optional[float] = Field(None, ge=0)


class GiftRequest(BaseModel):
    credit_id: str
    to_player_id: str


class RewardCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = None
    cost_points: float = Field(..., ge=0)
    credit_value: float = Field(0, ge=0)
    active: bool = True
    stock: Optional[int] = Field(None, ge=0)
    sort_order: int = 0


class RewardUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    description: Optional[str] = None
    cost_points: Optional[float] = Field(None, ge=0)
    credit_value: Optional[float] = Field(None, ge=0)
    active: Optional[bool] = None
    stock: Optional[int] = Field(None, ge=0)
    sort_order: Optional[int] = None


class RedeemRequest(BaseModel):
    reward_id: str


class CouponRedeem(BaseModel):
    code: str = Field(..., min_length=1, max_length=60)


class CouponCreate(BaseModel):
    code: str = Field(..., min_length=1, max_length=60)
    description: Optional[str] = None
    reward_type: str = Field("points", pattern="^(points|credit)$")
    points_value: float = Field(0, ge=0)
    credit_value: float = Field(0, ge=0)
    usage_limit: Optional[int] = Field(None, ge=1)
    per_player_limit: int = Field(1, ge=1)
    valid_until: Optional[str] = None
    active: bool = True


class GoalCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = None
    metric: str = Field(..., pattern="^(tournaments|entries|amount_spent)$")
    target: float = Field(..., gt=0)
    period: str = Field("monthly", pattern="^(monthly|all_time)$")
    reward_points: float = Field(0, ge=0)
    active: bool = True
    sort_order: int = 0


class LoyaltyTier(BaseModel):
    id: str
    name: str
    min_points: float = 0
    points_multiplier: float = 1
    cashback_percent: Optional[float] = None
    color: Optional[str] = None
    sort_order: int = 0


class LoyaltyLedgerEntry(BaseModel):
    id: str
    delta: float
    balance_after: float
    reason: str
    description: Optional[str] = None
    created_at: Optional[str] = None
