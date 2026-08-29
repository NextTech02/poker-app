from fastapi import APIRouter, Depends, Query
from typing import Optional

from app.auth.jwt import get_current_user
from app.models.expense import (
    ExpenseCreate, ExpenseUpdate,
    ExpenseCategoryCreate, ExpenseCategoryUpdate,
    RevenueCreate, RevenueUpdate,
    AttachmentCreate, ExpenseTemplateCreate,
)
from app.services.expense_service import ExpenseService
from app.utils.erros import da_excecao, nao_encontrado, recusado

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
        raise nao_encontrado("categoria_nao_encontrada", "Categoria não encontrada.")
    return updated


@router.delete("/categories/{category_id}")
def delete_category(category_id: str, current_user: dict = Depends(get_current_user)):
    if not ExpenseService.delete_category(_org(current_user), category_id):
        raise nao_encontrado("categoria_nao_encontrada", "Categoria não encontrada.")
    return {"deleted": True}


# ── Modelos de despesa recorrente ────────────────────────────────────────────
# Antes de /{expense_id} pelo mesmo motivo das categorias.

@router.get("/templates")
def list_templates(current_user: dict = Depends(get_current_user)):
    return ExpenseService.get_templates(_org(current_user))


@router.post("/templates")
def create_template(data: ExpenseTemplateCreate, current_user: dict = Depends(get_current_user)):
    return ExpenseService.create_template(_org(current_user), data.model_dump())


@router.delete("/templates/{template_id}")
def delete_template(template_id: str, current_user: dict = Depends(get_current_user)):
    if not ExpenseService.delete_template(_org(current_user), template_id):
        raise nao_encontrado("modelo_de_despesa_nao_encontrado", "Modelo não encontrado.")
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
    try:
        created = ExpenseService.create_expense(
            _org(current_user), data.model_dump(), current_user.get("sub")
        )
    except ValueError as e:
        # A frase vem do BANCO (o RPC do débito no caixa geral diz o motivo:
        # "Saldo insuficiente…"), então não há código específico a dar aqui —
        # o genérico mantém o formato único e a frase continua chegando inteira.
        raise da_excecao(e, code_padrao="despesa_recusada")
    if not created:
        raise recusado("despesa_nao_registrada", "Não foi possível registrar a despesa.")
    return created


@router.patch("/{expense_id}")
def update_expense(
    expense_id: str,
    data: ExpenseUpdate,
    current_user: dict = Depends(get_current_user),
):
    try:
        updated = ExpenseService.update_expense(
            _org(current_user), expense_id, data.model_dump(exclude_unset=True)
        )
    except ValueError as e:
        raise da_excecao(e, code_padrao="despesa_recusada")
    if updated is None:
        raise nao_encontrado("despesa_nao_encontrada", "Despesa não encontrada.")
    return updated


@router.delete("/{expense_id}")
def delete_expense(expense_id: str, current_user: dict = Depends(get_current_user)):
    if not ExpenseService.delete_expense(_org(current_user), expense_id):
        raise nao_encontrado("despesa_nao_encontrada", "Despesa não encontrada.")
    return {"deleted": True}


# ── Comprovantes ─────────────────────────────────────────────────────────────
# O upload/download acontece direto entre navegador e Storage (URL assinada);
# estas rotas só registram e listam os metadados.

@router.get("/{expense_id}/attachments")
def list_attachments(expense_id: str, current_user: dict = Depends(get_current_user)):
    return ExpenseService.list_attachments(_org(current_user), expense_id)


@router.post("/{expense_id}/attachments")
def add_attachment(
    expense_id: str,
    data: AttachmentCreate,
    current_user: dict = Depends(get_current_user),
):
    created = ExpenseService.add_attachment(
        _org(current_user), expense_id, data.model_dump(), current_user.get("sub")
    )
    if not created:
        raise recusado("comprovante_nao_registrado", "Não foi possível registrar o comprovante.")
    return created


@router.delete("/{expense_id}/attachments/{attachment_id}")
def delete_attachment(
    expense_id: str,
    attachment_id: str,
    current_user: dict = Depends(get_current_user),
):
    if not ExpenseService.delete_attachment(_org(current_user), attachment_id):
        raise nao_encontrado("comprovante_nao_encontrado", "Comprovante não encontrado.")
    return {"deleted": True}


# ── Outras receitas ──────────────────────────────────────────────────────────
# Router separado para não colidir com /expenses/{expense_id}.

revenues_router = APIRouter(prefix="/revenues", tags=["revenues"])


@revenues_router.get("/summary")
def revenue_summary(
    stage_id: Optional[str] = Query(None),
    tournament_id: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    current_user: dict = Depends(get_current_user),
):
    return ExpenseService.summarize_revenues(_org(current_user), stage_id, tournament_id, start, end)


@revenues_router.get("")
def list_revenues(
    stage_id: Optional[str] = Query(None),
    tournament_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    current_user: dict = Depends(get_current_user),
):
    return ExpenseService.list_revenues(
        _org(current_user), stage_id, tournament_id, status, start, end
    )


@revenues_router.post("")
def create_revenue(data: RevenueCreate, current_user: dict = Depends(get_current_user)):
    try:
        created = ExpenseService.create_revenue(
            _org(current_user), data.model_dump(), current_user.get("sub")
        )
    except ValueError as e:
        raise da_excecao(e, code_padrao="receita_recusada")
    if not created:
        raise recusado("receita_nao_registrada", "Não foi possível registrar a receita.")
    return created


@revenues_router.patch("/{revenue_id}")
def update_revenue(
    revenue_id: str,
    data: RevenueUpdate,
    current_user: dict = Depends(get_current_user),
):
    try:
        updated = ExpenseService.update_revenue(
            _org(current_user), revenue_id, data.model_dump(exclude_unset=True)
        )
    except ValueError as e:
        raise da_excecao(e, code_padrao="receita_recusada")
    if updated is None:
        raise nao_encontrado("receita_nao_encontrada", "Receita não encontrada.")
    return updated


@revenues_router.delete("/{revenue_id}")
def delete_revenue(revenue_id: str, current_user: dict = Depends(get_current_user)):
    if not ExpenseService.delete_revenue(_org(current_user), revenue_id):
        raise nao_encontrado("receita_nao_encontrada", "Receita não encontrada.")
    return {"deleted": True}
