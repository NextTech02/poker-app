from typing import List, Optional
from datetime import datetime, timezone
from app.database import supabase
from app.models.satellite_ticket import (
    TicketCreate,
    TicketResponse,
    TicketSummary,
)


class SatelliteTicketService:

    # ================================================
    # Create Ticket — simplified flow
    # ================================================

    @staticmethod
    def create_ticket(data: TicketCreate, user_id: str) -> TicketResponse:
        """Create a ticket already bound to a player, a target tournament and
        a target tournament day. The value is derived from the day's buy_in."""
        # Validate target tournament
        target = supabase.table("tournaments").select("name") \
            .eq("id", data.target_tournament_id).execute()
        if not target.data:
            raise ValueError("Torneio alvo não encontrado")

        # Validate target day belongs to the tournament and pull its buy-in
        day = supabase.table("tournament_days") \
            .select("buy_in, day_name, tournament_id") \
            .eq("id", data.target_tournament_day_id).execute()
        if not day.data:
            raise ValueError("Dia do torneio não encontrado")
        if day.data[0]["tournament_id"] != data.target_tournament_id:
            raise ValueError("O dia selecionado não pertence ao torneio alvo")
        ticket_value = float(day.data[0]["buy_in"] or 0)
        target_day_name = day.data[0].get("day_name")

        # Validate player
        player = supabase.table("players").select("name, nickname") \
            .eq("id", data.player_id).execute()
        if not player.data:
            raise ValueError("Jogador não encontrado")

        # Legacy column `satellite_name` is still NOT NULL until the
        # `database_migration_ticket_simplified.sql` migration runs in prod.
        # Auto-fill it with a derived label so the simplified flow works
        # before/after the migration.
        derived_label_parts = [target.data[0]["name"]]
        if target_day_name:
            derived_label_parts.append(target_day_name)
        derived_label = " — ".join(derived_label_parts)

        won_at_clean = (data.won_at or "").strip()
        funded_by_clean = (data.funded_by or "").strip()

        insert_data = {
            "satellite_name": derived_label,
            "target_tournament_id": data.target_tournament_id,
            "target_tournament_day_id": data.target_tournament_day_id,
            "player_id": data.player_id,
            "ticket_value": ticket_value,
            "status": "awarded",
            "won_at": won_at_clean,
            "funded_by": funded_by_clean,
            "stage_id": data.stage_id,
            "created_by": user_id,
        }

        # Pre-migration tolerance: if `won_at` or `funded_by` columns don't
        # exist yet, drop them from the payload and stash both into `notes`
        # so we don't lose the audit info before the column is added.
        try:
            response = supabase.table("satellite_tickets").insert(insert_data).execute()
        except Exception as exc:
            msg = str(exc)
            stripped = False
            note_lines = []
            for col in ("won_at", "funded_by"):
                if col in msg and col in insert_data:
                    val = insert_data.pop(col, None)
                    if val:
                        prefix = "Ganho em" if col == "won_at" else "Financiado por"
                        note_lines.append(f"{prefix}: {val}")
                    stripped = True
            if not stripped:
                raise
            if note_lines:
                existing = (insert_data.get("notes") or "").strip()
                merged = " | ".join(note_lines)
                insert_data["notes"] = f"{existing} | {merged}".strip(" |") if existing else merged
            response = supabase.table("satellite_tickets").insert(insert_data).execute()

        item = response.data[0]
        # Surface the original values even if they were stashed into notes
        if not item.get("won_at"):
            item["won_at"] = won_at_clean or None
        if not item.get("funded_by"):
            item["funded_by"] = funded_by_clean or None

        return TicketResponse(
            **item,
            player_name=player.data[0].get("name"),
            player_nickname=player.data[0].get("nickname"),
            target_tournament_name=target.data[0]["name"],
            target_day_name=target_day_name,
        )

    # ================================================
    # Query Tickets
    # ================================================

    @staticmethod
    def get_ticket(ticket_id: str) -> Optional[TicketResponse]:
        response = supabase.table("satellite_tickets").select("*, players(name, nickname)") \
            .eq("id", ticket_id).execute()
        if not response.data:
            return None
        return SatelliteTicketService._enrich_ticket(response.data[0])

    @staticmethod
    def get_all_tickets(
        stage_id: Optional[str] = None,
        status: Optional[str] = None,
        target_tournament_id: Optional[str] = None,
    ) -> List[TicketResponse]:
        query = supabase.table("satellite_tickets").select("*, players(name, nickname)")

        if stage_id:
            query = query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")
        if status:
            query = query.eq("status", status)
        if target_tournament_id:
            query = query.eq("target_tournament_id", target_tournament_id)

        response = query.order("created_at", desc=True).execute()
        return SatelliteTicketService._enrich_many(response.data or [])

    @staticmethod
    def get_available_tickets(
        target_tournament_id: Optional[str] = None,
    ) -> List[TicketResponse]:
        """Get all un-redeemed tickets (covers both 'awarded' and the legacy
        'available' status)."""
        query = supabase.table("satellite_tickets").select("*, players(name, nickname)") \
            .in_("status", ["awarded", "available"])

        if target_tournament_id:
            query = query.eq("target_tournament_id", target_tournament_id)

        response = query.order("created_at").execute()
        return SatelliteTicketService._enrich_many(response.data or [])

    @staticmethod
    def get_summary(stage_id: Optional[str] = None) -> TicketSummary:
        query = supabase.table("satellite_tickets").select("status")
        if stage_id:
            query = query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")

        response = query.execute()
        statuses = [t["status"] for t in (response.data or [])]

        # Backwards compatibility: treat both "awarded" (current schema) and
        # "available" (legacy schema) as the un-redeemed bucket.
        return TicketSummary(
            total_available=statuses.count("awarded") + statuses.count("available"),
            total_redeemed=statuses.count("redeemed"),
            total_cancelled=statuses.count("cancelled"),
        )

    # ================================================
    # Redeem & Cancel
    # ================================================

    @staticmethod
    def redeem_ticket(ticket_id: str, funded_by: Optional[str], user_id: str) -> dict:
        """Redeem a ticket: registers the bound player on the bound day.
        `funded_by` is sourced from the ticket itself (set at creation). The
        argument is only honored for legacy tickets created before that
        field existed at creation time."""
        ticket = supabase.table("satellite_tickets").select("*").eq("id", ticket_id).execute()
        if not ticket.data:
            raise ValueError("Ticket não encontrado")

        t = ticket.data[0]

        if t["status"] not in ("awarded", "available"):
            raise ValueError(f"Ticket não pode ser resgatado (status: {t['status']})")

        player_id = t.get("player_id")
        if not player_id:
            raise ValueError("Este ticket não tem jogador atribuído. Cadastre um novo ticket no formato atual.")

        day_id = t.get("target_tournament_day_id")
        if not day_id:
            raise ValueError("Este ticket não tem dia alvo definido")

        # Prefer the funder set at creation; fall back to the legacy notes
        # encoding ("Financiado por: X"); finally fall back to the payload
        # for tickets that pre-date both.
        ticket_funded = (t.get("funded_by") or "").strip()
        if not ticket_funded and t.get("notes"):
            note_value = t["notes"].strip()
            for prefix in ("Financiado por:",):
                if note_value.lower().startswith(prefix.lower()):
                    ticket_funded = note_value[len(prefix):].strip()
                    break
        funded_by_clean = ticket_funded or (funded_by or "").strip()
        if not funded_by_clean:
            raise ValueError("Informe quem financiou o ticket")

        # Register player using tournament_player_service
        from app.models.tournament_player import TournamentPlayerCreate
        from app.services.tournament_player_service import TournamentPlayerService

        registration = TournamentPlayerCreate(
            tournament_id=t["target_tournament_id"],
            tournament_day_id=day_id,
            player_id=player_id,
            buy_in_count=1,
            payment_source="ticket",
            ticket_id=ticket_id,
            notes=f"Resgate de ticket — financiado por {funded_by_clean}",
        )

        tp = TournamentPlayerService.register_player(registration, user_id)

        # Update ticket. If the `funded_by` column hasn't been added by the
        # migration yet, retry without it and fall back to storing the funder
        # in the existing `notes` column.
        update_payload = {
            "status": "redeemed",
            "funded_by": funded_by_clean,
            "redeemed_at": datetime.now(timezone.utc).isoformat(),
            "redeemed_tournament_player_id": tp.id,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            supabase.table("satellite_tickets").update(update_payload).eq("id", ticket_id).execute()
        except Exception as e:
            if "funded_by" in str(e):
                update_payload.pop("funded_by", None)
                update_payload["notes"] = f"Financiado por: {funded_by_clean}"
                supabase.table("satellite_tickets").update(update_payload).eq("id", ticket_id).execute()
            else:
                raise

        return {
            "ticket_id": ticket_id,
            "tournament_player_id": tp.id,
            "player_name": tp.player_name,
            "tournament_name": tp.tournament_name,
            "funded_by": funded_by_clean,
            "message": "Ticket resgatado com sucesso",
        }

    @staticmethod
    def cancel_ticket(ticket_id: str, user_id: str) -> TicketResponse:
        ticket = supabase.table("satellite_tickets").select("*, players(name, nickname)") \
            .eq("id", ticket_id).execute()
        if not ticket.data:
            raise ValueError("Ticket não encontrado")

        t = ticket.data[0]
        if t["status"] not in ("awarded", "available"):
            raise ValueError("Apenas tickets ainda não resgatados podem ser cancelados")

        supabase.table("satellite_tickets").update({
            "status": "cancelled",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", ticket_id).execute()

        updated = supabase.table("satellite_tickets").select("*, players(name, nickname)") \
            .eq("id", ticket_id).execute()
        return SatelliteTicketService._enrich_ticket(updated.data[0])

    # ================================================
    # Helpers
    # ================================================

    @staticmethod
    def _enrich_many(items: List[dict]) -> List[TicketResponse]:
        """Enrich a list of tickets with O(1) extra queries instead of O(N).

        The per-item _enrich_ticket path issues 2 lookups (tournament + day)
        per ticket, i.e. 1 + 2N round-trips to a remote Postgres. Here we
        batch all tournament/day names into 2 `in_` queries and feed them to
        the enricher as maps, so any list size costs at most 3 queries total.
        """
        if not items:
            return []

        tour_ids = {i["target_tournament_id"] for i in items if i.get("target_tournament_id")}
        day_ids = {i["target_tournament_day_id"] for i in items if i.get("target_tournament_day_id")}

        tour_names: dict = {}
        if tour_ids:
            r = supabase.table("tournaments").select("id, name").in_("id", list(tour_ids)).execute()
            tour_names = {t["id"]: t["name"] for t in (r.data or [])}

        day_names: dict = {}
        if day_ids:
            r = supabase.table("tournament_days").select("id, day_name").in_("id", list(day_ids)).execute()
            day_names = {d["id"]: d.get("day_name") for d in (r.data or [])}

        return [
            SatelliteTicketService._enrich_ticket(i, tour_names, day_names)
            for i in items
        ]

    @staticmethod
    def _enrich_ticket(
        item: dict,
        tour_names: Optional[dict] = None,
        day_names: Optional[dict] = None,
    ) -> TicketResponse:
        p = item.pop("players", {}) or {}

        tgt_name = None
        tgt_day_name = None

        tgt_id = item.get("target_tournament_id")
        day_id = item.get("target_tournament_day_id")

        # Use pre-fetched maps when available (list path); otherwise fall back
        # to single lookups (single-item paths: get_ticket / cancel_ticket).
        if tour_names is not None:
            tgt_name = tour_names.get(tgt_id)
        elif tgt_id:
            tgt = supabase.table("tournaments").select("name").eq("id", tgt_id).execute()
            if tgt.data:
                tgt_name = tgt.data[0]["name"]

        if day_names is not None:
            tgt_day_name = day_names.get(day_id)
        elif day_id:
            d = supabase.table("tournament_days").select("day_name") \
                .eq("id", day_id).execute()
            if d.data:
                tgt_day_name = d.data[0].get("day_name")

        # Pre-migration fallback: when the `won_at` / `funded_by` columns
        # don't exist yet, both creation and redemption flows stash the data
        # into `notes` using "Ganho em: X" / "Financiado por: X" prefixes
        # (joined with " | " when both are present). Surface them as proper
        # fields so the UI is consistent across both modes.
        if (not item.get("funded_by") or not item.get("won_at")) and item.get("notes"):
            for chunk in [c.strip() for c in item["notes"].split("|")]:
                if not item.get("funded_by") and chunk.lower().startswith("financiado por:"):
                    item["funded_by"] = chunk.split(":", 1)[1].strip()
                elif not item.get("won_at") and chunk.lower().startswith("ganho em:"):
                    item["won_at"] = chunk.split(":", 1)[1].strip()

        return TicketResponse(
            **item,
            player_name=p.get("name"),
            player_nickname=p.get("nickname"),
            target_tournament_name=tgt_name,
            target_day_name=tgt_day_name,
        )
