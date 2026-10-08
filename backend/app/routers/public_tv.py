"""Rotas PÚBLICAS (sem auth) para exibição de blinds em TVs via código."""
from uuid import UUID

from fastapi import APIRouter

from app.models.prize_allocation import BroadcastPrizes
from app.models.public_tv import PublicTvExtras
from app.services.prize_allocation_service import PrizeAllocationService
from app.services.public_tv_service import PublicTvService
from app.services.tournament_day_service import TournamentDayService
# A TV do salao e publica, mas a recusa ainda e lida por quem a instala:
# vai com `code` para a tela escolher a frase (ver app/utils/erros.py).
from app.utils.erros import da_excecao

router = APIRouter(prefix="/public", tags=["public"])


@router.get("/broadcast/{tournament_id}/prizes", response_model=BroadcastPrizes)
def broadcast_prizes(tournament_id: UUID):
    """Premiação para o telão do salão, sem autenticação (por TORNEIO).

    `GET /tournaments/{id}/prizes` e `/prizes/summary` exigem login, e a TV
    aberta pelo código não tem — por isso ela nunca mostrava a coluna de
    prêmios e exibia o prizepool antigo do dia. Esta rota devolve só o que o
    público pode ver: prizepool disponível e faixas visíveis, sem rake, sem
    entradas brutas, sem nome de ganhador nem situação de pagamento.

    O telão novo usa `/tv/days/{day_id}/extras` (que inclui moeda e clube);
    esta continua servindo quem só precisa da premiação por torneio.
    """
    return PrizeAllocationService.get_broadcast_prizes(tournament_id)


@router.get("/tv/{code}")
def resolve_tv_code(code: str):
    """Resolve um código público de TV → o DIA exato a exibir. Sem autenticação
    (a exibição de blinds já é pública). O código é único por dia do torneio."""
    try:
        return TournamentDayService.resolve_broadcast_code(code)
    except ValueError as e:
        raise da_excecao(e, "codigo_de_tv_invalido", status=404)


@router.get("/tv/days/{day_id}/extras", response_model=PublicTvExtras)
def get_tv_day_extras(day_id: str):
    """Nome do clube, moeda, prize pool e prêmios VISÍVEIS de um dia, para o
    telão anônimo. Um request a cada 30 s junto com o dia; nada aqui é
    sensível (é o que já está na TV do salão)."""
    try:
        return PublicTvService.get_day_extras(day_id)
    except ValueError as e:
        raise da_excecao(e, "dia_nao_encontrado", status=404)
