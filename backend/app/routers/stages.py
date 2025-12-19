from fastapi import APIRouter, Depends, HTTPException, status
from typing import List, Optional
from app.models.stage import StageCreate, StageUpdate, Stage, StageSummary
from app.services.stage_service import StageService
from app.auth.jwt import get_current_user

router = APIRouter(prefix="/stages", tags=["stages"])


@router.post("", response_model=Stage, status_code=status.HTTP_201_CREATED)
def create_stage(
    stage: StageCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new stage/etapa"""
    return StageService.create_stage(stage)


@router.get("", response_model=List[StageSummary])
def get_stages(
    status: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get all stages, optionally filtered by status"""
    return StageService.get_stages(status)


@router.get("/{stage_id}", response_model=Stage)
def get_stage(
    stage_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get a specific stage by ID"""
    stage = StageService.get_stage(stage_id)
    if not stage:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Stage not found"
        )
    return stage


@router.patch("/{stage_id}", response_model=Stage)
def update_stage(
    stage_id: str,
    stage: StageUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update a stage"""
    updated_stage = StageService.update_stage(stage_id, stage)
    if not updated_stage:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Stage not found"
        )
    return updated_stage


@router.delete("/{stage_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_stage(
    stage_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Delete a stage"""
    success = StageService.delete_stage(stage_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Stage not found"
        )
    return None
