"""
Cash Register Models
Pydantic models for cash management system (stage cash, general cash, rake, and sangria)
"""
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from decimal import Decimal


# Stage Cash Register (Caixa do Dia)
class StageCashRegisterBase(BaseModel):
    stage_id: str = Field(..., description="Stage UUID")
    current_balance: Decimal = Field(default=Decimal('0.00'), ge=0, description="Current balance in stage cash")
    total_received: Decimal = Field(default=Decimal('0.00'), ge=0, description="Total amount received")
    total_sangrias: Decimal = Field(default=Decimal('0.00'), ge=0, description="Total sangrias made")


class StageCashRegister(StageCashRegisterBase):
    id: str
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# General Cash Register (Caixa Geral)
class GeneralCashRegisterBase(BaseModel):
    current_balance: Decimal = Field(default=Decimal('0.00'), ge=0, description="Current balance in general cash")
    total_received: Decimal = Field(default=Decimal('0.00'), ge=0, description="Total received from sangrias")


class GeneralCashRegister(GeneralCashRegisterBase):
    id: str
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# Rake Register
class RakeRegisterBase(BaseModel):
    total_rake: Decimal = Field(default=Decimal('0.00'), ge=0, description="Total accumulated rake")


class RakeRegister(RakeRegisterBase):
    id: str
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# Sangria Transaction
class SangriaTransactionBase(BaseModel):
    stage_id: str = Field(..., description="Stage UUID")
    stage_name: str = Field(..., min_length=1, description="Stage name for reference")
    amount: Decimal = Field(..., gt=0, description="Total amount before rake")
    rake_percentage: Decimal = Field(default=Decimal('20.00'), ge=0, le=100, description="Rake percentage")
    notes: Optional[str] = Field(None, description="Additional notes")


class SangriaTransactionCreate(SangriaTransactionBase):
    """Request model for creating a sangria transaction"""
    # Offline: chave de idempotência (evita sangria duplicada no replay).
    client_mutation_id: Optional[str] = Field(default=None, description="Idempotency key (offline)")


class SangriaTransaction(SangriaTransactionBase):
    id: str
    rake_amount: Decimal = Field(..., description="Calculated rake amount")
    net_amount: Decimal = Field(..., description="Amount after rake deduction")
    created_by: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# Dashboard/Summary Models
class CashDashboard(BaseModel):
    """Complete cash management dashboard data"""
    stage_cash: Optional[StageCashRegister] = Field(None, description="Stage cash register (caixa do dia)")
    general_cash: GeneralCashRegister = Field(..., description="General cash register (caixa geral)")
    rake: RakeRegister = Field(..., description="Rake register")
    recent_sangrias: list[SangriaTransaction] = Field(default=[], description="Recent sangria transactions")

    class Config:
        from_attributes = True


class StageCashSummary(BaseModel):
    """Stage cash summary with stage info"""
    stage_id: str
    stage_name: str
    stage_location: str
    stage_status: str
    cash_register: StageCashRegister
    total_tournaments: int = Field(default=0, description="Number of tournaments in stage")

    class Config:
        from_attributes = True


# Response models
class SangriaResponse(BaseModel):
    """Response after performing sangria"""
    success: bool
    message: str
    sangria_transaction: SangriaTransaction
    updated_stage_cash: StageCashRegister
    updated_general_cash: GeneralCashRegister
    updated_rake: RakeRegister

    class Config:
        from_attributes = True
