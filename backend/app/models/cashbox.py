from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime
from enum import Enum


class CashboxStatus(str, Enum):
    closed = "closed"
    open = "open"
    archived = "archived"


class CashboxTransactionType(str, Enum):
    buy_in = "buy_in"
    rebuy = "rebuy"
    addon = "addon"
    prize = "prize"
    supply = "supply"
    sangria = "sangria"
    # Devolução de uma venda cancelada. TIPO PRÓPRIO de propósito: 'adjustment'
    # já significa "diferença de contagem do fechamento" e por isso é EXCLUÍDO
    # do saldo esperado do relatório de sessão. Lançar o estorno como
    # 'adjustment' fazia o relatório acusar o operador de faltar dinheiro que o
    # admin devolveu ao jogador.
    refund = "refund"
    adjustment = "adjustment"
    # Cash game: a compra e a devolução de fichas na mesa. Tipos PRÓPRIOS, e
    # não reuso de buy_in/prize, porque o Financeiro e o relatório de torneio
    # agregam por literal de tipo — reusar misturaria as duas receitas em toda
    # tela existente, sem forma de separar depois.
    #
    # O rake e o jackpot de cash NÃO aparecem aqui: eles saem do POTE, em
    # fichas, e já estão na gaveta como a diferença entre estes dois. Lançá-los
    # seria contar o mesmo dinheiro duas vezes.
    cash_buy_in = "cash_buy_in"
    cash_out = "cash_out"
    # Bar: pagamento de comanda com dinheiro REAL (qualquer meio). Tipo próprio
    # pelo mesmo motivo do cash. A perna paga com crédito do jogador NÃO entra
    # aqui — crédito não é dinheiro na gaveta. O estorno reusa `refund`, com
    # `bar_payment_id` preenchido.
    bar_sale = "bar_sale"


# ────────────────────────────────────────────────
# Cashbox
# ────────────────────────────────────────────────

class CashboxResponse(BaseModel):
    id: str
    staff_id: str
    # Âncora do caixa: uma etapa (torneio), um dia (cash game) OU um turno do
    # bar — exatamente uma. No cash e no bar a operação é por dia/turno, então
    # a gaveta abre e fecha nesse recorte — e a conferência já sai como o
    # clube usa.
    stage_id: Optional[str] = None
    cash_day_id: Optional[str] = None
    bar_shift_id: Optional[str] = None
    status: CashboxStatus
    current_balance: float
    current_session_id: Optional[str] = None
    last_opened_at: Optional[datetime] = None
    last_closed_at: Optional[datetime] = None
    archived_at: Optional[datetime] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    # Joined
    staff_name: Optional[str] = None
    staff_email: Optional[str] = None
    stage_name: Optional[str] = None
    cash_day_label: Optional[str] = None
    bar_shift_label: Optional[str] = None

    class Config:
        from_attributes = True


# ────────────────────────────────────────────────
# Sessions
# ────────────────────────────────────────────────

class CashboxCreate(BaseModel):
    """Manually ensure a cashbox exists for a staff member in the current stage
    (idempotent — returns the existing one if already present).

    `cash_day_id`/`bar_shift_id` trocam a âncora: sem eles, vale a etapa do
    header X-Stage-ID."""
    staff_id: str
    cash_day_id: Optional[str] = None
    bar_shift_id: Optional[str] = None


class CashboxOpen(BaseModel):
    """Open a cashbox with a counted initial balance."""
    initial_balance: float = Field(default=0.0, ge=0)
    notes: Optional[str] = Field(default=None, max_length=500)


class CashboxClose(BaseModel):
    """Close the current session. `actual_final_balance` is the physical
    count; the service computes the difference vs expected and (if non-zero)
    records an `adjustment` cashbox_transaction."""
    actual_final_balance: float = Field(..., ge=0)
    notes: Optional[str] = Field(default=None, max_length=500)


class CashboxSessionResponse(BaseModel):
    id: str
    cashbox_id: str
    opened_at: datetime
    opened_by: Optional[str] = None
    initial_balance: float
    closed_at: Optional[datetime] = None
    closed_by: Optional[str] = None
    expected_final_balance: Optional[float] = None
    actual_final_balance: Optional[float] = None
    difference: Optional[float] = None
    notes: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# ────────────────────────────────────────────────
# Movements (admin operations)
# ────────────────────────────────────────────────

class CashboxSupply(BaseModel):
    """Add money to a cashbox. Requires `cashbox.admin` permission."""
    amount: float = Field(..., gt=0)
    notes: Optional[str] = Field(default=None, max_length=500)


class CashboxSangria(BaseModel):
    """Withdraw money from a cashbox. Requires `cashbox.admin` permission.
    Unlike the stage-level sangria, this does NOT compute rake — it just
    moves money out of the operator's till to another destination."""
    amount: float = Field(..., gt=0)
    notes: Optional[str] = Field(default=None, max_length=500)


class CashboxTransactionResponse(BaseModel):
    id: str
    cashbox_id: str
    session_id: Optional[str] = None
    type: CashboxTransactionType
    amount: float
    signed_amount: float
    transaction_id: Optional[str] = None
    cash_transaction_id: Optional[str] = None
    bar_payment_id: Optional[str] = None
    performed_by: Optional[str] = None
    notes: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# ────────────────────────────────────────────────
# Aggregated views
# ────────────────────────────────────────────────

