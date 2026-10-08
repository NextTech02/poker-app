"""Dados extras do telão PÚBLICO (sem login).

A TV do salão abre `/tv/<código>` sem autenticar. O relógio sempre foi
público, mas a premiação não: `GET /tournaments/{id}/prizes` exige login, então
a TV anônima nunca mostrava os prêmios (401 silencioso → lista vazia). A moeda
tinha o mesmo problema, pior: a tela lia `app_settings` sem filtro e, como
anônima, pegava a linha de uma organização QUALQUER.

Aqui tudo é lido com a chave de serviço — de propósito. Se um operador logado
abrir o telão, o request leva JWT e o proxy `supabase` rodaria como ele; um
funcionário sem permissão de premiação veria o telão sem prêmios. O telão é
o mesmo para todo mundo no salão, então a leitura não depende de quem abriu.
"""
import logging
from typing import Optional

from app.database.supabase_client import supabase_admin
from app.models.public_tv import PublicTvExtras, PublicTvPrize
from app.services.module_service import ModuleService
from app.services.prize_allocation_service import PrizeAllocationService
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger(__name__)

MOEDA_PADRAO = "BRL"

# Só o que o telão mostra. `player_name`, documento e `paid_*` ficam de fora:
# a rota é aberta à internet.
_CAMPOS_DO_PREMIO = (
    "position, prize_amount, prize_type, vaga_target_tournament_id, vaga_target_day_id, visible"
)


class PublicTvService:

    @staticmethod
    def get_day_extras(day_id: str) -> PublicTvExtras:
        resp = (
            supabase_admin.table("tournament_days")
            .select("id, tournament_id, organization_id")
            .eq("id", day_id)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            # 404 seco: sem dizer se o id existe em outro clube.
            raise ErroDeNegocio("dia_nao_encontrado", "Dia não encontrado.", status=404)
        day = rows[0]
        tournament_id = str(day.get("tournament_id"))
        org_id = day.get("organization_id")

        return PublicTvExtras(
            day_id=str(day["id"]),
            tournament_id=tournament_id,
            organization_name=ModuleService.org_name(org_id),
            currency=PublicTvService._currency(org_id),
            prize_pool=PublicTvService._prize_pool(tournament_id),
            prizes=PublicTvService._prizes(tournament_id),
        )

    # ── partes ────────────────────────────────────────────────────────────

    @staticmethod
    def _currency(org_id: Optional[str]) -> str:
        """Moeda da ORGANIZAÇÃO do dia (não a de quem abriu a tela)."""
        if not org_id:
            return MOEDA_PADRAO
        try:
            resp = (
                supabase_admin.table("app_settings")
                .select("currency")
                .eq("organization_id", org_id)
                .limit(1)
                .execute()
            )
        except Exception as exc:  # decorativo: nunca derruba o telão
            logger.warning("Moeda da org %s não lida para o telão: %s", org_id, exc)
            return MOEDA_PADRAO
        rows = resp.data or []
        if not rows:
            return MOEDA_PADRAO
        return (rows[0] or {}).get("currency") or MOEDA_PADRAO

    @staticmethod
    def _prize_pool(tournament_id: str) -> Optional[float]:
        """Prize pool disponível pelo mesmo cálculo da tela de premiação.
        Falhou? `None` — a TV cai no `prize_pool` do dia, e os prêmios
        continuam vindo (são buscados à parte)."""
        try:
            summary = PrizeAllocationService.get_prize_summary(tournament_id)
            return float(summary.available_prize_pool)
        except Exception as exc:
            logger.warning("Resumo de premiação do torneio %s indisponível para o telão: %s",
                           tournament_id, exc)
            return None

    @staticmethod
    def _prizes(tournament_id: str) -> list[PublicTvPrize]:
        try:
            resp = (
                supabase_admin.table("prize_allocations")
                .select(_CAMPOS_DO_PREMIO)
                .eq("tournament_id", tournament_id)
                .order("position")
                .execute()
            )
        except Exception as exc:
            logger.warning("Prêmios do torneio %s não lidos para o telão: %s", tournament_id, exc)
            return []
        saida = []
        for row in resp.data or []:
            # Filtro em Python, não `.neq("visible", false)`: a semântica de
            # NULL no PostgREST excluiria linhas antigas sem o campo.
            if row.get("visible") is False:
                continue
            saida.append(PublicTvPrize(
                position=int(row.get("position") or 0),
                prize_amount=float(row.get("prize_amount") or 0),
                prize_type=row.get("prize_type") or "cash",
                vaga_target_tournament_id=_str_ou_none(row.get("vaga_target_tournament_id")),
                vaga_target_day_id=_str_ou_none(row.get("vaga_target_day_id")),
            ))
        return saida


def _str_ou_none(valor) -> Optional[str]:
    return str(valor) if valor is not None else None
