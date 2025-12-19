from typing import Optional
from datetime import datetime
from app.database import supabase
from app.models.report import ReportSummary, PlayerReport


class ReportService:
    @staticmethod
    def get_reports(start_date: Optional[str] = None, end_date: Optional[str] = None) -> ReportSummary:
        """Generate comprehensive reports for a date range"""

        # Build query for transactions
        query = supabase.table("transactions").select("*")

        if start_date:
            query = query.gte("created_at", start_date)
        if end_date:
            # Add one day to include the end date
            end_datetime = datetime.fromisoformat(end_date)
            end_datetime = end_datetime.replace(hour=23, minute=59, second=59)
            query = query.lte("created_at", end_datetime.isoformat())

        transactions = query.execute().data

        # Calculate totals
        total_revenue = sum(float(t["amount"]) for t in transactions if t["type"] in ["buy_in", "rebuy", "addon"])
        total_buy_ins = sum(1 for t in transactions if t["type"] == "buy_in")
        total_rebuys = sum(1 for t in transactions if t["type"] == "rebuy")
        total_addons = sum(1 for t in transactions if t["type"] == "addon")
        total_entries = total_buy_ins + total_rebuys + total_addons

        # Calculate average buy-in
        buy_in_amounts = [float(t["amount"]) for t in transactions if t["type"] == "buy_in"]
        avg_buy_in = sum(buy_in_amounts) / len(buy_in_amounts) if buy_in_amounts else 0

        # Get tournament count
        tournament_query = supabase.table("tournaments").select("id", count="exact")
        if start_date:
            tournament_query = tournament_query.gte("created_at", start_date)
        if end_date:
            tournament_query = tournament_query.lte("created_at", end_date)

        tournament_count = tournament_query.execute().count or 0

        # Generate player reports from tournament_players data
        player_query = supabase.table("tournament_players").select("*, players(name)")

        # Join with tournaments to filter by date if needed
        if start_date or end_date:
            # Get tournament IDs in date range
            date_query = supabase.table("tournaments").select("id")
            if start_date:
                date_query = date_query.gte("created_at", start_date)
            if end_date:
                date_query = date_query.lte("created_at", end_date)
            tournament_ids = [t["id"] for t in date_query.execute().data]

            if tournament_ids:
                player_query = player_query.in_("tournament_id", tournament_ids)
            else:
                # No tournaments in range, return empty player reports
                player_data = []
        else:
            player_data = player_query.execute().data

        # Aggregate player stats
        player_stats = {}
        if 'player_data' not in locals():
            player_data = player_query.execute().data

        for tp in player_data:
            player_info = tp.get("players", {})
            player_name = player_info.get("name", "Unknown")

            if player_name not in player_stats:
                player_stats[player_name] = {
                    "player_name": player_name,
                    "total_entries": 0,
                    "buy_ins": 0,
                    "rebuys": 0,
                    "addons": 0,
                    "total_spent": 0.0,
                }

            player_stats[player_name]["total_entries"] += tp["buy_in_count"] + tp["rebuy_count"] + tp["addon_count"]
            player_stats[player_name]["buy_ins"] += tp["buy_in_count"]
            player_stats[player_name]["rebuys"] += tp["rebuy_count"]
            player_stats[player_name]["addons"] += tp["addon_count"]
            player_stats[player_name]["total_spent"] += float(tp["total_spent"])

        player_reports = [PlayerReport(**stats) for stats in player_stats.values()]

        return ReportSummary(
            totalRevenue=total_revenue,
            totalTournaments=tournament_count,
            totalPlayers=total_entries,
            avgBuyIn=avg_buy_in,
            totalBuyIns=total_buy_ins,
            totalRebuys=total_rebuys,
            totalAddons=total_addons,
            playerReports=player_reports,
        )
