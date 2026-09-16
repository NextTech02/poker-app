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
    BarItemCancel,
    BarItemCourtesy,
    BarPaymentCancel,
    BarPendingOrder,
    BarProductCreate,
    BarProductResponse,
    BarProductUpdate,
    BarShiftClose,
    BarShiftCreate,
    BarShiftResponse,
    BarShiftSummary,
    BarStockMovementCreate,
    BarStockMovementResponse,
    BarTabCancel,
    BarTabClose,
    BarTabDetail,
    BarTabDiscount,
    BarTabItemCreate,
    BarTabOpen,
    BarTabPay,
    BarTabResponse,
)
from app.services.bar_product_service import BarProductService
from app.services.bar_shift_service import BarShiftService
from app.services.bar_tab_service import BarTabService
from app.services.staff_service import StaffService
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


# ══════════════════════════════════════════════════════════════════════
# Comandas
# ══════════════════════════════════════════════════════════════════════

def _pode_administrar_o_bar(user: dict) -> bool:
    """Para as ações que dependem do CARGO dentro da mesma rota (cancelar item
    já entregue): operador e gerente batem na mesma URL."""
    perms = StaffService.get_my_permissions(user.get("sub"))
    return bool(perms.is_admin or "bar.admin" in (perms.permissions or []))


@router.post("/tabs/open", response_model=BarTabResponse)
def open_tab(
    data: BarTabOpen,
    user=_operar,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    """Devolve a comanda aberta do jogador ou cria uma (comanda ÚNICA por
    jogador — o banco garante, o serviço relê)."""
    try:
        return BarTabService.open_tab(data, user.get("sub"), organization_id)
    except ValueError as e:
        raise da_excecao(e)


@router.get("/tabs", response_model=List[BarTabResponse])
def list_tabs(
    bar_shift_id: Optional[str] = None,
    status: Optional[str] = None,
    player_id: Optional[str] = None,
    limit: int = Query(200, ge=1, le=1000),
    user=_operar,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return BarTabService.list_tabs(organization_id, bar_shift_id, status, player_id, limit)


@router.get("/orders", response_model=List[BarPendingOrder])
def pending_orders(
    bar_shift_id: str,
    user=_operar,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    """Os itens ainda não entregues do turno — a tela do balcão/cozinha."""
    return BarTabService.pending_orders(organization_id, bar_shift_id)


@router.get("/players/{player_id}/tabs", response_model=List[BarTabResponse])
def player_tabs(
    player_id: str,
    limit: int = Query(50, ge=1, le=500),
    user=Depends(require_permission("players", "bar.operate")),
):
    return BarTabService.player_history(player_id, limit)


@router.get("/tabs/{tab_id}", response_model=BarTabDetail)
def get_tab(tab_id: str, user=_operar):
    try:
        return BarTabService.detail(tab_id)
    except ValueError as e:
        raise da_excecao(e)


@router.post("/tabs/{tab_id}/items", response_model=BarTabDetail)
def add_item(tab_id: str, data: BarTabItemCreate, user=_operar):
    try:
        return BarTabService.add_item(tab_id, data, user.get("sub"))
    except ValueError as e:
        raise da_excecao(e)


@router.post("/tabs/{tab_id}/items/{item_id}/deliver", response_model=BarTabDetail)
def deliver_item(tab_id: str, item_id: str, user=_operar):
    try:
        return BarTabService.deliver_item(tab_id, item_id, user.get("sub"))
    except ValueError as e:
        raise da_excecao(e)


@router.post("/tabs/{tab_id}/deliver-all", response_model=BarTabDetail)
def deliver_all(tab_id: str, user=_operar):
    try:
        return BarTabService.deliver_all(tab_id, user.get("sub"))
    except ValueError as e:
        raise da_excecao(e)


@router.post("/tabs/{tab_id}/items/{item_id}/cancel", response_model=BarTabDetail)
def cancel_item(tab_id: str, item_id: str, data: BarItemCancel, user=_operar):
    """Pendente: o operador cancela. Entregue: só bar.admin — o item já saiu
    do balcão, e tirá-lo da conta é decisão de gerente."""
    try:
        return BarTabService.cancel_item(
            tab_id, item_id, data.reason, user.get("sub"), _pode_administrar_o_bar(user)
        )
    except ValueError as e:
        raise da_excecao(e)


@router.post("/tabs/{tab_id}/items/{item_id}/courtesy", response_model=BarTabDetail)
def set_courtesy(tab_id: str, item_id: str, data: BarItemCourtesy, user=_admin):
    try:
        return BarTabService.set_courtesy(tab_id, item_id, data, user.get("sub"))
    except ValueError as e:
        raise da_excecao(e)


@router.post("/tabs/{tab_id}/discount", response_model=BarTabDetail)
def set_discount(tab_id: str, data: BarTabDiscount, user=_admin):
    try:
        return BarTabService.set_discount(tab_id, data, user.get("sub"))
    except ValueError as e:
        raise da_excecao(e)


@router.post("/tabs/{tab_id}/payments", response_model=BarTabDetail)
def pay_tab(
    tab_id: str,
    data: BarTabPay,
    user=_operar,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    """Uma ou várias pernas (parcial e/ou dividido). Perna `cash` (qualquer
    meio) exige a gaveta do barman aberta; perna `credit` consome o crédito do
    jogador e não passa pela gaveta."""
    try:
        return BarTabService.pay(tab_id, data, user.get("sub"), organization_id)
    except ValueError as e:
        raise da_excecao(e)


@router.post("/tabs/{tab_id}/payments/{payment_id}/cancel", response_model=BarTabDetail)
def cancel_payment(tab_id: str, payment_id: str, data: BarPaymentCancel, user=_admin):
    try:
        return BarTabService.cancel_payment(tab_id, payment_id, data.reason, user.get("sub"))
    except ValueError as e:
        raise da_excecao(e)


@router.post("/tabs/{tab_id}/close", response_model=BarTabResponse)
def close_tab(tab_id: str, data: BarTabClose, user=_operar):
    try:
        return BarTabService.close_tab(tab_id, data, user.get("sub"))
    except ValueError as e:
        raise da_excecao(e)


@router.post("/tabs/{tab_id}/reopen", response_model=BarTabResponse)
def reopen_tab(tab_id: str, user=_admin):
    try:
        return BarTabService.reopen_tab(tab_id, user.get("sub"))
    except ValueError as e:
        raise da_excecao(e)


@router.post("/tabs/{tab_id}/cancel", response_model=BarTabResponse)
def cancel_tab(tab_id: str, data: BarTabCancel, user=_admin):
    try:
        return BarTabService.cancel_tab(tab_id, data.reason, user.get("sub"))
    except ValueError as e:
        raise da_excecao(e)
