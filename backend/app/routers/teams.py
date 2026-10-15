"""Torneio por equipes: cadastro, sorteio de mesas, pontos da Fase 1
(conferência e oficialização), cobrança por equipe e a final por revezamento.

A eliminação continua sendo o ✕ de sempre na Gestão de Mesas — o gancho em
`TournamentPlayerService.eliminar` grava a mesa da Fase 1. Recusas vão com
código (ver app/utils/erros.py).

As rotas FIXAS (/teams/seating, /teams/stage1…, /teams/final) vêm antes das que
têm `{team_id}`: o FastAPI casa na ordem em que as rotas foram declaradas.
"""
from fastapi import APIRouter, Depends

from app.auth import get_current_user
from app.models.team import (
    FinalSetup,
    OfficialRequest,
    RelayOrderUpdate,
    ResultCorrection,
    SeatingRequest,
    TablePositions,
    TeamCharge,
    TeamChargeCancel,
    TeamCreate,
    TeamUpdate,
    TiebreakOrder,
    VerifyRequest,
)
from app.services.team_charge_service import TeamChargeService
from app.services.team_service import TeamService
from app.utils.erros import da_excecao

router = APIRouter(prefix="/tournaments", tags=["teams"])

_RECUSA = "acao_de_equipe_recusada"


def _executar(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ValueError as e:
        raise da_excecao(e, _RECUSA)


@router.get("/{tournament_id}/teams")
def listar(tournament_id: str, current_user: dict = Depends(get_current_user)):
    """Equipes do torneio, com os integrantes e a situação de cada um na Fase 1."""
    return _executar(TeamService.listar, tournament_id)


@router.post("/{tournament_id}/teams", status_code=201)
def criar(tournament_id: str, body: TeamCreate, current_user: dict = Depends(get_current_user)):
    return _executar(TeamService.criar, tournament_id, body.name, body.captain_player_id, body.player_ids)


@router.post("/{tournament_id}/teams/seating")
def sortear(tournament_id: str, body: SeatingRequest = SeatingRequest(),
            current_user: dict = Depends(get_current_user)):
    """Sorteio da Fase 1: integrantes de cada equipe em mesas diferentes."""
    return _executar(TeamService.sortear_mesas, tournament_id, body.day_id, body.redo)


@router.get("/{tournament_id}/teams/stage1")
def fase1(tournament_id: str, current_user: dict = Depends(get_current_user)):
    """Pontos por mesa, ranking das equipes e avisos da Fase 1."""
    return _executar(TeamService.fase1_resumo, tournament_id)


@router.patch("/{tournament_id}/teams/stage1/results/{tournament_player_id}")
def corrigir(tournament_id: str, tournament_player_id: str, body: ResultCorrection,
             current_user: dict = Depends(get_current_user)):
    return _executar(
        TeamService.corrigir_resultado, tournament_id, tournament_player_id,
        tie_with_previous=body.tie_with_previous, table_id=body.table_id,
        swap_with_previous=body.swap_with_previous, user_id=current_user.get("sub"),
    )


@router.put("/{tournament_id}/teams/stage1/tables/{table_id}/positions")
def posicoes(tournament_id: str, table_id: str, body: TablePositions,
             current_user: dict = Depends(get_current_user)):
    return _executar(TeamService.posicoes_da_mesa, tournament_id, table_id, body.positions, current_user.get("sub"))


@router.delete("/{tournament_id}/teams/stage1/tables/{table_id}/positions")
def limpar_posicoes(tournament_id: str, table_id: str, current_user: dict = Depends(get_current_user)):
    return _executar(TeamService.limpar_posicoes_da_mesa, tournament_id, table_id)


@router.post("/{tournament_id}/teams/stage1/official")
def oficializar(tournament_id: str, body: OfficialRequest = OfficialRequest(),
                current_user: dict = Depends(get_current_user)):
    return _executar(TeamService.oficializar, tournament_id, current_user.get("sub"), body.force)


@router.delete("/{tournament_id}/teams/stage1/official")
def desoficializar(tournament_id: str, current_user: dict = Depends(get_current_user)):
    return _executar(TeamService.desoficializar, tournament_id)


@router.put("/{tournament_id}/teams/tiebreak")
def desempate(tournament_id: str, body: TiebreakOrder, current_user: dict = Depends(get_current_user)):
    """Ordem da direção para equipes que continuam empatadas."""
    return _executar(TeamService.desempate_manual, tournament_id, body.team_ids)


@router.post("/{tournament_id}/teams/final")
def montar_final(tournament_id: str, body: FinalSetup, current_user: dict = Depends(get_current_user)):
    return _executar(TeamService.montar_final, tournament_id, body.finalists, body.chips)


@router.delete("/{tournament_id}/teams/final")
def desfazer_final(tournament_id: str, current_user: dict = Depends(get_current_user)):
    return _executar(TeamService.desfazer_final, tournament_id)


@router.get("/{tournament_id}/teams/relay")
def revezamento(tournament_id: str, current_user: dict = Depends(get_current_user)):
    """Equipes da final, ordem do revezamento e classificação."""
    return _executar(TeamService.revezamento, tournament_id)


@router.patch("/{tournament_id}/teams/{team_id}")
def editar(tournament_id: str, team_id: str, body: TeamUpdate, current_user: dict = Depends(get_current_user)):
    return _executar(
        TeamService.editar, tournament_id, team_id,
        name=body.name, captain_player_id=body.captain_player_id, player_ids=body.player_ids,
    )


@router.delete("/{tournament_id}/teams/{team_id}")
def excluir(tournament_id: str, team_id: str, current_user: dict = Depends(get_current_user)):
    return _executar(TeamService.excluir, tournament_id, team_id)


@router.put("/{tournament_id}/teams/{team_id}/relay-order")
def ordem(tournament_id: str, team_id: str, body: RelayOrderUpdate, current_user: dict = Depends(get_current_user)):
    return _executar(TeamService.definir_ordem, tournament_id, team_id, body.player_ids, body.force)


@router.post("/{tournament_id}/teams/{team_id}/verify")
def conferir(tournament_id: str, team_id: str, body: VerifyRequest = VerifyRequest(),
             current_user: dict = Depends(get_current_user)):
    """O capitão conferiu a soma da equipe (ou a conferência foi retirada)."""
    return _executar(TeamService.conferir, tournament_id, team_id, body.verified, current_user.get("sub"))


@router.post("/{tournament_id}/teams/{team_id}/charge")
def cobrar(tournament_id: str, team_id: str, body: TeamCharge, current_user: dict = Depends(get_current_user)):
    """Cobra a inscrição da EQUIPE (valor do meio "por equipe" dividido entre os integrantes)."""
    return _executar(
        TeamChargeService.cobrar, tournament_id, team_id, body.buy_type_id,
        body.payment_method or "cash", body.client_mutation_id, current_user.get("sub"),
    )


@router.post("/{tournament_id}/teams/{team_id}/charge/cancel")
def estornar(tournament_id: str, team_id: str, body: TeamChargeCancel = TeamChargeCancel(),
             current_user: dict = Depends(get_current_user)):
    return _executar(TeamChargeService.estornar, tournament_id, team_id, body.reason, current_user.get("sub"))
