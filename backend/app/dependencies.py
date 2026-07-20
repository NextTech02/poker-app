"""
Dependencies for extracting and validating stage context from requests.
"""
from typing import Optional
from fastapi import Header, HTTPException, Depends
from .auth.jwt import get_current_user
from .database.supabase_client import supabase


def get_org_id(current_user: dict = Depends(get_current_user)) -> str:
    """Organização do usuário, lida do CLAIM do JWT (injetado pelo Auth Hook).

    Esta é a fronteira do multi-tenant. O claim vem assinado pelo servidor de
    auth (ES256) — o cliente não consegue forjá-lo. NUNCA aceite a organização
    por header/body/query: seria o mesmo buraco do X-Stage-ID, que é fornecido
    pelo cliente e por isso não isola nada.

    Fail-closed: sem claim => sem organização => 403.
    """
    org_id = current_user.get("organization_id")
    if not org_id:
        raise HTTPException(
            status_code=403,
            detail="Sua conta não está vinculada a nenhuma organização.",
        )
    return org_id


def get_org_id_optional(current_user: dict = Depends(get_current_user)) -> Optional[str]:
    """Igual a get_org_id, mas devolve None em vez de 403 (ex.: platform admin)."""
    return current_user.get("organization_id")


def is_platform_admin(current_user: dict = Depends(get_current_user)) -> bool:
    """Claim `platform_admin` (tabela platform_admins, via Auth Hook)."""
    return current_user.get("platform_admin") is True


async def get_stage_id_optional(x_stage_id: Optional[str] = Header(None)) -> Optional[str]:
    """
    Extract stage_id from X-Stage-ID header (optional).

    O valor vem do cliente, então por si só não isola nada. A POSSE, porém, é
    garantida pelo RLS: `validate_stage_exists` faz um SELECT em `stages`, que
    só devolve linhas da organização do JWT. Um X-Stage-ID de outra organização
    simplesmente não é encontrado => 404. Verificado: usuário de outra org vê 0
    etapas, mesmo forjando o header.

    Ou seja: este header particiona a visão DENTRO da organização; o isolamento
    ENTRE organizações é do claim organization_id + RLS.
    """
    return x_stage_id


async def get_stage_id_required(x_stage_id: Optional[str] = Header(None)) -> str:
    """
    Extract stage_id from X-Stage-ID header (required).
    Raises HTTPException if header is not present.
    """
    if not x_stage_id:
        raise HTTPException(
            status_code=400,
            detail="X-Stage-ID header is required. Please select a stage first."
        )
    return x_stage_id


async def validate_stage_exists(stage_id: str = Depends(get_stage_id_required)) -> str:
    """
    Validate that the stage exists in the database.
    Returns the stage_id if valid, raises HTTPException otherwise.
    """
    try:
        response = supabase.table('stages').select('id').eq('id', stage_id).execute()
        if not response.data or len(response.data) == 0:
            raise HTTPException(
                status_code=404,
                detail=f"Stage with id {stage_id} not found"
            )
        return stage_id
    except Exception as e:
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(
            status_code=500,
            detail=f"Error validating stage: {str(e)}"
        )


async def get_current_user_with_stage(
    current_user: dict = Depends(get_current_user),
    stage_id: str = Depends(validate_stage_exists)
):
    """
    Combine user authentication with stage validation.
    Returns both user and stage_id.
    """
    return {
        "user": current_user,
        "stage_id": stage_id
    }


async def get_current_user_with_optional_stage(
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Combine user authentication with optional stage.
    Returns both user and stage_id (which may be None).
    """
    return {
        "user": current_user,
        "stage_id": stage_id
    }
