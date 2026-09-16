from pydantic import BaseModel
from typing import List, Optional


class RevenueBreakdown(BaseModel):
    buy_ins: float = 0
    rebuys: float = 0
    addons: float = 0
    total: float = 0


class TournamentFinancial(BaseModel):
    tournament_id: str
    tournament_name: str
    players: int = 0
    buy_ins_count: int = 0
    rebuys_count: int = 0
    addons_count: int = 0
    revenue: float = 0
    prizes: float = 0
    net: float = 0


class TransactionEntry(BaseModel):
    id: str
    created_at: str
    tournament_name: Optional[str] = None
    player_name: Optional[str] = None
    type: str
    payment_source: Optional[str] = None
    payment_method: Optional[str] = None
    amount: float


class ExpenseCategoryTotal(BaseModel):
    category: str
    kind: Optional[str] = None      # fixo | variavel
    amount: float = 0


class FinancialSummary(BaseModel):
    revenue: RevenueBreakdown
    tickets_redeemed_value: float = 0
    gross_revenue: float = 0
    prizes: float = 0
    operational_result: float = 0   # entradas − premiação (≈ rake)
    rake: float = 0
    # Despesas da etapa (competência: pagas + pendentes).
    expenses: float = 0
    expenses_paid: float = 0
    expenses_pending: float = 0
    expenses_by_category: List[ExpenseCategoryTotal] = []
    # Aporte da casa na premiação. INFORMATIVO: já sai como prêmio e está
    # embutido em `prizes`, então somar aqui contaria o mesmo dinheiro 2x.
    guarantee_committed: float = 0
    # Outras receitas (bar, patrocínio, aluguel de espaço) — competência.
    other_revenue: float = 0
    other_revenue_received: float = 0
    other_revenue_pending: float = 0
    other_revenue_by_source: List[ExpenseCategoryTotal] = []
    # ── Cash game ──────────────────────────────────────────────────────
    # `cash_revenue` é o RAKE apurado na caixa das mesas — a ÚNICA linha de
    # cash que é receita. Ela entra em `gross_revenue`.
    cash_revenue: float = 0
    # Giro: entrou e saiu da gaveta. INFORMATIVO — buy-in é troca de dinheiro
    # por ficha e a maior parte volta ao jogador no cash-out. Somar aqui
    # multiplicaria o faturamento do clube por dez.
    cash_buy_ins: float = 0
    cash_cash_outs: float = 0
    # PASSIVO: dinheiro dos jogadores retido para pagamento futuro. Fora de
    # `gross_revenue` e de `net_result` — contabilizá-lo como lucro seria
    # registrar como ganho algo que o clube vai devolver.
    cash_jackpot_collected: float = 0
    cash_jackpot_paid: float = 0
    cash_days_count: int = 0
    cash_tables_count: int = 0
    cash_players_count: int = 0
    # ── Bar ────────────────────────────────────────────────────────────
    # `bar_revenue` = Σ total das comandas fechadas do período (depois do
    # desconto). Entra em `gross_revenue`. `bar_cogs` (custo das mercadorias)
    # é INFORMATIVO: a compra da mercadoria já entra como despesa, e subtrair
    # o CMV também contaria duas vezes — o mesmo princípio de
    # `guarantee_committed`. A margem do bar vive no relatório do bar.
    bar_revenue: float = 0
    bar_gross: float = 0
    bar_discounts: float = 0
    bar_cogs: float = 0
    bar_gross_margin: float = 0
    bar_tabs_count: int = 0
    bar_shifts_count: int = 0
    net_result: float = 0           # operacional + outras receitas − despesas
    pending_credits: float = 0
    available_tickets: int = 0
    by_tournament: List[TournamentFinancial] = []
    transactions: List[TransactionEntry] = []
