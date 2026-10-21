"""Resposta PÚBLICA do telão (rota sem login).

Lista branca de campos de propósito: a rota é aberta à internet, então nada de
nome de jogador, documento ou dado de pagamento — só o que a TV do salão
mostra para quem já está no salão. A exceção é o quadro de mesas
(`PublicSeating`), que existe para mostrar quem senta onde.
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
    # Premiação por eliminação: o telão mostra o pool KO junto do prizepool e,
    # na fase Mystery, quantos envelopes ainda faltam sair. Nada de quem
    # tem qual bounty — a rota é aberta.
    ko_format: str = "none"
    ko_pool: Optional[float] = None
    mystery_envelopes_left: Optional[int] = None
    # "Listado de premios disponibles" (guia do NSOP): os envelopes que restam,
    # por valor; e, antes da fase, o nível em que ela começa.
    mystery_envelopes: list[dict] = []
    mystery_start_level: Optional[int] = None
    # Torneio por equipes, dia FINAL: o revezamento — nome da equipe, apelido
    # (ou primeiro nome) dos integrantes NA ORDEM e se a equipe já caiu. O
    # telão calcula quem joga em cada nível. Nada de documento ou nome completo.
    relay: Optional[dict] = None
    # Meios de entrada ATIVOS do torneio, na ordem do Caixa (o telão mostra
    # "BUY-IN: 50 · REBUY: 20 …" quando o diretor liga).
    buy_types: list[PublicTvBuyType] = []


class PublicSeat(BaseModel):
    """Um jogador sentado, como o quadro de mesas do salão mostra."""
    name: str
    table_number: int
    seat_number: int
    # Fichas com que se classificou (só entrada vinda de classificatório).
    chips: Optional[int] = None


class PublicSeating(BaseModel):
    """Telão de MESAS E ASSENTOS, aberto pelo código de TV do dia.

    A EXCEÇÃO deste arquivo: leva o nome do jogador, porque é o quadro de
    sorteio que o clube afixa no salão para cada um achar a sua cadeira (e o
    relógio público já lê /tournament-players/day sem login). Só nome, mesa,
    assento e fichas de classificação — nada de documento, contato ou id.
    """
    day_id: str
    tournament_name: Optional[str] = None
    day_name: Optional[str] = None
    organization_name: Optional[str] = None
    language: str = "pt-BR"
    seats: list[PublicSeat] = []

