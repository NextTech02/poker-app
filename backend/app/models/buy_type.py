"""Meios de entrada de um DIA do torneio.

Cada dia configura os seus: nome, categoria, valor, rake e fichas. É o que
permite a "recompra dupla" existir como venda própria — antes ela era o rebuy
simples multiplicado, conta que só fechava por acidente.
"""
from pydantic import BaseModel, Field
from typing import List, Literal, Optional


class BuyTypeItem(BaseModel):
    """Uma linha da lista enviada pela tela de configuração do dia.

    `id` nulo é linha NOVA. Os limites aqui repetem os CHECKs do banco de
    propósito: recusar no router devolve uma mensagem que o operador entende,
    em vez do erro cru do Postgres no meio do cadastro.
    """
    id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=80)
    category: Literal['buy_in', 'rebuy', 'addon']
    amount: float = Field(..., ge=0)
    rake_percentage: float = Field(0, ge=0, le=100)
    # Fichas zeradas são válidas: o dia final costuma ter entrada sem pilha nova
    # para quem chega classificado.
    chips: int = Field(0, ge=0)
    active: bool = True
    sort_order: int = 0


class BuyTypesReplace(BaseModel):
    """A lista INTEIRA do dia — o que não vier nela sai de circulação.

    Substituição em vez de um POST/PATCH/DELETE por linha porque a tela edita
    tudo junto: com chamadas separadas, fechar o navegador no meio deixaria o
    dia com metade da configuração nova e metade da antiga.
    """
    items: List[BuyTypeItem]
