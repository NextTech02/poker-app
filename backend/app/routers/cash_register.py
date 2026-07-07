"""
Cash Register Router
REST API endpoints for cash management system
"""
from fastapi import APIRouter, Depends, HTTPException, status, Query
from typing import List, Optional
from app.models.cash_register import (
    StageCashRegister,
    GeneralCashRegister,
    RakeRegister,
    SangriaTransaction,
    SangriaTransactionCreate,
    CashDashboard,
    StageCashSummary,
    SangriaResponse
)
from app.services.cash_register_service import CashRegisterService
from app.auth.jwt import get_current_user

router = APIRouter(prefix="/cash", tags=["cash-management"])


# Stage Cash Endpoints (Caixa do Dia)
@router.get("/stage/{stage_id}", response_model=StageCashRegister)
def get_stage_cash(
    stage_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get cash register for a specific stage (caixa do dia)"""
    stage_cash = CashRegisterService.get_stage_cash(stage_id)
    if not stage_cash:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Cash register not found for stage {stage_id}"
        )
    return stage_cash


@router.get("/stage/{stage_id}/pending-rake")
def get_stage_pending_rake(
    stage_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Rake pendente da etapa (soma dos rakes por transação ainda não sangrados).
    Usado para pré-visualizar o rake automático da sangria (Fase 2)."""
    stage_cash = CashRegisterService.get_stage_cash(stage_id)
    pending = CashRegisterService.get_stage_pending_rake(stage_id)
    balance = stage_cash.current_balance if stage_cash else 0
    return {"stage_id": stage_id, "pending_rake": float(pending), "stage_balance": float(balance)}


@router.get("/stage", response_model=List[StageCashSummary])
def get_all_stage_cash(
    current_user: dict = Depends(get_current_user)
):
    """Get all stage cash registers with stage information"""
    return CashRegisterService.get_all_stage_cash()


# General Cash Endpoint (Caixa Geral)
@router.get("/general", response_model=GeneralCashRegister)
def get_general_cash(
    current_user: dict = Depends(get_current_user)
):
    """Get general cash register (caixa geral) - accumulates from all sangrias"""
    try:
        return CashRegisterService.get_general_cash()
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error getting general cash: {str(e)}"
        )


# Rake Endpoint
@router.get("/rake", response_model=RakeRegister)
def get_rake_register(
    current_user: dict = Depends(get_current_user)
):
    """Get rake register - total accumulated house profit"""
    try:
        return CashRegisterService.get_rake_register()
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error getting rake register: {str(e)}"
        )


# Sangria Endpoints
@router.post("/sangria", response_model=SangriaResponse, status_code=status.HTTP_201_CREATED)
def perform_sangria(
    sangria_data: SangriaTransactionCreate,
    current_user: dict = Depends(get_current_user)
):
    """
    Perform sangria operation:
    - Deduct amount from stage cash (caixa do dia)
    - Calculate and deduct rake (default 20%)
    - Add net amount to general cash (caixa geral)
    - Record transaction
    """
    try:
        return CashRegisterService.perform_sangria(
            sangria_data=sangria_data,
            user_id=current_user["sub"]
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error performing sangria: {str(e)}"
        )


@router.get("/sangria/history", response_model=List[SangriaTransaction])
def get_sangria_history(
    stage_id: Optional[str] = Query(None, description="Filter by stage ID"),
    limit: int = Query(50, ge=1, le=200, description="Maximum number of records"),
    current_user: dict = Depends(get_current_user)
):
    """Get sangria transaction history, optionally filtered by stage"""
    return CashRegisterService.get_sangria_history(stage_id=stage_id, limit=limit)


# Dashboard Endpoint
@router.get("/dashboard", response_model=CashDashboard)
def get_cash_dashboard(
    stage_id: Optional[str] = Query(None, description="Optional stage ID for stage-specific data"),
    current_user: dict = Depends(get_current_user)
):
    """
    Get complete cash management dashboard with:
    - Stage cash (if stage_id provided)
    - General cash
    - Rake register
    - Recent sangria transactions
    """
    return CashRegisterService.get_cash_dashboard(stage_id=stage_id)
