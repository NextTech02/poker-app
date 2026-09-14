from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime


# ── Consignment (header) ──

class ConsignmentRelease(BaseModel):
    """Cashier releases a chip value to a sangi (opens a consignment)."""
    sangi_staff_id: str
    released_amount: float = Field(..., gt=0)
    # O dia de cash. O sangeur é papel do CASH: ele circula pelas mesas vendendo
    # fichas. No torneio a venda acontece no caixa, com o jogador indo até lá.
    cash_day_id: Optional[str] = None   # cai no dia aberto quando omitido
    notes: Optional[str] = None


class ConsignmentReconcile(BaseModel):
    notes: Optional[str] = None


class SaleResponse(BaseModel):
    """Uma venda do sangeur. `cash_transaction_id` é o fio que a liga ao
    dinheiro do dia — sem ele, conferir o livro do sangeur contra o caixa do dia
    exigiria casar linha a linha por valor e horário."""
    id: str
    consignment_id: str
    amount: float
    buyer_player_id: str
    buyer_player_name: Optional[str] = None
    sold_by: Optional[str] = None
    table_id: Optional[str] = None
    table_number: Optional[int] = None
    cash_transaction_id: Optional[str] = None
    notes: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ConsignmentResponse(BaseModel):
    id: str
    sangi_staff_id: str
    sangi_name: Optional[str] = None
    stage_id: Optional[str] = None        # só nas consignações históricas
    cash_day_id: Optional[str] = None
    released_amount: float
    total_sold: float = 0.0
    remaining: float = 0.0          # released_amount - total_sold (chips still out)
    divergence: Optional[float] = None  # set at reconcile
    status: str = 'open'
    opened_at: datetime
    reconciled_at: Optional[datetime] = None
    notes: Optional[str] = None
    created_at: datetime
    sales: List[SaleResponse] = []

    class Config:
        from_attributes = True


# ── Sale ──

class SaleCreate(BaseModel):
    """Venda de fichas na mesa: valor + comprador + ONDE.

    `table_id` é obrigatório porque a venda vira um `rebuy` do jogador NAQUELA
    mesa — sem ela não dá para dizer de quem é o dinheiro nem em qual sessão
    entra, e o resultado da noite do jogador sairia errado.
    """
    amount: float = Field(..., gt=0)
    table_id: str
    # Duplo clique e retry não podem virar duas vendas — mesma proteção das
    # outras escritas de dinheiro do módulo.
    client_mutation_id: Optional[str] = None
    buyer_player_id: str
    notes: Optional[str] = None
