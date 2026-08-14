from fastapi import APIRouter, Depends, HTTPException, status
from typing import List, Optional
from pydantic import BaseModel, Field
from app.models.stage import StageCreate, StageUpdate, Stage, StageSummary
from app.services.stage_service import StageService
from app.services.cashbox_service import CashboxService
from app.services.sales_block_service import SalesBlockService
from app.auth.jwt import get_current_user

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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Stage not found")

    try:
        return SalesBlockService.set_stage_block(stage_id, data.blocked, data.reason, user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("", response_model=Stage, status_code=status.HTTP_201_CREATED)
def create_stage(
    stage: StageCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new stage/etapa"""
    return StageService.create_stage(stage)


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
            detail="Stage not found"
        )
    return stage


@router.patch("/{stage_id}", response_model=Stage)
def update_stage(
    stage_id: str,
    stage: StageUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update a stage"""
    updated_stage = StageService.update_stage(stage_id, stage)
    if not updated_stage:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Stage not found"
        )
    return updated_stage


@router.delete("/{stage_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_stage(
    stage_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Delete a stage"""
    success = StageService.delete_stage(stage_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Stage not found"
        )
    return None
