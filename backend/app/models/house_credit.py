"""Modelos do FIADO DA CASA — a conta-corrente do jogador com o clube.

Não confundir com o crédito de PATROCINADOR (`models/player_credit.py`): lá o
saldo é a favor do jogador e quem deve é o patrocinador. Aqui quem deve é o
jogador, ao clube, e o saldo é o quanto ele deve.
"""
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field, model_validator


class HouseCreditSettings(BaseModel):
    due_days: int = 30
    block_overdue: bool = True
    default_limit: float = 0.0


class HouseCreditSettingsUpdate(BaseModel):
    due_days: int = Field(..., ge=1, le=3650)
    block_overdue: bool
    default_limit: float = Field(0.0, ge=0)


class HouseCreditAccount(BaseModel):
    """O retrato da conta para quem está no caixa.

    Jogador sem conta volta com `exists=False` e tudo zerado — não é erro: a
    tela pergunta de todo jogador, e a maioria nunca terá fiado.
    """
    player_id: str
    exists: bool = False
    account_id: Optional[str] = None
    enabled: bool = False
    credit_limit: float = 0.0
    balance: float = 0.0
    # Quanto ainda dá para vender no fiado (0 com a conta desligada).
    available: float = 0.0
    oldest_open_at: Optional[datetime] = None
    days_open: Optional[int] = None
    overdue: bool = False
    # Bloqueia venda nova AGORA (vencido com bloqueio ligado).
    blocked: bool = False
    due_days: int = 30
    notes: Optional[str] = None
    updated_at: Optional[datetime] = None


class HouseCreditAccountUpdate(BaseModel):
    enabled: bool
    credit_limit: float = Field(..., ge=0)
    notes: Optional[str] = Field(None, max_length=500)


class HouseCreditEntry(BaseModel):
    id: str
    type: str
    amount: float
    # Preenchidos pelo trigger de aplicação; sempre presentes numa linha gravada.
    signed_amount: float = 0.0
    balance_after: float = 0.0
    module: str = "cash"
    cash_transaction_id: Optional[str] = None
    reverses_entry_id: Optional[str] = None
    cashbox_id: Optional[str] = None
    cash_day_id: Optional[str] = None
    bar_shift_id: Optional[str] = None
    payment_method: Optional[str] = None
    reason: Optional[str] = None
    notes: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime
    # Enriquecido
    created_by_name: Optional[str] = None
    # Recebimento já estornado (a tela esconde o botão).
    reversed: bool = False


class HouseCreditPaymentCreate(BaseModel):
    """Recebimento de fiado numa gaveta. A âncora vai EXPLÍCITA: o operador pode
    ter a gaveta do cash e a do bar abertas ao mesmo tempo, e o dinheiro precisa
    cair na que ele está atendendo."""
    amount: float = Field(..., gt=0)
    payment_method: Optional[str] = Field(None, max_length=50)
    cash_day_id: Optional[str] = None
    bar_shift_id: Optional[str] = None
    client_mutation_id: Optional[str] = Field(None, max_length=80)
    notes: Optional[str] = Field(None, max_length=500)

    @model_validator(mode="after")
    def _uma_ancora(self):
        if bool(self.cash_day_id) == bool(self.bar_shift_id):
            raise ValueError("Informe a gaveta do cash (cash_day_id) OU a do bar (bar_shift_id).")
        return self


class HouseCreditReverse(BaseModel):
    reason: str = Field(..., min_length=3, max_length=500)


class HouseCreditWriteOff(BaseModel):
    amount: float = Field(..., gt=0)
    reason: str = Field(..., min_length=3, max_length=500)


class HouseCreditMovement(BaseModel):
    """Resposta das escritas: o lançamento e a conta já atualizada."""
    entry: HouseCreditEntry
    account: HouseCreditAccount


class HouseCreditBalance(BaseModel):
    """Versão enxuta para os badges ("deve R$ X") nas listas de jogador."""
    player_id: str
    enabled: bool
    balance: float
    available: float
    overdue: bool = False


class HouseCreditDebtor(BaseModel):
    player_id: str
    player_name: Optional[str] = None
    nickname: Optional[str] = None
    phone: Optional[str] = None
    enabled: bool
    credit_limit: float
    balance: float
    oldest_open_at: Optional[datetime] = None
    days_open: Optional[int] = None
    overdue: bool = False


class HouseCreditDebtors(BaseModel):
    rows: List[HouseCreditDebtor]
    total_open: float = 0.0
    total_overdue: float = 0.0
    count: int = 0
    overdue_count: int = 0
    due_days: int = 30


class HouseCreditUnderOffset(BaseModel):
    """Cash-out em que o operador abateu MENOS do que o sistema propôs. É o
    relatório do conluio clássico (pagar o amigo e deixar a dívida de pé)."""
    cash_transaction_id: str
    created_at: datetime
    player_id: Optional[str] = None
    player_name: Optional[str] = None
    operator_name: Optional[str] = None
    chips_amount: float
    expected: float
    settled: float
    reason: Optional[str] = None
