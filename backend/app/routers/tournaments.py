from fastapi import APIRouter, Depends, HTTPException, status
from typing import List, Optional
from app.models.tournament import (
    TournamentCreate,
    TournamentUpdate,
    Tournament,
    TournamentSummary,
    TournamentDeleteImpact,
)
from app.services.tournament_service import (
    TournamentService,
    MovimentoFinanceiroImpedeExclusao,
)
from app.auth.jwt import get_current_user
from app.dependencies import get_stage_id_optional

router = APIRouter(prefix="/tournaments", tags=["tournaments"])


def _exigir_torneio_da_etapa(tournament_id: str, stage_id: Optional[str]) -> None:
    """Confere que o torneio existe e pertence à etapa selecionada.

    Sem o header não há o que conferir: a chamada segue e quem responde 404 é o
    próprio service, como sempre foi."""
    if not stage_id:
        return
    existente = TournamentService.get_tournament(tournament_id)
    if not existente:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )
    if existente.stage_id != stage_id:
        raise HTTPException(
            status_code=403,
            detail="Tournament does not belong to the selected stage"
        )


@router.post("", response_model=Tournament, status_code=status.HTTP_201_CREATED)
def create_tournament(
    tournament: TournamentCreate,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """Create a new tournament. A stage (etapa) is mandatory: it comes from the
    X-Stage-ID header (preferred) or the request body, and must reference an
    existing stage."""
    user_id = current_user.get("sub")

    # Stage is required: never allow creating a tournament without an etapa.
    # The header takes precedence; fall back to a stage_id supplied in the body.
    effective_stage_id = stage_id or tournament.stage_id
    if not effective_stage_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="É necessário selecionar uma etapa antes de criar um torneio."
        )

    tournament.stage_id = effective_stage_id

    # Validate stage exists
    from app.database.supabase_client import supabase
    stage_response = supabase.table('stages').select('id').eq('id', effective_stage_id).execute()
    if not stage_response.data:
        raise HTTPException(
            status_code=404,
            detail=f"Stage with id {effective_stage_id} not found"
        )

    return TournamentService.create_tournament(tournament, user_id)


@router.get("", response_model=List[TournamentSummary])
def get_tournaments(
    stage_id: Optional[str] = None,
    header_stage_id: Optional[str] = Depends(get_stage_id_optional),
    current_user: dict = Depends(get_current_user),
):
    """
    Get all tournaments with aggregated entries from non-final days.
    If X-Stage-ID header is present, it takes precedence over stage_id query parameter.

    Requires authentication: this lists every tournament across stages and is
    only used by the authenticated operator UI. The public broadcast view reads
    a single tournament via GET /tournaments/{id}, which stays open by design.
    """
    effective_stage_id = header_stage_id if header_stage_id else stage_id
    return TournamentService.get_tournament_summary(stage_id=effective_stage_id)


@router.get("/{tournament_id}", response_model=Tournament)
def get_tournament(tournament_id: str):
    """Get a specific tournament by ID"""
    tournament = TournamentService.get_tournament(tournament_id)
    if not tournament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )
    return tournament


@router.get("/{tournament_id}/delete-impact", response_model=TournamentDeleteImpact)
def get_tournament_delete_impact(
    tournament_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """O que a exclusão deste torneio destruiria, com números reais.

    A tela chama isto ANTES de perguntar "tem certeza?": o operador precisa ler
    quantas entradas, quantos jogadores e quanto dinheiro somem com o clique.
    Exige autenticação — expõe faturamento."""
    _exigir_torneio_da_etapa(tournament_id, stage_id)

    impacto = TournamentService.get_delete_impact(tournament_id)
    if impacto is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )
    return impacto


@router.patch("/{tournament_id}", response_model=Tournament)
def update_tournament(
    tournament_id: str,
    tournament_data: TournamentUpdate,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Update a tournament.
    If X-Stage-ID header is present, validates that tournament belongs to that stage.
    """
    _exigir_torneio_da_etapa(tournament_id, stage_id)

    tournament = TournamentService.update_tournament(tournament_id, tournament_data)
    if not tournament:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )
    return tournament


@router.delete(
    "/{tournament_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        409: {
            "description": (
                "O torneio tem movimento financeiro (entradas vendidas, jogador "
                "pago ou premiação paga) e a exclusão foi recusada. O corpo traz "
                "`impact` com os números do que seria destruído."
            )
        },
    },
)
def delete_tournament(
    tournament_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Delete a tournament.
    If X-Stage-ID header is present, validates that tournament belongs to that stage.

    Torneio com dinheiro em cima é RECUSADO aqui, no servidor, e não só na tela:
    quem chama a API direto (curl, script, integração) não pode contornar uma
    cascata que apaga venda, caixa e histórico de quem pagou.
    """
    _exigir_torneio_da_etapa(tournament_id, stage_id)

    try:
        success = TournamentService.delete_tournament(tournament_id)
    except MovimentoFinanceiroImpedeExclusao as recusa:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": recusa.mensagem,
                "impact": recusa.impacto.model_dump(),
            },
        )
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tournament not found"
        )
