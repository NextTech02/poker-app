"""Módulos contratados pela organização (torneio × cash game × bar).

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
from typing import List, Optional

from app.database import supabase

logger = logging.getLogger(__name__)

MODULE_TOURNAMENT = "tournament"
MODULE_CASH = "cash"
MODULE_BAR = "bar"
# A ORDEM aqui é a ordem canônica em que os módulos são devolvidos — e o
# frontend abre o PRIMEIRO da lista para quem nunca escolheu. Um `sorted()`
# alfabético punha 'bar' (e 'cash') na frente de 'tournament': todo caixa de
# torneio que nunca gravou escolha cairia na home do bar, sem permissão para
# ela, e o guard de rota o mandaria de volta para a mesma home — em laço.
# Torneio primeiro é o único padrão que não muda o mundo de ninguém.
ALL_MODULES = (MODULE_TOURNAMENT, MODULE_CASH, MODULE_BAR)

# Piso usado quando não dá para saber: é o que toda organização já tinha antes
# de existir a tabela, então é o único padrão que não muda o mundo de ninguém.
DEFAULT_MODULES = [MODULE_TOURNAMENT]


class ModuleService:

    @staticmethod
    def org_name(organization_id: str) -> Optional[str]:
        """Nome da organização para o cabeçalho do menu. Nunca levanta: a tela
        de permissões não pode cair por causa de uma linha decorativa."""
        if not organization_id:
            return None
        # A tabela `organizations` só tem a política restritiva de 2FA (nenhum
        # SELECT permissivo para `authenticated`): como usuário a leitura volta
        # vazia. O id vem do claim assinado, então buscar o nome com a chave de
        # serviço não abre nada que o usuário já não saiba.
        try:
            from app.database.supabase_client import supabase_admin
            resp = supabase_admin.table("organizations").select("name")                 .eq("id", organization_id).limit(1).execute()
        except Exception:
            return None
        rows = resp.data or []
        return (rows[0] or {}).get("name") if rows else None

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

        modules = ModuleService.ordenar(
            {r.get("module") for r in (resp.data or []) if r.get("module")}
        )
        # Organização sem NENHUMA linha é uma que nasceu antes da migração de
        # backfill (ou cujo trigger de seed falhou). Tratar como torneio.
        return modules or list(DEFAULT_MODULES)

    @staticmethod
    def ordenar(modulos) -> List[str]:
        """Ordem canônica (ALL_MODULES) na frente; um módulo que este backend
        ainda não conhece vai para o fim, em ordem alfabética, em vez de sumir
        — esconder seria pior do que exibir."""
        conhecidos = [m for m in ALL_MODULES if m in modulos]
        desconhecidos = sorted(m for m in modulos if m not in ALL_MODULES)
        return conhecidos + desconhecidos

    @staticmethod
    def has_module(organization_id: str, module: str) -> bool:
        return module in ModuleService.list_for_org(organization_id)
