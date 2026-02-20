from fastapi import APIRouter, Depends, HTTPException, status
from typing import List, Optional
from pydantic import BaseModel
from app.models.tournament_day import (
    TournamentDayCreate,
    TournamentDayUpdate,
    TournamentDay,
    TournamentDaySummary,
    QualifyingDayStats,
    FinalDayAggregatedStats,
    TimerAdjustment,
    TimerStatus,
    EliminationCountAdjust
)
from app.services.tournament_day_service import TournamentDayService
from app.services.tournament_service import TournamentService
from app.auth.jwt import get_current_user
from app.dependencies import get_stage_id_optional


class ChipUpdate(BaseModel):
    player_id: str
    chip_count: int


class BulkChipUpdate(BaseModel):
    updates: List[ChipUpdate]


class AdvanceQualifiersResponse(BaseModel):
    advanced_count: int
    final_day_id: str
    final_day_name: str
    total_chips: int = 0
    total_entries: int = 0
    players: List[dict] = []

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


@router.get("/{day_id}/survivors", response_model=List[dict])
def get_day_survivors(
    day_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get all surviving (non-eliminated) players from a tournament day.
    Useful for qualifying days to see who will advance.
    """
    # Validate day exists
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

    return TournamentDayService.get_survivors(day_id)


@router.post("/{day_id}/advance-qualifiers", response_model=AdvanceQualifiersResponse)
def advance_qualifiers(
    day_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Advance all surviving players from a qualifying day to its linked final day.
    Creates entries in the final day with is_qualified_entry=True (no buy-in).
    Players maintain their chip count from the qualifying day.
    """
    # Validate day exists
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

    try:
        result = TournamentDayService.advance_qualifiers(day_id)
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.patch("/{day_id}/player-chips/{player_id}")
def update_player_chips(
    day_id: str,
    player_id: str,
    chip_count: int,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Update the final chip count for a player in a tournament day.
    Used at end of day to record chips for carrying over to next day.
    """
    # Validate day exists
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

    success = TournamentDayService.update_player_chips(day_id, player_id, chip_count)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Player not found in this day"
        )

    return {"success": True, "player_id": player_id, "chip_count": chip_count}


@router.post("/{day_id}/bulk-update-chips")
def bulk_update_chips(
    day_id: str,
    data: BulkChipUpdate,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Bulk update chip counts for multiple players in a tournament day.
    Useful for recording final chip counts at end of qualifying day.
    """
    # Validate day exists
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

    updates = [{"player_id": u.player_id, "chip_count": u.chip_count} for u in data.updates]
    updated_count = TournamentDayService.bulk_update_chips(day_id, updates)

    return {"success": True, "updated_count": updated_count}


@router.get("/{day_id}/stats", response_model=QualifyingDayStats)
def get_day_stats(
    day_id: str,
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get detailed statistics for a single tournament day.
    Shows player counts, entry counts, and financial totals.
    Useful for qualifying days to see encapsulated data.
    """
    # Validate day exists
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

    try:
        return TournamentDayService.get_qualifying_day_stats(day_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.get("/{day_id}/aggregated-stats", response_model=FinalDayAggregatedStats)
def get_final_day_aggregated_stats(
    day_id: str,
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get aggregated statistics for a final day from all qualifying days.

    Returns comprehensive stats including:
    - Per-qualifying-day breakdown (encapsulated data per day)
    - Total aggregated stats from all qualifying days
    - Final day specific stats (direct buy-ins)
    - Combined totals (qualifying + final day)

    Use this endpoint to view the consolidated data of all qualifying days
    that feed into a final day.
    """
    # Validate day exists
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

    try:
        return TournamentDayService.get_final_day_aggregated_stats(day_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


# ================================================
# Timer Control Endpoints
# ================================================

@router.post("/{day_id}/timer/start")
def start_tournament_timer(
    day_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Start or resume tournament timer.
    Sets status to active and begins timing.
    """
    # Validate day exists
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

    try:
        result = TournamentDayService.start_timer(day_id)
        return {"success": True, "data": result}
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.post("/{day_id}/timer/pause")
def pause_tournament_timer(
    day_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Pause tournament timer.
    Saves current elapsed time and stops counting.
    """
    # Validate day exists
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

    try:
        result = TournamentDayService.pause_timer(day_id)
        return {"success": True, "data": result}
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.post("/{day_id}/timer/adjust")
def adjust_tournament_timer(
    day_id: str,
    adjustment: TimerAdjustment,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Manually adjust timer by adding or subtracting seconds.
    Use positive values to add time, negative to subtract.
    """
    # Validate day exists
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

    try:
        result = TournamentDayService.adjust_timer(day_id, adjustment.seconds)
        return {"success": True, "data": result}
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.post("/{day_id}/timer/next-level")
def next_blind_level(
    day_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Advance to next blind level.
    """
    # Validate day exists
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

    try:
        result = TournamentDayService.next_level(day_id)
        return {"success": True, "data": result}
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.post("/{day_id}/timer/prev-level")
def previous_blind_level(
    day_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Go back to previous blind level.
    Cannot go below level 1.
    """
    # Validate day exists
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

    try:
        result = TournamentDayService.previous_level(day_id)
        return {"success": True, "data": result}
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.post("/{day_id}/timer/reset")
def reset_tournament_timer(
    day_id: str,
    stage_id: Optional[str] = Depends(get_stage_id_optional),
    current_user: dict = Depends(get_current_user)
):
    """
    Reset timer to 00:00 and pause.
    Resets elapsed time, adjustments, and returns to level 1.
    """
    # Validate day exists
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

    try:
        result = TournamentDayService.reset_timer(day_id)
        return {"success": True, "message": "Timer reset successfully", "data": result}
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.get("/{day_id}/timer/status", response_model=TimerStatus)
def get_tournament_timer_status(
    day_id: str,
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get current timer status including level, elapsed time, and player counts.
    Public endpoint - no authentication required for broadcast display.
    """
    # Validate day exists
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

    try:
        return TournamentDayService.get_timer_status(day_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.get("/{day_id}/timer/status-enriched")
def get_tournament_timer_status_enriched(
    day_id: str,
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get enriched timer status with current/next blind info and break countdown.
    Includes:
    - Current blind details (small_blind, big_blind, ante, duration, is_break)
    - Next blind preview
    - Time remaining in current level
    - Next break information and time until break
    - Active players and total entries

    Public endpoint - no authentication required for broadcast display.
    """
    # Validate day exists
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

    try:
        return TournamentDayService.get_enriched_timer_status(day_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.post("/{day_id}/eliminations")
def adjust_eliminations(
    day_id: str,
    data: EliminationCountAdjust,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Adjust the eliminations counter.
    Send count=1 to eliminate one, count=5 for bulk, count=-1 to undo.
    Active players = total_entries - eliminations_count.
    """
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

    try:
        result = TournamentDayService.adjust_eliminations(day_id, data.count)
        return {"success": True, **result}
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.post("/{day_id}/tables-lock")
def toggle_tables_lock(
    day_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Toggle the tables_locked flag for a tournament day.
    When locked, new buy-ins skip auto-allocation and players become alternates.
    """
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

    from app.database import supabase
    new_locked = not getattr(existing_day, 'tables_locked', False)
    supabase.table("tournament_days").update({"tables_locked": new_locked}).eq("id", day_id).execute()
    return {"success": True, "tables_locked": new_locked}
