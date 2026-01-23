from fastapi import APIRouter, Depends, HTTPException, status
from typing import List
from uuid import UUID
from datetime import datetime

from ..auth.jwt import get_current_user
from ..database import supabase
from ..models.blind import BlindCreateRequest, BlindUpdate, BlindResponse

router = APIRouter(tags=["blinds"])


@router.get("/tournaments/{tournament_id}/blinds", response_model=List[BlindResponse])
async def get_tournament_blinds(
    tournament_id: UUID,
    current_user: dict = Depends(get_current_user)
):
    """Get all blinds for a tournament, ordered by level."""

    # Verify tournament exists
    tournament_response = supabase.table("tournaments").select("id").eq("id", str(tournament_id)).execute()
    if not tournament_response.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )

    # Get blinds ordered by level
    response = supabase.table("blinds")\
        .select("*")\
        .eq("tournament_id", str(tournament_id))\
        .order("level")\
        .execute()

    return response.data


@router.post("/tournaments/{tournament_id}/blinds", response_model=BlindResponse, status_code=status.HTTP_201_CREATED)
async def create_blind(
    tournament_id: UUID,
    blind: BlindCreateRequest,
    current_user: dict = Depends(get_current_user)
):
    """Create a new blind level for a tournament."""

    # Verify tournament exists
    tournament_response = supabase.table("tournaments").select("id").eq("id", str(tournament_id)).execute()
    if not tournament_response.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )

    # Add tournament_id from URL to the blind data
    blind_data = blind.model_dump()
    blind_data["tournament_id"] = str(tournament_id)

    # Check if blind level already exists for this tournament
    existing = supabase.table("blinds")\
        .select("id")\
        .eq("tournament_id", str(tournament_id))\
        .eq("level", blind.level)\
        .execute()

    if existing.data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Blind level {blind.level} already exists for this tournament"
        )

    # Create blind
    try:
        response = supabase.table("blinds").insert(blind_data).execute()
        if not response.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create blind"
            )
        return response.data[0]
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error creating blind: {str(e)}"
        )


