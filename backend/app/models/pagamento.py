"""Pagamento dividido: uma venda paga com vários meios (300 em dinheiro +
200 em transferência). As partes moram NA linha da venda (`payment_split`);
ver `app/services/pagamento_dividido.py`."""
from typing import List, Optional

from pydantic import BaseModel, Field


class PaymentLeg(BaseModel):
    """Uma parte do pagamento: o meio (código de `payment_methods`) e quanto."""
    payment_method: str = Field(..., min_length=1, max_length=50)
    amount: float = Field(..., gt=0)


class PagamentoDaVenda(BaseModel):
    """Corpo opcional da reentrada e do add-on, que recebem o resto por
    parâmetro de consulta. Só `payment_split` é lido daqui: o Caixa já manda
    um corpo com os mesmos campos dos parâmetros, e eles continuam valendo
    pelos parâmetros (os que sobram são ignorados)."""
    payment_split: Optional[List[PaymentLeg]] = Field(None, max_length=10)
