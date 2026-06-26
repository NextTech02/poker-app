import logging
from typing import List, Optional
from collections import Counter
from app.database import supabase
from app.models.stage import StageCreate, StageUpdate, Stage, StageSummary

logger = logging.getLogger("uvicorn.error")


class StageService:
    @staticmethod
    def create_stage(stage_data: StageCreate) -> Stage:
        """Create a new stage"""
        data = stage_data.model_dump()

        # Convert dates to ISO format strings if present
        if data.get('start_date'):
            data['start_date'] = data['start_date'].isoformat()
        if data.get('end_date'):
            data['end_date'] = data['end_date'].isoformat()

        response = supabase.table("stages").insert(data).execute()
        return Stage(**response.data[0])

    @staticmethod
    def get_stage(stage_id: str) -> Optional[Stage]:
        """Get a specific stage by ID"""
        response = supabase.table("stages").select("*").eq("id", stage_id).execute()
        if response.data:
            return Stage(**response.data[0])
        return None

    @staticmethod
    def get_stages(status: Optional[str] = None) -> List[StageSummary]:
        """All stages with tournament_count. Single round-trip via the
        `get_stage_summaries` RPC; falls back to the batched query path if the
        RPC isn't deployed yet."""
        statuses = [s.strip() for s in status.split(",")] if status else None
        try:
            resp = supabase.rpc("get_stage_summaries", {"p_statuses": statuses}).execute()
            return [StageSummary(**row) for row in (resp.data or [])]
        except Exception as exc:
            logger.warning("get_stage_summaries RPC unavailable, using batched fallback: %s", exc)
            return StageService._get_stages_batched(status)

    @staticmethod
    def _get_stages_batched(status: Optional[str] = None) -> List[StageSummary]:
        """Get all stages with tournament count, optionally filtered by status"""
        query = supabase.table("stages").select("*")

        if status:
            # Handle multiple statuses separated by comma
            status_list = [s.strip() for s in status.split(",")]
            if len(status_list) == 1:
                query = query.eq("status", status_list[0])
            else:
                query = query.in_("status", status_list)

        stages = query.order("created_at", desc=True).execute().data or []
        if not stages:
            return []

        # Tournament counts in ONE round-trip instead of one COUNT per stage
        # (N+1). Fetch the stage_id of every tournament in these stages and tally
        # them in memory with a Counter (hash map, O(n)).
        stage_ids = [s["id"] for s in stages]
        tournament_rows = (
            supabase.table("tournaments")
            .select("stage_id")
            .in_("stage_id", stage_ids)
            .execute()
            .data
            or []
        )
        counts = Counter(r["stage_id"] for r in tournament_rows if r.get("stage_id"))

        return [
            StageSummary(**stage_data, tournament_count=counts.get(stage_data["id"], 0))
            for stage_data in stages
        ]

    @staticmethod
    def update_stage(stage_id: str, stage_data: StageUpdate) -> Optional[Stage]:
        """Update a stage"""
        data = stage_data.model_dump(exclude_unset=True)

        # Convert dates to ISO format strings if present
        if 'start_date' in data and data['start_date']:
            data['start_date'] = data['start_date'].isoformat()
        if 'end_date' in data and data['end_date']:
            data['end_date'] = data['end_date'].isoformat()

        response = (
            supabase.table("stages")
            .update(data)
            .eq("id", stage_id)
            .execute()
        )

        if response.data:
            return Stage(**response.data[0])
        return None

    @staticmethod
    def delete_stage(stage_id: str) -> bool:
        """Delete a stage (tournaments will have stage_id set to NULL)"""
        response = supabase.table("stages").delete().eq("id", stage_id).execute()
        return len(response.data) > 0
