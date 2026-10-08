"""Resposta PÚBLICA do telão (rota sem login).

Lista branca de campos de propósito: a rota é aberta à internet, então nada de
nome de jogador, documento ou dado de pagamento — só o que a TV do salão
mostra para quem já está no salão.
"""
from typing import Optional

from pydantic import BaseModel, Field


class PublicTvPrize(BaseModel):
    position: int
    prize_amount: float = 0
    prize_type: str = "cash"  # 'cash' | 'vaga'
    vaga_target_tournament_id: Optional[str] = None
    vaga_target_day_id: Optional[str] = None


class PublicTvBuyType(BaseModel):
    """Meio de entrada do torneio como o telão mostra: nome e QUANTAS vendas
    houve por ele neste dia (o que o diretor quer ver — "Buy-in: 120 · Rebuy:
    40"). Valor fica só como referência; rake, fichas e id ficam de fora — a
    rota é aberta."""
    name: str
    count: int = 0
    amount: float = 0
    category: str = "buy_in"  # 'buy_in' | 'rebuy' | 'addon'


class PublicTvExtras(BaseModel):
    """O que o telão precisa além do relógio e que, antes, só existia atrás
    de autenticação: nome do clube, moeda da organização, prize pool e a
    lista de prêmios VISÍVEIS."""
    day_id: str
    tournament_id: str
    organization_name: Optional[str] = None
    currency: str = "BRL"
    language: str = Field(
        default="pt-BR",
        description="Idioma do clube (app_settings.language): a TV anônima do salão usa este para os rótulos.",
    )
    prize_pool: Optional[float] = Field(
        default=None,
        description="Prize pool disponível (garantido + pool dos jogadores). None se o resumo falhar.",
    )
    prizes: list[PublicTvPrize] = []
    # Meios de entrada ATIVOS do torneio, na ordem do Caixa (o telão mostra
    # "BUY-IN: 50 · REBUY: 20 …" quando o diretor liga).
    buy_types: list[PublicTvBuyType] = []
