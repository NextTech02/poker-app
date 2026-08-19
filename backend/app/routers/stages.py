from fastapi import APIRouter, Depends, HTTPException, status
from typing import List, Optional
from pydantic import BaseModel, Field
from app.models.stage import (
    StageCreate,
    StageUpdate,
    Stage,
    StageSummary,
    StageDeleteImpact,
)
from app.services.stage_service import StageService
from app.services.cashbox_service import CashboxService
from app.services.sales_block_service import SalesBlockService
from app.auth.jwt import get_current_user

# Mensagem 404 de etapa inexistente, igual em todas as rotas de etapa.
ETAPA_NAO_ENCONTRADA = "Stage not found"

router = APIRouter(prefix="/stages", tags=["stages"])


class SalesBlockToggle(BaseModel):
    """Chave-mestra: bloqueia a venda em TODOS os dias da etapa de uma vez."""
    blocked: bool
    reason: Optional[str] = Field(default=None, max_length=500)


@router.post(
    "/{stage_id}/sales-block",
    responses={
        400: {
            "description": (
                "Não foi possível gravar o bloqueio: a migração do banco que cria as "
                "colunas de bloqueio ainda não foi aplicada, ou a etapa sumiu no meio "
                "da atualização."
            )
        },
        403: {"description": "Só quem administra o caixa pode bloquear ou liberar vendas."},
        404: {"description": "Etapa não encontrada."},
    },
)
def set_stage_sales_block(
    stage_id: str,
    data: SalesBlockToggle,
    current_user: dict = Depends(get_current_user),
):
    """Liga/desliga a venda em toda a etapa ("fecha tudo agora").

    Só admin de caixa — ver o endpoint equivalente por dia.
    """
    user_id = current_user.get("sub")
    if not CashboxService.can_admin(user_id):
        raise HTTPException(status_code=403, detail="Sem permissão para bloquear vendas")

    if not StageService.get_stage(stage_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ETAPA_NAO_ENCONTRADA)

    try:
        return SalesBlockService.set_stage_block(stage_id, data.blocked, data.reason, user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post(
    "", response_model=Stage, status_code=status.HTTP_201_CREATED,
    responses={400: {"description": "Datas incoerentes: fim antes do início, ou etapa sem data de início."}},
)
def create_stage(
    stage: StageCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new stage/etapa"""
    try:
        return StageService.create_stage(stage)
    except ValueError as e:
        # Mesma tradução da edição: 400 com `detail` em texto simples, para a
        # tela de Etapas exibir a frase em português direto.
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("", response_model=List[StageSummary])
def get_stages(
    status: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    """Get all stages, optionally filtered by status"""
    return StageService.get_stages(status)


@router.get("/{stage_id}", response_model=Stage)
def get_stage(
    stage_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get a specific stage by ID"""
    stage = StageService.get_stage(stage_id)
    if not stage:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ETAPA_NAO_ENCONTRADA
        )
    return stage


@router.patch(
    "/{stage_id}",
    response_model=Stage,
    responses={400: {"description": "Datas incoerentes: fim antes do início, ou etapa sem data de início."}},
)
def update_stage(
    stage_id: str,
    stage: StageUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update a stage"""
    try:
        updated_stage = StageService.update_stage(stage_id, stage)
    except ValueError as e:
        # Regra de data violada. 400 (e não 422) para o texto chegar em
        # `detail` como string simples e a tela conseguir mostrá-lo direto.
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if not updated_stage:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ETAPA_NAO_ENCONTRADA
        )
    return updated_stage


@router.get("/{stage_id}/delete-impact", response_model=StageDeleteImpact)
def get_stage_delete_impact(
    stage_id: str,
    current_user: dict = Depends(get_current_user)
):
    """O que a exclusão desta etapa destruiria, com números reais.

    A tela chama isto ANTES de perguntar "tem certeza?" — sem isso a
    confirmação não diz que a contabilidade da etapa vai junto.
    """
    impacto = StageService.get_delete_impact(stage_id)
    if impacto is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ETAPA_NAO_ENCONTRADA)
    return impacto


@router.post("/{stage_id}/archive", response_model=Stage)
def archive_stage(
    stage_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Arquiva a etapa (status 'cancelled') preservando tudo o que ela tem.

    Alternativa oferecida quando a exclusão é recusada por haver movimento
    financeiro.
    """
    etapa = StageService.archive_stage(stage_id)
    if not etapa:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ETAPA_NAO_ENCONTRADA)
    return etapa


@router.delete(
    "/{stage_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={409: {"description": "A etapa tem movimento financeiro: arquive em vez de excluir."}},
)
def delete_stage(
    stage_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Delete a stage"""
    try:
        success = StageService.delete_stage(stage_id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ETAPA_NAO_ENCONTRADA
        )
    return None
