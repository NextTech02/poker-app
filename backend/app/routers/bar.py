"""Rotas do módulo de BAR.

Prefixo `/bar`. O escopo viaja EXPLÍCITO (`bar_shift_id` na query, ids no
caminho), nunca num header — o `X-Stage-ID` do torneio é ignorado aqui.

Quem barra o acesso de fora é `require_module("bar")`, aplicado em bloco no
main.py: permissão diz quem opera, módulo diz se o clube contratou.

Permissões:
  bar.operate  comanda, itens, entrega, pagamento, fechamento
  bar.shift    abrir/fechar o turno
  bar.admin    catálogo, estoque, desconto/cortesia, estorno, reabrir/cancelar
  bar.reports  relatórios
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, Query

from app.auth.jwt import get_current_user
from app.auth.permissions import require_permission
from app.dependencies import get_org_id_optional
from app.models.bar import (
    BarCategoryCreate,
    BarCategoryResponse,
    BarCategoryUpdate,
    BarProductCreate,
    BarProductResponse,
    BarProductUpdate,
    BarShiftClose,
    BarShiftCreate,
    BarShiftResponse,
    BarShiftSummary,
    BarStockMovementCreate,
    BarStockMovementResponse,
)
from app.services.bar_product_service import BarProductService
from app.services.bar_shift_service import BarShiftService
from app.utils.erros import da_excecao

router = APIRouter(prefix="/bar", tags=["bar"])

_operar  = Depends(require_permission("bar.operate"))
_turno   = Depends(require_permission("bar.shift"))
_admin   = Depends(require_permission("bar.admin"))
_relatar = Depends(require_permission("bar.reports", "bar.shift", "bar.operate"))
# Quem opera a POS precisa LER o catálogo; só o admin o edita.
_catalogo = Depends(require_permission("bar.operate", "bar.admin", "bar.shift"))


# ══════════════════════════════════════════════════════════════════════
# Turno
# ══════════════════════════════════════════════════════════════════════

@router.post("/shifts", response_model=BarShiftResponse)
def open_shift(
    data: BarShiftCreate,
    user=_turno,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    """Abre o turno. A data vem do formulário, não do relógio — a noite que
    atravessa a meia-noite é um turno só."""
    try:
        return BarShiftService.open_shift(data, user.get("sub"), organization_id)
    except ValueError as e:
        raise da_excecao(e)


# Antes de /shifts/{bar_shift_id}: senão "current" seria lido como um id.
@router.get("/shifts/current", response_model=Optional[BarShiftResponse])
def current_shift(
    user=Depends(get_current_user),
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return BarShiftService.get_current(organization_id)


@router.get("/shifts", response_model=List[BarShiftResponse])
def list_shifts(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = Query(90, ge=1, le=400),
    user=_relatar,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return BarShiftService.list_shifts(organization_id, date_from, date_to, status, limit)


@router.get("/shifts/{bar_shift_id}", response_model=BarShiftResponse)
def get_shift(bar_shift_id: str, user=Depends(get_current_user)):
    try:
        return BarShiftResponse(**BarShiftService.get_shift(bar_shift_id))
    except ValueError as e:
        raise da_excecao(e)


@router.get("/shifts/{bar_shift_id}/summary", response_model=BarShiftSummary)
def shift_summary(bar_shift_id: str, user=Depends(get_current_user)):
    try:
        return BarShiftService.summary(bar_shift_id)
    except ValueError as e:
        raise da_excecao(e)


@router.post("/shifts/{bar_shift_id}/close", response_model=BarShiftResponse)
def close_shift(bar_shift_id: str, data: BarShiftClose, user=_turno):
    """Fecha o turno. Recusa com comanda aberta (comanda não vira dívida) e
    com gaveta aberta (o turno é a unidade de conferência)."""
    try:
        return BarShiftService.close_shift(bar_shift_id, user.get("sub"), data.notes)
    except ValueError as e:
        raise da_excecao(e)


# ══════════════════════════════════════════════════════════════════════
# Catálogo: categorias
# ══════════════════════════════════════════════════════════════════════

@router.get("/categories", response_model=List[BarCategoryResponse])
def list_categories(
    active: Optional[bool] = None,
    user=_catalogo,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return BarProductService.list_categories(organization_id, active)


@router.post("/categories", response_model=BarCategoryResponse, status_code=201)
def create_category(
    data: BarCategoryCreate,
    user=_admin,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    try:
        return BarProductService.create_category(data, organization_id)
    except ValueError as e:
        raise da_excecao(e)


@router.patch("/categories/{category_id}", response_model=BarCategoryResponse)
def update_category(category_id: str, data: BarCategoryUpdate, user=_admin):
    try:
        return BarProductService.update_category(category_id, data)
    except ValueError as e:
        raise da_excecao(e)


@router.delete("/categories/{category_id}")
def delete_category(category_id: str, user=_admin):
    try:
        return BarProductService.delete_category(category_id)
    except ValueError as e:
        raise da_excecao(e)


# ══════════════════════════════════════════════════════════════════════
# Catálogo: produtos e estoque
# ══════════════════════════════════════════════════════════════════════

@router.get("/products", response_model=List[BarProductResponse])
def list_products(
    active: Optional[bool] = None,
    category_id: Optional[str] = None,
    q: Optional[str] = None,
    low_stock: Optional[bool] = None,
    user=_catalogo,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return BarProductService.list_products(organization_id, active, category_id, q, low_stock)


# Antes de /products/{product_id}.
@router.get("/stock/low", response_model=List[BarProductResponse])
def low_stock(
    user=_catalogo,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return BarProductService.low_stock(organization_id)


@router.post("/products", response_model=BarProductResponse, status_code=201)
def create_product(
    data: BarProductCreate,
    user=_admin,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    try:
        return BarProductService.create_product(data, organization_id)
    except ValueError as e:
        raise da_excecao(e)


@router.get("/products/{product_id}", response_model=BarProductResponse)
def get_product(product_id: str, user=_catalogo):
    try:
        produto = BarProductService.get_product(product_id)
        return BarProductService._enriquecer([produto], produto.get("organization_id"))[0]
    except ValueError as e:
        raise da_excecao(e)


@router.patch("/products/{product_id}", response_model=BarProductResponse)
def update_product(product_id: str, data: BarProductUpdate, user=_admin):
    try:
        return BarProductService.update_product(product_id, data)
    except ValueError as e:
        raise da_excecao(e)


@router.delete("/products/{product_id}")
def delete_product(product_id: str, user=_admin):
    try:
        return BarProductService.delete_product(product_id)
    except ValueError as e:
        raise da_excecao(e)


@router.post("/products/{product_id}/stock-movements")
def add_stock_movement(
    product_id: str,
    data: BarStockMovementCreate,
    user=_admin,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    """Entrada, ajuste ou perda. Venda e devolução nascem por trigger a partir
    do item da comanda — nunca por aqui."""
    try:
        return BarProductService.add_stock_movement(product_id, data, user.get("sub"), organization_id)
    except ValueError as e:
        raise da_excecao(e)


@router.get("/products/{product_id}/stock-movements", response_model=List[BarStockMovementResponse])
def list_stock_movements(
    product_id: str,
    limit: int = Query(100, ge=1, le=1000),
    user=_admin,
):
    try:
        return BarProductService.list_movements(product_id, limit)
    except ValueError as e:
        raise da_excecao(e)
