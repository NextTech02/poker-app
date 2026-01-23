"""
Dependencies for extracting and validating stage context from requests.
"""
from typing import Optional
from fastapi import Header, HTTPException, Depends
from .auth.jwt import get_current_user
from .database.supabase_client import supabase


async def get_stage_id_optional(x_stage_id: Optional[str] = Header(None)) -> Optional[str]:
    """
    Extract stage_id from X-Stage-ID header (optional).
    Returns None if header is not present.
    """
    return x_stage_id


async def get_stage_id_required(x_stage_id: Optional[str] = Header(None)) -> str:
    """
    Extract stage_id from X-Stage-ID header (required).
    Raises HTTPException if header is not present.
    """
    if not x_stage_id:
        raise HTTPException(
            status_code=400,
            detail="X-Stage-ID header is required. Please select a stage first."
        )
    return x_stage_id


async def validate_stage_exists(stage_id: str = Depends(get_stage_id_required)) -> str:
    """
    Validate that the stage exists in the database.
    Returns the stage_id if valid, raises HTTPException otherwise.
    """
    try:
        response = supabase.table('stages').select('id').eq('id', stage_id).execute()
        if not response.data or len(response.data) == 0:
            raise HTTPException(
                status_code=404,
                detail=f"Stage with id {stage_id} not found"
            )
        return stage_id
    except Exception as e:
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(
            status_code=500,
            detail=f"Error validating stage: {str(e)}"
        )


async def get_current_user_with_stage(
    current_user: dict = Depends(get_current_user),
    stage_id: str = Depends(validate_stage_exists)
):
    """
    Combine user authentication with stage validation.
    Returns both user and stage_id.
    """
    return {
        "user": current_user,
        "stage_id": stage_id
    }


async def get_current_user_with_optional_stage(
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Combine user authentication with optional stage.
    Returns both user and stage_id (which may be None).
    """
    return {
        "user": current_user,
        "stage_id": stage_id
    }
