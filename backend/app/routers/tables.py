from fastapi import APIRouter, HTTPException, status, Depends
from typing import List, Optional
from app.models.table import SeatStatusUpdate, TableCreate, TableUpdate, Table
from app.services.table_service import TableService
from app.auth import get_current_user
# Recusas com CODIGO para a tela traduzir (ver app/utils/erros.py).
from app.utils.erros import da_excecao, nao_encontrado, recusado

router = APIRouter(prefix="/tables", tags=["tables"])


def _validar_lote(count: int, seats: int, start_number: Optional[int]) -> None:
    """Limites do lote. Os valores vão TAMBÉM como dado nomeado: a tela monta
    "entre 1 e 50" no idioma dela sem depender da frase em inglês.

    Quantidade tem teto (500 mesas seria erro de digitação, não intenção).
    Assentos NÃO têm: o clube monta a mesa que o salão pede — só precisa ser
    positivo. O número inicial, quando vem, idem.
    """
    if count < 1 or count > 50:
        raise recusado(
            "quantidade_de_mesas_invalida",
            "Count must be between 1 and 50",
            minimo=1, maximo=50,
        )
    if seats < 1:
        raise recusado(
            "lugares_por_mesa_invalido",
            "Seats must be at least 1",
            minimo=1,
        )
    if start_number is not None and start_number < 1:
        raise recusado(
            "numero_de_mesa_invalido",
            "Table number must be at least 1",
            minimo=1,
        )


def _torneio_do_dia(day_id: str) -> str:
    """As rotas por dia descobrem o torneio a partir do dia. Dia inexistente é
    404, não 500: o operador escolheu o dia errado, o sistema não quebrou."""
    from app.database import supabase
    day = supabase.table("tournament_days").select("tournament_id").eq("id", day_id).single().execute()
    if not day.data:
        raise nao_encontrado("dia_nao_encontrado", "Day not found")
    return day.data["tournament_id"]


# ── Tournament-scoped (legacy) endpoints ──────────────────────────────────────

@router.post("/tournament/{tournament_id}", response_model=Table, status_code=status.HTTP_201_CREATED)
def create_table(
    tournament_id: str,
    table_data: TableCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new table for a tournament"""
    try:
        return TableService.create_table(tournament_id, table_data)
    except Exception as e:
        raise da_excecao(e, "criacao_de_mesa_recusada")


@router.post("/tournament/{tournament_id}/bulk", response_model=List[Table], status_code=status.HTTP_201_CREATED)
def create_multiple_tables(
    tournament_id: str,
    count: int,
    seats: int,
    start_number: Optional[int] = None,
    current_user: dict = Depends(get_current_user)
):
    """Create multiple tables at once"""
    _validar_lote(count, seats, start_number)
    try:
        return TableService.create_multiple_tables(tournament_id, count, seats, start_number=start_number)
    except ValueError as e:
        raise da_excecao(e, "criacao_de_mesas_recusada")


@router.get("/tournament/{tournament_id}", response_model=List[Table])
def get_tournament_tables(
    tournament_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get all tables for a tournament"""
    return TableService.get_tournament_tables(tournament_id)


@router.get("/tournament/{tournament_id}/stats")
def get_tournament_table_stats(
    tournament_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get table statistics for a tournament"""
    return TableService.get_tournament_stats(tournament_id)


# ── Day-scoped endpoints ──────────────────────────────────────────────────────

@router.post("/day/{day_id}", response_model=Table, status_code=status.HTTP_201_CREATED)
def create_table_for_day(
    day_id: str,
    table_data: TableCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new table scoped to a tournament day"""
    try:
        tournament_id = _torneio_do_dia(day_id)
        return TableService.create_table(tournament_id, table_data, tournament_day_id=day_id)
    except HTTPException:
        raise
    except Exception as e:
        raise da_excecao(e, "criacao_de_mesa_recusada")


@router.post("/day/{day_id}/bulk", response_model=List[Table], status_code=status.HTTP_201_CREATED)
def create_multiple_tables_for_day(
    day_id: str,
    count: int,
    seats: int,
    start_number: Optional[int] = None,
    current_user: dict = Depends(get_current_user)
):
    """Create multiple tables scoped to a tournament day"""
    _validar_lote(count, seats, start_number)
    try:
        tournament_id = _torneio_do_dia(day_id)
        return TableService.create_multiple_tables(
            tournament_id, count, seats, tournament_day_id=day_id, start_number=start_number,
        )
    except HTTPException:
        raise
    except ValueError as e:
        raise da_excecao(e, "criacao_de_mesas_recusada")


@router.get("/day/{day_id}", response_model=List[Table])
def get_day_tables(
    day_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get all tables for a specific tournament day"""
    return TableService.get_day_tables(day_id)


@router.get("/day/{day_id}/stats")
def get_day_table_stats(
    day_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get table statistics for a specific tournament day"""
    return TableService.get_day_stats(day_id)


# ── Per-table endpoints ───────────────────────────────────────────────────────

@router.get("/{table_id}", response_model=Table)
def get_table(
    table_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get a specific table"""
    table = TableService.get_table(table_id)
    if not table:
        raise nao_encontrado("mesa_nao_encontrada", "Table not found")
    return table


@router.patch("/{table_id}", response_model=Table)
def update_table(
    table_id: str,
    update_data: TableUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update table information (number, seats, status)"""
    try:
        table = TableService.update_table(table_id, update_data)
    except ValueError as e:
        # Número repetido no dia chega aqui como ErroDeNegocio (409 com código).
        raise da_excecao(e, "atualizacao_de_mesa_recusada")
    if not table:
        raise nao_encontrado("mesa_nao_encontrada", "Table not found")
    return table


@router.patch("/{table_id}/seats/{seat_number}", response_model=Table)
def set_seat_status(
    table_id: str,
    seat_number: int,
    body: SeatStatusUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Ativa ou desativa um assento da mesa."""
    try:
        table = TableService.set_seat_active(table_id, seat_number, body.active)
    except ValueError as e:
        raise da_excecao(e, "alteracao_de_assento_recusada")
    if not table:
        raise nao_encontrado("mesa_nao_encontrada", "Table not found")
    return table


@router.delete("/{table_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_table(
    table_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Delete a table"""
    try:
        success = TableService.delete_table(table_id)
        if not success:
            raise nao_encontrado("mesa_nao_encontrada", "Table not found")
    except ValueError as e:
        raise da_excecao(e, "exclusao_de_mesa_recusada")


@router.post("/{table_id}/break", response_model=Table)
def break_table(
    table_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Mark table as broken"""
    table = TableService.break_table(table_id)
    if not table:
        raise nao_encontrado("mesa_nao_encontrada", "Table not found")
    return table
