import logging
from typing import List, Optional
from datetime import datetime
from collections import defaultdict
from app.database import supabase
from app.models.tournament import TournamentCreate, TournamentUpdate, Tournament, TournamentSummary

logger = logging.getLogger("uvicorn.error")


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
        response = supabase.table("tournaments").select("*, sponsors(name)").eq("id", tournament_id).execute()

        if response.data:
            item = response.data[0]
            sponsor = item.pop("sponsors", None) or {}
            item["sponsor_name"] = sponsor.get("name")
            return Tournament(**item)
        return None

    # ── Código público de exibição (TV) ─────────────────────────────────────────
    @staticmethod
    def get_or_create_broadcast_code(tournament_id: str) -> str:
        """Retorna (ou gera) o código curto e único do torneio p/ exibição em TV."""
        import random
        t = supabase.table("tournaments").select("id, broadcast_code").eq("id", tournament_id).execute()
        if not t.data:
            raise ValueError("Torneio não encontrado")
        code = t.data[0].get("broadcast_code")
        if code:
            return code
        alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # sem 0/O/1/I/L
        for _ in range(12):
            candidate = "".join(random.choice(alphabet) for _ in range(6))
            try:
                supabase.table("tournaments").update({"broadcast_code": candidate}) \
                    .eq("id", tournament_id).is_("broadcast_code", "null").execute()
            except Exception:
                continue  # colisão no UNIQUE — tenta outro
            cur = supabase.table("tournaments").select("broadcast_code").eq("id", tournament_id).execute()
            if cur.data and cur.data[0].get("broadcast_code"):
                return cur.data[0]["broadcast_code"]
        raise ValueError("Não foi possível gerar o código")

    @staticmethod
    def resolve_broadcast_code(code: str) -> dict:
        """Resolve o código público → torneio + dia a exibir (ativo; senão o mais
        recente não-final; senão o último)."""
        code = (code or "").strip().upper()
        if not code:
            raise ValueError("Código inválido")
        t = supabase.table("tournaments").select("id, name").eq("broadcast_code", code).execute()
        if not t.data:
            raise ValueError("Código inválido")
        tour = t.data[0]
        days = supabase.table("tournament_days") \
            .select("id, day_name, day_number, status, day_type") \
            .eq("tournament_id", tour["id"]).order("day_number", desc=False).execute().data or []
        day = None
        active = [d for d in days if d.get("status") == "active"]
        if active:
            day = active[-1]
        elif days:
            non_final = [d for d in days if d.get("day_type") != "final"]
            day = (non_final or days)[-1]
        return {
            "tournament_id": tour["id"],
            "tournament_name": tour["name"],
            "day_id": day["id"] if day else None,
            "day_name": day["day_name"] if day else None,
        }

    @staticmethod
    def get_tournament_summary(tournament_id: Optional[str] = None, stage_id: Optional[str] = None) -> List[TournamentSummary]:
        """Tournament summaries — single round-trip via the `get_tournament_summary`
        Postgres RPC (GROUP BY aggregation in the DB). Falls back to the batched
        query path if the RPC isn't deployed yet or errors, so the endpoint keeps
        working before the migration is applied."""
        try:
            resp = supabase.rpc(
                "get_tournament_summary",
                {"p_stage_id": stage_id, "p_tournament_id": tournament_id},
            ).execute()
            return [TournamentSummary(**row) for row in (resp.data or [])]
        except Exception as exc:  # RPC missing / transient error -> safe fallback
            logger.warning(
                "get_tournament_summary RPC unavailable, using batched fallback: %s", exc
            )
            return TournamentService._get_tournament_summary_batched(tournament_id, stage_id)

    @staticmethod
    def _get_tournament_summary_batched(tournament_id: Optional[str] = None, stage_id: Optional[str] = None) -> List[TournamentSummary]:
        """Get tournament summaries with aggregated data from all tournament days.

        Performance: this used to be an O(1 + N + N*M) cascade of round-trips to
        the (remote) database — one query per tournament for its days, then one
        query per day for its players, plus one UPDATE per tournament. On a
        remote DB each round-trip costs tens of ms, so a handful of tournaments
        meant hundreds of queries and multi-second responses.

        It is now O(3) round-trips regardless of size: fetch tournaments, then
        all their days in a single IN query, then all players for those days in
        a single IN query. Aggregation is done in memory with hash maps (dicts)
        for O(1) grouping/lookup. Status sync writes are batched by target value
        (at most ~3 UPDATEs, only when something actually changed) instead of N.
        """
        query = supabase.table("tournaments").select("*, sponsors(name)")

        if tournament_id:
            query = query.eq("id", tournament_id)

        if stage_id:
            query = query.eq("stage_id", stage_id)

        tournaments = query.order("created_at", desc=True).execute().data or []
        if not tournaments:
            return []

        # --- 1 round-trip: all days for all these tournaments ---
        tournament_ids = [t["id"] for t in tournaments]
        days = (
            supabase.table("tournament_days")
            .select("id, tournament_id, day_type, status")
            .in_("tournament_id", tournament_ids)
            .execute()
            .data
            or []
        )

        # --- 1 round-trip: all players for the non-final days ---
        # Final days inherit data from qualifying days and must not be counted.
        counted_day_ids = [d["id"] for d in days if d.get("day_type") != "final"]
        players = []
        if counted_day_ids:
            players = (
                supabase.table("tournament_players")
                .select("tournament_day_id, buy_in_count, rebuy_count")
                .in_("tournament_day_id", counted_day_ids)
                .execute()
                .data
                or []
            )

        # --- In-memory aggregation (hash maps, O(n)) ---
        entries_by_day = defaultdict(int)
        for p in players:
            entries_by_day[p["tournament_day_id"]] += (
                (p.get("buy_in_count") or 0) + (p.get("rebuy_count") or 0)
            )

        days_by_tournament = defaultdict(list)
        for d in days:
            days_by_tournament[d["tournament_id"]].append(d)

        status_updates = defaultdict(list)  # derived_status -> [tournament_id, ...]
        summaries = []
        for item in tournaments:
            tdays = days_by_tournament.get(item["id"], [])
            total_days = len(tdays)
            total_entries = 0
            day_statuses = []
            for day in tdays:
                day_statuses.append(day.get("status", "pending"))
                if day.get("day_type") == "final":
                    continue
                total_entries += entries_by_day.get(day["id"], 0)

            # Derive tournament status from its days
            if day_statuses:
                if "active" in day_statuses:
                    derived_status = "active"
                elif all(s in ("completed", "cancelled") for s in day_statuses) and "completed" in day_statuses:
                    derived_status = "completed"
                else:
                    derived_status = "pending"

                if item.get("status") != derived_status:
                    status_updates[derived_status].append(item["id"])
                    item["status"] = derived_status

            item["total_entries"] = total_entries
            item["total_days"] = total_days
            sponsor = item.pop("sponsors", None) or {}
            item["sponsor_name"] = sponsor.get("name")
            summaries.append(TournamentSummary(**item))

        # --- Batched status sync: one UPDATE per distinct status (only if changed) ---
        for status_value, ids in status_updates.items():
            supabase.table("tournaments").update({"status": status_value}).in_("id", ids).execute()

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
