from fastapi import APIRouter, HTTPException, status, Depends
from typing import List
from app.models.table import TableCreate, TableUpdate, Table
from app.services.table_service import TableService
from app.auth import get_current_user

router = APIRouter(prefix="/tables", tags=["tables"])


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
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.post("/tournament/{tournament_id}/bulk", response_model=List[Table], status_code=status.HTTP_201_CREATED)
def create_multiple_tables(
    tournament_id: str,
    count: int,
    seats: int,
    current_user: dict = Depends(get_current_user)
):
    """Create multiple tables at once"""
    try:
        if count < 1 or count > 50:
            raise ValueError("Count must be between 1 and 50")
        if seats < 1 or seats > 10:
            raise ValueError("Seats must be between 1 and 10")

        return TableService.create_multiple_tables(tournament_id, count, seats)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


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


@router.get("/{table_id}", response_model=Table)
def get_table(
    table_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get a specific table"""
    table = TableService.get_table(table_id)
    if not table:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Table not found"
        )
    return table


@router.patch("/{table_id}", response_model=Table)
def update_table(
    table_id: str,
    update_data: TableUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update table information"""
    table = TableService.update_table(table_id, update_data)
    if not table:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Table not found"
        )
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
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Table not found"
            )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.post("/{table_id}/break", response_model=Table)
def break_table(
    table_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Mark table as broken"""
    table = TableService.break_table(table_id)
    if not table:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Table not found"
        )
    return table
