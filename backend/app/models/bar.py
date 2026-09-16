"""Modelos do módulo de BAR (produtos, estoque, turno, comandas, pagamentos).

A unidade de operação é o TURNO (`bar_shifts`): abre, roda a noite, quita as
comandas e fecha. O caixa do bar é a gaveta do operador (`cashboxes`) ancorada
no turno — o mesmo modelo de caixa do torneio e do cash.

TRÊS NÚMEROS QUE NÃO SE MISTURAM NA COMANDA:
  - `subtotal`: itens ativos que se cobram (cortesia fica fora);
  - `total`: subtotal − desconto (é o que o jogador deve);
  - `paid_amount`: Σ pernas ativas (dinheiro em qualquer meio + crédito).
A comanda fecha quando `total − paid_amount == 0`. Nunca há saldo devedor.
"""
from datetime import date, datetime
from typing import List, Optional

from pydantic import BaseModel, Field


# ────────────────────────────────────────────────
# Turno
# ────────────────────────────────────────────────

class BarShiftCreate(BaseModel):
    # A data é ESCOLHIDA, nunca deduzida do relógio: a noite que começa 21h e
    # termina 03h é um turno só.
    business_date: date
    label: Optional[str] = Field(None, max_length=160)
    notes: Optional[str] = None


class BarShiftClose(BaseModel):
    notes: Optional[str] = None


class BarShiftResponse(BaseModel):
    id: str
    organization_id: Optional[str] = None
    business_date: date
    label: Optional[str] = None
    status: str
    opened_at: datetime
    opened_by: Optional[str] = None
    closed_at: Optional[datetime] = None
    closed_by: Optional[str] = None
    last_tab_number: int = 0
    # Congelados no fechamento; None enquanto aberto (a leitura ao vivo agrega).
    total_gross: Optional[float] = None
    total_discounts: Optional[float] = None
    total_courtesy: Optional[float] = None
    total_net: Optional[float] = None
    total_paid: Optional[float] = None
    total_paid_cash: Optional[float] = None
    total_paid_credit: Optional[float] = None
    total_cogs: Optional[float] = None
    tabs_count: Optional[int] = None
    items_count: Optional[int] = None
    totals_by_method: Optional[dict] = None
    notes: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BarPaymentMethodTotal(BaseModel):
    payment_method: str
    amount: float = 0.0
    count: int = 0


class BarShiftSummary(BaseModel):
    """Os números do turno, ao vivo ou congelados.

    `total_net` é a receita (o que os jogadores devem pelas comandas);
    `total_paid` é o que efetivamente entrou (em turno fechado os dois são
    iguais — comanda só fecha quitada). `total_cogs` é o custo das mercadorias
    vendidas: serve à MARGEM, e é informativo no DRE (a compra já é despesa).
    """
    bar_shift_id: str
    business_date: date
    status: str
    total_gross: float = 0.0
    total_discounts: float = 0.0
    total_courtesy: float = 0.0
    total_net: float = 0.0
    total_paid: float = 0.0
    total_paid_cash: float = 0.0
    total_paid_credit: float = 0.0
    total_cogs: float = 0.0
    gross_margin: float = 0.0
    tabs_open: int = 0
    tabs_total: int = 0
    items_pending: int = 0
    items_count: int = 0
    balance_due: float = 0.0        # Σ saldo das comandas abertas
    by_method: List[BarPaymentMethodTotal] = []
    low_stock_count: int = 0


# ────────────────────────────────────────────────
# Catálogo
# ────────────────────────────────────────────────

class BarCategoryCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    sort_order: int = 0
    active: bool = True


class BarCategoryUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    sort_order: Optional[int] = None
    active: Optional[bool] = None


