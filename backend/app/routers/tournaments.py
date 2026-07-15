from fastapi import APIRouter, Depends, HTTPException, status
from typing import List, Optional
from app.models.tournament import TournamentCreate, TournamentUpdate, Tournament, TournamentSummary
from app.services.tournament_service import TournamentService
from app.auth.jwt import get_current_user
from app.dependencies import get_stage_id_optional

router = APIRouter(prefix="/tournaments", tags=["tournaments"])


@router.post("", response_model=Tournament, status_code=status.HTTP_201_CREATED)
def create_tournament(
    tournament: TournamentCreate,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """Create a new tournament. A stage (etapa) is mandatory: it comes from the
    X-Stage-ID header (preferred) or the request body, and must reference an
    existing stage."""
    user_id = current_user.get("sub")

    # Stage is required: never allow creating a tournament without an etapa.
    # The header takes precedence; fall back to a stage_id supplied in the body.
    effective_stage_id = stage_id or tournament.stage_id
    if not effective_stage_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="É necessário selecionar uma etapa antes de criar um torneio."
        )

    tournament.stage_id = effective_stage_id

    # Validate stage exists
    from app.database.supabase_client import supabase
    stage_response = supabase.table('stages').select('id').eq('id', effective_stage_id).execute()
    if not stage_response.data:
        raise HTTPException(
            status_code=404,
            detail=f"Stage with id {effective_stage_id} not found"
        )

    return TournamentService.create_tournament(tournament, user_id)


@router.get("", response_model=List[TournamentSummary])
def get_tournaments(
    stage_id: Optional[str] = None,
    header_stage_id: Optional[str] = Depends(get_stage_id_optional),
    current_user: dict = Depends(get_current_user),
):
    """
    Get all tournaments with aggregated entries from non-final days.
    If X-Stage-ID header is present, it takes precedence over stage_id query parameter.

    Requires authentication: this lists every tournament across stages and is
    only used by the authenticated operator UI. The public broadcast view reads
    a single tournament via GET /tournaments/{id}, which stays open by design.
    """
    effective_stage_id = header_stage_id if header_stage_id else stage_id
    return TournamentService.get_tournament_summary(stage_id=effective_stage_id)


@router.get("/{tournament_id}", response_model=Tournament)
def get_tournament(tournament_id: str):
    """Get a specific tournament by ID"""
    tournament = TournamentService.get_tournament(tournament_id)
    if not tournament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )
    return tournament


@router.patch("/{tournament_id}", response_model=Tournament)
def update_tournament(
    tournament_id: str,
    tournament_data: TournamentUpdate,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Update a tournament.
    If X-Stage-ID header is present, validates that tournament belongs to that stage.
    """
    # Validate tournament belongs to stage if stage_id is provided
    if stage_id:
        existing_tournament = TournamentService.get_tournament(tournament_id)
        if not existing_tournament:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Tournament not found"
            )
        if existing_tournament.stage_id != stage_id:
            raise HTTPException(
                status_code=403,
                detail="Tournament does not belong to the selected stage"
            )

    tournament = TournamentService.update_tournament(tournament_id, tournament_data)
    if not tournament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )
    return tournament


@router.delete("/{tournament_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tournament(
    tournament_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Delete a tournament.
    If X-Stage-ID header is present, validates that tournament belongs to that stage.
    """
    # Validate tournament belongs to stage if stage_id is provided
    if stage_id:
        existing_tournament = TournamentService.get_tournament(tournament_id)
        if not existing_tournament:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Tournament not found"
            )
        if existing_tournament.stage_id != stage_id:
            raise HTTPException(
                status_code=403,
                detail="Tournament does not belong to the selected stage"
            )

    success = TournamentService.delete_tournament(tournament_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )
