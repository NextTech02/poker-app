from typing import List, Optional, Dict
from app.database import supabase
from app.models.seat_allocation import SeatAllocation, SeatAllocationCreate, SeatAllocationUpdate, SeatAllocationWithDetails
import random


class AllocationService:
    @staticmethod
    def auto_allocate_player(tournament_id: str, player_id: str) -> SeatAllocationWithDetails:
        """
        Automatically allocate a player to the least occupied table with an available seat.
        Balances tables to keep them as even as possible.
        """
        # Check if player already has an allocation in this tournament
        existing_allocation = supabase.table("seat_allocations")\
            .select("id, table_id")\
            .eq("tournament_id", tournament_id)\
            .eq("player_id", player_id)\
            .execute()

        # If player has existing allocation, remove it first
        if existing_allocation.data:
            old_allocation = existing_allocation.data[0]
            supabase.table("seat_allocations").delete().eq("id", old_allocation["id"]).execute()

            # Update old table occupied_seats count
            old_table = supabase.table("tournament_tables").select("occupied_seats").eq("id", old_allocation["table_id"]).single().execute()
            if old_table.data:
                new_count = max(0, old_table.data["occupied_seats"] - 1)
                supabase.table("tournament_tables").update({"occupied_seats": new_count}).eq("id", old_allocation["table_id"]).execute()

        # Get all tables for the tournament
        tables_response = supabase.table("tournament_tables").select("*").eq("tournament_id", tournament_id).eq("status", "active").order("table_number").execute()

        if not tables_response.data:
            raise ValueError("No active tables available for this tournament")

        tables = tables_response.data

        # Get current allocations
        allocations_response = supabase.table("seat_allocations").select("table_id, seat_number").eq("tournament_id", tournament_id).execute()
        allocations = allocations_response.data

        # Count players per table
        table_counts = {}
        occupied_seats = {}  # Track which seats are taken: table_id -> set of seat numbers

        for table in tables:
            table_counts[table["id"]] = 0
            occupied_seats[table["id"]] = set()

        for allocation in allocations:
            if allocation["table_id"] in table_counts:
                table_counts[allocation["table_id"]] += 1
                occupied_seats[allocation["table_id"]].add(allocation["seat_number"])

        # Find table with least players that still has available seats
        best_table = None
        min_players = float('inf')

        for table in tables:
            table_id = table["id"]
            current_count = table_counts[table_id]
            max_seats = table["seats"]

            # Check if table has available seats
            if current_count < max_seats:
                if current_count < min_players:
                    min_players = current_count
                    best_table = table

        if not best_table:
            raise ValueError("All tables are full")

        # Find available seat number at the chosen table
        table_id = best_table["id"]
        max_seats = best_table["seats"]
        taken_seats = occupied_seats[table_id]

        # Get random available seat
        available_seats = [i for i in range(1, max_seats + 1) if i not in taken_seats]
        if not available_seats:
            raise ValueError("No available seats at selected table")

        seat_number = random.choice(available_seats)

        # Create allocation
        allocation_data = {
            "tournament_id": tournament_id,
            "player_id": player_id,
            "table_id": table_id,
            "seat_number": seat_number
        }

        response = supabase.table("seat_allocations").insert(allocation_data).execute()

        if not response.data:
            raise ValueError("Failed to create seat allocation")

        # Update table occupied_seats count
        new_count = table_counts[table_id] + 1
        supabase.table("tournament_tables").update({"occupied_seats": new_count}).eq("id", table_id).execute()

        # Get detailed information for response
        return AllocationService.get_allocation_with_details(response.data[0]["id"])

    @staticmethod
    def manual_allocate_player(tournament_id: str, player_id: str, table_id: str, seat_number: int) -> SeatAllocationWithDetails:
        """Manually allocate a player to a specific table and seat"""
        # Check if seat is available
        existing = supabase.table("seat_allocations").select("*").eq("tournament_id", tournament_id).eq("table_id", table_id).eq("seat_number", seat_number).execute()

        if existing.data:
            raise ValueError(f"Seat {seat_number} at this table is already occupied")

        # Check if table exists and has capacity
        table_response = supabase.table("tournament_tables").select("*").eq("id", table_id).execute()
        if not table_response.data:
            raise ValueError("Table not found")

        table = table_response.data[0]
        if table["occupied_seats"] >= table["seats"]:
            raise ValueError("Table is full")

        if seat_number > table["seats"]:
            raise ValueError(f"Invalid seat number. Table only has {table['seats']} seats")

        # Check if player is already allocated in this tournament
        existing_allocation = supabase.table("seat_allocations").select("*").eq("tournament_id", tournament_id).eq("player_id", player_id).execute()

        if existing_allocation.data:
            # Remove old allocation
            old_allocation = existing_allocation.data[0]
            AllocationService.remove_allocation(old_allocation["id"])

        # Create new allocation
        allocation_data = {
            "tournament_id": tournament_id,
            "player_id": player_id,
            "table_id": table_id,
            "seat_number": seat_number
        }

        response = supabase.table("seat_allocations").insert(allocation_data).execute()

        # Update table occupied_seats count
        supabase.table("tournament_tables").update({"occupied_seats": table["occupied_seats"] + 1}).eq("id", table_id).execute()

        return AllocationService.get_allocation_with_details(response.data[0]["id"])

    @staticmethod
    def get_allocation_with_details(allocation_id: str) -> SeatAllocationWithDetails:
        """Get seat allocation with player, table, and tournament details"""
        query = """
            seat_allocations!inner(
                id,
                tournament_id,
                player_id,
                table_id,
                seat_number,
                created_at,
                updated_at,
                players!inner(name),
                tables!inner(table_number),
                tournaments!inner(name)
            )
        """

        response = supabase.table("seat_allocations").select("*, players(name), tournament_tables(table_number), tournaments(name)").eq("id", allocation_id).single().execute()

        if not response.data:
            raise ValueError("Allocation not found")

        data = response.data
        return SeatAllocationWithDetails(
            id=data["id"],
            tournament_id=data["tournament_id"],
            player_id=data["player_id"],
            table_id=data["table_id"],
            seat_number=data["seat_number"],
            created_at=data["created_at"],
            updated_at=data.get("updated_at"),
            player_name=data["players"]["name"],
            table_number=data["tournament_tables"]["table_number"],
            tournament_name=data["tournaments"]["name"]
        )

    @staticmethod
    def get_tournament_allocations(tournament_id: str) -> List[Dict]:
        """Get all seat allocations for a tournament with details"""
        response = supabase.table("seat_allocations").select("*, players(name), tournament_tables(table_number, seats)").eq("tournament_id", tournament_id).order("tournament_tables(table_number)").order("seat_number").execute()

        return response.data

    @staticmethod
    def get_table_allocations(table_id: str) -> List[SeatAllocation]:
        """Get all allocations for a specific table"""
        response = supabase.table("seat_allocations").select("*").eq("table_id", table_id).order("seat_number").execute()

        return [SeatAllocation(**allocation) for allocation in response.data]

    @staticmethod
    def update_allocation(allocation_id: str, update_data: SeatAllocationUpdate) -> SeatAllocationWithDetails:
        """Update a seat allocation (move player to different seat/table)"""
        # Get current allocation
        current = supabase.table("seat_allocations").select("*").eq("id", allocation_id).single().execute()
        if not current.data:
            raise ValueError("Allocation not found")

        current_data = current.data
        old_table_id = current_data["table_id"]

        # If changing table or seat, check availability
        new_table_id = update_data.table_id or old_table_id
        new_seat_number = update_data.seat_number or current_data["seat_number"]

        if new_table_id != old_table_id or new_seat_number != current_data["seat_number"]:
            # Check if new seat is available
            existing = supabase.table("seat_allocations").select("*").eq("table_id", new_table_id).eq("seat_number", new_seat_number).execute()

            if existing.data and existing.data[0]["id"] != allocation_id:
                raise ValueError("Target seat is already occupied")

        # Update allocation
        update_dict = update_data.model_dump(exclude_unset=True)
        update_dict["updated_at"] = "now()"

        response = supabase.table("seat_allocations").update(update_dict).eq("id", allocation_id).execute()

        # Update table counts if table changed
        if new_table_id != old_table_id:
            # Decrease old table count
            old_table = supabase.table("tournament_tables").select("occupied_seats").eq("id", old_table_id).single().execute()
            if old_table.data:
                supabase.table("tournament_tables").update({"occupied_seats": max(0, old_table.data["occupied_seats"] - 1)}).eq("id", old_table_id).execute()

            # Increase new table count
            new_table = supabase.table("tournament_tables").select("occupied_seats").eq("id", new_table_id).single().execute()
            if new_table.data:
                supabase.table("tournament_tables").update({"occupied_seats": new_table.data["occupied_seats"] + 1}).eq("id", new_table_id).execute()

        return AllocationService.get_allocation_with_details(allocation_id)

    @staticmethod
    def remove_allocation(allocation_id: str) -> bool:
        """Remove a seat allocation"""
        # Get allocation to update table count
        allocation = supabase.table("seat_allocations").select("*").eq("id", allocation_id).single().execute()

        if not allocation.data:
            return False

        table_id = allocation.data["table_id"]

        # Delete allocation
        supabase.table("seat_allocations").delete().eq("id", allocation_id).execute()

        # Update table occupied_seats count
        table = supabase.table("tournament_tables").select("occupied_seats").eq("id", table_id).single().execute()
        if table.data:
            new_count = max(0, table.data["occupied_seats"] - 1)
            supabase.table("tournament_tables").update({"occupied_seats": new_count}).eq("id", table_id).execute()

        return True

    @staticmethod
    def get_unallocated_players(tournament_id: str) -> List[Dict]:
        """Get list of players registered in tournament but not yet allocated to a seat"""
        # Get all players in tournament (active or registered, but not eliminated or winner)
        players_response = supabase.table("tournament_players")\
            .select("*, players(*)")\
            .eq("tournament_id", tournament_id)\
            .in_("status", ["active", "registered"])\
            .execute()

        # Get all allocated players
        allocations_response = supabase.table("seat_allocations").select("player_id").eq("tournament_id", tournament_id).execute()

        allocated_player_ids = {alloc["player_id"] for alloc in allocations_response.data}

        # Filter unallocated players
        unallocated = [
            {
                "player_id": tp["player_id"],
                "player_name": tp["players"]["name"],
                "entries": tp.get("entries", 1)
            }
            for tp in players_response.data
            if tp["player_id"] not in allocated_player_ids
        ]

        return unallocated
