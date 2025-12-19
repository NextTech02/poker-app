from typing import List, Optional
from datetime import datetime
from app.database import supabase
from app.models.tournament import TournamentCreate, TournamentUpdate, Tournament, TournamentSummary


class TournamentService:
    @staticmethod
    def create_tournament(tournament_data: TournamentCreate, user_id: str) -> Tournament:
        """Create a new tournament"""
        data = {
            **tournament_data.model_dump(),
            "status": "pending",
            "created_by": user_id,
            "registered_players": 0,
            "prize_pool": 0,
        }

        response = supabase.table("tournaments").insert(data).execute()
        return Tournament(**response.data[0])

    @staticmethod
    def get_tournaments(status: Optional[str] = None, stage_id: Optional[str] = None) -> List[Tournament]:
        """Get all tournaments, optionally filtered by status or stage_id"""
        query = supabase.table("tournaments").select("*")

        if status:
            statuses = status.split(',')
            query = query.in_("status", statuses)

        if stage_id:
            query = query.eq("stage_id", stage_id)

        response = query.order("created_at", desc=True).execute()
        return [Tournament(**item) for item in response.data]

    @staticmethod
    def get_tournament(tournament_id: str) -> Optional[Tournament]:
        """Get a tournament by ID"""
        response = supabase.table("tournaments").select("*").eq("id", tournament_id).execute()

        if response.data:
            return Tournament(**response.data[0])
        return None

    @staticmethod
    def get_tournament_summary(tournament_id: Optional[str] = None) -> List[TournamentSummary]:
        """Get tournament summaries from view"""
        query = supabase.table("tournament_summary").select("*")

        if tournament_id:
            query = query.eq("id", tournament_id)

        response = query.order("created_at", desc=True).execute()
        return [TournamentSummary(**item) for item in response.data]

    @staticmethod
    def update_tournament(tournament_id: str, tournament_data: TournamentUpdate) -> Optional[Tournament]:
        """Update a tournament"""
        data = tournament_data.model_dump(exclude_unset=True)

        # If status is being changed to 'active', set start_time
        if 'status' in data and data['status'] == 'active':
            data['start_time'] = datetime.utcnow().isoformat()

        response = (
            supabase.table("tournaments")
            .update(data)
            .eq("id", tournament_id)
            .execute()
        )

        if response.data:
            return Tournament(**response.data[0])
        return None

    @staticmethod
    def delete_tournament(tournament_id: str) -> bool:
        """Delete a tournament"""
        response = supabase.table("tournaments").delete().eq("id", tournament_id).execute()
        return len(response.data) > 0
