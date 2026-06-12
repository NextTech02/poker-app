"""Backend permission enforcement.

The app's RBAC stores screen-permission keys in permission_groups.permissions
(TEXT[]) linked to staff. Historically authorization was enforced only in the
frontend (route guards). This module adds server-side enforcement so restricted
roles — notably the `sangi` — cannot reach financial/cashier endpoints by
calling the API directly with a valid JWT.

Semantics (mirrors PermissionContext.hasPermission on the frontend):
  - A user with NO staff record is treated as super-admin (bypass).
  - Otherwise the user must hold at least one of the required permission keys.
"""
from typing import Iterable
from fastapi import Depends, HTTPException, status

from app.auth.jwt import get_current_user
from app.services.staff_service import StaffService


def require_permission(*required: str):
    """Dependency factory: ensure the current user holds at least one of
    `required` permission keys. Super-admins (no staff record) bypass."""
    required_set = set(required)

    def _dependency(current_user: dict = Depends(get_current_user)) -> dict:
        auth_user_id = current_user.get("sub")
        perms = StaffService.get_my_permissions(auth_user_id)
        if perms.is_admin:
            return current_user
        if required_set & set(perms.permissions or []):
            return current_user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Você não tem permissão para acessar este recurso.",
        )

    return _dependency


def forbid_permission(*forbidden: str):
    """Dependency factory: block users whose ONLY access would come from a
    restricted role. Used to keep restricted roles (e.g. `sangi`) out of an
    endpoint even if some overlap exists. Super-admins bypass."""
    forbidden_set = set(forbidden)

    def _dependency(current_user: dict = Depends(get_current_user)) -> dict:
        auth_user_id = current_user.get("sub")
        perms = StaffService.get_my_permissions(auth_user_id)
        if perms.is_admin:
            return current_user
        user_perms = set(perms.permissions or [])
        # If the user has ONLY forbidden perms (no other access), block.
        if user_perms and user_perms.issubset(forbidden_set):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Acesso não permitido para este perfil.",
            )
        return current_user

    return _dependency
