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
from app.utils.cache_curto import CacheCurto

logger = logging.getLogger(__name__)

# Os módulos contratados mudam por decisão comercial (raro) e são checados em
# TODA rota do cash e do bar (`require_module`). 30 s de validade tiram essa
# consulta de quase todas as requisições; contratar um módulo leva até isso
# para valer.
_modulos_do_clube = CacheCurto(validade_s=30)


class _LeituraFalhou(Exception):
    """org_modules não respondeu: cai no padrão SEM guardar a falha no cache."""

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
        """Módulos habilitados da organização. Nunca levanta.

        Guardado por 30 s por organização (`_modulos_do_clube`). Uma falha de
        leitura NÃO é guardada: o padrão de emergência vale só para aquela vez.
        """
        if not organization_id:
            return list(DEFAULT_MODULES)
        try:
            return list(_modulos_do_clube.obter(
                organization_id, lambda: ModuleService._ler_modulos(organization_id)
            ))
        except _LeituraFalhou:
            # Ver o docstring do módulo: lista vazia aqui apagaria a sidebar.
            logger.warning("org_modules indisponível; assumindo %s", DEFAULT_MODULES)
            return list(DEFAULT_MODULES)

    @staticmethod
    def esquecer_cache(organization_id: str) -> None:
        """Depois de mudar os módulos de uma org: a próxima checagem relê."""
        _modulos_do_clube.esquecer(organization_id)

    @staticmethod
    def _ler_modulos(organization_id: str) -> tuple:
        """Lê do banco. Tupla (imutável) porque o valor é guardado e
        compartilhado; quem pede recebe uma lista nova (`list_for_org`)."""
        try:
            resp = supabase.table("org_modules") \
                .select("module") \
                .eq("organization_id", organization_id) \
                .eq("enabled", True) \
                .execute()
        except Exception as exc:
            raise _LeituraFalhou() from exc

        modules = ModuleService.ordenar(
            {r.get("module") for r in (resp.data or []) if r.get("module")}
        )
        # Organização sem NENHUMA linha é uma que nasceu antes da migração de
        # backfill (ou cujo trigger de seed falhou). Tratar como torneio.
        return tuple(modules or DEFAULT_MODULES)

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
