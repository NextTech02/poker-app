from app.database import supabase
from datetime import datetime, timedelta


class DashboardService:
    @staticmethod
    def _get_stage_tournament_ids(stage_id: str) -> list:
        """Get tournament IDs belonging to a stage"""
        stage_tournaments = (
            supabase.table("tournaments")
            .select("id")
            .eq("stage_id", stage_id)
            .execute()
        )
        return [t["id"] for t in stage_tournaments.data]

    @staticmethod
    def get_stats(stage_id: str = None):
        """Get dashboard statistics"""

        # If filtering by stage, get tournament IDs once
        tournament_ids = None
        if stage_id:
            tournament_ids = DashboardService._get_stage_tournament_ids(stage_id)
            if not tournament_ids:
                return {
                    "activeTournaments": 0,
                    "totalPlayers": 0,
                    "totalRevenue": 0,
                    "todayRevenue": 0,
                }

        # Get active tournament days (status lives on tournament_days, not tournaments)
        active_query = (
            supabase.table("tournament_days")
            .select("id", count="exact")
            .eq("status", "active")
        )
        if tournament_ids:
            active_query = active_query.in_("tournament_id", tournament_ids)
        active_days = active_query.execute()
        active_count = active_days.count or 0

        # Get active players from tournament days
        players_query = (
            supabase.table("tournament_players")
            .select("id", count="exact")
            .eq("status", "active")
        )
        if tournament_ids:
            # Get day IDs for these tournaments
            day_ids_res = (
                supabase.table("tournament_days")
                .select("id")
                .in_("tournament_id", tournament_ids)
                .execute()
            )
            day_ids = [d["id"] for d in day_ids_res.data]
            if day_ids:
                players_query = players_query.in_("tournament_day_id", day_ids)
            else:
                players_query = None

        player_count = 0
        if players_query:
            active_players = players_query.execute()
            player_count = active_players.count or 0

        # Get total revenue (transactions linked via tournament_id)
        revenue_query = supabase.table("transactions").select("amount")
        if tournament_ids:
            revenue_query = revenue_query.in_("tournament_id", tournament_ids)
        all_transactions = revenue_query.execute()
        total_revenue = sum(float(t["amount"]) for t in all_transactions.data)

        # Get today's revenue
        today = datetime.now().date().isoformat()
        today_query = (
            supabase.table("transactions")
            .select("amount")
            .gte("created_at", today)
        )
        if tournament_ids:
            today_query = today_query.in_("tournament_id", tournament_ids)
        today_transactions = today_query.execute()
        today_revenue = sum(float(t["amount"]) for t in today_transactions.data)

        return {
            "activeTournaments": active_count,
            "totalPlayers": player_count,
            "totalRevenue": total_revenue,
            "todayRevenue": today_revenue,
        }