class CashboxSummary(BaseModel):
    """Per-cashbox aggregate over a period for the demonstrativo screen."""
    cashbox_id: str
    staff_name: Optional[str] = None
    stage_name: Optional[str] = None
    cash_day_id: Optional[str] = None
    cash_day_label: Optional[str] = None
    bar_shift_id: Optional[str] = None
    bar_shift_label: Optional[str] = None
    status: CashboxStatus
    initial_balance: float = 0.0
    total_supply: float = 0.0
    total_sangria: float = 0.0
    total_buy_ins: float = 0.0
    buy_in_count: int = 0
    total_rebuys: float = 0.0
    rebuy_count: int = 0
    total_addons: float = 0.0
    addon_count: int = 0
    total_prizes_paid: float = 0.0
    prize_count: int = 0
    # Cash game: fichas vendidas na mesa (entrada) e pagas no cash-out (saída).
    # Contam no esperado como qualquer outro dinheiro da gaveta.
    total_cash_buy_ins: float = 0.0
    cash_buy_in_count: int = 0
    total_cash_outs: float = 0.0
    cash_out_count: int = 0
    # Bar: pagamentos de comanda em dinheiro real (entrada).
    total_bar_sales: float = 0.0
    bar_sale_count: int = 0
    # Vendas canceladas (dinheiro devolvido ao jogador). Saída REAL da gaveta —
    # entra no saldo esperado, ao contrário de total_adjustments.
    total_refunds: float = 0.0
    refund_count: int = 0
    total_adjustments: float = 0.0
    expected_balance: float = 0.0
    current_balance: float = 0.0


class CashboxAggregatedSummary(BaseModel):
    """Aggregate across many cashboxes (admin demonstrativo)."""
    cashboxes: List[CashboxSummary] = []
    grand_total_balance: float = 0.0
    grand_total_buy_ins: float = 0.0
    grand_total_prizes: float = 0.0
    grand_total_supply: float = 0.0
    grand_total_sangria: float = 0.0
    grand_total_cash_buy_ins: float = 0.0
    grand_total_cash_outs: float = 0.0
    grand_total_bar_sales: float = 0.0


# ────────────────────────────────────────────────
# Demonstrativo (session-based reconciliation)
# ────────────────────────────────────────────────

class CashboxSessionReport(BaseModel):
    """One open→close cycle = one full reconciliation row. Within a session the
    invariant `current_balance == SUM(signed_amount)` holds, so expected vs
    actual reconciles (unlike a cross-session aggregate)."""
    session_id: str
    cashbox_id: str
    staff_name: Optional[str] = None
    stage_name: Optional[str] = None
    cash_day_label: Optional[str] = None
    bar_shift_label: Optional[str] = None
    opened_at: datetime
    closed_at: Optional[datetime] = None
    is_open: bool = False
    initial_balance: float = 0.0
    total_supply: float = 0.0          # additional supplies (excludes opening balance)
    total_sangria: float = 0.0
    total_buy_ins: float = 0.0
    buy_in_count: int = 0
    total_rebuys: float = 0.0
    rebuy_count: int = 0
    total_addons: float = 0.0
    addon_count: int = 0
    total_prizes_paid: float = 0.0
    prize_count: int = 0
    # Cash game. Sem estas colunas o esperado continuaria CERTO (a conta da
    # sessão soma signed_amount), mas o conferente veria um esperado que não
    # bate com a soma das colunas na tela — e é assim que um relatório passa a
    # parecer errado sem estar.
    total_cash_buy_ins: float = 0.0
    cash_buy_in_count: int = 0
    total_cash_outs: float = 0.0
    cash_out_count: int = 0
    # Bar: pagamentos de comanda em dinheiro real. Mesma razão das colunas de
    # cash: o esperado já os soma; sem a coluna a tela não bate com a conta.
    total_bar_sales: float = 0.0
    bar_sale_count: int = 0
    # Estornos de vendas canceladas ocorridos DENTRO da sessão: saída real da
    # gaveta, ENTRA no esperado.
    total_refunds: float = 0.0
    refund_count: int = 0
    # Estornos lançados DEPOIS do fechamento (o admin cancelou a venda no dia
    # seguinte). Não mexem no fechamento — que já foi conferido e assinado —,
    # aparecem à parte para o conferente saber que aquela noite teve devolução
    # posterior e que o dinheiro saiu do caixa geral, não da gaveta.
    total_refunds_after_close: float = 0.0
    refund_after_close_count: int = 0
    total_adjustments: float = 0.0
    expected_balance: float = 0.0
    actual_balance: Optional[float] = None   # counted (closed) or live balance (open)
    difference: Optional[float] = None        # actual - expected (None while no count)


class CashboxDemonstrativo(BaseModel):
    """Session-based demonstrativo across cashboxes, filterable by period and
    employee. Each session row reconciles; grand totals sum the rows."""
    sessions: List[CashboxSessionReport] = []
    grand_initial: float = 0.0
    grand_supply: float = 0.0
    grand_sangria: float = 0.0
    grand_buy_ins: float = 0.0
    grand_prizes: float = 0.0
    grand_cash_buy_ins: float = 0.0
    grand_cash_outs: float = 0.0
    grand_bar_sales: float = 0.0
    grand_refunds: float = 0.0
    # Devoluções lançadas depois do fechamento das sessões do período — fora
    # de grand_expected/grand_difference de propósito.
    grand_refunds_after_close: float = 0.0
    grand_adjustments: float = 0.0
    grand_expected: float = 0.0
    grand_actual: float = 0.0
    grand_difference: float = 0.0
    open_session_count: int = 0
