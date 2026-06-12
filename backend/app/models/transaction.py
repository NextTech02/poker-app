from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from enum import Enum


class TransactionType(str, Enum):
    buy_in = "buy_in"
    rebuy = "rebuy"
    addon = "addon"
    prize = "prize"


class TransactionBase(BaseModel):
    tournament_id: str
    player_id: str
    type: TransactionType
    amount: float = Field(..., ge=0)
    payment_method: Optional[str] = Field(None, max_length=50)
    reference_number: Optional[str] = Field(None, max_length=100)
    notes: Optional[str] = None


class TransactionCreate(TransactionBase):
    pass


class Transaction(TransactionBase):
    id: str
    tournament_player_id: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class TransactionDetail(Transaction):
    """Transaction with player and tournament details"""
    player_name: str
    player_nickname: Optional[str] = None
    tournament_name: str
