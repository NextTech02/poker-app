"""Rotas PÚBLICAS (sem auth) para exibição de blinds em TVs via código."""
from fastapi import APIRouter

from app.services.tournament_day_service import TournamentDayService
# A TV do salao e publica, mas a recusa ainda e lida por quem a instala:
# vai com `code` para a tela escolher a frase (ver app/utils/erros.py).
from app.utils.erros import da_excecao

router = APIRouter(prefix="/public", tags=["public"])


@router.get("/tv/{code}")
def resolve_tv_code(code: str):
    """Resolve um código público de TV → o DIA exato a exibir. Sem autenticação
    (a exibição de blinds já é pública). O código é único por dia do torneio."""
    try:
        return TournamentDayService.resolve_broadcast_code(code)
    except ValueError as e:
        raise da_excecao(e, "codigo_de_tv_invalido", status=404)