class BarCategoryResponse(BaseModel):
    id: str
    organization_id: Optional[str] = None
    name: str
    sort_order: int = 0
    active: bool = True
    products_count: int = 0
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BarProductCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    category_id: Optional[str] = None
    description: Optional[str] = None
    price: float = Field(..., ge=0)
    cost_price: float = Field(0, ge=0)
    track_stock: bool = False
    min_stock: int = Field(0, ge=0)
    sku: Optional[str] = Field(None, max_length=40)
    active: bool = True
    sort_order: int = 0


class BarProductUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    category_id: Optional[str] = None
    description: Optional[str] = None
    price: Optional[float] = Field(None, ge=0)
    cost_price: Optional[float] = Field(None, ge=0)
    track_stock: Optional[bool] = None
    min_stock: Optional[int] = Field(None, ge=0)
    sku: Optional[str] = Field(None, max_length=40)
    active: Optional[bool] = None
    sort_order: Optional[int] = None
    # Aceito no corpo SÓ para ser recusado com nome (estoque_so_por_movimento):
    # estoque muda por entrada, ajuste ou perda, nunca por edição do produto.
    # Ignorar em silêncio deixaria o operador achando que gravou.
    stock_qty: Optional[int] = None


class BarProductResponse(BaseModel):
    id: str
    organization_id: Optional[str] = None
    category_id: Optional[str] = None
    category_name: Optional[str] = None
    name: str
    description: Optional[str] = None
    price: float
    cost_price: float = 0.0
    track_stock: bool = False
    stock_qty: int = 0
    min_stock: int = 0
    low_stock: bool = False
    sku: Optional[str] = None
    active: bool = True
    sort_order: int = 0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BarStockMovementCreate(BaseModel):
    # Só os MANUAIS: venda e devolução são gerados por trigger.
    kind: str = Field(..., pattern="^(in|adjustment|loss)$")
    # Sempre positivo na entrada; o serviço aplica o sinal pelo `kind`
    # ('in' soma, 'loss' subtrai, 'adjustment' pode ser ±).
    quantity: int
    unit_cost: Optional[float] = Field(None, ge=0)
    notes: Optional[str] = None
    client_mutation_id: Optional[str] = Field(None, max_length=80)


class BarStockMovementResponse(BaseModel):
    id: str
    product_id: str
    kind: str
    quantity: int
    unit_cost: Optional[float] = None
    tab_item_id: Optional[str] = None
    notes: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ────────────────────────────────────────────────
# Comanda
# ────────────────────────────────────────────────

class BarTabOpen(BaseModel):
    player_id: str
    notes: Optional[str] = None
    client_mutation_id: Optional[str] = Field(None, max_length=80)


class BarTabResponse(BaseModel):
    id: str
    organization_id: Optional[str] = None
    bar_shift_id: str
    player_id: str
    player_name: Optional[str] = None
    player_nickname: Optional[str] = None
    number: int
    status: str
    subtotal: float = 0.0
    courtesy_amount: float = 0.0
    discount_amount: float = 0.0
    discount_reason: Optional[str] = None
    total: float = 0.0
    paid_amount: float = 0.0
    balance_due: float = 0.0
    items_count: int = 0
    pending_count: int = 0
    opened_at: datetime
    opened_by: Optional[str] = None
    closed_at: Optional[datetime] = None
    closed_by: Optional[str] = None
    cancelled_at: Optional[datetime] = None
    cancel_reason: Optional[str] = None
    notes: Optional[str] = None

    class Config:
        from_attributes = True


class BarTabItemCreate(BaseModel):
    product_id: str
    quantity: int = Field(1, ge=1, le=999)
    notes: Optional[str] = None
    client_mutation_id: Optional[str] = Field(None, max_length=80)


class BarTabItemResponse(BaseModel):
    id: str
    tab_id: str
    bar_shift_id: Optional[str] = None
    product_id: str
    product_name: str
    unit_price: float
    unit_cost: float = 0.0
    quantity: int
    line_total: float = 0.0
    is_courtesy: bool = False
    courtesy_reason: Optional[str] = None
    status: str
    delivered_at: Optional[datetime] = None
    cancelled_at: Optional[datetime] = None
    cancel_reason: Optional[str] = None
    notes: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BarItemCancel(BaseModel):
    reason: str = Field(..., min_length=1, max_length=300)


