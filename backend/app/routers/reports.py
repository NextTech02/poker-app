from fastapi import APIRouter, Depends, Query
from typing import Optional
from app.models.report import ReportSummary, TournamentReport
from app.models.financial import FinancialSummary
from app.services.report_service import ReportService
from app.services.financial_service import FinancialService
from app.auth.jwt import get_current_user

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/tournament/{tournament_id}", response_model=TournamentReport)
def get_tournament_report(
    tournament_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Comprehensive per-tournament report: participation, financials, prize execution."""
    return ReportService.get_tournament_report(tournament_id)


@router.get("", response_model=ReportSummary)
def get_reports(
    start: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    current_user: dict = Depends(get_current_user)
):
    """Get comprehensive reports for a date range"""
    return ReportService.get_reports(start, end)


@router.get("/financial", response_model=FinancialSummary)
def get_financial_summary(
    stage_id: Optional[str] = Query(None),
    tournament_id: Optional[str] = Query(None),
    start: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    current_user: dict = Depends(get_current_user),
):
    """Get financial summary for DRE and closing"""
    return FinancialService.get_financial_summary(stage_id, start, end, tournament_id)
