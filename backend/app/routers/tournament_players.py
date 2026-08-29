from fastapi import APIRouter, Depends, HTTPException, status, Query
from typing import List, Optional
from app.models.tournament_player import (
    TournamentPlayerCreate,
    TournamentPlayerUpdate,
    TournamentPlayer,
    TournamentPlayerDetail
)
from app.services.tournament_player_service import TournamentPlayerService
from app.auth.jwt import get_current_user

router = APIRouter(prefix="/tournament-players", tags=["tournament-players"])


@router.post("", response_model=TournamentPlayerDetail, status_code=status.HTTP_201_CREATED)
def register_player(
    registration: TournamentPlayerCreate,
    current_user: dict = Depends(get_current_user)
):
    """Register a player for a tournament"""
    user_id = current_user.get("sub")
    try:
        return TournamentPlayerService.register_player(registration, user_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )


@router.post(
    "/{tournament_player_id}/rebuy",
    response_model=TournamentPlayer,
    responses={
        400: {"description": "Recompra recusada: fora do nível permitido, vendas bloqueadas no dia ou na etapa, ou caixa do operador fechado."},
        404: {"description": "Inscrição não encontrada."},
    },
)
def add_rebuy(
    tournament_player_id: str,
    payment_source: Optional[str] = Query("cash"),
    payment_method: Optional[str] = Query("cash"),
    buy_type_id: Optional[str] = Query(None),
    quantity: int = Query(1, ge=1, le=20, description="EM DEPRECIAÇÃO — quantas recompras registrar de uma vez. A recompra dupla passou a ser um meio de entrada com valor e fichas próprios."),
    client_mutation_id: Optional[str] = Query(None, description="Identificador gerado no cliente; torna a chamada repetível sem duplicar a venda."),
    current_user: dict = Depends(get_current_user),
):
    """Registra uma ou mais recompras do jogador.

    `quantity` evita o caminho antigo, em que o Caixa disparava uma chamada por
    recompra e o operador esperava a soma de todas. Cada ida ao banco custa
    ~270ms nesta instalação (o banco fica em outra região), então três recompras
    em três chamadas passavam de 5 segundos com a fila esperando.

    `client_mutation_id` era enviado pelo Caixa no CORPO da requisição, mas esta
    rota só lê parâmetros de consulta — ele se perdia, e com ele a proteção
    contra registrar a mesma venda duas vezes numa retentativa.

    `quantity` está EM DEPRECIAÇÃO: a recompra dupla virou um meio de entrada
    com valor e fichas próprios (multiplicar o rebuy simples só acertava por
    acidente). Ele fica porque o deploy não é atômico — um Caixa antigo aberto
    no navegador ainda manda `quantity=3`, e ignorá-lo gravaria uma recompra só
    onde o jogador pagou três.
    """
    user_id = current_user.get("sub")
    try:
        return TournamentPlayerService.add_rebuy(tournament_player_id, user_id, payment_source=payment_source, payment_method=payment_method, buy_type_id=buy_type_id, quantity=quantity, client_mutation_id=client_mutation_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )


@router.post("/{tournament_player_id}/addon", response_model=TournamentPlayer)
def add_addon(
    tournament_player_id: str,
    payment_source: Optional[str] = Query("cash"),
    payment_method: Optional[str] = Query("cash"),
    buy_type_id: Optional[str] = Query(None),
    current_user: dict = Depends(get_current_user),
):
    """Add an add-on for a tournament player"""
    user_id = current_user.get("sub")
    try:
        return TournamentPlayerService.add_addon(tournament_player_id, user_id, payment_source=payment_source, payment_method=payment_method, buy_type_id=buy_type_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )


@router.get("/tournament/{tournament_id}", response_model=List[TournamentPlayerDetail])
def get_tournament_players(
    tournament_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get all players in a tournament"""
    return TournamentPlayerService.get_tournament_players(tournament_id)


@router.get("/day/{day_id}", response_model=List[TournamentPlayerDetail])
def get_tournament_day_players(day_id: str):
    """Get all players in a specific tournament day (no auth required for broadcast)"""
    return TournamentPlayerService.get_tournament_day_players(day_id)


@router.patch("/{tournament_player_id}", response_model=TournamentPlayer)
def update_tournament_player(
    tournament_player_id: str,
    update_data: TournamentPlayerUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update tournament player (position, prize, status, etc.)"""
    result = TournamentPlayerService.update_tournament_player(tournament_player_id, update_data)
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament player not found"
        )
    return result


@router.post("/{tournament_player_id}/eliminate", response_model=TournamentPlayer)
def eliminate_player(
    tournament_player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Eliminate a player from the tournament (mark as eliminated)"""
    user_id = current_user.get("sub")
    try:
        return TournamentPlayerService.eliminate_player(tournament_player_id, user_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
