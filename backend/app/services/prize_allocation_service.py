from decimal import Decimal
from uuid import UUID
from typing import Optional
from fastapi import HTTPException, status
from app.database import supabase
from ..models.prize_allocation import (
    PrizeAllocationCreate,
    PrizeAllocationUpdate,
    PrizeAllocationResponse,
    PrizePayoutRequest,
    PrizeSummary
)


class PrizeAllocationService:

    @staticmethod
    def _to_response(item: dict) -> PrizeAllocationResponse:
        """Build a PrizeAllocationResponse from a prize_allocations row.
        Accepts an optional joined `players(name)` relation."""
        player_name = None
        if item.get("players"):
            player_name = item["players"].get("name")
        return PrizeAllocationResponse(
            id=item["id"],
            tournament_id=item["tournament_id"],
            position=item["position"],
            prize_amount=Decimal(str(item["prize_amount"])),
            player_id=item.get("player_id"),
            player_name=player_name,
            paid=item.get("paid", False),
            paid_at=item.get("paid_at"),
            document_type=item.get("document_type"),
            document_number=item.get("document_number"),
            paid_by=item.get("paid_by"),
            released=item.get("released", False),
            released_at=item.get("released_at"),
            visible=item.get("visible", True),
            prize_type=item.get("prize_type", "cash"),
            vaga_target_tournament_id=item.get("vaga_target_tournament_id"),
            vaga_target_day_id=item.get("vaga_target_day_id"),
            generated_ticket_id=item.get("generated_ticket_id"),
            created_at=item["created_at"],
            updated_at=item["updated_at"],
        )

    @staticmethod
    def get_tournament_info(tournament_id: UUID) -> dict:
        """Get tournament information including guaranteed prize"""
        response = supabase.table("tournaments")\
            .select("*")\
            .eq("id", str(tournament_id))\
            .execute()

        if not response.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Tournament not found"
            )

        return response.data[0]

    @staticmethod
    def calculate_total_entries(tournament_id: UUID) -> tuple[Decimal, Decimal, bool]:
        """
        Calculate total entries (buy_ins + rebuys + addons) for ALL days of a tournament.
        Returns tuple of (total_entries, effective_rake_percentage, has_qualifying_days).

        FASE 1 (tipos de buy): o rake é a SOMA do rake real por transação
        (transactions.rake_amount) — não mais o % médio dos dias. Devolvemos o
        rake EFETIVO (= rake_total / entries * 100) para que os cálculos de pool
        (player_pool = entries - rake) reflitam o rake real, inclusive quando
        cada tipo de buy tem um rake diferente.
        """
        days_response = supabase.table("tournament_days")\
            .select("day_type")\
            .eq("tournament_id", str(tournament_id))\
            .execute()

        has_qualifying = any(
            d.get("day_type") in ("qualifying", "final")
            for d in (days_response.data or [])
        )

        # Soma bruta das entradas + rake real, agregados no banco (1 round-trip).
        # Fallback: busca as linhas e soma em Python se a RPC não existir.
        total = Decimal("0")
        total_rake = Decimal("0")
        try:
            r = supabase.rpc("get_tournament_entry_totals", {"p_tournament_id": str(tournament_id)}).execute()
            if r.data:
                total = Decimal(str(r.data[0].get("total") or 0))
                total_rake = Decimal(str(r.data[0].get("total_rake") or 0))
        except Exception:
            transactions_response = supabase.table("transactions")\
                .select("amount, rake_amount")\
                .eq("tournament_id", str(tournament_id))\
                .in_("type", ["buy_in", "rebuy", "addon"])\
                .execute()
            for t in (transactions_response.data or []):
                total += Decimal(str(t.get("amount") or 0))
                total_rake += Decimal(str(t.get("rake_amount") or 0))

        effective_rake = (total_rake / total * Decimal("100")) if total > 0 else Decimal("0")

        return total, effective_rake, has_qualifying

    @staticmethod
    def get_prize_summary(tournament_id: UUID) -> PrizeSummary:
        """Get complete prize summary for a tournament (summing all days)"""
        tournament_info = PrizeAllocationService.get_tournament_info(tournament_id)
        guaranteed_prize = Decimal(str(tournament_info.get("guaranteed_prize") or 0))

        total_entries, rake_percentage, has_qualifying = \
            PrizeAllocationService.calculate_total_entries(tournament_id)

        player_pool = total_entries * (Decimal("100") - rake_percentage) / Decimal("100")
        available_prize_pool = guaranteed_prize + player_pool

        allocations = PrizeAllocationService.get_allocations(tournament_id)
        total_allocated = sum(Decimal(str(a.prize_amount)) for a in allocations)
        # ── Reserved prize: a % of the GROSS entries, taken OUT OF the players'
        # prize pool (NOT the rake). E.g. 20% rake + 3% reserved → players get 77%
        # of entries (100 - 20 rake - 3 reserved = 77).
        reserved_pct = Decimal(str(tournament_info.get("reserved_prize_percentage") or 0))
        reserved_purpose = tournament_info.get("reserved_purpose")
        reserved_amount = total_entries * reserved_pct / Decimal("100")
        payable_pool = available_prize_pool - reserved_amount

        remaining_balance = payable_pool - total_allocated

        return PrizeSummary(
            tournament_id=tournament_id,
            guaranteed_prize=guaranteed_prize,
            total_entries=total_entries,
            rake_percentage=rake_percentage,
            player_pool=player_pool,
            available_prize_pool=available_prize_pool,
            reserved_prize_percentage=reserved_pct,
            reserved_purpose=reserved_purpose,
            reserved_amount=reserved_amount,
            payable_pool=payable_pool,
            total_allocated=total_allocated,
            remaining_balance=remaining_balance,
            allocations=allocations,
            has_qualifying_days=has_qualifying
        )

    @staticmethod
    def get_allocations(tournament_id: UUID) -> list[PrizeAllocationResponse]:
        """Get all prize allocations for a tournament"""
        response = supabase.table("prize_allocations")\
            .select("*, players(name)")\
            .eq("tournament_id", str(tournament_id))\
            .order("position")\
            .execute()

        return [PrizeAllocationService._to_response(item) for item in response.data]

    @staticmethod
    def create_allocation(
        tournament_id: UUID,
        allocation: PrizeAllocationCreate
    ) -> PrizeAllocationResponse:
        """Create a new prize allocation"""
        PrizeAllocationService.get_tournament_info(tournament_id)

        existing = supabase.table("prize_allocations")\
            .select("id")\
            .eq("tournament_id", str(tournament_id))\
            .eq("position", allocation.position)\
            .execute()

        if existing.data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Position {allocation.position} already has a prize allocation"
            )

        prize_type = getattr(allocation, "prize_type", "cash") or "cash"
        data = {
            "tournament_id": str(tournament_id),
            "position": allocation.position,
            "prize_amount": float(allocation.prize_amount or 0),
            "prize_type": prize_type,
        }

        if prize_type == "vaga":
            # Value of a 'vaga' is the target day's buy-in (feature 4.2)
            day_id = getattr(allocation, "vaga_target_day_id", None)
            tgt_tournament_id = getattr(allocation, "vaga_target_tournament_id", None)
            if not day_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Vaga requer um dia alvo (vaga_target_day_id)"
                )
            day = supabase.table("tournament_days")\
                .select("buy_in, tournament_id")\
                .eq("id", str(day_id))\
                .execute()
            if not day.data:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Dia alvo da vaga não encontrado"
                )
            data["prize_amount"] = float(day.data[0]["buy_in"] or 0)
            data["vaga_target_day_id"] = str(day_id)
            data["vaga_target_tournament_id"] = str(
                tgt_tournament_id or day.data[0]["tournament_id"]
            )

        response = supabase.table("prize_allocations").insert(data).execute()

        if not response.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create prize allocation"
            )

        return PrizeAllocationService._to_response(response.data[0])

    @staticmethod
    def update_allocation(
        tournament_id: UUID,
        allocation_id: UUID,
        update: PrizeAllocationUpdate
    ) -> PrizeAllocationResponse:
        """Update an existing prize allocation"""
        existing = supabase.table("prize_allocations")\
            .select("*")\
            .eq("id", str(allocation_id))\
            .eq("tournament_id", str(tournament_id))\
            .execute()

        if not existing.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Prize allocation not found"
            )

        update_data = {}
        if update.position is not None:
            conflict = supabase.table("prize_allocations")\
                .select("id")\
                .eq("tournament_id", str(tournament_id))\
                .eq("position", update.position)\
                .neq("id", str(allocation_id))\
                .execute()

            if conflict.data:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Position {update.position} already has a prize allocation"
                )
            update_data["position"] = update.position

        if update.prize_amount is not None:
            update_data["prize_amount"] = float(update.prize_amount)

        if update.player_id is not None:
            update_data["player_id"] = str(update.player_id)

        if update.paid is not None:
            update_data["paid"] = update.paid
            if update.paid:
                from datetime import datetime
                update_data["paid_at"] = datetime.utcnow().isoformat()
            else:
                update_data["paid_at"] = None

        if update.visible is not None:
            update_data["visible"] = update.visible

        if update.released is not None:
            update_data["released"] = update.released
            if update.released:
                from datetime import datetime
                update_data["released_at"] = datetime.utcnow().isoformat()
            else:
                update_data["released_at"] = None
                update_data["released_by"] = None

        if not update_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No fields to update"
            )

        from datetime import datetime
        update_data["updated_at"] = datetime.utcnow().isoformat()

        response = supabase.table("prize_allocations")\
            .update(update_data)\
            .eq("id", str(allocation_id))\
            .execute()

        if not response.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update prize allocation"
            )

        result = supabase.table("prize_allocations")\
            .select("*, players(name)")\
            .eq("id", str(allocation_id))\
            .execute()

        return PrizeAllocationService._to_response(result.data[0])

    @staticmethod
    def set_released(
        tournament_id: UUID,
        allocation_id: UUID,
        released: bool,
        user_id: Optional[str] = None,
    ) -> PrizeAllocationResponse:
        """Release (or revoke release of) a prize allocation for payment.
        Feature 4.3: a prize can only be paid after being released here."""
        from datetime import datetime

        existing = supabase.table("prize_allocations")\
            .select("*")\
            .eq("id", str(allocation_id))\
            .eq("tournament_id", str(tournament_id))\
            .execute()
        if not existing.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Prize allocation not found"
            )
        alloc = existing.data[0]
        if alloc.get("paid") and not released:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Não é possível revogar liberação de um prêmio já pago"
            )

        update_data = {
            "released": released,
            "released_at": datetime.utcnow().isoformat() if released else None,
            "released_by": user_id if released else None,
            "updated_at": datetime.utcnow().isoformat(),
        }

        # Feature 4.2: releasing a 'vaga' generates a satellite ticket (entry)
        # for the awarded player instead of a cash payout.
        if released and alloc.get("prize_type") == "vaga" and not alloc.get("generated_ticket_id"):
            ticket = PrizeAllocationService._generate_vaga_ticket(tournament_id, alloc, user_id)
            update_data["generated_ticket_id"] = ticket["id"]

        supabase.table("prize_allocations")\
            .update(update_data)\
            .eq("id", str(allocation_id))\
            .execute()

        result = supabase.table("prize_allocations")\
            .select("*, players(name)")\
            .eq("id", str(allocation_id))\
            .execute()
        return PrizeAllocationService._to_response(result.data[0])

    @staticmethod
    def _generate_vaga_ticket(tournament_id: UUID, alloc: dict, user_id: Optional[str]) -> dict:
        """Create a satellite_ticket for a released 'vaga' prize."""
        player_id = alloc.get("player_id")
        if not player_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Atribua o jogador à posição antes de liberar a vaga."
            )
        target_day_id = alloc.get("vaga_target_day_id")
        target_tournament_id = alloc.get("vaga_target_tournament_id")
        if not target_day_id or not target_tournament_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Vaga sem dia alvo configurado; edite a premiação antes de liberar."
            )

        stage_id = PrizeAllocationService.get_tournament_info(tournament_id).get("stage_id")

        from app.models.satellite_ticket import TicketCreate
        from app.services.satellite_ticket_service import SatelliteTicketService

        ticket = SatelliteTicketService.create_ticket(
            TicketCreate(
                player_id=str(player_id),
                target_tournament_id=str(target_tournament_id),
                target_tournament_day_id=str(target_day_id),
                won_at=f"Premiação — Vaga {alloc.get('position')}º",
                funded_by="Premiação",
                stage_id=stage_id,
            ),
            user_id or "",
        )
        return {"id": str(ticket.id)}

    @staticmethod
    def update_reserved_config(
        tournament_id: UUID,
        reserved_prize_percentage: Decimal,
        reserved_purpose: Optional[str],
    ) -> dict:
        """Update reserved-prize configuration on the tournament (feature 4.1)."""
        from datetime import datetime
        PrizeAllocationService.get_tournament_info(tournament_id)

        if reserved_purpose not in (None, "", "ranking", "staff"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="reserved_purpose deve ser 'ranking', 'staff' ou vazio"
            )

        response = supabase.table("tournaments")\
            .update({
                "reserved_prize_percentage": float(reserved_prize_percentage),
                "reserved_purpose": reserved_purpose or None,
                "updated_at": datetime.utcnow().isoformat(),
            })\
            .eq("id", str(tournament_id))\
            .execute()

        if not response.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update reserved prize config"
            )
        return response.data[0]

    @staticmethod
    def get_tournament_prize_pool(tournament_id: UUID) -> dict:
        """
        Calculate prize pool and how much has already been paid.
        Returns dict with total_entries, rake_amount, guaranteed, prize_pool, total_paid, available.
        """
        tournament_info = PrizeAllocationService.get_tournament_info(tournament_id)
        guaranteed_prize = Decimal(str(tournament_info.get("guaranteed_prize") or 0))

        total_entries, rake_percentage, _ = \
            PrizeAllocationService.calculate_total_entries(tournament_id)

        rake_amount = total_entries * rake_percentage / Decimal("100")
        player_pool = total_entries - rake_amount
        prize_pool = guaranteed_prize + player_pool

        # Sum already paid prizes
        paid_resp = supabase.table("prize_allocations")\
            .select("prize_amount")\
            .eq("tournament_id", str(tournament_id))\
            .eq("paid", True)\
            .execute()

        total_paid = sum(Decimal(str(p["prize_amount"])) for p in (paid_resp.data or []))

        # Reserved prize: % of GROSS entries, taken from the players' pool (NOT the
        # rake), then blocked from payout. E.g. 20% rake + 3% reserved → 77% payable.
        reserved_pct = Decimal(str(tournament_info.get("reserved_prize_percentage") or 0))
        reserved_amount = total_entries * reserved_pct / Decimal("100")
        payable_pool = prize_pool - reserved_amount
        available = payable_pool - total_paid

        return {
            "total_entries": float(total_entries),
            "rake_percentage": float(rake_percentage),
            "rake_amount": float(rake_amount),
            "guaranteed_prize": float(guaranteed_prize),
            "prize_pool": float(prize_pool),
            "reserved_prize_percentage": float(reserved_pct),
            "reserved_amount": float(reserved_amount),
            "payable_pool": float(payable_pool),
            "total_paid": float(total_paid),
            "available": float(available),
        }

    @staticmethod
    def pay_prize(
        tournament_id: UUID,
        allocation_id: UUID,
        payout: PrizePayoutRequest,
        user_id: str = None
    ) -> PrizeAllocationResponse:
        """
        Process prize payout with financial integration.
        1. Validates allocation exists and is unpaid.
        2. Validates prize doesn't exceed tournament prize pool.
        3. Validates general cash register has sufficient balance.
        4. Cross-references document against player's registered document.
        5. Deducts from general cash register.
        6. Creates transaction record for traceability.
        7. Marks allocation as paid with document info.
        """
        from datetime import datetime

        # Verify allocation exists, belongs to tournament, and is not already paid
        alloc_resp = supabase.table("prize_allocations")\
            .select("*")\
            .eq("id", str(allocation_id))\
            .eq("tournament_id", str(tournament_id))\
            .execute()

        if not alloc_resp.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Prize allocation not found"
            )

        allocation = alloc_resp.data[0]
        if allocation.get("paid"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This prize has already been paid"
            )

        # Feature 4.3: prize must be released before it can be paid
        if not allocation.get("released"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Premiação não liberada. Libere na aba de Liberação antes de pagar."
            )

        # Feature 4.2: 'vaga' prizes cannot be paid in cash
        if allocation.get("prize_type") == "vaga":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Premiação do tipo 'Vaga' não pode ser paga em dinheiro; gere o ticket na liberação."
            )

        # Block when the operator has no open cashbox (super-admins bypass)
        if user_id:
            from app.services.cashbox_service import CashboxService
            try:
                CashboxService.require_open_cashbox_for_tournament(user_id, str(tournament_id))
            except ValueError as exc:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

        prize_amount = Decimal(str(allocation["prize_amount"]))

        # ── Validate prize pool limit ──
        pool_info = PrizeAllocationService.get_tournament_prize_pool(tournament_id)
        if float(prize_amount) > pool_info["available"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Premio excede o prize pool disponivel do torneio. "
                       f"Disponivel: R$ {pool_info['available']:.2f}, "
                       f"Solicitado: R$ {float(prize_amount):.2f}"
            )

        # ── Validate general cash balance ──
        from app.services.cash_register_service import CashRegisterService
        general_cash = CashRegisterService.get_general_cash()

        if general_cash.current_balance < prize_amount:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Saldo insuficiente no caixa geral. "
                       f"Disponivel: R$ {float(general_cash.current_balance):.2f}, "
                       f"Solicitado: R$ {float(prize_amount):.2f}"
            )

        # Verify player exists
        player_resp = supabase.table("players")\
            .select("id, name, document_type, document_number")\
            .eq("id", str(payout.player_id))\
            .execute()

        if not player_resp.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Player not found"
            )

        player = player_resp.data[0]

        # Cross-reference document
        registered_doc = player.get("document_number")

        if registered_doc:
            def normalize(s: str) -> str:
                return s.replace(" ", "").replace(".", "").replace("-", "").replace("/", "").upper()

            if normalize(registered_doc) != normalize(payout.document_number):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Documento não confere com o cadastro do jogador"
                )
        else:
            supabase.table("players").update({
                "document_type": payout.document_type,
                "document_number": payout.document_number,
                "updated_at": datetime.utcnow().isoformat()
            }).eq("id", str(payout.player_id)).execute()

        # ── Deduct from general cash register ──
        new_balance = general_cash.current_balance - prize_amount
        supabase.table("general_cash_register").update({
            "current_balance": str(new_balance),
            "updated_at": datetime.utcnow().isoformat()
        }).eq("id", general_cash.id).execute()

        # ── Create transaction record ──
        transaction_data = {
            "tournament_id": str(tournament_id),
            "player_id": str(payout.player_id),
            "type": "prize",
            "amount": float(prize_amount),
            "payment_source": "cash",
            "created_by": user_id,
        }
        supabase.table("transactions").insert(transaction_data).execute()

        # ── Mark allocation as paid ──
        update_data = {
            "player_id": str(payout.player_id),
            "paid": True,
            "paid_at": datetime.utcnow().isoformat(),
            "document_type": payout.document_type,
            "document_number": payout.document_number,
            "paid_by": payout.paid_by,
            "updated_at": datetime.utcnow().isoformat()
        }

        supabase.table("prize_allocations")\
            .update(update_data)\
            .eq("id", str(allocation_id))\
            .execute()

        # Return updated allocation with player name
        result = supabase.table("prize_allocations")\
            .select("*, players(name)")\
            .eq("id", str(allocation_id))\
            .execute()

        return PrizeAllocationService._to_response(result.data[0])

    @staticmethod
    def delete_allocation(tournament_id: UUID, allocation_id: UUID) -> None:
        """Delete a prize allocation"""
        existing = supabase.table("prize_allocations")\
            .select("id, paid")\
            .eq("id", str(allocation_id))\
            .eq("tournament_id", str(tournament_id))\
            .execute()

        if not existing.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Prize allocation not found"
            )

        if existing.data[0].get("paid"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete a paid prize allocation"
            )

        supabase.table("prize_allocations").delete().eq("id", str(allocation_id)).execute()

    @staticmethod
    def update_guaranteed_prize(tournament_id: UUID, guaranteed_prize: Decimal) -> dict:
        """Update the guaranteed prize for a tournament"""
        PrizeAllocationService.get_tournament_info(tournament_id)

        from datetime import datetime
        response = supabase.table("tournaments")\
            .update({
                "guaranteed_prize": float(guaranteed_prize),
                "updated_at": datetime.utcnow().isoformat()
            })\
            .eq("id", str(tournament_id))\
            .execute()

        if not response.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update guaranteed prize"
            )

        return response.data[0]

    @staticmethod
    def bulk_create_allocations(
        tournament_id: UUID,
        allocations: list[PrizeAllocationCreate]
    ) -> list[PrizeAllocationResponse]:
        """Create multiple prize allocations at once, replacing existing ones"""
        PrizeAllocationService.get_tournament_info(tournament_id)

        supabase.table("prize_allocations")\
            .delete()\
            .eq("tournament_id", str(tournament_id))\
            .execute()

        if not allocations:
            return []

        data = [
            {
                "tournament_id": str(tournament_id),
                "position": a.position,
                "prize_amount": float(a.prize_amount)
            }
            for a in allocations
        ]

        response = supabase.table("prize_allocations").insert(data).execute()

        if not response.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create prize allocations"
            )

        return PrizeAllocationService.get_allocations(tournament_id)
