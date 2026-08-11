from app.database import supabase
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class DashboardService:
    @staticmethod
    def _get_stage_tournament_ids(stage_id: str) -> list:
        """Get tournament IDs belonging to a stage"""
        try:
            res = (
                supabase.table("tournaments")
                .select("id")
                .eq("stage_id", stage_id)
                .execute()
            )
            return [t["id"] for t in (res.data or [])]
        except Exception as e:
            logger.exception("[DashboardService] Failed to get stage tournament IDs")
            return []

    @staticmethod
    def _safe_sum(query) -> float:
        """Execute a revenue query and safely sum the 'amount' column."""
        try:
            res = query.execute()
            return sum(float(row["amount"]) for row in (res.data or []))
        except Exception as e:
            logger.exception("[DashboardService] Revenue query failed")
            return 0.0

    @staticmethod
    def _safe_count(query) -> int:
        """Execute a count query and safely return the count."""
        try:
            res = query.execute()
            return res.count or 0
        except Exception as e:
            logger.exception("[DashboardService] Count query failed")
            return 0

    @staticmethod
    def get_stats(stage_id: str = None):
        """Get dashboard statistics. Returns safe defaults on any error."""
        safe_defaults = {
            "activeTournaments": 0,
            "totalPlayers": 0,
            "totalRevenue": 0.0,
            "todayRevenue": 0.0,
        }

        # Caminho rápido: 1 round-trip via RPC de agregação (em vez de buscar até
        # 10k linhas só para somar). Cai para a lógica antiga se a RPC não existir.
        try:
            res = supabase.rpc("get_dashboard_stats", {"p_stage_id": stage_id}).execute()
            if res.data:
                row = res.data[0]
                return {
                    "activeTournaments": int(row.get("active_tournaments") or 0),
                    "totalPlayers": int(row.get("total_players") or 0),
                    "totalRevenue": float(row.get("total_revenue") or 0),
                    "todayRevenue": float(row.get("today_revenue") or 0),
                }
        except Exception as e:
            logger.warning(f"[DashboardService] get_dashboard_stats RPC unavailable, fallback: {e}")

        try:
            # ── 1. Resolve tournament IDs for stage filter ──────────────────
            tournament_ids = None
            if stage_id:
                tournament_ids = DashboardService._get_stage_tournament_ids(stage_id)
                if not tournament_ids:
                    return safe_defaults

            # ── 2. Active tournament days count ────────────────────────────
            active_q = (
                supabase.table("tournament_days")
                .select("id", count="exact")
                .eq("status", "active")
            )
            if tournament_ids:
                active_q = active_q.in_("tournament_id", tournament_ids)
            active_count = DashboardService._safe_count(active_q)

            # ── 3. Active players count ────────────────────────────────────
            player_count = 0
            players_q = (
                supabase.table("tournament_players")
                .select("id", count="exact")
                .eq("status", "active")
            )
            if tournament_ids:
                try:
                    day_ids_res = (
                        supabase.table("tournament_days")
                        .select("id")
                        .in_("tournament_id", tournament_ids)
                        .execute()
                    )
                    day_ids = [d["id"] for d in (day_ids_res.data or [])]
                    if day_ids:
                        player_count = DashboardService._safe_count(
                            players_q.in_("tournament_day_id", day_ids)
                        )
                except Exception as e:
                    logger.exception("[DashboardService] Player count query failed")
            else:
                player_count = DashboardService._safe_count(players_q)

            # ── 4. Total revenue ───────────────────────────────────────────
            # Limit to 5000 rows as a safety net — avoids fetching entire table
            revenue_q = supabase.table("transactions").select("amount").limit(5000)
            if tournament_ids:
                revenue_q = revenue_q.in_("tournament_id", tournament_ids)
            total_revenue = DashboardService._safe_sum(revenue_q)

            # ── 5. Today's revenue ─────────────────────────────────────────
            today = datetime.now().date().isoformat()
            today_q = (
                supabase.table("transactions")
                .select("amount")
                .gte("created_at", today)
                .limit(5000)
            )
            if tournament_ids:
                today_q = today_q.in_("tournament_id", tournament_ids)
            today_revenue = DashboardService._safe_sum(today_q)

            return {
                "activeTournaments": active_count,
                "totalPlayers": player_count,
                "totalRevenue": total_revenue,
                "todayRevenue": today_revenue,
            }

        except Exception as e:
            logger.exception("[DashboardService] get_stats failed entirely")
            return safe_defaults
