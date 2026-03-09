from typing import List, Optional
from datetime import datetime
from app.database import supabase
from app.models.tournament import TournamentCreate, TournamentUpdate, Tournament, TournamentSummary


class TournamentService:
    @staticmethod
    def create_tournament(tournament_data: TournamentCreate, user_id: str) -> Tournament:
        """Create a new tournament - simplified to just name and stage"""
        data = {
            **tournament_data.model_dump(),
            "created_by": user_id,
        }

        response = supabase.table("tournaments").insert(data).execute()
        return Tournament(**response.data[0])

    @staticmethod
    def get_tournaments(stage_id: Optional[str] = None) -> List[Tournament]:
        """Get all tournaments, optionally filtered by stage_id"""
        query = supabase.table("tournaments").select("*")

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
    def get_tournament_summary(tournament_id: Optional[str] = None, stage_id: Optional[str] = None) -> List[TournamentSummary]:
        """Get tournament summaries with aggregated data from all tournament days"""
        query = supabase.table("tournaments").select("*")

        if tournament_id:
            query = query.eq("id", tournament_id)

        if stage_id:
            query = query.eq("stage_id", stage_id)

        response = query.order("created_at", desc=True).execute()

        summaries = []
        for item in response.data:
            # Get all days for this tournament
            days_response = supabase.table("tournament_days")\
                .select("id, total_entries, day_type")\
                .eq("tournament_id", item["id"])\
                .execute()

            # Calculate aggregated total_entries from non-final days only
            # Final days inherit data from qualifying days and should not be counted
            total_entries = 0
            total_days = 0
            if days_response.data:
                total_days = len(days_response.data)
                for day in days_response.data:
                    if day.get("day_type") == "final":
                        continue

                    # Get total entries from players for this day
                    players_response = supabase.table("tournament_players")\
                        .select("buy_in_count, rebuy_count")\
                        .eq("tournament_day_id", day["id"])\
                        .execute()

                    if players_response.data:
                        for player in players_response.data:
                            buy_ins = player.get("buy_in_count", 0) or 0
                            rebuys = player.get("rebuy_count", 0) or 0
                            total_entries += buy_ins + rebuys

            item["total_entries"] = total_entries
            item["total_days"] = total_days
            summaries.append(TournamentSummary(**item))

        return summaries

    @staticmethod
    def update_tournament(tournament_id: str, tournament_data: TournamentUpdate) -> Optional[Tournament]:
        """Update a tournament (name and/or stage_id)"""
        data = tournament_data.model_dump(exclude_unset=True)

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
