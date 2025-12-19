from typing import List, Optional
from app.database import supabase
from app.models.table import TableCreate, TableUpdate, Table, TableWithPlayers


class TableService:
    @staticmethod
    def create_table(tournament_id: str, table_data: TableCreate) -> Table:
        """Create a new table for a tournament"""
        data = {
            "tournament_id": tournament_id,
            "table_number": table_data.table_number,
            "seats": table_data.seats,
            "status": "active",
            "occupied_seats": 0,
        }

        response = supabase.table("tournament_tables").insert(data).execute()
        return Table(**response.data[0])

    @staticmethod
    def create_multiple_tables(tournament_id: str, count: int, seats: int) -> List[Table]:
        """Create multiple tables with the same seat count"""
        tables = []

        # Get the highest table number for this tournament
        existing = supabase.table("tournament_tables").select("table_number").eq("tournament_id", tournament_id).order("table_number", desc=True).limit(1).execute()

        start_number = 1
        if existing.data:
            start_number = existing.data[0]["table_number"] + 1

        # Create tables
        tables_data = []
        for i in range(count):
            tables_data.append({
                "tournament_id": tournament_id,
                "table_number": start_number + i,
                "seats": seats,
                "status": "active",
                "occupied_seats": 0,
            })

        response = supabase.table("tournament_tables").insert(tables_data).execute()

        for table_data in response.data:
            tables.append(Table(**table_data))

        return tables

    @staticmethod
    def get_tournament_tables(tournament_id: str) -> List[Table]:
        """Get all tables for a tournament"""
        response = supabase.table("tournament_tables").select("*").eq("tournament_id", tournament_id).order("table_number").execute()

        return [Table(**table) for table in response.data]

    @staticmethod
    def get_table(table_id: str) -> Optional[Table]:
        """Get a specific table"""
        response = supabase.table("tournament_tables").select("*").eq("id", table_id).execute()

        if response.data:
            return Table(**response.data[0])
        return None

    @staticmethod
    def update_table(table_id: str, update_data: TableUpdate) -> Optional[Table]:
        """Update table information"""
        data = update_data.model_dump(exclude_unset=True)

        response = supabase.table("tournament_tables").update(data).eq("id", table_id).execute()

        if response.data:
            return Table(**response.data[0])
        return None

    @staticmethod
    def delete_table(table_id: str) -> bool:
        """Delete a table (only if no players are seated)"""
        # Check if table has players
        table = TableService.get_table(table_id)
        if not table:
            return False

        if table.occupied_seats > 0:
            raise ValueError("Cannot delete table with seated players")

        supabase.table("tournament_tables").delete().eq("id", table_id).execute()
        return True

    @staticmethod
    def break_table(table_id: str) -> Optional[Table]:
        """Mark table as broken (players will be redistributed)"""
        return TableService.update_table(table_id, TableUpdate(status="broken"))

    @staticmethod
    def get_tournament_stats(tournament_id: str) -> dict:
        """Get tournament table statistics"""
        tables = TableService.get_tournament_tables(tournament_id)

        total_tables = len(tables)
        active_tables = len([t for t in tables if t.status == "active"])
        total_seats = sum(t.seats for t in tables)
        occupied_seats = sum(t.occupied_seats for t in tables)

        return {
            "total_tables": total_tables,
            "active_tables": active_tables,
            "total_seats": total_seats,
            "occupied_seats": occupied_seats,
            "available_seats": total_seats - occupied_seats,
        }