@router.patch("/tournaments/{tournament_id}/blinds/{blind_id}", response_model=BlindResponse)
async def update_blind(
    tournament_id: UUID,
    blind_id: UUID,
    blind_update: BlindUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update an existing blind level."""

    # Verify blind exists and belongs to the tournament
    blind_response = supabase.table("blinds")\
        .select("*")\
        .eq("id", str(blind_id))\
        .eq("tournament_id", str(tournament_id))\
        .execute()

    if not blind_response.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Blind not found or does not belong to this tournament"
        )

    # Prepare update data (only include non-None values)
    update_data = {k: v for k, v in blind_update.model_dump().items() if v is not None}

    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update"
        )

    # If updating level, check it doesn't conflict with existing level
    if "level" in update_data:
        existing = supabase.table("blinds")\
            .select("id")\
            .eq("tournament_id", str(tournament_id))\
            .eq("level", update_data["level"])\
            .neq("id", str(blind_id))\
            .execute()

        if existing.data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Blind level {update_data['level']} already exists for this tournament"
            )

    # Add updated_at timestamp
    update_data["updated_at"] = datetime.utcnow().isoformat()

    # Update blind
    try:
        response = supabase.table("blinds")\
            .update(update_data)\
            .eq("id", str(blind_id))\
            .execute()

        if not response.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update blind"
            )
        return response.data[0]
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error updating blind: {str(e)}"
        )


@router.delete("/tournaments/{tournament_id}/blinds/{blind_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_blind(
    tournament_id: UUID,
    blind_id: UUID,
    current_user: dict = Depends(get_current_user)
):
    """Delete a blind level."""

    # Verify blind exists and belongs to the tournament
    blind_response = supabase.table("blinds")\
        .select("id")\
        .eq("id", str(blind_id))\
        .eq("tournament_id", str(tournament_id))\
        .execute()

    if not blind_response.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Blind not found or does not belong to this tournament"
        )

    # Delete blind
    try:
        supabase.table("blinds").delete().eq("id", str(blind_id)).execute()
        return None
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error deleting blind: {str(e)}"
        )


# ============================================
# Tournament Day Blinds Endpoints
# ============================================

@router.get("/tournament-days/{tournament_day_id}/blinds", response_model=List[BlindResponse])
async def get_tournament_day_blinds(
    tournament_day_id: UUID,
    current_user: dict = Depends(get_current_user)
):
    """Get all blinds for a tournament day, ordered by level."""

    # Verify tournament day exists
    day_response = supabase.table("tournament_days").select("id").eq("id", str(tournament_day_id)).execute()
    if not day_response.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament day not found"
        )

    # Get blinds ordered by level
    response = supabase.table("blinds")\
        .select("*")\
        .eq("tournament_day_id", str(tournament_day_id))\
        .order("level")\
        .execute()

    return response.data


@router.post("/tournament-days/{tournament_day_id}/blinds", response_model=BlindResponse, status_code=status.HTTP_201_CREATED)
async def create_blind_for_day(
    tournament_day_id: UUID,
    blind: BlindCreateRequest,
    current_user: dict = Depends(get_current_user)
):
    """Create a new blind level for a tournament day."""

    # Verify tournament day exists
    day_response = supabase.table("tournament_days").select("id, tournament_id").eq("id", str(tournament_day_id)).execute()
    if not day_response.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament day not found"
        )

    # Add tournament_day_id from URL to the blind data
    blind_data = blind.model_dump()
    blind_data["tournament_day_id"] = str(tournament_day_id)
    # Also store tournament_id for reference
    blind_data["tournament_id"] = day_response.data[0]["tournament_id"]

    # Check if blind level already exists for this tournament day
    existing = supabase.table("blinds")\
        .select("id")\
        .eq("tournament_day_id", str(tournament_day_id))\
        .eq("level", blind.level)\
        .execute()

    if existing.data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Blind level {blind.level} already exists for this tournament day"
        )

    # Create blind
    try:
        response = supabase.table("blinds").insert(blind_data).execute()
        if not response.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create blind"
            )
        return response.data[0]
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error creating blind: {str(e)}"
        )


@router.patch("/tournament-days/{tournament_day_id}/blinds/{blind_id}", response_model=BlindResponse)
async def update_blind_for_day(
    tournament_day_id: UUID,
    blind_id: UUID,
    blind_update: BlindUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update an existing blind level for a tournament day."""

    # Verify blind exists and belongs to the tournament day
    blind_response = supabase.table("blinds")\
        .select("*")\
        .eq("id", str(blind_id))\
        .eq("tournament_day_id", str(tournament_day_id))\
        .execute()

    if not blind_response.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Blind not found or does not belong to this tournament day"
        )

    # Prepare update data (only include non-None values)
    update_data = {k: v for k, v in blind_update.model_dump().items() if v is not None}

    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update"
        )

    # If updating level, check it doesn't conflict with existing level
    if "level" in update_data:
        existing = supabase.table("blinds")\
            .select("id")\
            .eq("tournament_day_id", str(tournament_day_id))\
            .eq("level", update_data["level"])\
            .neq("id", str(blind_id))\
            .execute()

        if existing.data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Blind level {update_data['level']} already exists for this tournament day"
            )

    # Add updated_at timestamp
    update_data["updated_at"] = datetime.utcnow().isoformat()

    # Update blind
    try:
        response = supabase.table("blinds")\
            .update(update_data)\
            .eq("id", str(blind_id))\
            .execute()

        if not response.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update blind"
            )
        return response.data[0]
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error updating blind: {str(e)}"
        )


@router.delete("/tournament-days/{tournament_day_id}/blinds/{blind_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_blind_for_day(
    tournament_day_id: UUID,
    blind_id: UUID,
    current_user: dict = Depends(get_current_user)
):
    """Delete a blind level from a tournament day."""

    # Verify blind exists and belongs to the tournament day
    blind_response = supabase.table("blinds")\
        .select("id")\
        .eq("id", str(blind_id))\
        .eq("tournament_day_id", str(tournament_day_id))\
        .execute()

    if not blind_response.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Blind not found or does not belong to this tournament day"
        )

    # Delete blind
    try:
        supabase.table("blinds").delete().eq("id", str(blind_id)).execute()
        return None
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error deleting blind: {str(e)}"
        )
