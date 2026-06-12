from typing import Optional
from datetime import datetime
from decimal import Decimal
from app.database import supabase
from app.models.report import (
    ReportSummary,
    PlayerReport,
    TournamentReport,
    TournamentDayReport,
    TournamentPrizeRow,
)


class ReportService:

    @staticmethod
    def get_tournament_report(tournament_id: str) -> TournamentReport:
        """Comprehensive per-tournament report: participation, financials and
        prize execution (distributed vs reserved vs vagas)."""
        from fastapi import HTTPException

        t_resp = supabase.table("tournaments")\
            .select("*, sponsors(name)")\
            .eq("id", tournament_id)\
            .execute()
        if not t_resp.data:
            raise HTTPException(status_code=404, detail="Torneio não encontrado")
        t = t_resp.data[0]
        sponsor = t.pop("sponsors", None) or {}

        # ── Days ──
        days_resp = supabase.table("tournament_days")\
            .select("id, day_name, day_type, status, buy_in")\
            .eq("tournament_id", tournament_id)\
            .order("created_at")\
            .execute()
        days = days_resp.data or []

        # ── Participation per day (from tournament_players) ──
        # Batch: fetch all days' players in one query, then group in memory,
        # instead of one query per day (1 + N round-trips to a remote Postgres).
        day_ids = [d["id"] for d in days]
        tps_by_day: dict = {}
        if day_ids:
            all_tp_resp = supabase.table("tournament_players")\
                .select("tournament_day_id, player_id, buy_in_count, rebuy_count, addon_count, total_buy_in_amount, total_rebuy_amount, total_addon_amount")\
                .in_("tournament_day_id", day_ids)\
                .execute()
            for p in (all_tp_resp.data or []):
                tps_by_day.setdefault(p.get("tournament_day_id"), []).append(p)

        day_reports = []
        distinct_players = set()
        tot_buy_ins = tot_rebuys = tot_addons = 0
        for d in days:
            tps = tps_by_day.get(d["id"], [])
            d_buy_ins = sum(int(p.get("buy_in_count") or 0) for p in tps)
            d_rebuys = sum(int(p.get("rebuy_count") or 0) for p in tps)
            d_addons = sum(int(p.get("addon_count") or 0) for p in tps)
            d_rev = sum(
                float(p.get("total_buy_in_amount") or 0)
                + float(p.get("total_rebuy_amount") or 0)
                + float(p.get("total_addon_amount") or 0)
                for p in tps
            )
            for p in tps:
                if p.get("player_id"):
                    distinct_players.add(p["player_id"])
            tot_buy_ins += d_buy_ins
            tot_rebuys += d_rebuys
            tot_addons += d_addons
            day_reports.append(TournamentDayReport(
                day_id=d["id"],
                day_name=d.get("day_name") or "",
                day_type=d.get("day_type"),
                status=d.get("status"),
                buy_in=float(d.get("buy_in") or 0),
                players=len({p["player_id"] for p in tps if p.get("player_id")}),
                buy_ins=d_buy_ins,
                rebuys=d_rebuys,
                addons=d_addons,
                revenue=d_rev,
            ))

        # ── Revenue from transactions ──
        tx_resp = supabase.table("transactions")\
            .select("amount, type")\
            .eq("tournament_id", tournament_id)\
            .in_("type", ["buy_in", "rebuy", "addon"])\
            .execute()
        total_revenue = sum(float(x["amount"]) for x in (tx_resp.data or []))

        # ── Prize pool + reserved (reuse PrizeAllocationService) ──
        from app.services.prize_allocation_service import PrizeAllocationService
        summary = PrizeAllocationService.get_prize_summary(tournament_id)

        # ── Prize allocations detail ──
        alloc_resp = supabase.table("prize_allocations")\
            .select("*, players(name)")\
            .eq("tournament_id", tournament_id)\
            .order("position")\
            .execute()
        allocs = alloc_resp.data or []
        prize_rows = []
        total_distributed = 0.0
        pending_release = 0
        vagas_count = 0
        vagas_generated = 0
        for a in allocs:
            pname = (a.get("players") or {}).get("name")
            ptype = a.get("prize_type", "cash")
            paid = bool(a.get("paid"))
            if paid and ptype == "cash":
                total_distributed += float(a.get("prize_amount") or 0)
            if not a.get("released"):
                pending_release += 1
            if ptype == "vaga":
                vagas_count += 1
                if a.get("generated_ticket_id"):
                    vagas_generated += 1
            prize_rows.append(TournamentPrizeRow(
                position=a["position"],
                prize_type=ptype,
                prize_amount=float(a.get("prize_amount") or 0),
                player_name=pname,
                released=bool(a.get("released")),
                paid=paid,
                visible=a.get("visible", True),
            ))

        return TournamentReport(
            tournament_id=tournament_id,
            tournament_name=t.get("name") or "",
            sponsor_name=sponsor.get("name"),
            status=t.get("status"),
            has_qualifying=bool(t.get("has_qualifying")),
            is_satellite=bool(t.get("is_satellite")),
            total_players=len(distinct_players),
            total_entries=tot_buy_ins + tot_rebuys + tot_addons,
            total_buy_ins=tot_buy_ins,
            total_rebuys=tot_rebuys,
            total_addons=tot_addons,
            total_revenue=total_revenue,
            rake_percentage=float(summary.rake_percentage),
            rake_amount=float(Decimal(str(total_revenue)) * summary.rake_percentage / Decimal("100")),
            guaranteed_prize=float(summary.guaranteed_prize),
            available_prize_pool=float(summary.available_prize_pool),
            reserved_prize_percentage=float(summary.reserved_prize_percentage),
            reserved_purpose=summary.reserved_purpose,
            reserved_amount=float(summary.reserved_amount),
            payable_pool=float(summary.payable_pool),
            total_allocated=float(summary.total_allocated),
            total_distributed=total_distributed,
            pending_release=pending_release,
            vagas_count=vagas_count,
            vagas_generated=vagas_generated,
            days=day_reports,
            prizes=prize_rows,
        )
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
