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


class PublicTvExtras(BaseModel):
    """O que o telão precisa além do relógio e que, antes, só existia atrás
    de autenticação: nome do clube, moeda da organização, prize pool e a
    lista de prêmios VISÍVEIS."""
    day_id: str
    tournament_id: str
    organization_name: Optional[str] = None
    currency: str = "BRL"
    prize_pool: Optional[float] = Field(
        default=None,
        description="Prize pool disponível (garantido + pool dos jogadores). None se o resumo falhar.",
    )
    prizes: list[PublicTvPrize] = []
