from typing import List, Optional
from app.database import supabase
from app.models.stage import StageCreate, StageUpdate, Stage, StageSummary


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
        """Get all stages with tournament count, optionally filtered by status"""
        query = supabase.table("stages").select("*")

        if status:
            # Handle multiple statuses separated by comma
            status_list = [s.strip() for s in status.split(",")]
            if len(status_list) == 1:
                query = query.eq("status", status_list[0])
            else:
                query = query.in_("status", status_list)

        response = query.order("created_at", desc=True).execute()

        # Get tournament count for each stage
        stages_with_count = []
        for stage_data in response.data:
            # Count tournaments in this stage
            tournaments_response = supabase.table("tournaments").select("id", count="exact").eq("stage_id", stage_data["id"]).execute()
            tournament_count = tournaments_response.count if tournaments_response.count else 0

            stages_with_count.append(StageSummary(
                **stage_data,
                tournament_count=tournament_count
            ))

        return stages_with_count

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
