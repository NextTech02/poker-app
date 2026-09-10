"""Módulos contratados pela organização (torneio × cash game).

O sistema nasceu só com torneio. Cash game é um módulo IRMÃO: o clube contrata
um, o outro ou os dois, e escolhe qual acessar ao entrar.

O QUE ESTE MÓDULO **NÃO** É: fronteira de isolamento de dados. Isso continua
sendo o claim `organization_id` + RLS. Aqui é entitlement comercial — o que o
cliente comprou — e roteamento de tela. Por isso não vive no JWT: pôr no claim
obrigaria a mexer no `custom_access_token_hook` (que roda em TODO login) e a
forçar um `refreshSession()` a cada contratação.

FAIL-SAFE, NÃO FAIL-CLOSED, na LEITURA: se a consulta falhar (rede, RLS, tabela
ainda não migrada), devolvemos `['tournament']`. O motivo é concreto: devolver
lista vazia deixaria a sidebar sem um único item e o clube inteiro parado por um
timeout de banco. Quem barra o acesso de verdade é `require_module`, que consulta
de novo — e lá, sim, um erro derruba a requisição.
"""
import logging
from typing import List

from app.database import supabase

logger = logging.getLogger(__name__)

MODULE_TOURNAMENT = "tournament"
MODULE_CASH = "cash"
ALL_MODULES = (MODULE_TOURNAMENT, MODULE_CASH)

# Piso usado quando não dá para saber: é o que toda organização já tinha antes
# de existir a tabela, então é o único padrão que não muda o mundo de ninguém.
DEFAULT_MODULES = [MODULE_TOURNAMENT]


class ModuleService:

    @staticmethod
    def list_for_org(organization_id: str) -> List[str]:
        """Módulos habilitados da organização. Nunca levanta."""
        if not organization_id:
            return list(DEFAULT_MODULES)
        try:
            resp = supabase.table("org_modules") \
                .select("module") \
                .eq("organization_id", organization_id) \
                .eq("enabled", True) \
                .execute()
        except Exception:
            # Ver o docstring do módulo: lista vazia aqui apagaria a sidebar.
            logger.warning("org_modules indisponível; assumindo %s", DEFAULT_MODULES)
            return list(DEFAULT_MODULES)

        modules = sorted({r.get("module") for r in (resp.data or []) if r.get("module")})
        # Organização sem NENHUMA linha é uma que nasceu antes da migração de
        # backfill (ou cujo trigger de seed falhou). Tratar como torneio.
        return modules or list(DEFAULT_MODULES)

    @staticmethod
    def has_module(organization_id: str, module: str) -> bool:
        return module in ModuleService.list_for_org(organization_id)
