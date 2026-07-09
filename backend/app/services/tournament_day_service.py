import logging
from typing import List, Optional
from datetime import datetime, timezone
from collections import defaultdict
import time
from app.database import supabase

logger = logging.getLogger("uvicorn.error")

# Chipcount cache: {day_id: (timestamp, chipcount)}
# Chipcount only changes on buy-in/rebuy/addon — no need to recompute every 3s poll.
_chipcount_cache: dict = {}
_CHIPCOUNT_TTL = 60  # seconds
from app.models.tournament_day import (
    TournamentDayCreate,
    TournamentDayUpdate,
    TournamentDay,
    TournamentDaySummary,
    QualifyingDayStats,
    FinalDayAggregatedStats,
    TournamentDayStatus
)


class TournamentDayService:
    @staticmethod
    def _sync_tournament_status(tournament_id: str):
        """Sync tournament status based on its days' statuses.
        - Any day active → tournament active
        - All days completed/cancelled (at least one completed) → tournament completed
        - Otherwise → pending
        """
        days_response = supabase.table("tournament_days")\
            .select("status")\
            .eq("tournament_id", tournament_id)\
            .execute()

        days = days_response.data or []
        if not days:
            return

        statuses = [d["status"] for d in days]

        if "active" in statuses:
            new_status = "active"
        elif all(s in ("completed", "cancelled") for s in statuses) and "completed" in statuses:
            new_status = "completed"
        else:
            new_status = "pending"

        supabase.table("tournaments")\
            .update({"status": new_status})\
            .eq("id", tournament_id)\
            .execute()

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

        rows = query.order("day_number", desc=False).execute().data or []
        if not rows:
            return []

        # total_entries per day in ONE round-trip (was one query per day = N+1).
        entries_by_day = TournamentDayService._entries_by_day([r["id"] for r in rows])

        days = []
        for item in rows:
            item["total_entries"] = entries_by_day.get(item["id"], 0)
            days.append(TournamentDay(**item))

        return days

    @staticmethod
    def _entries_by_day(day_ids: List[str]) -> dict:
        """Map day_id -> total entries (buy_in_count + rebuy_count) for the given
        days in a single batched query, aggregated in memory (hash map)."""
        if not day_ids:
            return {}
        players = (
            supabase.table("tournament_players")
            .select("tournament_day_id, buy_in_count, rebuy_count")
            .in_("tournament_day_id", day_ids)
            .execute()
            .data
            or []
        )
        agg = defaultdict(int)
        for p in players:
            agg[p["tournament_day_id"]] += (p.get("buy_in_count") or 0) + (p.get("rebuy_count") or 0)
        return agg

    @staticmethod
    def get_tournament_day(day_id: str, include_entries: bool = True) -> Optional[TournamentDay]:
        """Get a tournament day by ID.

        `include_entries=False` skips the tournament_players scan used only to
        compute total_entries — for callers that don't need it (e.g. timer
        commands), this avoids a wasteful extra round-trip.
        """
        response = supabase.table("tournament_days").select("*").eq("id", day_id).execute()

        if response.data:
            item = response.data[0]

            total_entries = 0
            if include_entries:
                # Calculate total_entries
                players_response = supabase.table("tournament_players")\
                    .select("buy_in_count, rebuy_count")\
                    .eq("tournament_day_id", day_id)\
                    .execute()

                if players_response.data:
                    for player in players_response.data:
                        buy_ins = player.get("buy_in_count", 0) or 0
                        rebuys = player.get("rebuy_count", 0) or 0
                        total_entries += buy_ins + rebuys

            item["total_entries"] = total_entries
            return TournamentDay(**item)
        return None

    @staticmethod
    def get_day_with_stage(day_id: str):
        """Single round-trip validation helper: fetches the day row plus its parent
        tournament's stage_id (via FK embedding), WITHOUT the players sub-query.
        Returns (TournamentDay | None, stage_id | None) so timer endpoints can
        validate existence + stage scoping and reuse the day without re-fetching."""
        response = supabase.table("tournament_days")\
            .select("*, tournaments(stage_id)")\
            .eq("id", day_id)\
            .execute()

        if not response.data:
            return None, None

        row = dict(response.data[0])
        tourn = row.pop("tournaments", None)
        stage_id = tourn.get("stage_id") if isinstance(tourn, dict) else None
        row["total_entries"] = 0
        return TournamentDay(**row), stage_id

    @staticmethod
    def get_tournament_day_summary(
        tournament_id: Optional[str] = None,
        day_id: Optional[str] = None
    ) -> List[TournamentDaySummary]:
        """Tournament-day summaries — single round-trip via the
        `get_tournament_day_summaries` RPC; falls back to the batched query path
        if the RPC isn't deployed yet."""
        try:
            resp = supabase.rpc(
                "get_tournament_day_summaries",
                {"p_tournament_id": tournament_id, "p_day_id": day_id},
            ).execute()
            return [TournamentDaySummary(**row) for row in (resp.data or [])]
        except Exception as exc:
            logger.warning(
                "get_tournament_day_summaries RPC unavailable, using batched fallback: %s", exc
            )
            return TournamentDayService._get_tournament_day_summary_batched(tournament_id, day_id)

    @staticmethod
    def _get_tournament_day_summary_batched(
        tournament_id: Optional[str] = None,
        day_id: Optional[str] = None
    ) -> List[TournamentDaySummary]:
        """Get tournament day summaries with aggregated data"""
        query = supabase.table("tournament_days").select("*")

        if tournament_id:
            query = query.eq("tournament_id", tournament_id)

        if day_id:
            query = query.eq("id", day_id)

        rows = query.order("day_number", desc=False).execute().data or []
        if not rows:
            return []

        # All player stats for all days in ONE round-trip (was N+1), tallied per
        # day in memory with hash maps.
        day_ids = [r["id"] for r in rows]
        players = (
            supabase.table("tournament_players")
            .select("tournament_day_id, buy_in_count, rebuy_count, addon_count")
            .in_("tournament_day_id", day_ids)
            .execute()
            .data
            or []
        )

        buy_ins_by_day = defaultdict(int)
        rebuys_by_day = defaultdict(int)
        addons_by_day = defaultdict(int)
        for p in players:
            d = p["tournament_day_id"]
            buy_ins_by_day[d] += p.get("buy_in_count") or 0
            rebuys_by_day[d] += p.get("rebuy_count") or 0
            addons_by_day[d] += p.get("addon_count") or 0

        summaries = []
        for item in rows:
            did = item["id"]
            total_buy_ins = buy_ins_by_day.get(did, 0)
            total_rebuys = rebuys_by_day.get(did, 0)
            item["total_buy_ins"] = total_buy_ins
            item["total_rebuys"] = total_rebuys
            item["total_addons"] = addons_by_day.get(did, 0)
            item["total_entries"] = total_buy_ins + total_rebuys  # addons not counted
            summaries.append(TournamentDaySummary(**item))

        return summaries

    @staticmethod
    def update_tournament_day(day_id: str, day_data: TournamentDayUpdate) -> Optional[TournamentDay]:
        """Update a tournament day"""
        data = day_data.model_dump(exclude_unset=True)

        # If status is being changed to 'active', set start_time
        if 'status' in data and data['status'] == 'active':
            data['start_time'] = datetime.now(timezone.utc).isoformat()

        try:
            response = (
                supabase.table("tournament_days")
                .update(data)
                .eq("id", day_id)
                .execute()
            )
        except Exception as exc:
            # Tolerate columns that don't exist yet (pre-migration). Strip the
            # unknown column from the payload and retry once.
            msg = str(exc)
            stripped = False
            for col in list(data.keys()):
                if col in msg and "column" in msg.lower():
                    data.pop(col, None)
                    stripped = True
            if not stripped:
                raise
            if data:
                response = (
                    supabase.table("tournament_days")
                    .update(data)
                    .eq("id", day_id)
                    .execute()
                )
            else:
                # Nothing left to update — read the row back so we can return it.
                response = (
                    supabase.table("tournament_days")
                    .select("*")
                    .eq("id", day_id)
                    .execute()
                )

        if response.data:
            day = TournamentDay(**response.data[0])
            # Sync tournament status when day status changes
            if 'status' in data:
                TournamentDayService._sync_tournament_status(day.tournament_id)
            return day
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

    @staticmethod
    def get_survivors(day_id: str) -> List[dict]:
        """Get all non-eliminated players from a day (survivors)"""
        response = supabase.table("tournament_players")\
            .select("*, players(name, nickname)")\
            .eq("tournament_day_id", day_id)\
            .neq("status", "eliminated")\
            .execute()

        return response.data if response.data else []

    @staticmethod
    def advance_qualifiers(qualifying_day_id: str) -> dict:
        """
        Advance survivors from a qualifying day to the final day.
        Uses the generic elimination counter - no individual player tracking needed.

        Updates the final day with:
        - Number of surviving players (registered - eliminations)
        - Total chip count from all entries in the qualifying day
        - Prize pool carried over from the qualifying day
        """
        # Get the qualifying day
        qualifying_day = TournamentDayService.get_tournament_day(qualifying_day_id)
        if not qualifying_day:
            raise ValueError("Dia classificatório não encontrado")

        if qualifying_day.day_type != "qualifying":
            raise ValueError("Este dia não é um dia classificatório")

        if not qualifying_day.qualifies_to_day_id:
            raise ValueError("Este dia não tem um dia final vinculado")

        # Get the final day
        final_day = TournamentDayService.get_tournament_day(qualifying_day.qualifies_to_day_id)
        if not final_day:
            raise ValueError("Dia final não encontrado")

        # Calculate survivors using generic elimination counter
        eliminations_count = qualifying_day.eliminations_count if hasattr(qualifying_day, 'eliminations_count') and qualifying_day.eliminations_count else 0
        registered = qualifying_day.registered_players or 0
        survivors_count = max(0, registered - eliminations_count)

        if survivors_count <= 0:
            raise ValueError("Nenhum sobrevivente para avançar (todos eliminados)")

        # Calculate total chips in play from qualifying day entries
        # Get entry counts from tournament_players
        players_response = supabase.table("tournament_players")\
            .select("buy_in_count, rebuy_count, addon_count")\
            .eq("tournament_day_id", qualifying_day_id)\
            .execute()

        total_chips = 0
        total_entries = 0
        if players_response.data:
            for p in players_response.data:
                buy_ins = p.get("buy_in_count", 0) or 0
                rebuys = p.get("rebuy_count", 0) or 0
                addons = p.get("addon_count", 0) or 0
                total_chips += buy_ins * (qualifying_day.starting_chips or 0)
                total_chips += rebuys * (qualifying_day.rebuy_chips or 0)
                total_chips += addons * (qualifying_day.addon_chips or 0)
                total_entries += buy_ins + rebuys

        # Carry over prize pool
        qualifying_prize_pool = qualifying_day.prize_pool or 0
        final_prize_pool = final_day.prize_pool or 0
        final_registered = final_day.registered_players or 0
        final_entries = final_day.total_entries or 0

        # Update final day: add survivors count, entries, and prize pool
        supabase.table("tournament_days")\
            .update({
                "registered_players": final_registered + survivors_count,
                "total_entries": final_entries + total_entries,
                "prize_pool": final_prize_pool + qualifying_prize_pool
            })\
            .eq("id", final_day.id)\
            .execute()

        return {
            "advanced_count": survivors_count,
            "final_day_id": final_day.id,
            "final_day_name": final_day.day_name,
            "total_chips": total_chips,
            "total_entries": total_entries,
            "players": [],
        }

    @staticmethod
    def update_player_chips(day_id: str, player_id: str, chip_count: int) -> bool:
        """Update the final chip count for a player in a day"""
        response = supabase.table("tournament_players")\
            .update({"final_chip_count": chip_count})\
            .eq("tournament_day_id", day_id)\
            .eq("player_id", player_id)\
            .execute()

        return len(response.data) > 0 if response.data else False

    @staticmethod
    def bulk_update_chips(day_id: str, chip_updates: List[dict]) -> int:
        """
        Bulk update chip counts for multiple players.
        chip_updates: list of {"player_id": str, "chip_count": int}
        Returns number of players updated.

        Prefere a RPC `bulk_update_chip_counts` (UPDATE set-based, 1 round-trip).
        Cai para o loop por jogador (N round-trips) se a RPC não estiver no banco.
        """
        if not chip_updates:
            return 0

        player_ids = [u["player_id"] for u in chip_updates]
        chips = [int(u["chip_count"]) for u in chip_updates]
        try:
            resp = supabase.rpc("bulk_update_chip_counts", {
                "p_day_id": day_id,
                "p_player_ids": player_ids,
                "p_chips": chips,
            }).execute()
            _chipcount_cache.pop(day_id, None)
            return resp.data if isinstance(resp.data, int) else (resp.data or 0)
        except Exception:
            updated_count = 0
            for update in chip_updates:
                if TournamentDayService.update_player_chips(
                    day_id, update["player_id"], update["chip_count"]
                ):
                    updated_count += 1
            _chipcount_cache.pop(day_id, None)
            return updated_count

    @staticmethod
    def get_final_day_aggregated_stats(final_day_id: str) -> FinalDayAggregatedStats:
        """
        Get aggregated statistics for a final day including all qualifying days.

        Returns comprehensive stats showing:
        - Per-qualifying-day breakdown
        - Total aggregated stats from all qualifying days
        - Final day specific stats (direct entries)
        - Combined totals
        """
        # Get the final day
        final_day = TournamentDayService.get_tournament_day(final_day_id)
        if not final_day:
            raise ValueError("Dia final não encontrado")

        # Get all qualifying days that point to this final day
        qualifying_days_response = supabase.table("tournament_days")\
            .select("*")\
            .eq("qualifies_to_day_id", final_day_id)\
            .order("day_number")\
            .execute()

        qualifying_days_stats = []
        total_qualifying_buy_ins = 0
        total_qualifying_rebuys = 0
        total_qualifying_addons = 0
        total_qualifying_buy_in_amount = 0.0
        total_qualifying_rebuy_amount = 0.0
        total_qualifying_addon_amount = 0.0
        total_qualifying_prize_pool = 0.0

        # Busca os jogadores de TODOS os dias classificatórios numa só query e
        # agrupa por dia (antes era 1 query por dia = N+1 round-trips).
        q_day_ids = [q["id"] for q in (qualifying_days_response.data or [])]
        players_by_day = {}
        if q_day_ids:
            all_q_players = supabase.table("tournament_players")\
                .select("*")\
                .in_("tournament_day_id", q_day_ids)\
                .execute()
            for p in (all_q_players.data or []):
                players_by_day.setdefault(p.get("tournament_day_id"), []).append(p)

        for q_day in (qualifying_days_response.data or []):
            players = players_by_day.get(q_day["id"], [])

            # Calculate stats for this qualifying day
            day_buy_ins = sum(p.get("buy_in_count", 0) or 0 for p in players)
            day_rebuys = sum(p.get("rebuy_count", 0) or 0 for p in players)
            day_addons = sum(p.get("addon_count", 0) or 0 for p in players)
            day_buy_in_amount = sum(float(p.get("total_buy_in_amount", 0) or 0) for p in players)
            day_rebuy_amount = sum(float(p.get("total_rebuy_amount", 0) or 0) for p in players)
            day_addon_amount = sum(float(p.get("total_addon_amount", 0) or 0) for p in players)

            eliminated = len([p for p in players if p.get("status") == "eliminated"])
            qualified = len([p for p in players if p.get("status") != "eliminated"])

            day_stats = QualifyingDayStats(
                day_id=q_day["id"],
                day_name=q_day["day_name"],
                day_number=q_day["day_number"],
                status=TournamentDayStatus(q_day["status"]),
                total_players=len(players),
                eliminated_players=eliminated,
                qualified_players=qualified,
                total_buy_ins=day_buy_ins,
                total_rebuys=day_rebuys,
                total_addons=day_addons,
                total_entries=day_buy_ins + day_rebuys,
                buy_in_amount=day_buy_in_amount,
                rebuy_amount=day_rebuy_amount,
                addon_amount=day_addon_amount,
                total_collected=day_buy_in_amount + day_rebuy_amount + day_addon_amount,
                prize_pool=float(q_day.get("prize_pool", 0) or 0)
            )
            qualifying_days_stats.append(day_stats)

            # Accumulate totals
            total_qualifying_buy_ins += day_buy_ins
            total_qualifying_rebuys += day_rebuys
            total_qualifying_addons += day_addons
            total_qualifying_buy_in_amount += day_buy_in_amount
            total_qualifying_rebuy_amount += day_rebuy_amount
            total_qualifying_addon_amount += day_addon_amount
            total_qualifying_prize_pool += float(q_day.get("prize_pool", 0) or 0)

        # Get final day players and calculate stats
        final_players_response = supabase.table("tournament_players")\
            .select("*")\
            .eq("tournament_day_id", final_day_id)\
            .execute()

        final_players = final_players_response.data or []

        # Separate qualified vs direct buy-in players
        qualified_players = [p for p in final_players if p.get("is_qualified_entry")]
        direct_players = [p for p in final_players if not p.get("is_qualified_entry")]

        # Calculate final day specific stats (only from direct entries, not carried over)
        # For direct entries, count their entries
        final_day_buy_ins = sum(p.get("buy_in_count", 0) or 0 for p in direct_players)
        final_day_rebuys = sum(p.get("rebuy_count", 0) or 0 for p in final_players)  # All rebuys in final day
        final_day_addons = sum(p.get("addon_count", 0) or 0 for p in final_players)  # All addons in final day

        # For direct players, calculate collected amounts in final day
        final_day_collected = (
            sum(float(p.get("total_buy_in_amount", 0) or 0) for p in direct_players) +
            sum(float(p.get("total_rebuy_amount", 0) or 0) for p in final_players) +
            sum(float(p.get("total_addon_amount", 0) or 0) for p in final_players)
        )

        total_qualifying_collected = total_qualifying_buy_in_amount + total_qualifying_rebuy_amount + total_qualifying_addon_amount

        return FinalDayAggregatedStats(
            final_day_id=final_day_id,
            final_day_name=final_day.day_name,
            total_qualified_players=len(qualified_players),
            direct_buy_in_players=len(direct_players),
            total_players=len(final_players),
            qualifying_days=qualifying_days_stats,
            total_qualifying_buy_ins=total_qualifying_buy_ins,
            total_qualifying_rebuys=total_qualifying_rebuys,
            total_qualifying_addons=total_qualifying_addons,
            total_qualifying_entries=total_qualifying_buy_ins + total_qualifying_rebuys,
            total_qualifying_buy_in_amount=total_qualifying_buy_in_amount,
            total_qualifying_rebuy_amount=total_qualifying_rebuy_amount,
            total_qualifying_addon_amount=total_qualifying_addon_amount,
            total_qualifying_collected=total_qualifying_collected,
            total_qualifying_prize_pool=total_qualifying_prize_pool,
            final_day_buy_ins=final_day_buy_ins,
            final_day_rebuys=final_day_rebuys,
            final_day_addons=final_day_addons,
            final_day_collected=final_day_collected,
            combined_prize_pool=float(final_day.prize_pool or 0),
            combined_total_collected=total_qualifying_collected + final_day_collected
        )

    @staticmethod
    def get_qualifying_day_stats(day_id: str) -> QualifyingDayStats:
        """Get detailed statistics for a single qualifying day"""
        day = TournamentDayService.get_tournament_day(day_id)
        if not day:
            raise ValueError("Dia não encontrado")

        # Get all players for this day
        players_response = supabase.table("tournament_players")\
            .select("*")\
            .eq("tournament_day_id", day_id)\
            .execute()

        players = players_response.data or []

        # Calculate stats
        buy_ins = sum(p.get("buy_in_count", 0) or 0 for p in players)
        rebuys = sum(p.get("rebuy_count", 0) or 0 for p in players)
        addons = sum(p.get("addon_count", 0) or 0 for p in players)
        buy_in_amount = sum(float(p.get("total_buy_in_amount", 0) or 0) for p in players)
        rebuy_amount = sum(float(p.get("total_rebuy_amount", 0) or 0) for p in players)
        addon_amount = sum(float(p.get("total_addon_amount", 0) or 0) for p in players)

        eliminated = len([p for p in players if p.get("status") == "eliminated"])
        qualified = len([p for p in players if p.get("status") != "eliminated"])

        return QualifyingDayStats(
            day_id=day_id,
            day_name=day.day_name,
            day_number=day.day_number,
            status=day.status,
            total_players=len(players),
            eliminated_players=eliminated,
            qualified_players=qualified,
            total_buy_ins=buy_ins,
            total_rebuys=rebuys,
            total_addons=addons,
            total_entries=buy_ins + rebuys,
            buy_in_amount=buy_in_amount,
            rebuy_amount=rebuy_amount,
            addon_amount=addon_amount,
            total_collected=buy_in_amount + rebuy_amount + addon_amount,
            prize_pool=float(day.prize_pool or 0)
        )

    # ================================================
    # Timer Control Methods
    # ================================================

    @staticmethod
    def start_timer(day_id: str, day: Optional[TournamentDay] = None):
        """Start or resume tournament timer. `day` may be passed pre-fetched
        (e.g. from the router validation) to avoid an extra round-trip."""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ValueError("Tournament day not found")

        was_active = day.status == "active"

        # Update timer state
        response = supabase.table("tournament_days")\
            .update({
                "is_paused": False,
                "timer_started_at": datetime.now(timezone.utc).isoformat(),
                "status": "active"
            })\
            .eq("id", day_id)\
            .execute()

        # Sync tournament status only on the pending→active transition. On a resume
        # (pause keeps status='active') the tournament is already active, so we skip
        # the 2 extra round-trips of _sync_tournament_status.
        if response.data and not was_active:
            TournamentDayService._sync_tournament_status(day.tournament_id)

        return response.data[0] if response.data else None

    @staticmethod
    def pause_timer(day_id: str, day: Optional[TournamentDay] = None):
        """Pause tournament timer"""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ValueError("Tournament day not found")

        # Calculate current elapsed time
        if day.timer_started_at and not day.is_paused:
            time_since_start = (datetime.now(timezone.utc) - day.timer_started_at).total_seconds()
            new_elapsed_time = day.elapsed_time + round(time_since_start)
        else:
            new_elapsed_time = day.elapsed_time

        # Update timer state
        response = supabase.table("tournament_days")\
            .update({
                "is_paused": True,
                "elapsed_time": new_elapsed_time,
                "timer_started_at": None
            })\
            .eq("id", day_id)\
            .execute()

        return response.data[0] if response.data else None

    @staticmethod
    def adjust_timer(day_id: str, seconds: int, day: Optional[TournamentDay] = None):
        """Manually adjust remaining time. Positive = add time (subtract elapsed), negative = remove time (add elapsed)"""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ValueError("Tournament day not found")

        # If timer is running, materialize the current elapsed time
        current_elapsed = day.elapsed_time or 0
        if day.timer_started_at and not day.is_paused:
            time_since_start = (datetime.now(timezone.utc) - day.timer_started_at).total_seconds()
            current_elapsed += round(time_since_start)

        # Adjust: positive seconds = add remaining time = subtract elapsed
        new_elapsed_time = max(0, current_elapsed - seconds)
        new_adjustment = (day.manual_time_adjustment or 0) + seconds

        update_data = {
            "manual_time_adjustment": new_adjustment,
            "elapsed_time": new_elapsed_time,
        }
        # Reset timer_started_at if running so elapsed continues from new base
        if day.timer_started_at and not day.is_paused:
            update_data["timer_started_at"] = datetime.now(timezone.utc).isoformat()

        response = supabase.table("tournament_days")\
            .update(update_data)\
            .eq("id", day_id)\
            .execute()

        return response.data[0] if response.data else None

    @staticmethod
    def set_level(day_id: str, level: int):
        """Set current blind level"""
        day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ValueError("Tournament day not found")

        if level < 1:
            raise ValueError("Level must be at least 1")

        response = supabase.table("tournament_days")\
            .update({"current_level": level})\
            .eq("id", day_id)\
            .execute()

        return response.data[0] if response.data else None

    @staticmethod
    def next_level(day_id: str, day: Optional[TournamentDay] = None):
        """Advance to next blind level - sync elapsed_time to start of new level"""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ValueError("Tournament day not found")

        new_level = day.current_level + 1
        blinds = TournamentDayService._get_all_blinds(day_id, day.tournament_id)

        # Calculate elapsed_time that corresponds to the START of the new level
        new_elapsed = TournamentDayService._sum_durations_before_level(blinds, new_level)

        update_data = {
            "current_level": new_level,
            "elapsed_time": new_elapsed,
        }
        # If timer is running, reset timer_started_at to now so elapsed continues from new base
        if day.timer_started_at and not day.is_paused:
            update_data["timer_started_at"] = datetime.now(timezone.utc).isoformat()

        response = supabase.table("tournament_days")\
            .update(update_data)\
            .eq("id", day_id)\
            .execute()

        return response.data[0] if response.data else None

    @staticmethod
    def previous_level(day_id: str, day: Optional[TournamentDay] = None):
        """Go back to previous blind level - sync elapsed_time to start of that level"""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ValueError("Tournament day not found")

        new_level = max(1, day.current_level - 1)
        blinds = TournamentDayService._get_all_blinds(day_id, day.tournament_id)

        # Calculate elapsed_time that corresponds to the START of the target level
        new_elapsed = TournamentDayService._sum_durations_before_level(blinds, new_level)

        update_data = {
            "current_level": new_level,
            "elapsed_time": new_elapsed,
        }
        # If timer is running, reset timer_started_at to now so elapsed continues from new base
        if day.timer_started_at and not day.is_paused:
            update_data["timer_started_at"] = datetime.now(timezone.utc).isoformat()

        response = supabase.table("tournament_days")\
            .update(update_data)\
            .eq("id", day_id)\
            .execute()

        return response.data[0] if response.data else None

    @staticmethod
    def reset_timer(day_id: str, day: Optional[TournamentDay] = None):
        """Reset timer to 00:00 and pause"""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ValueError("Tournament day not found")

        response = supabase.table("tournament_days")\
            .update({
                "elapsed_time": 0,
                "manual_time_adjustment": 0,
                "is_paused": True,
                "timer_started_at": None,
                "current_level": 1
            })\
            .eq("id", day_id)\
            .execute()

        return response.data[0] if response.data else None

    @staticmethod
    def get_timer_status(day_id: str, day: Optional[TournamentDay] = None):
        """Get current timer status with player counts"""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ValueError("Tournament day not found")

        # One players scan feeds both active count and total_entries (so we don't
        # depend on day.total_entries — the day may be fetched without that scan)
        players_response = supabase.table("tournament_players")\
            .select("status, buy_in_count, rebuy_count")\
            .eq("tournament_day_id", day_id)\
            .execute()

        rows = players_response.data or []
        active_players = len([p for p in rows if p.get("status") == "active"])
        total_entries = sum((p.get("buy_in_count") or 0) + (p.get("rebuy_count") or 0) for p in rows)

        # Calculate current elapsed time if timer is running
        current_elapsed = day.elapsed_time
        if day.timer_started_at and not day.is_paused:
            time_since_start = (datetime.now(timezone.utc) - day.timer_started_at).total_seconds()
            current_elapsed = day.elapsed_time + round(time_since_start)

        from app.models.tournament_day import TimerStatus
        return TimerStatus(
            day_id=day_id,
            current_level=day.current_level or 1,
            elapsed_time=current_elapsed,
            is_paused=day.is_paused or False,
            timer_started_at=day.timer_started_at,
            manual_time_adjustment=day.manual_time_adjustment or 0,
            active_players=active_players,
            total_entries=total_entries
        )

    # ================================================
    # Helper Methods for Enriched Timer Status
    # ================================================

    @staticmethod
    def _get_all_blinds(day_id: str, tournament_id: str) -> list:
        """Get all blinds for a tournament day (day-specific or tournament-level)"""
        # Try to get day-specific blinds first
        blinds_response = supabase.table("blinds")\
            .select("*")\
            .eq("tournament_day_id", day_id)\
            .order("level")\
            .execute()

        blinds = blinds_response.data

        # If no day-specific blinds, get tournament blinds
        if not blinds or len(blinds) == 0:
            blinds_response = supabase.table("blinds")\
                .select("*")\
                .eq("tournament_id", tournament_id)\
                .order("level")\
                .execute()
            blinds = blinds_response.data

        return blinds if blinds else []

    @staticmethod
    def _find_blind_by_level(blinds: list, level: int) -> dict:
        """Find a specific blind level in the blinds list"""
        for blind in blinds:
            if blind["level"] == level:
                return blind
        return None

    @staticmethod
    def _sum_durations_before_level(blinds: list, target_level: int) -> int:
        """Calculate total duration (in seconds) of all levels before target_level"""
        total_seconds = 0
        for blind in blinds:
            if blind["level"] < target_level:
                total_seconds += blind["duration"] * 60
        return total_seconds

    @staticmethod
    def _find_next_break(blinds: list, current_level: int, current_elapsed: int) -> dict:
        """Find the next break and calculate time until it"""
        # Calculate elapsed in all previous levels
        elapsed_in_previous = TournamentDayService._sum_durations_before_level(blinds, current_level)

        # Find current blind to get its duration
        current_blind = TournamentDayService._find_blind_by_level(blinds, current_level)
        if not current_blind:
            return None

        # Calculate time already elapsed in current level
        elapsed_in_current = current_elapsed - elapsed_in_previous
        remaining_in_current = (current_blind['duration'] * 60) - elapsed_in_current

        # Look for next break
        for blind in blinds:
            if blind['level'] > current_level and blind.get('is_break', False):
                # Calculate time from end of current level to this break
                time_between = 0
                for b in blinds:
                    if b['level'] > current_level and b['level'] < blind['level']:
                        time_between += b['duration'] * 60

                time_until_break = remaining_in_current + time_between

                return {
                    "level": blind['level'],
                    "duration": blind['duration'] * 60,
                    "time_until_break": max(0, time_until_break)
                }

        return None  # No break found

    @staticmethod
    def _calculate_current_level(blinds: list, elapsed_seconds: int) -> dict:
        """Calculate the correct level based on total elapsed time.
        Returns dict with level, time_remaining, elapsed_in_current_level."""
        if not blinds:
            return {"level": 1, "time_remaining": 0, "elapsed_in_current": 0}

        accumulated = 0
        for blind in blinds:
            level_duration = blind["duration"] * 60
            if elapsed_seconds < accumulated + level_duration:
                elapsed_in_current = elapsed_seconds - accumulated
                remaining = level_duration - elapsed_in_current
                return {
                    "level": blind["level"],
                    "time_remaining": max(0, remaining),
                    "elapsed_in_current": elapsed_in_current
                }
            accumulated += level_duration

        # Past all levels - stay on last level with 0 remaining
        last_blind = blinds[-1]
        return {
            "level": last_blind["level"],
            "time_remaining": 0,
            "elapsed_in_current": elapsed_seconds - (accumulated - last_blind["duration"] * 60)
        }

    @staticmethod
    def get_enriched_timer_status(day_id: str, day: Optional[TournamentDay] = None):
        """Get timer status with all calculated information (current/next blind, break info).
        Auto-advances level in DB when elapsed time exceeds current level duration.
        `day` may be passed pre-fetched (from the router validation) to skip a fetch;
        total_entries/chipcount come from a cached players scan, not from the day."""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ValueError("Tournament day not found")

        # Get all blinds sorted by level
        blinds = TournamentDayService._get_all_blinds(day_id, day.tournament_id)

        # Calculate current elapsed time if timer is running
        current_elapsed = day.elapsed_time or 0
        if day.timer_started_at and not day.is_paused:
            time_since_start = (datetime.now(timezone.utc) - day.timer_started_at).total_seconds()
            current_elapsed = (day.elapsed_time or 0) + round(time_since_start)

        # Calculate what level we SHOULD be at based on elapsed time
        level_calc = TournamentDayService._calculate_current_level(blinds, current_elapsed)
        correct_level = level_calc["level"]
        time_remaining_current = level_calc["time_remaining"]

        # Auto-advance: if DB level is behind the calculated level, update it
        db_level = day.current_level or 1
        if correct_level != db_level and not day.is_paused and blinds:
            supabase.table("tournament_days")\
                .update({"current_level": correct_level})\
                .eq("id", day_id)\
                .execute()

        # Find current blind
        current_blind = TournamentDayService._find_blind_by_level(blinds, correct_level)

        # Find next blind
        next_blind = TournamentDayService._find_blind_by_level(blinds, correct_level + 1)

        # Find next break and calculate time until it
        next_break_info = TournamentDayService._find_next_break(blinds, correct_level, current_elapsed)

        # Player aggregates (total_entries + chipcount) — cached for 60s in ONE scan,
        # since both only change on buy-in/rebuy/addon, not on the 3s poll. This avoids
        # the per-poll players scan that get_tournament_day used to do for total_entries.
        now = time.time()
        cached = _chipcount_cache.get(day_id)
        if cached and (now - cached[0]) < _CHIPCOUNT_TTL:
            chipcount = cached[1]
            total_entries = cached[2]
        else:
            try:
                agg_resp = supabase.table("tournament_players")\
                    .select("total_chips, buy_in_count, rebuy_count")\
                    .eq("tournament_day_id", day_id)\
                    .execute()
                players_data = agg_resp.data or []
                if not players_data:
                    agg_resp2 = supabase.table("tournament_players")\
                        .select("total_chips, buy_in_count, rebuy_count")\
                        .eq("tournament_id", day.tournament_id)\
                        .execute()
                    players_data = agg_resp2.data or []
                chipcount = sum(int(p.get("total_chips") or 0) for p in players_data)
                total_entries = sum(
                    (p.get("buy_in_count") or 0) + (p.get("rebuy_count") or 0)
                    for p in players_data
                )
                _chipcount_cache[day_id] = (now, chipcount, total_entries)
            except Exception:
                chipcount = cached[1] if cached else 0
                total_entries = cached[2] if cached else 0

        # Active players = total_entries - eliminations_count (eliminations read fresh
        # from the day row, so they reflect instantly even while aggregates are cached)
        eliminations_count = day.eliminations_count if hasattr(day, 'eliminations_count') and day.eliminations_count else 0
        active_players = max(0, total_entries - eliminations_count)
        average_stack = round(chipcount / active_players) if active_players > 0 else 0

        # If is_paused=False but timer_started_at is None, the timer was never actually
        # started (inconsistent DB state). Treat it as paused to prevent the frontend
        # ticker from counting down while the server always returns the same value.
        effective_paused = (day.is_paused or False) or (not day.timer_started_at)

        # Instante ABSOLUTO (epoch, relógio do servidor) em que o nível atual termina
        # — e em que o próximo intervalo começa. Derivado de timer_started_at + duração
        # − elapsed_base + sum_before, SEM arredondamento e SEM depender de quando a
        # request é processada (o "agora" do servidor se cancela na conta). Assim
        # TODAS as telas calculam restante = fim − agora a partir do MESMO valor e
        # ficam em sincronia exata (some o offset de 1s entre Controle e Broadcast).
        current_level_ends_at = None
        next_break_starts_at = None
        if not effective_paused and day.timer_started_at and current_blind:
            tsa = day.timer_started_at.timestamp()
            elapsed_base = day.elapsed_time or 0
            level_dur = (current_blind.get("duration") or 0) * 60
            sum_before = TournamentDayService._sum_durations_before_level(blinds, correct_level)
            current_level_ends_at = tsa + level_dur - elapsed_base + sum_before
            if next_break_info:
                sum_before_break = TournamentDayService._sum_durations_before_level(
                    blinds, next_break_info["level"]
                )
                next_break_starts_at = tsa + sum_before_break - elapsed_base

        return {
            "current_level": correct_level,
            "elapsed_time": current_elapsed,
            "is_paused": effective_paused,
            "timer_started_at": day.timer_started_at.isoformat() if day.timer_started_at else None,
            "current_blind": current_blind,
            "next_blind": next_blind,
            "time_remaining_current_level": time_remaining_current,
            "next_break": next_break_info,
            "current_level_ends_at": current_level_ends_at,
            "next_break_starts_at": next_break_starts_at,
            "active_players": active_players,
            "total_entries": total_entries,
            "eliminations_count": eliminations_count,
            "chipcount": chipcount,
            "average_stack": average_stack,
        }

    # ================================================
    # Simple Elimination Counter
    # ================================================

    @staticmethod
    def adjust_eliminations(day_id: str, count: int):
        """Adjust eliminations counter. Positive = add eliminations, negative = undo."""
        day = TournamentDayService.get_tournament_day(day_id)
        if not day:
            raise ValueError("Tournament day not found")

        current = day.eliminations_count if hasattr(day, 'eliminations_count') and day.eliminations_count else 0
        new_count = max(0, current + count)

        # Don't allow more eliminations than total entries
        total_entries = day.total_entries or 0
        if new_count > total_entries:
            new_count = total_entries

        response = supabase.table("tournament_days")\
            .update({"eliminations_count": new_count})\
            .eq("id", day_id)\
            .execute()

        return {
            "eliminations_count": new_count,
            "active_players": max(0, total_entries - new_count),
            "total_entries": total_entries
        }
