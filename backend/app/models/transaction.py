from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime
from enum import Enum


class TransactionType(str, Enum):
    buy_in = "buy_in"
    rebuy = "rebuy"
    addon = "addon"
    prize = "prize"


class TransactionStatus(str, Enum):
    active = "active"
    # Estado INTERMEDIÁRIO do estorno: a venda já saiu de todas as somas de
    # dinheiro (o jogador vai receber de volta), mas os passos do estorno ainda
    # não terminaram. Existe para a retentativa saber que precisa RETOMAR o que
    # faltou — sem ele, um passo que falhasse no meio deixaria o caixa inflado
    # para sempre e o segundo clique responderia "já cancelada".
    cancelling = "cancelling"
    cancelled = "cancelled"


class TransactionBase(BaseModel):
    tournament_id: str
    player_id: str
    type: TransactionType
    amount: float = Field(..., ge=0)
    payment_method: Optional[str] = Field(None, max_length=50)
    reference_number: Optional[str] = Field(None, max_length=100)
    notes: Optional[str] = None


class TransactionCreate(TransactionBase):
    pass


class Transaction(TransactionBase):
    id: str
    tournament_player_id: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime

    # Campos que existem na tabela desde os tipos de buy / caixa modular mas
    # sumiam na serialização (o Pydantic descarta o que não está declarado).
    # O extrato do Caixa precisa deles para mostrar o TIPO vendido e para
    # decidir se a venda pode ser cancelada (crédito/ticket não pode).
    buy_type_id: Optional[str] = None
    # Nome do meio de entrada e fichas CONGELADOS na venda. As duas colunas já
    # existiam na tabela, mas sumiam aqui: o extrato caía no rótulo genérico da
    # categoria e a reimpressão do bilhete não tinha como dizer quantas fichas
    # o jogador comprou — que é o que o floor confere antes de entregar a pilha.
    buy_type_name: Optional[str] = None
    chips: Optional[int] = None
    rake_percentage: Optional[float] = None
    rake_amount: Optional[float] = None
    payment_source: Optional[str] = None
    cashbox_id: Optional[str] = None

    # Estorno lógico. Default 'active' para tolerar o schema antigo: enquanto a
    # migração não rodar, a coluna não vem e toda venda é tratada como ativa —
    # exatamente o comportamento de hoje.
    status: TransactionStatus = TransactionStatus.active
    cancelled_at: Optional[datetime] = None
    cancelled_by: Optional[str] = None
    cancel_reason: Optional[str] = None

    class Config:
        from_attributes = True


class TransactionDetail(Transaction):
    """Transaction with player and tournament details"""
    player_name: str
    player_nickname: Optional[str] = None
    tournament_name: str

    # Avisos do cancelamento: o que o estorno NÃO conseguiu desfazer sozinho
    # (dinheiro já sangrado, cashback já convertido em crédito, fidelidade
    # indisponível). O admin PRECISA ver isso na tela — falhar em silêncio aqui
    # é o que faz o fechamento da noite não bater sem ninguém saber por quê.
    cancel_warnings: List[str] = []


class TransactionCancel(BaseModel):
    """Cancelamento de venda: o motivo é obrigatório porque é ele que explica a
    diferença no fechamento do caixa da noite."""
    reason: str = Field(..., min_length=3, max_length=500)


class TransactionPaymentMethodUpdate(BaseModel):
    """Troca só do RÓTULO da forma de pagamento (dinheiro/pix/cartão).

    Não mexe em `payment_source` de propósito: aquele MOVE dinheiro (consome
    crédito do jogador ou ticket de satélite) e trocá-lo exigiria estornar e
    refazer a venda.
    """
    payment_method: str = Field(..., min_length=1, max_length=50)
    notes: Optional[str] = None
