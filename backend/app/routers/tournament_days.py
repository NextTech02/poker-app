from fastapi import APIRouter, Depends, HTTPException, status
from typing import List, Optional
from app.models.tournament_day import (
    TournamentDayCreate,
    TournamentDayUpdate,
    TournamentDay,
    TournamentDaySummary
)
from app.services.tournament_day_service import TournamentDayService
from app.services.tournament_service import TournamentService
from app.auth.jwt import get_current_user
from app.dependencies import get_stage_id_optional

router = APIRouter(prefix="/tournament-days", tags=["tournament-days"])


@router.post("", response_model=TournamentDay, status_code=status.HTTP_201_CREATED)
def create_tournament_day(
    day_data: TournamentDayCreate,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Create a new tournament day.
    If X-Stage-ID header is provided, validates that the parent tournament belongs to that stage.
    """
    # Validate that the tournament exists and belongs to the stage if stage_id is provided
    tournament = TournamentService.get_tournament(day_data.tournament_id)
    if not tournament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tournament with id {day_data.tournament_id} not found"
        )

    if stage_id and tournament.stage_id != stage_id:
        raise HTTPException(
            status_code=403,
            detail="Tournament does not belong to the selected stage"
        )

    return TournamentDayService.create_tournament_day(day_data)


@router.get("", response_model=List[TournamentDay])
def get_tournament_days(
    tournament_id: Optional[str] = None,
    status_filter: Optional[str] = None,
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get all tournament days, optionally filtered by tournament_id or status.
    If X-Stage-ID header is present and tournament_id is not specified,
    returns all tournament days for tournaments in that stage.
    """
    # If stage_id is provided but tournament_id is not, we need to get all tournaments in that stage first
    if stage_id and not tournament_id:
        tournaments = TournamentService.get_tournaments(stage_id=stage_id)
        tournament_ids = [t.id for t in tournaments]

        # Get days for all tournaments in the stage
        all_days = []
        for tid in tournament_ids:
            days = TournamentDayService.get_tournament_days(
                tournament_id=tid,
                status=status_filter
            )
            all_days.extend(days)
        return all_days

    return TournamentDayService.get_tournament_days(
        tournament_id=tournament_id,
        status=status_filter
    )


@router.get("/summary", response_model=List[TournamentDaySummary])
def get_tournament_days_summary(
    tournament_id: Optional[str] = None,
    day_id: Optional[str] = None,
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get tournament day summaries with aggregated statistics.
    If X-Stage-ID header is present and tournament_id is not specified,
    returns summaries for all tournament days in that stage.
    """
    # If stage_id is provided but tournament_id is not, get all tournaments in that stage
    if stage_id and not tournament_id:
        tournaments = TournamentService.get_tournaments(stage_id=stage_id)
        tournament_ids = [t.id for t in tournaments]

        # Get summaries for all tournaments in the stage
        all_summaries = []
        for tid in tournament_ids:
            summaries = TournamentDayService.get_tournament_day_summary(tournament_id=tid)
            all_summaries.extend(summaries)
        return all_summaries

    return TournamentDayService.get_tournament_day_summary(
        tournament_id=tournament_id,
        day_id=day_id
    )


@router.get("/tournament/{tournament_id}", response_model=List[TournamentDay])
def get_days_by_tournament(
    tournament_id: str,
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get all days for a specific tournament.
    If X-Stage-ID header is present, validates that tournament belongs to that stage.
    """
    # Validate tournament exists and belongs to stage if stage_id is provided
    tournament = TournamentService.get_tournament(tournament_id)
    if not tournament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )

    if stage_id and tournament.stage_id != stage_id:
        raise HTTPException(
            status_code=403,
            detail="Tournament does not belong to the selected stage"
        )

    return TournamentDayService.get_days_by_tournament(tournament_id)


@router.get("/{day_id}", response_model=TournamentDay)
def get_tournament_day(
    day_id: str,
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get a specific tournament day by ID.
    If X-Stage-ID header is present, validates that the day's tournament belongs to that stage.
    """
    day = TournamentDayService.get_tournament_day(day_id)
    if not day:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament day not found"
        )

    # Validate tournament belongs to stage if stage_id is provided
    if stage_id:
        tournament = TournamentService.get_tournament(day.tournament_id)
        if tournament and tournament.stage_id != stage_id:
            raise HTTPException(
                status_code=403,
                detail="Tournament day does not belong to the selected stage"
            )

    return day


@router.patch("/{day_id}", response_model=TournamentDay)
def update_tournament_day(
    day_id: str,
    day_data: TournamentDayUpdate,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Update a tournament day.
    If X-Stage-ID header is present, validates that the day's tournament belongs to that stage.
    """
    # Validate day exists and belongs to stage if stage_id is provided
    existing_day = TournamentDayService.get_tournament_day(day_id)
    if not existing_day:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament day not found"
        )

    if stage_id:
        tournament = TournamentService.get_tournament(existing_day.tournament_id)
        if tournament and tournament.stage_id != stage_id:
            raise HTTPException(
                status_code=403,
                detail="Tournament day does not belong to the selected stage"
            )

    day = TournamentDayService.update_tournament_day(day_id, day_data)
    if not day:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament day not found"
        )
    return day


@router.delete("/{day_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tournament_day(
    day_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Delete a tournament day.
    If X-Stage-ID header is present, validates that the day's tournament belongs to that stage.
    """
    # Validate day exists and belongs to stage if stage_id is provided
    existing_day = TournamentDayService.get_tournament_day(day_id)
    if not existing_day:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament day not found"
        )

    if stage_id:
        tournament = TournamentService.get_tournament(existing_day.tournament_id)
        if tournament and tournament.stage_id != stage_id:
            raise HTTPException(
                status_code=403,
                detail="Tournament day does not belong to the selected stage"
            )

    success = TournamentDayService.delete_tournament_day(day_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament day not found"
        )
