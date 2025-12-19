from app.database import supabase
from datetime import datetime, timedelta


class DashboardService:
    @staticmethod
    def get_stats():
        """Get dashboard statistics"""

        # Get active tournaments
        active_tournaments = (
            supabase.table("tournaments")
            .select("id", count="exact")
            .eq("status", "active")
            .execute()
        )
        active_count = active_tournaments.count or 0

        # Get total players from active tournaments
        total_players = (
            supabase.table("transactions")
            .select("id", count="exact")
            .execute()
        )
        player_count = total_players.count or 0

        # Get total revenue
        all_transactions = supabase.table("transactions").select("amount").execute()
        total_revenue = sum(float(t["amount"]) for t in all_transactions.data)

        # Get today's revenue
        today = datetime.now().date().isoformat()
        today_transactions = (
            supabase.table("transactions")
            .select("amount")
            .gte("created_at", today)
            .execute()
        )
        today_revenue = sum(float(t["amount"]) for t in today_transactions.data)

        return {
            "activeTournaments": active_count,
            "totalPlayers": player_count,
            "totalRevenue": total_revenue,
            "todayRevenue": today_revenue,
        }
