from fastapi import APIRouter, Depends, HTTPException, status, Query
from typing import List, Optional
from uuid import UUID

from ..auth.jwt import get_current_user
from ..services.blind_template_service import BlindTemplateService
from ..models.blind_template import (
    BlindTemplateCreate,
    BlindTemplateUpdate,
    BlindTemplateResponse,
    ApplyTemplateRequest
)
from ..models.blind import BlindResponse
# Recusas com CODIGO para a tela traduzir (ver app/utils/erros.py).
from ..utils.erros import da_excecao, nao_encontrado

router = APIRouter(prefix="/blind-templates", tags=["blind-templates"])


@router.get("", response_model=List[BlindTemplateResponse])
async def get_templates(
    stage_id: Optional[UUID] = Query(None, description="Filter by stage ID"),
    current_user: dict = Depends(get_current_user)
):
    """Get all blind templates, optionally filtered by stage."""
    stage_id_str = str(stage_id) if stage_id else None
    return BlindTemplateService.get_templates(stage_id=stage_id_str)


@router.get("/{template_id}", response_model=BlindTemplateResponse)
async def get_template(
    template_id: UUID,
    current_user: dict = Depends(get_current_user)
):
    """Get a specific blind template by ID."""
    template = BlindTemplateService.get_template(str(template_id))
    if not template:
        raise nao_encontrado(
            "template_de_blinds_nao_encontrado", "Template not found"
        )
    return template


@router.post("", response_model=BlindTemplateResponse, status_code=status.HTTP_201_CREATED)
async def create_template(
    template: BlindTemplateCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new blind template."""
    try:
        user_id = current_user.get('sub') or current_user.get('id')
        return BlindTemplateService.create_template(template, user_id=user_id)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error creating template: {str(e)}"
        )


@router.patch("/{template_id}", response_model=BlindTemplateResponse)
async def update_template(
    template_id: UUID,
    template_update: BlindTemplateUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update an existing blind template."""
    template = BlindTemplateService.update_template(str(template_id), template_update)
    if not template:
        raise nao_encontrado(
            "template_de_blinds_nao_encontrado", "Template not found"
        )
    return template


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: UUID,
    current_user: dict = Depends(get_current_user)
):
    """Delete a blind template."""
    success = BlindTemplateService.delete_template(str(template_id))
    if not success:
        raise nao_encontrado(
            "template_de_blinds_nao_encontrado", "Template not found"
        )
    return None


@router.post("/apply", response_model=List[BlindResponse])
async def apply_template(
    request: ApplyTemplateRequest,
    current_user: dict = Depends(get_current_user)
):
    """Apply a blind template to a tournament day."""
    try:
        blinds = BlindTemplateService.apply_template_to_day(
            template_id=str(request.template_id),
            tournament_day_id=str(request.tournament_day_id),
            clear_existing=request.clear_existing
        )
        return blinds
    except ValueError as e:
        raise da_excecao(e, "template_de_blinds_nao_encontrado", status=404)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error applying template: {str(e)}"
        )


@router.post("/save-from-day", response_model=BlindTemplateResponse, status_code=status.HTTP_201_CREATED)
async def save_blinds_as_template(
    tournament_day_id: UUID = Query(..., description="Tournament day to copy blinds from"),
    template_name: str = Query(..., description="Name for the new template"),
    description: Optional[str] = Query(None, description="Template description"),
    stage_id: Optional[UUID] = Query(None, description="Stage to associate template with"),
    current_user: dict = Depends(get_current_user)
):
    """Save the blinds from a tournament day as a new template."""
    try:
        user_id = current_user.get('sub') or current_user.get('id')
        stage_id_str = str(stage_id) if stage_id else None

        return BlindTemplateService.save_blinds_as_template(
            tournament_day_id=str(tournament_day_id),
            template_name=template_name,
            description=description,
            stage_id=stage_id_str,
            user_id=user_id
        )
    except ValueError as e:
        raise da_excecao(e, "template_de_blinds_recusado")
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error saving template: {str(e)}"
        )