class BarItemCourtesy(BaseModel):
    courtesy: bool = True
    reason: Optional[str] = Field(None, max_length=300)


class BarTabDiscount(BaseModel):
    amount: float = Field(..., ge=0)
    reason: Optional[str] = Field(None, max_length=300)


class BarPaymentLeg(BaseModel):
    # Código de payment_methods (cash/pix/card/...) — ou 'credit'.
    payment_method: str = Field(..., min_length=1, max_length=50)
    amount: float = Field(..., gt=0)
    # 'cash' = dinheiro real (qualquer meio); 'credit' = crédito do jogador.
    payment_source: str = Field("cash", pattern="^(cash|credit)$")


class BarTabPay(BaseModel):
    legs: List[BarPaymentLeg] = Field(..., min_length=1, max_length=10)
    notes: Optional[str] = None
    client_mutation_id: Optional[str] = Field(None, max_length=80)


class BarPaymentResponse(BaseModel):
    id: str
    tab_id: str
    bar_shift_id: Optional[str] = None
    amount: float
    payment_method: str
    payment_source: str = "cash"
    cashbox_id: Optional[str] = None
    status: str
    cancelled_at: Optional[datetime] = None
    cancel_reason: Optional[str] = None
    notes: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BarPaymentCancel(BaseModel):
    reason: str = Field(..., min_length=1, max_length=300)


class BarTabClose(BaseModel):
    deliver_pending: bool = False
    notes: Optional[str] = None


class BarTabCancel(BaseModel):
    reason: str = Field(..., min_length=1, max_length=300)


class BarTabDetail(BaseModel):
    tab: BarTabResponse
    items: List[BarTabItemResponse] = []
    payments: List[BarPaymentResponse] = []
    # Calculado no servidor SEM filtro de etapa (o endpoint de saldo de crédito
    # filtra por X-Stage-ID, e uma etapa selecionada por acaso esconderia
    # crédito do jogador na POS).
    player_available_credit: float = 0.0


class BarPendingOrder(BaseModel):
    """Um item pendente, como a tela de pedidos o mostra."""
    item_id: str
    tab_id: str
    tab_number: int
    player_name: Optional[str] = None
    product_name: str
    quantity: int
    notes: Optional[str] = None
    created_at: Optional[datetime] = None


# ────────────────────────────────────────────────
# Relatórios
# ────────────────────────────────────────────────

class BarDailyRow(BaseModel):
    business_date: date
    shifts: int = 0
    tabs: int = 0
    items: int = 0
    gross: float = 0.0
    discounts: float = 0.0
    courtesy: float = 0.0
    net: float = 0.0
    paid: float = 0.0
    paid_cash: float = 0.0
    paid_credit: float = 0.0
    cogs: float = 0.0
    margin: float = 0.0


class BarProductRow(BaseModel):
    product_id: str
    product_name: str
    category_name: Optional[str] = None
    quantity: int = 0
    courtesy_quantity: int = 0
    revenue: float = 0.0
    cogs: float = 0.0
    margin: float = 0.0


class BarPlayerRow(BaseModel):
    player_id: str
    player_name: Optional[str] = None
    tabs: int = 0
    items: int = 0
    spent: float = 0.0


class BarReportSummary(BaseModel):
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    shifts: int = 0
    tabs: int = 0
    items: int = 0
    gross: float = 0.0
    discounts: float = 0.0
    courtesy: float = 0.0
    net: float = 0.0
    paid: float = 0.0
    paid_cash: float = 0.0
    paid_credit: float = 0.0
    cogs: float = 0.0
    margin: float = 0.0
    average_tab: float = 0.0
    by_method: List[BarPaymentMethodTotal] = []
    daily: List[BarDailyRow] = []
    top_products: List[BarProductRow] = []
