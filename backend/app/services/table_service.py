from typing import List, Optional
from app.database import supabase
from app.models.table import TableCreate, TableUpdate, Table, TableWithPlayers
from app.utils.erros import ErroDeNegocio


def _numero_repetido(exc: Exception) -> bool:
    """O banco recusou por UNIQUE (tournament_day_id, table_number)."""
    texto = str(exc).lower()
    return "duplicate key" in texto or "23505" in texto


def _recusa_numero_repetido(numero: Optional[int]) -> ErroDeNegocio:
    # O número é o que identifica a mesa NO SALÃO: duas "Mesa 3" no mesmo dia
    # mandariam o jogador para a cadeira errada. É recusa de regra (409), não
    # erro de servidor — o operador resolve escolhendo outro número.
    return ErroDeNegocio(
        "numero_de_mesa_repetido",
        "Já existe uma mesa com este número neste dia.",
        status=409,
        table_number=numero,
    )


class TableService:
    @staticmethod
    def create_table(tournament_id: str, table_data: TableCreate, tournament_day_id: str = None) -> Table:
        """Create a new table for a tournament (optionally scoped to a day)"""
        data = {
            "tournament_id": tournament_id,
            "table_number": table_data.table_number,
            "seats": table_data.seats,
            "status": "active",
            "occupied_seats": 0,
        }
        if tournament_day_id:
            data["tournament_day_id"] = tournament_day_id

        try:
            response = supabase.table("tournament_tables").insert(data).execute()
        except Exception as exc:
            if _numero_repetido(exc):
                raise _recusa_numero_repetido(table_data.table_number) from exc
            raise
        return Table(**response.data[0])

    @staticmethod
    def create_multiple_tables(
        tournament_id: str,
        count: int,
        seats: int,
        tournament_day_id: str = None,
        start_number: Optional[int] = None,
    ) -> List[Table]:
        """Create multiple tables with the same seat count.

        Sem `start_number`, a numeração continua da maior mesa existente. Com
        ele, o operador escolhe onde começar (o salão já tem as mesas 1-4 de
        outro evento, o torneio usa as 5-8) — e aí conferimos antes de gravar
        se algum número do lote já está em uso, para recusar com o número
        certo em vez de deixar o banco responder com uma frase em inglês.
        """
        query = supabase.table("tournament_tables").select("table_number").eq("tournament_id", tournament_id)
        if tournament_day_id:
            query = query.eq("tournament_day_id", tournament_day_id)

        if start_number is None:
            existing = query.order("table_number", desc=True).limit(1).execute()
            start_number = 1
            if existing.data:
                start_number = existing.data[0]["table_number"] + 1
        else:
            numeros = list(range(start_number, start_number + count))
            em_uso = query.in_("table_number", numeros).execute().data or []
            if em_uso:
                raise _recusa_numero_repetido(min(r["table_number"] for r in em_uso))

        # Create tables
        tables_data = []
        for i in range(count):
            row = {
                "tournament_id": tournament_id,
                "table_number": start_number + i,
                "seats": seats,
                "status": "active",
                "occupied_seats": 0,
            }
            if tournament_day_id:
                row["tournament_day_id"] = tournament_day_id
            tables_data.append(row)

        try:
            response = supabase.table("tournament_tables").insert(tables_data).execute()
        except Exception as exc:
            if _numero_repetido(exc):
                raise _recusa_numero_repetido(start_number) from exc
            raise

        return [Table(**table_data) for table_data in response.data]

    @staticmethod
    def get_tournament_tables(tournament_id: str) -> List[Table]:
        """Get all tables for a tournament"""
        response = supabase.table("tournament_tables").select("*").eq("tournament_id", tournament_id).order("table_number").execute()

        return [Table(**table) for table in response.data]

    @staticmethod
    def get_day_tables(day_id: str) -> List[Table]:
        """Get all tables for a specific tournament day"""
        response = supabase.table("tournament_tables").select("*").eq("tournament_day_id", day_id).order("table_number").execute()
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
        """Update table information (number, seats, status)"""
        data = update_data.model_dump(exclude_unset=True)

        # Mesa que encolhe leva junto os assentos desativados que deixaram de
        # existir: um "assento 9 desativado" numa mesa de 8 contaria contra a
        # capacidade dela sem aparecer na tela.
        if data.get("seats") is not None:
            atual = TableService.get_table(table_id)
            if atual and any(s > data["seats"] for s in atual.blocked_seats):
                data["blocked_seats"] = [s for s in atual.blocked_seats if s <= data["seats"]]

        try:
            response = supabase.table("tournament_tables").update(data).eq("id", table_id).execute()
        except Exception as exc:
            if _numero_repetido(exc):
                raise _recusa_numero_repetido(data.get("table_number")) from exc
            raise

        if response.data:
            return Table(**response.data[0])
        return None

    @staticmethod
    def set_seat_active(table_id: str, seat_number: int, active: bool) -> Optional[Table]:
        """Liga ou desliga um assento. None = mesa inexistente.

        Desligar um assento com alguém sentado é recusado: o jogador ficaria
        numa cadeira que o sistema diz não existir. O operador move o
        jogador antes. Repetir o mesmo comando não muda nada (idempotente).
        """
        mesa = TableService.get_table(table_id)
        if not mesa:
            return None
        if seat_number < 1 or seat_number > mesa.seats:
            raise ErroDeNegocio(
                "assento_invalido", "Este lugar não existe nesta mesa.",
                status=400, seat_number=seat_number, seats=mesa.seats,
            )

        bloqueados = set(mesa.blocked_seats)
        if active:
            bloqueados.discard(seat_number)
        else:
            sentado = supabase.table("seat_allocations").select("id") \
                .eq("table_id", table_id).eq("seat_number", seat_number) \
                .limit(1).execute()
            if sentado.data:
                raise ErroDeNegocio(
                    "assento_ocupado", "Este lugar já está ocupado.",
                    status=409, seat_number=seat_number,
                )
            bloqueados.add(seat_number)

        novos = sorted(bloqueados)
        if novos == sorted(mesa.blocked_seats):
            return mesa
        response = supabase.table("tournament_tables") \
            .update({"blocked_seats": novos}).eq("id", table_id).execute()
        return Table(**response.data[0]) if response.data else None

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
        total_seats = sum(t.seats - len(t.blocked_seats) for t in tables)
        occupied_seats = sum(t.occupied_seats for t in tables)

        return {
            "total_tables": total_tables,
            "active_tables": active_tables,
            "total_seats": total_seats,
            "occupied_seats": occupied_seats,
            "available_seats": total_seats - occupied_seats,
        }

    @staticmethod
    def get_day_stats(day_id: str) -> dict:
        """Get table statistics for a specific tournament day"""
        tables = TableService.get_day_tables(day_id)

        total_tables = len(tables)
        active_tables = len([t for t in tables if t.status == "active"])
        total_seats = sum(t.seats - len(t.blocked_seats) for t in tables if t.status == "active")
        occupied_seats = sum(t.occupied_seats for t in tables if t.status == "active")

        return {
            "total_tables": total_tables,
            "active_tables": active_tables,
            "total_seats": total_seats,
            "occupied_seats": occupied_seats,
            "available_seats": total_seats - occupied_seats,
        }
