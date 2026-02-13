from typing import Optional
from fastapi import APIRouter, Depends
from app.services.dashboard_service import DashboardService
from app.auth.jwt import get_current_user
from app.dependencies import get_stage_id_optional

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/stats")
def get_dashboard_stats(
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """Get dashboard statistics, optionally filtered by stage"""
    return DashboardService.get_stats(stage_id=stage_id)
