from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional

from app.auth.jwt import get_current_user
from app.models.expense import (
    ExpenseCreate, ExpenseUpdate,
    ExpenseCategoryCreate, ExpenseCategoryUpdate,
)
from app.services.expense_service import ExpenseService

router = APIRouter(prefix="/expenses", tags=["expenses"])


def _org(current_user: dict) -> Optional[str]:
    return current_user.get("organization_id")


# ── Categorias ───────────────────────────────────────────────────────────────
# Declaradas ANTES de /{expense_id}, senão "categories" seria lido como um id.

@router.get("/categories")
def list_categories(active: bool = False, current_user: dict = Depends(get_current_user)):
    return ExpenseService.get_categories(_org(current_user), active_only=active)


@router.post("/categories")
def create_category(data: ExpenseCategoryCreate, current_user: dict = Depends(get_current_user)):
    return ExpenseService.create_category(_org(current_user), data.model_dump())


@router.patch("/categories/{category_id}")
def update_category(
    category_id: str,
    data: ExpenseCategoryUpdate,
    current_user: dict = Depends(get_current_user),
):
    updated = ExpenseService.update_category(
        _org(current_user), category_id, data.model_dump(exclude_unset=True)
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Categoria não encontrada.")
    return updated


@router.delete("/categories/{category_id}")
def delete_category(category_id: str, current_user: dict = Depends(get_current_user)):
    if not ExpenseService.delete_category(_org(current_user), category_id):
        raise HTTPException(status_code=404, detail="Categoria não encontrada.")
    return {"deleted": True}


# ── Resumo (DRE) ─────────────────────────────────────────────────────────────

@router.get("/summary")
def summary(
    stage_id: Optional[str] = Query(None),
    tournament_id: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    current_user: dict = Depends(get_current_user),
):
    """Total por categoria + pago/pendente, para o DRE da etapa."""
    return ExpenseService.summarize(_org(current_user), stage_id, tournament_id, start, end)


# ── Despesas ─────────────────────────────────────────────────────────────────

@router.get("")
def list_expenses(
    stage_id: Optional[str] = Query(None),
    tournament_id: Optional[str] = Query(None),
    category_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    current_user: dict = Depends(get_current_user),
):
    return ExpenseService.list_expenses(
        _org(current_user), stage_id, tournament_id, category_id, status, start, end
    )


@router.post("")
def create_expense(data: ExpenseCreate, current_user: dict = Depends(get_current_user)):
    created = ExpenseService.create_expense(
        _org(current_user), data.model_dump(), current_user.get("sub")
    )
    if not created:
        raise HTTPException(status_code=400, detail="Não foi possível registrar a despesa.")
    return created


@router.patch("/{expense_id}")
def update_expense(
    expense_id: str,
    data: ExpenseUpdate,
    current_user: dict = Depends(get_current_user),
):
    updated = ExpenseService.update_expense(
        _org(current_user), expense_id, data.model_dump(exclude_unset=True)
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Despesa não encontrada.")
    return updated


@router.delete("/{expense_id}")
def delete_expense(expense_id: str, current_user: dict = Depends(get_current_user)):
    if not ExpenseService.delete_expense(_org(current_user), expense_id):
        raise HTTPException(status_code=404, detail="Despesa não encontrada.")
    return {"deleted": True}
