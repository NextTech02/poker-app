from fastapi import APIRouter, Depends
from app.services.dashboard_service import DashboardService
from app.auth.jwt import get_current_user

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/stats")
def get_dashboard_stats(current_user: dict = Depends(get_current_user)):
    """Get dashboard statistics"""
    return DashboardService.get_stats()
