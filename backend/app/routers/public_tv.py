"""Rotas PÚBLICAS (sem auth) para exibição de blinds em TVs via código."""
from fastapi import APIRouter, HTTPException, status

from app.services.tournament_day_service import TournamentDayService

router = APIRouter(prefix="/public", tags=["public"])


@router.get("/tv/{code}")
def resolve_tv_code(code: str):
    """Resolve um código público de TV → o DIA exato a exibir. Sem autenticação
    (a exibição de blinds já é pública). O código é único por dia do torneio."""
    try:
        return TournamentDayService.resolve_broadcast_code(code)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
