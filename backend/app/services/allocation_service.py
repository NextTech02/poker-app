from typing import List, Optional, Dict
from app.database import supabase
from app.models.seat_allocation import SeatAllocation, SeatAllocationCreate, SeatAllocationUpdate, SeatAllocationWithDetails
import random

# Sorteio de lugar usa a entropia do sistema operacional (os.urandom), não o
# Mersenne Twister do `random` global. O gerador padrão é determinístico: quem
# observar assentos sorteados suficientes consegue prever os próximos, e
# posição na mesa vale dinheiro (sentar à esquerda de um jogador é vantagem
# real). Com SystemRandom o sorteio não é reproduzível nem previsível, e o
# custo é irrelevante — são poucas dezenas de sorteios por noite.
_sorteio = random.SystemRandom()


def liberar_assento_do_dia(tournament_id: str, player_id: str, day_id: Optional[str], cliente=None) -> int:
    """Tira o jogador da cadeira DO DIA e devolve a vaga à mesa.

    Usada quando o jogador sai do dia (eliminado na mesa, inscrição estornada).
    Só a cadeira do dia: as mesas são por dia, e apagar por (torneio, jogador)
    tiraria da cadeira o mesmo jogador sentado em outro dia.

    Baixa `occupied_seats` junto — apagar só a alocação deixava a mesa
    "cheia" para `manual_allocate_player_for_day`, que confia nesse número.

    `cliente`: o `supabase` de quem chama (os testes trocam módulo a módulo).
    Devolve quantas cadeiras foram liberadas.
    """
    db = cliente or supabase

    def _ler(com_dia: bool):
        q = (
            db.table("seat_allocations").select("id, table_id")
            .eq("tournament_id", tournament_id)
            .eq("player_id", player_id)
        )
        if com_dia:
            q = q.eq("tournament_day_id", day_id)
        return q.execute().data or []

    if day_id:
        try:
            assentos = _ler(True)
        except Exception:
            # Base anterior à coluna por dia: cai no filtro antigo em vez de
            # deixar a vaga presa a um jogador que saiu.
            assentos = _ler(False)
    else:
        assentos = _ler(False)

    for assento in assentos:
        db.table("seat_allocations").delete().eq("id", assento["id"]).execute()
        mesa_id = assento.get("table_id")
        if not mesa_id:
            continue
        mesa = db.table("tournament_tables").select("occupied_seats").eq("id", mesa_id).execute().data or []
        if mesa:
            ocupados = max(0, int(mesa[0].get("occupied_seats") or 0) - 1)
            db.table("tournament_tables").update({"occupied_seats": ocupados}).eq("id", mesa_id).execute()
    return len(assentos)


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

        seat_number = _sorteio.choice(available_seats)

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
    def auto_allocate_player_for_day(tournament_id: str, day_id: str, player_id: str, mode: str = "balanced") -> SeatAllocationWithDetails:
        """
        Automatically allocate a player for a specific day.
        mode:
          - 'balanced'       : least-occupied table, lowest available seat
          - 'sequential'     : lowest-numbered table with space, lowest available seat
          - 'random_balanced': least-occupied table, random available seat
        """
        # Remove existing allocation for this day (re-allocate)
        existing = supabase.table("seat_allocations")\
            .select("id, table_id")\
            .eq("tournament_day_id", day_id)\
            .eq("player_id", player_id)\
            .execute()

        if existing.data:
            old = existing.data[0]
            supabase.table("seat_allocations").delete().eq("id", old["id"]).execute()
            old_table = supabase.table("tournament_tables").select("occupied_seats").eq("id", old["table_id"]).single().execute()
            if old_table.data:
                supabase.table("tournament_tables").update({"occupied_seats": max(0, old_table.data["occupied_seats"] - 1)}).eq("id", old["table_id"]).execute()

        # Get active tables for this day (ordered by table_number for sequential)
        tables_response = supabase.table("tournament_tables").select("*")\
            .eq("tournament_day_id", day_id)\
            .eq("status", "active")\
            .order("table_number").execute()

        if not tables_response.data:
            raise ValueError("No active tables available for this day")

        tables = tables_response.data

        # Build counts and occupied seat sets
        allocs = supabase.table("seat_allocations").select("table_id, seat_number").eq("tournament_day_id", day_id).execute().data
        table_counts = {t["id"]: 0 for t in tables}
        occupied_seats_map = {t["id"]: set() for t in tables}
        for a in allocs:
            if a["table_id"] in table_counts:
                table_counts[a["table_id"]] += 1
                occupied_seats_map[a["table_id"]].add(a["seat_number"])

        # Select table and seat based on mode
        tables_with_space = [t for t in tables if table_counts[t["id"]] < t["seats"]]
        if not tables_with_space:
            raise ValueError("All tables are full")

        if mode == "sequential":
            # Pick the table with the lowest table_number that still has space
            best_table = tables_with_space[0]  # already sorted by table_number
        else:
            # balanced / random_balanced: pick least-occupied table
            best_table = min(tables_with_space, key=lambda t: table_counts[t["id"]])

        table_id = best_table["id"]
        taken = occupied_seats_map[table_id]
        available = [i for i in range(1, best_table["seats"] + 1) if i not in taken]

        if mode == "random_balanced":
            seat_number = _sorteio.choice(available)
        else:
            seat_number = available[0]  # lowest available seat

        allocation_data = {
            "tournament_id": tournament_id,
            "tournament_day_id": day_id,
            "player_id": player_id,
            "table_id": table_id,
            "seat_number": seat_number,
        }

        response = supabase.table("seat_allocations").insert(allocation_data).execute()
        if not response.data:
            raise ValueError("Failed to create seat allocation")

        supabase.table("tournament_tables").update({"occupied_seats": table_counts[table_id] + 1}).eq("id", table_id).execute()

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
    def manual_allocate_player_for_day(tournament_id: str, day_id: str, player_id: str, table_id: str, seat_number: int) -> SeatAllocationWithDetails:
        """Manually allocate a player to a specific table and seat for a specific day"""
        # Check if seat is available
        existing = supabase.table("seat_allocations").select("*")\
            .eq("table_id", table_id).eq("seat_number", seat_number).execute()
        if existing.data:
            raise ValueError(f"Seat {seat_number} at this table is already occupied")

        # Check table
        table_response = supabase.table("tournament_tables").select("*").eq("id", table_id).execute()
        if not table_response.data:
            raise ValueError("Table not found")

        table = table_response.data[0]
        if table["occupied_seats"] >= table["seats"]:
            raise ValueError("Table is full")
        if seat_number > table["seats"]:
            raise ValueError(f"Invalid seat number. Table only has {table['seats']} seats")

        # Check if player already allocated for this day
        existing_alloc = supabase.table("seat_allocations").select("*")\
            .eq("tournament_day_id", day_id).eq("player_id", player_id).execute()
        if existing_alloc.data:
            AllocationService.remove_allocation(existing_alloc.data[0]["id"])

        allocation_data = {
            "tournament_id": tournament_id,
            "tournament_day_id": day_id,
            "player_id": player_id,
            "table_id": table_id,
            "seat_number": seat_number,
        }

        response = supabase.table("seat_allocations").insert(allocation_data).execute()
        supabase.table("tournament_tables").update({"occupied_seats": table["occupied_seats"] + 1}).eq("id", table_id).execute()

        return AllocationService.get_allocation_with_details(response.data[0]["id"])

    @staticmethod
    def bulk_allocate_players(tournament_id: str, day_id: str, mode: str, player_ids: List[str] = None) -> List[SeatAllocationWithDetails]:
        """
        Bulk allocate multiple players at once.
        Modes:
          - sequential: Fill table 1 completely, then table 2, etc.
          - balanced: Round-robin distribution (1 player per table, repeat)
          - random_balanced: Like balanced but seat chosen randomly
        """
        # Get unallocated players for this day
        if player_ids:
            players_to_allocate = player_ids
        else:
            unallocated = AllocationService.get_unallocated_players_for_day(tournament_id, day_id)
            players_to_allocate = [p["player_id"] for p in unallocated]

        if not players_to_allocate:
            return []

        # Get active tables for this day
        tables_response = supabase.table("tournament_tables").select("*")\
            .eq("tournament_day_id", day_id).eq("status", "active")\
            .order("table_number").execute()

        if not tables_response.data:
            raise ValueError("No active tables available")

        tables = tables_response.data

        # Get current allocations
        allocs = supabase.table("seat_allocations").select("table_id, seat_number")\
            .eq("tournament_day_id", day_id).execute().data

        table_counts = {}
        occupied_seats_map = {}
        for t in tables:
            table_counts[t["id"]] = 0
            occupied_seats_map[t["id"]] = set()
        for a in allocs:
            if a["table_id"] in table_counts:
                table_counts[a["table_id"]] += 1
                occupied_seats_map[a["table_id"]].add(a["seat_number"])

        results = []

        if mode == "sequential":
            results = AllocationService._bulk_sequential(
                tournament_id, day_id, players_to_allocate, tables, table_counts, occupied_seats_map
            )
        elif mode == "balanced":
            results = AllocationService._bulk_balanced(
                tournament_id, day_id, players_to_allocate, tables, table_counts, occupied_seats_map, randomize_seat=False
            )
        elif mode == "random_balanced":
            results = AllocationService._bulk_balanced(
                tournament_id, day_id, players_to_allocate, tables, table_counts, occupied_seats_map, randomize_seat=True
            )
        else:
            raise ValueError(f"Unknown allocation mode: {mode}")

        return results

    @staticmethod
    def _bulk_sequential(tournament_id, day_id, player_ids, tables, table_counts, occupied_seats_map):
        """Fill tables sequentially: table 1 fully, then table 2, etc."""
        # Seat assignment is computed entirely in memory (table_counts /
        # occupied_seats_map); the rows are then written in ONE bulk insert
        # instead of one INSERT per player (was N round-trips).
        pending = []
        table_idx = 0

        for player_id in player_ids:
            placed = False
            attempts = 0
            while not placed and attempts < len(tables):
                t = tables[table_idx % len(tables)]
                tid = t["id"]
                if table_counts[tid] < t["seats"]:
                    available = [s for s in range(1, t["seats"] + 1) if s not in occupied_seats_map[tid]]
                    if available:
                        seat = available[0]  # Sequential: first available seat
                        pending.append({
                            "tournament_id": tournament_id,
                            "tournament_day_id": day_id,
                            "player_id": player_id,
                            "table_id": tid,
                            "seat_number": seat,
                        })
                        table_counts[tid] += 1
                        occupied_seats_map[tid].add(seat)
                        # Move to next table only when current is full
                        if table_counts[tid] >= t["seats"]:
                            table_idx += 1
                        placed = True
                        continue
                table_idx += 1
                attempts += 1

        results = []
        if pending:
            results = supabase.table("seat_allocations").insert(pending).execute().data or []

        # Update occupied_seats counts on all tables
        AllocationService._sync_table_counts(tables, table_counts)
        return results

    @staticmethod
    def _bulk_balanced(tournament_id, day_id, player_ids, tables, table_counts, occupied_seats_map, randomize_seat=False):
        """Distribute players round-robin across tables (least occupied first)."""
        # Placement is decided in memory; rows are written in ONE bulk insert
        # instead of one INSERT per player (was N round-trips).
        pending = []

        for player_id in player_ids:
            # Sort tables by occupancy (least first), then by table_number
            sorted_tables = sorted(tables, key=lambda t: (table_counts[t["id"]], t["table_number"]))

            placed = False
            for t in sorted_tables:
                tid = t["id"]
                if table_counts[tid] < t["seats"]:
                    available = [s for s in range(1, t["seats"] + 1) if s not in occupied_seats_map[tid]]
                    if available:
                        seat = _sorteio.choice(available) if randomize_seat else available[0]
                        pending.append({
                            "tournament_id": tournament_id,
                            "tournament_day_id": day_id,
                            "player_id": player_id,
                            "table_id": tid,
                            "seat_number": seat,
                        })
                        table_counts[tid] += 1
                        occupied_seats_map[tid].add(seat)
                        placed = True
                        break

            if not placed:
                break  # No more available seats

        results = []
        if pending:
            results = supabase.table("seat_allocations").insert(pending).execute().data or []

        AllocationService._sync_table_counts(tables, table_counts)
        return results

    @staticmethod
    def _sync_table_counts(tables, table_counts):
        """Update occupied_seats on all tables to match actual counts.

        Agrupa as mesas pelo novo valor de occupied_seats e faz UMA query por
        valor distinto (com .in_(ids)) em vez de uma por mesa (N+1).
        """
        from collections import defaultdict
        by_count = defaultdict(list)
        for t in tables:
            tid = t["id"]
            new_count = table_counts.get(tid, 0)
            if new_count != t.get("occupied_seats", 0):
                by_count[new_count].append(tid)

        for count, ids in by_count.items():
            supabase.table("tournament_tables")\
                .update({"occupied_seats": count})\
                .in_("id", ids)\
                .execute()

    @staticmethod
    def get_allocation_with_details(allocation_id: str) -> SeatAllocationWithDetails:
        """Get seat allocation with player, table, and tournament details"""
        response = supabase.table("seat_allocations").select(
            "*, players(name), tournament_tables(table_number), tournaments(name)"
        ).eq("id", allocation_id).single().execute()

        if not response.data:
            raise ValueError("Allocation not found")

        data = response.data

        # Fetch day name separately to avoid nullable FK join issues
        day_name = None
        if data.get("tournament_day_id"):
            day_resp = supabase.table("tournament_days").select("day_name")\
                .eq("id", data["tournament_day_id"]).single().execute()
            if day_resp.data:
                day_name = day_resp.data.get("day_name")

        return SeatAllocationWithDetails(
            id=data["id"],
            tournament_id=data["tournament_id"],
            tournament_day_id=data.get("tournament_day_id"),
            player_id=data["player_id"],
            table_id=data["table_id"],
            seat_number=data["seat_number"],
            created_at=data["created_at"],
            updated_at=data.get("updated_at"),
            player_name=data["players"]["name"],
            table_number=data["tournament_tables"]["table_number"],
            tournament_name=data["tournaments"]["name"],
            day_name=day_name
        )

    @staticmethod
    def get_tournament_allocations(tournament_id: str) -> List[Dict]:
        """Get all seat allocations for a tournament with details"""
        response = supabase.table("seat_allocations").select("*, players(name), tournament_tables(table_number, seats)").eq("tournament_id", tournament_id).order("tournament_tables(table_number)").order("seat_number").execute()

        return response.data

    @staticmethod
    def get_day_allocations(day_id: str) -> List[Dict]:
        """Get all seat allocations for a specific tournament day with details"""
        response = supabase.table("seat_allocations")\
            .select("*, players(name), tournament_tables(table_number, seats)")\
            .eq("tournament_day_id", day_id)\
            .order("seat_number").execute()
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

    @staticmethod
    def get_unallocated_players_for_day(tournament_id: str, day_id: str) -> List[Dict]:
        """Get players registered in this specific day but not yet allocated to a seat"""
        players_response = supabase.table("tournament_players")\
            .select("*, players(*)")\
            .eq("tournament_day_id", day_id)\
            .in_("status", ["active", "registered"])\
            .execute()

        allocations_response = supabase.table("seat_allocations")\
            .select("player_id")\
            .eq("tournament_day_id", day_id)\
            .execute()

        allocated_ids = {a["player_id"] for a in allocations_response.data}

        unallocated = [
            {
                "player_id": tp["player_id"],
                "player_name": tp["players"]["name"],
                "entries": tp.get("entries", 1),
            }
            for tp in players_response.data
            if tp["player_id"] not in allocated_ids
        ]

        return unallocated
