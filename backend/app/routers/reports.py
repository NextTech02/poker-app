from fastapi import APIRouter, Depends, Query
from typing import Optional
from app.models.report import ReportSummary
from app.services.report_service import ReportService
from app.auth.jwt import get_current_user

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("", response_model=ReportSummary)
def get_reports(
    start: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    current_user: dict = Depends(get_current_user)
):
    """Get comprehensive reports for a date range"""
    return ReportService.get_reports(start, end)
