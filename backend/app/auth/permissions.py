"""Backend permission enforcement.

The app's RBAC stores screen-permission keys in permission_groups.permissions
(TEXT[]) linked to staff. Historically authorization was enforced only in the
frontend (route guards). This module adds server-side enforcement so restricted
roles — notably the `sangi` — cannot reach financial/cashier endpoints by
calling the API directly with a valid JWT.

Semantics (mirrors PermissionContext.hasPermission on the frontend):
  - Sem linha em `staff`: NENHUM acesso, a menos que o id esteja na allowlist
    SUPER_ADMIN_USER_IDS. (Este comentario dizia o contrario — "tratado como
    super-admin" — mas `get_my_permissions` foi endurecido para fail-closed:
    o comportamento antigo dava poder total a qualquer conta autenticada sem
    vinculo, o que num SaaS faria o funcionario de um cliente virar dono de
    tudo.)
  - Com vinculo ativo: precisa ter ao menos uma das permissoes exigidas.
"""
from typing import Iterable
from fastapi import Depends

from app.auth.jwt import get_current_user
from app.services.staff_service import StaffService
from app.utils.erros import sem_permissao


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
        # Duas das recusas mais vistas do sistema — e as duas chegavam em
        # português na tela de um operador peruano ou colombiano. O `code` deixa
        # a tela escolher a frase; o `message` continua valendo de reserva.
        raise sem_permissao(
            "sem_permissao",
            "Você não tem permissão para acessar este recurso.",
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
            raise sem_permissao(
                "perfil_sem_acesso",
                "Acesso não permitido para este perfil.",
            )
        return current_user

    return _dependency
