"""Guarda de MÓDULO (torneio × cash game).

Espelha `app/auth/permissions.py`, mas responde a outra pergunta. Permissão é
"este funcionário pode fazer isto?"; módulo é "este clube comprou isto?". Um
admin de um clube que só faz torneio tem todas as permissões e mesmo assim não
pode abrir uma mesa de cash.

Aplicada em bloco no `main.py`, do mesmo jeito que `_no_sangi`:

    _cash = [Depends(forbid_permission("sangi")), Depends(require_module("cash"))]
    app.include_router(cash_days.router, dependencies=_cash)

O platform admin NÃO atravessa: quando ele entra numa organização, ele vê o que
aquela organização vê. Fingir que o clube tem um módulo que não comprou só
produziria telas que quebram no primeiro INSERT (o trigger de limite recusa).
"""
from fastapi import Depends

from app.auth.jwt import get_current_user
from app.services.module_service import ModuleService
from app.utils.erros import sem_permissao


def require_module(module: str):
    """Dependency factory: exige que a organização do usuário tenha `module`."""

    def _dependency(current_user: dict = Depends(get_current_user)) -> dict:
        organization_id = current_user.get("organization_id")
        if not organization_id:
            raise sem_permissao(
                "conta_sem_organizacao",
                "Sua conta não está vinculada a nenhuma organização.",
            )
        if not ModuleService.has_module(organization_id, module):
            # `modulo` vai como extra para a tela poder dizer QUAL módulo falta
            # e oferecer o caminho de contratação, sem depender da frase.
            raise sem_permissao(
                "modulo_nao_contratado",
                "Este módulo não está contratado para o seu clube.",
                modulo=module,
            )
        return current_user

    return _dependency
