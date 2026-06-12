from typing import Optional
from datetime import datetime
from app.database import supabase
from app.models.financial import (
    FinancialSummary,
    RevenueBreakdown,
    TournamentFinancial,
    TransactionEntry,
)


class FinancialService:
    @staticmethod
    def get_financial_summary(
        stage_id: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> FinancialSummary:
        """Generate comprehensive financial summary for DRE and closing"""

        # ── 1. Transactions ──
        query = supabase.table("transactions").select(
            "*, players(name), tournaments(name)"
        )

        if stage_id:
            # Get tournament IDs for this stage
            stage_tournaments = supabase.table("tournaments").select("id") \
                .eq("stage_id", stage_id).execute()
            t_ids = [t["id"] for t in (stage_tournaments.data or [])]
            if t_ids:
                query = query.in_("tournament_id", t_ids)
            else:
                # No tournaments in stage, return empty
                return FinancialSummary(
                    revenue=RevenueBreakdown(),
                    gross_revenue=0,
                    prizes=0,
                    operational_result=0,
                    rake=0,
                    net_result=0,
                )

        if start_date:
            query = query.gte("created_at", start_date)
        if end_date:
            end_dt = datetime.fromisoformat(end_date).replace(hour=23, minute=59, second=59)
            query = query.lte("created_at", end_dt.isoformat())

        transactions_data = query.order("created_at", desc=True).execute().data or []

        # ── 2. Revenue breakdown ──
        buy_in_total = 0.0
        rebuy_total = 0.0
        addon_total = 0.0
        prize_total = 0.0

        # Per-tournament aggregation
        tournament_map = {}

        # Transaction entries for extract
        tx_entries = []

        for tx in transactions_data:
            amount = float(tx.get("amount") or 0)
            tx_type = tx.get("type", "")
            t_id = tx.get("tournament_id")
            t_name = (tx.get("tournaments") or {}).get("name", "")
            p_name = (tx.get("players") or {}).get("name", "")

            # Aggregate by type
            if tx_type == "buy_in":
                buy_in_total += amount
            elif tx_type == "rebuy":
                rebuy_total += amount
            elif tx_type == "addon":
                addon_total += amount
            elif tx_type == "prize":
                prize_total += amount

            # Per-tournament
            if t_id and t_id not in tournament_map:
                tournament_map[t_id] = {
                    "tournament_id": t_id,
                    "tournament_name": t_name,
                    "players": set(),
                    "buy_ins_count": 0,
                    "rebuys_count": 0,
                    "addons_count": 0,
                    "revenue": 0.0,
                    "prizes": 0.0,
                }

            if t_id:
                tm = tournament_map[t_id]
                if tx.get("player_id"):
                    tm["players"].add(tx["player_id"])
                if tx_type == "buy_in":
                    tm["buy_ins_count"] += 1
                    tm["revenue"] += amount
                elif tx_type == "rebuy":
                    tm["rebuys_count"] += 1
                    tm["revenue"] += amount
                elif tx_type == "addon":
                    tm["addons_count"] += 1
                    tm["revenue"] += amount
                elif tx_type == "prize":
                    tm["prizes"] += amount

            # Transaction entry
            tx_entries.append(TransactionEntry(
                id=tx["id"],
                created_at=tx["created_at"],
                tournament_name=t_name,
                player_name=p_name,
                type=tx_type,
                payment_source=tx.get("payment_source"),
                amount=amount,
            ))

        revenue_total = buy_in_total + rebuy_total + addon_total

        # ── 3. Tickets redeemed value ──
        tickets_query = supabase.table("satellite_tickets").select("ticket_value") \
            .eq("status", "redeemed")
        if stage_id:
            tickets_query = tickets_query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")
        if start_date:
            tickets_query = tickets_query.gte("redeemed_at", start_date)
        if end_date:
            end_dt = datetime.fromisoformat(end_date).replace(hour=23, minute=59, second=59)
            tickets_query = tickets_query.lte("redeemed_at", end_dt.isoformat())

        redeemed_tickets = tickets_query.execute().data or []
        tickets_redeemed_value = sum(float(t.get("ticket_value") or 0) for t in redeemed_tickets)

        # ── 4. Rake ──
        rake_total = 0.0
        try:
            rake_resp = supabase.table("rake_register").select("total_rake").limit(1).execute()
            if rake_resp.data:
                rake_total = float(rake_resp.data[0].get("total_rake") or 0)
        except Exception:
            pass

        # ── 5. Pending credits ──
        pending_credits = 0.0
        try:
            credits_query = supabase.table("player_credits").select("amount, used_amount") \
                .eq("status", "active")
            if stage_id:
                credits_query = credits_query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")
            credits_data = credits_query.execute().data or []
            pending_credits = sum(
                float(c.get("amount") or 0) - float(c.get("used_amount") or 0)
                for c in credits_data
            )
        except Exception:
            pass

        # ── 6. Available tickets count ──
        available_tickets = 0
        try:
            avail_query = supabase.table("satellite_tickets").select("id", count="exact") \
                .eq("status", "available")
            if stage_id:
                avail_query = avail_query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")
            avail_resp = avail_query.execute()
            available_tickets = avail_resp.count or 0
        except Exception:
            pass

        # ── 7. Build tournament list ──
        by_tournament = []
        for tm in tournament_map.values():
            by_tournament.append(TournamentFinancial(
                tournament_id=tm["tournament_id"],
                tournament_name=tm["tournament_name"],
                players=len(tm["players"]),
                buy_ins_count=tm["buy_ins_count"],
                rebuys_count=tm["rebuys_count"],
                addons_count=tm["addons_count"],
                revenue=tm["revenue"],
                prizes=tm["prizes"],
                net=tm["revenue"] - tm["prizes"],
            ))

        by_tournament.sort(key=lambda t: t.revenue, reverse=True)

        gross_revenue = revenue_total
        operational_result = gross_revenue - prize_total
        net_result = operational_result

        return FinancialSummary(
            revenue=RevenueBreakdown(
                buy_ins=buy_in_total,
                rebuys=rebuy_total,
                addons=addon_total,
                total=revenue_total,
            ),
            tickets_redeemed_value=tickets_redeemed_value,
            gross_revenue=gross_revenue,
            prizes=prize_total,
            operational_result=operational_result,
            rake=rake_total,
            net_result=net_result,
            pending_credits=pending_credits,
            available_tickets=available_tickets,
            by_tournament=by_tournament,
            transactions=tx_entries,
        )
