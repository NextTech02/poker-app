"""Ranking de pontos (Manual de Ranking NSOP): parâmetros do clube, o torneio
no ranking (pontuável, buy-in oficial, oficializar/reabrir), e a
classificação por etapa e por temporada.

Tudo exige a permissão `points_ranking`. A organização vem do token (nunca do
corpo). Recusas vão com código (app/utils/erros.py) e a migração pendente vira
503 com `ranking_migracao_pendente`.
"""
from typing import Optional

from fastapi import APIRouter, Depends

from app.auth.permissions import require_permission
from app.dependencies import get_org_id, get_stage_id_optional
from app.models.ranking_pontos import (
    RankingOfficialRequest, RankingReopenRequest, RankingRulesUpdate,
    RankingSeasonCreate, RankingSeasonUpdate, RankingTournamentUpdate,
)
from app.services.ranking_pontos_service import RankingPontosService
from app.utils.erros import da_excecao

PERMISSAO = "points_ranking"

router = APIRouter(prefix="/points-ranking", tags=["points-ranking"])

_pode = require_permission(PERMISSAO)
_RECUSA = "acao_de_ranking_recusada"


def _executar(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ValueError as e:
        raise da_excecao(e, _RECUSA)


# ── Parâmetros do clube ──────────────────────────────────────────────────────

@router.get("/rules")
def obter_regras(org_id: str = Depends(get_org_id), current_user: dict = Depends(_pode)):
    return _executar(RankingPontosService.obter_regras, org_id)


@router.put("/rules")
def salvar_regras(body: RankingRulesUpdate, org_id: str = Depends(get_org_id),
                  current_user: dict = Depends(_pode)):
    return _executar(RankingPontosService.salvar_regras, org_id, body.model_dump(exclude_none=True),
                     current_user.get("sub"))


# ── O torneio ────────────────────────────────────────────────────────────────

@router.get("/tournaments/{tournament_id}")
def situacao_do_torneio(tournament_id: str, org_id: str = Depends(get_org_id),
                        current_user: dict = Depends(_pode)):
    return _executar(RankingPontosService.situacao, tournament_id, org_id)


@router.put("/tournaments/{tournament_id}")
def configurar_torneio(tournament_id: str, body: RankingTournamentUpdate,
                       stage_id: Optional[str] = Depends(get_stage_id_optional),
                       current_user: dict = Depends(_pode)):
    # Só os campos que vieram: `buy_in: null` limpa; ausente não mexe.
    dados = {campo: getattr(body, campo) for campo in body.model_fields_set}
    return _executar(RankingPontosService.configurar, tournament_id, dados, stage_id)


@router.post("/tournaments/{tournament_id}/official")
def oficializar(tournament_id: str, body: RankingOfficialRequest, org_id: str = Depends(get_org_id),
                stage_id: Optional[str] = Depends(get_stage_id_optional),
                current_user: dict = Depends(_pode)):
    return _executar(
        RankingPontosService.oficializar, tournament_id,
        [p.model_dump() for p in body.positions], org_id, current_user.get("sub"), stage_id,
    )


@router.post("/tournaments/{tournament_id}/reopen")
def reabrir(tournament_id: str, body: RankingReopenRequest, org_id: str = Depends(get_org_id),
            stage_id: Optional[str] = Depends(get_stage_id_optional),
            current_user: dict = Depends(_pode)):
    return _executar(RankingPontosService.reabrir, tournament_id, body.reason, org_id, stage_id)


# ── Classificação ────────────────────────────────────────────────────────────

@router.get("/stages/{stage_id}")
def ranking_da_etapa(stage_id: str, current_user: dict = Depends(_pode)):
    return _executar(RankingPontosService.ranking_da_etapa, stage_id)


@router.get("/seasons")
def listar_temporadas(org_id: str = Depends(get_org_id), current_user: dict = Depends(_pode)):
    return _executar(RankingPontosService.listar_temporadas, org_id)


@router.post("/seasons", status_code=201)
def criar_temporada(body: RankingSeasonCreate, org_id: str = Depends(get_org_id),
                    current_user: dict = Depends(_pode)):
    return _executar(RankingPontosService.criar_temporada, org_id, body.model_dump(), current_user.get("sub"))


@router.put("/seasons/{season_id}")
def atualizar_temporada(season_id: str, body: RankingSeasonUpdate, org_id: str = Depends(get_org_id),
                        current_user: dict = Depends(_pode)):
    dados = {campo: getattr(body, campo) for campo in body.model_fields_set}
    return _executar(RankingPontosService.atualizar_temporada, season_id, org_id, dados, current_user.get("sub"))


@router.delete("/seasons/{season_id}", status_code=204)
def excluir_temporada(season_id: str, current_user: dict = Depends(_pode)):
    _executar(RankingPontosService.excluir_temporada, season_id)


@router.get("/seasons/{season_id}/standings")
def ranking_da_temporada(season_id: str, current_user: dict = Depends(_pode)):
    return _executar(RankingPontosService.ranking_da_temporada, season_id)
