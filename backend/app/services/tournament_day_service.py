from typing import List, Optional
from datetime import datetime
from app.database import supabase
from app.models.tournament_day import (
    TournamentDayCreate,
    TournamentDayUpdate,
    TournamentDay,
    TournamentDaySummary
)


class TournamentDayService:
    @staticmethod
    def create_tournament_day(day_data: TournamentDayCreate) -> TournamentDay:
        """Create a new tournament day"""
        data = {
            **day_data.model_dump(),
            "status": "pending",
            "registered_players": 0,
            "total_entries": 0,
            "prize_pool": 0,
        }

        response = supabase.table("tournament_days").insert(data).execute()
        return TournamentDay(**response.data[0])

    @staticmethod
    def get_tournament_days(
        tournament_id: Optional[str] = None,
        status: Optional[str] = None
    ) -> List[TournamentDay]:
        """Get tournament days, optionally filtered by tournament_id or status"""
        query = supabase.table("tournament_days").select("*")

        if tournament_id:
            query = query.eq("tournament_id", tournament_id)

        if status:
            statuses = status.split(',')
            query = query.in_("status", statuses)

        response = query.order("day_number", desc=False).execute()

        # Calculate total_entries for each day
        days = []
        for item in response.data:
            # Get total entries (buy_in_count + rebuy_count) from tournament_players
            players_response = supabase.table("tournament_players")\
                .select("buy_in_count, rebuy_count")\
                .eq("tournament_day_id", item["id"])\
                .execute()

            total_entries = 0
            if players_response.data:
                for player in players_response.data:
                    buy_ins = player.get("buy_in_count", 0) or 0
                    rebuys = player.get("rebuy_count", 0) or 0
                    total_entries += buy_ins + rebuys

            item["total_entries"] = total_entries
            days.append(TournamentDay(**item))

        return days

    @staticmethod
    def get_tournament_day(day_id: str) -> Optional[TournamentDay]:
        """Get a tournament day by ID"""
        response = supabase.table("tournament_days").select("*").eq("id", day_id).execute()

        if response.data:
            item = response.data[0]

            # Calculate total_entries
            players_response = supabase.table("tournament_players")\
                .select("buy_in_count, rebuy_count")\
                .eq("tournament_day_id", day_id)\
                .execute()

            total_entries = 0
            if players_response.data:
                for player in players_response.data:
                    buy_ins = player.get("buy_in_count", 0) or 0
                    rebuys = player.get("rebuy_count", 0) or 0
                    total_entries += buy_ins + rebuys

            item["total_entries"] = total_entries
            return TournamentDay(**item)
        return None

    @staticmethod
    def get_tournament_day_summary(
        tournament_id: Optional[str] = None,
        day_id: Optional[str] = None
    ) -> List[TournamentDaySummary]:
        """Get tournament day summaries with aggregated data"""
        query = supabase.table("tournament_days").select("*")

        if tournament_id:
            query = query.eq("tournament_id", tournament_id)

        if day_id:
            query = query.eq("id", day_id)

        response = query.order("day_number", desc=False).execute()

        summaries = []
        for item in response.data:
            # Get player statistics
            players_response = supabase.table("tournament_players")\
                .select("buy_in_count, rebuy_count, addon_count")\
                .eq("tournament_day_id", item["id"])\
                .execute()

            total_entries = 0
            total_buy_ins = 0
            total_rebuys = 0
            total_addons = 0

            if players_response.data:
                for player in players_response.data:
                    buy_ins = player.get("buy_in_count", 0) or 0
                    rebuys = player.get("rebuy_count", 0) or 0
                    addons = player.get("addon_count", 0) or 0

                    total_buy_ins += buy_ins
                    total_rebuys += rebuys
                    total_addons += addons
                    total_entries += buy_ins + rebuys  # addons not counted

            item["total_entries"] = total_entries
            item["total_buy_ins"] = total_buy_ins
            item["total_rebuys"] = total_rebuys
            item["total_addons"] = total_addons

            summaries.append(TournamentDaySummary(**item))

        return summaries

    @staticmethod
    def update_tournament_day(day_id: str, day_data: TournamentDayUpdate) -> Optional[TournamentDay]:
        """Update a tournament day"""
        data = day_data.model_dump(exclude_unset=True)

        # If status is being changed to 'active', set start_time
        if 'status' in data and data['status'] == 'active':
            data['start_time'] = datetime.utcnow().isoformat()

        response = (
            supabase.table("tournament_days")
            .update(data)
            .eq("id", day_id)
            .execute()
        )

        if response.data:
            return TournamentDay(**response.data[0])
        return None

    @staticmethod
    def delete_tournament_day(day_id: str) -> bool:
        """Delete a tournament day"""
        response = supabase.table("tournament_days").delete().eq("id", day_id).execute()
        return len(response.data) > 0

    @staticmethod
    def get_days_by_tournament(tournament_id: str) -> List[TournamentDay]:
        """Get all days for a specific tournament, ordered by day_number"""
        return TournamentDayService.get_tournament_days(tournament_id=tournament_id)
