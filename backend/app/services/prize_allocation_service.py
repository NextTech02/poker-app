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
        Returns tuple of (total_entries, avg_rake_percentage, has_qualifying_days).
        Rake average excludes final days (they don't independently collect buy-ins).
        """
        days_response = supabase.table("tournament_days")\
            .select("id, rake_percentage, day_type")\
            .eq("tournament_id", str(tournament_id))\
            .execute()

        if not days_response.data:
            return Decimal("0"), Decimal("20"), False

        has_qualifying = any(
            d.get("day_type") in ("qualifying", "final")
            for d in days_response.data
        )

        # For rake calculation: exclude 'final' days (they don't directly collect money)
        rake_days = [d for d in days_response.data if d.get("day_type") != "final"]
        if not rake_days:
            rake_days = days_response.data  # fallback: use all days

        # Weighted average rake: weight each day's rake_percentage by its actual revenue
        # (mirrors TournamentDashboard.js logic)
        weighted_rake_sum = Decimal("0")
        total_day_revenue = Decimal("0")

        for day in rake_days:
            tp_resp = supabase.table("tournament_players")\
                .select("total_buy_in_amount, total_rebuy_amount, total_addon_amount")\
                .eq("tournament_day_id", day["id"])\
                .execute()

            day_rev = sum(
                Decimal(str(p.get("total_buy_in_amount") or 0)) +
                Decimal(str(p.get("total_rebuy_amount") or 0)) +
                Decimal(str(p.get("total_addon_amount") or 0))
                for p in tp_resp.data
            )

            weighted_rake_sum += day_rev * Decimal(str(day.get("rake_percentage", 20)))
            total_day_revenue += day_rev

        avg_rake = weighted_rake_sum / total_day_revenue if total_day_revenue > 0 else Decimal("20")

        # Sum ALL transactions regardless of day type
        transactions_response = supabase.table("transactions")\
            .select("amount, type")\
            .eq("tournament_id", str(tournament_id))\
            .in_("type", ["buy_in", "rebuy", "addon"])\
            .execute()

        total = Decimal("0")
        for t in transactions_response.data:
            total += Decimal(str(t["amount"]))

        return total, avg_rake, has_qualifying

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
        remaining_balance = available_prize_pool - total_allocated

        return PrizeSummary(
            tournament_id=tournament_id,
            guaranteed_prize=guaranteed_prize,
            total_entries=total_entries,
            rake_percentage=rake_percentage,
            player_pool=player_pool,
            available_prize_pool=available_prize_pool,
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

        allocations = []
        for item in response.data:
            player_name = None
            if item.get("players"):
                player_name = item["players"].get("name")

            allocations.append(PrizeAllocationResponse(
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
                created_at=item["created_at"],
                updated_at=item["updated_at"]
            ))

        return allocations

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

        data = {
            "tournament_id": str(tournament_id),
            "position": allocation.position,
            "prize_amount": float(allocation.prize_amount)
        }

        response = supabase.table("prize_allocations").insert(data).execute()

        if not response.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create prize allocation"
            )

        item = response.data[0]
        return PrizeAllocationResponse(
            id=item["id"],
            tournament_id=item["tournament_id"],
            position=item["position"],
            prize_amount=Decimal(str(item["prize_amount"])),
            player_id=item.get("player_id"),
            paid=item.get("paid", False),
            paid_at=item.get("paid_at"),
            document_type=item.get("document_type"),
            document_number=item.get("document_number"),
            paid_by=item.get("paid_by"),
            created_at=item["created_at"],
            updated_at=item["updated_at"]
        )

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

        item = result.data[0]
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
            created_at=item["created_at"],
            updated_at=item["updated_at"]
        )

    @staticmethod
    def pay_prize(
        tournament_id: UUID,
        allocation_id: UUID,
        payout: PrizePayoutRequest
    ) -> PrizeAllocationResponse:
        """
        Process prize payout with document verification.
        1. Validates allocation exists and is unpaid.
        2. Verifies player belongs to the tournament.
        3. Cross-references document against player's registered document.
           - If player has a document registered and it doesn't match → HTTP 400.
           - If player has no document → saves the provided document to player record.
        4. Marks allocation as paid with document info.
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
        registered_type = player.get("document_type")

        if registered_doc:
            # Normalize for comparison (strip spaces/dashes)
            def normalize(s: str) -> str:
                return s.replace(" ", "").replace(".", "").replace("-", "").replace("/", "").upper()

            if normalize(registered_doc) != normalize(payout.document_number):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Documento não confere com o cadastro do jogador"
                )
        else:
            # No document on file — save provided document to player record
            supabase.table("players").update({
                "document_type": payout.document_type,
                "document_number": payout.document_number,
                "updated_at": datetime.utcnow().isoformat()
            }).eq("id", str(payout.player_id)).execute()

        # Mark allocation as paid
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

        item = result.data[0]
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
            created_at=item["created_at"],
            updated_at=item["updated_at"]
        )

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
