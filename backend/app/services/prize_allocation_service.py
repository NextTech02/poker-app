from decimal import Decimal
from uuid import UUID
from typing import Optional
from fastapi import HTTPException, status
from app.database import supabase
from ..models.prize_allocation import (
    PrizeAllocationCreate,
    PrizeAllocationUpdate,
    PrizeAllocationResponse,
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
    def calculate_total_entries(tournament_id: UUID) -> tuple[Decimal, Decimal]:
        """
        Calculate total entries (buy_ins + rebuys + addons) for ALL days of a tournament.
        Returns tuple of (total_entries, average_rake_percentage)
        """
        # Get all tournament days to calculate average rake
        days_response = supabase.table("tournament_days")\
            .select("id, rake_percentage")\
            .eq("tournament_id", str(tournament_id))\
            .execute()

        if not days_response.data:
            return Decimal("0"), Decimal("20")

        # Get all entry transactions for this tournament
        transactions_response = supabase.table("transactions")\
            .select("amount, type")\
            .eq("tournament_id", str(tournament_id))\
            .in_("type", ["buy_in", "rebuy", "addon"])\
            .execute()

        total = Decimal("0")
        for t in transactions_response.data:
            total += Decimal(str(t["amount"]))

        # Calculate average rake percentage from all days
        total_rake = sum(Decimal(str(d.get("rake_percentage", 20))) for d in days_response.data)
        avg_rake = total_rake / len(days_response.data) if days_response.data else Decimal("20")

        return total, avg_rake

    @staticmethod
    def get_prize_summary(tournament_id: UUID) -> PrizeSummary:
        """Get complete prize summary for a tournament (summing all days)"""
        # Get tournament info
        tournament_info = PrizeAllocationService.get_tournament_info(tournament_id)

        # Get guaranteed prize (default to 0 if not set)
        guaranteed_prize = Decimal(str(tournament_info.get("guaranteed_prize") or 0))

        # Calculate total entries from all days
        total_entries, rake_percentage = PrizeAllocationService.calculate_total_entries(tournament_id)

        # Calculate player pool (entries after rake)
        player_pool = total_entries * (Decimal("100") - rake_percentage) / Decimal("100")

        # Available prize pool is guaranteed PLUS player pool
        available_prize_pool = guaranteed_prize + player_pool

        # Get all allocations
        allocations = PrizeAllocationService.get_allocations(tournament_id)

        # Calculate total allocated
        total_allocated = sum(Decimal(str(a.prize_amount)) for a in allocations)

        # Calculate remaining balance
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
            allocations=allocations
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
        # Verify tournament exists
        PrizeAllocationService.get_tournament_info(tournament_id)

        # Check if position already exists
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

        # Create allocation
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
        # Verify allocation exists and belongs to tournament
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

        # Prepare update data
        update_data = {}
        if update.position is not None:
            # Check if new position conflicts with existing
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

        # Fetch with player info
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
            created_at=item["created_at"],
            updated_at=item["updated_at"]
        )

    @staticmethod
    def delete_allocation(tournament_id: UUID, allocation_id: UUID) -> None:
        """Delete a prize allocation"""
        # Verify allocation exists and belongs to tournament
        existing = supabase.table("prize_allocations")\
            .select("id")\
            .eq("id", str(allocation_id))\
            .eq("tournament_id", str(tournament_id))\
            .execute()

        if not existing.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Prize allocation not found"
            )

        supabase.table("prize_allocations").delete().eq("id", str(allocation_id)).execute()

    @staticmethod
    def update_guaranteed_prize(tournament_id: UUID, guaranteed_prize: Decimal) -> dict:
        """Update the guaranteed prize for a tournament"""
        # Verify tournament exists
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
        # Verify tournament exists
        PrizeAllocationService.get_tournament_info(tournament_id)

        # Delete all existing allocations for this tournament
        supabase.table("prize_allocations")\
            .delete()\
            .eq("tournament_id", str(tournament_id))\
            .execute()

        # Create all new allocations
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

        # Return all allocations
        return PrizeAllocationService.get_allocations(tournament_id)
