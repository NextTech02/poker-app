"""Dia de operação do cash game.

O dia é a unidade que abre, fecha, é conferida e é MEDIDA. É por ele que o
clube responde "quanto faturamos ontem?", "qual dia da semana rende mais?" e
"vale abrir na terça?".

DUAS REGRAS QUE PARECEM BUROCRACIA E NÃO SÃO:

1. **Um dia aberto por vez.** Dois dias abertos significam dois fechamentos
   parciais e nenhum que feche — o dinheiro fica partido e ninguém sabe qual
   contagem vale. O banco tem o índice parcial; aqui a recusa vem com nome.

2. **Não fecha o dia com mesa aberta.** Fechar o dia é congelar o faturamento;
   uma mesa aberta ainda vai receber apuração de rake, e o número congelado
   nasceria errado sem nunca mais ser recalculado.
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from app.database import supabase
from app.models.cash_game import (
    CashDayCreate,
    CashDayResponse,
    CashDaySummary,
)
from app.services.house_credit_service import PAYMENT_SOURCE as FIADO, HouseCreditService
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger(__name__)


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


class CashDayService:

    # ============================================================
    # Leitura
    # ============================================================

    @staticmethod
    def get_day(cash_day_id: str) -> dict:
        resp = supabase.table("cash_days").select("*").eq("id", cash_day_id).execute()
        if not resp.data:
            # 404 também cobre "dia de outra organização": o RLS não devolve a
            # linha, e do lado de cá isso é indistinguível de não existir — que
            # é exatamente o que o cliente deve enxergar.
            raise ErroDeNegocio("dia_nao_encontrado", "Dia de operação não encontrado.", status=404)
        return resp.data[0]

    @staticmethod
    def get_current(organization_id: Optional[str] = None) -> Optional[CashDayResponse]:
        """O dia aberto agora, ou None. É o que a tela do salão usa para saber
        se a operação está no ar."""
        query = supabase.table("cash_days").select("*").eq("status", "open")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        resp = query.limit(1).execute()
        return CashDayResponse(**resp.data[0]) if resp.data else None

    @staticmethod
    def list_days(
        organization_id: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 90,
    ) -> List[CashDayResponse]:
        query = supabase.table("cash_days").select("*")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        if date_from:
            query = query.gte("business_date", date_from)
        if date_to:
            query = query.lte("business_date", date_to)
        if status:
            query = query.eq("status", status)
        resp = query.order("business_date", desc=True).limit(limit).execute()
        return [CashDayResponse(**r) for r in (resp.data or [])]

    # ============================================================
    # Abertura
    # ============================================================

    @staticmethod
    def open_day(
        data: CashDayCreate,
        auth_user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> CashDayResponse:
        aberto = CashDayService.get_current(organization_id)
        if aberto:
            # A data vai como dado nomeado: a tela remonta a frase no idioma
            # dela e ainda diz QUAL dia está aberto, que é a informação que
            # resolve o caso no balcão.
            raise ErroDeNegocio(
                "dia_ja_aberto",
                "Já existe um dia de operação aberto. Feche-o antes de abrir outro.",
                status=409,
                cash_day_id=aberto.id,
                business_date=str(aberto.business_date),
            )

        payload = {
            "business_date": str(data.business_date),
            "label": data.label,
            "notes": data.notes,
            "status": "open",
            "opened_by": auth_user_id,
        }
        if organization_id:
            payload["organization_id"] = organization_id

        try:
            resp = supabase.table("cash_days").insert(payload).execute()
        except Exception as exc:
            # O índice único (organization_id, business_date) pega o caso de
            # reabrir um dia já encerrado — que seria um segundo fechamento
            # para a mesma data e dois faturamentos concorrentes.
            if "duplicate key" in str(exc).lower() or "23505" in str(exc):
                raise ErroDeNegocio(
                    "dia_ja_existe",
                    "Já existe um dia de operação com esta data.",
                    status=409,
                    business_date=str(data.business_date),
                )
            raise
        return CashDayResponse(**resp.data[0])

    # ============================================================
    # Números do dia
    # ============================================================

    @staticmethod
    def summary(cash_day_id: str) -> CashDaySummary:
        """Agrega o dia ao vivo. Depois de fechado, devolve o congelado.

        `revenue` é o RAKE, não os buy-ins. Buy-in é troca de dinheiro por
        ficha e a maior parte volta ao jogador no cash-out; tratá-lo como
        receita multiplicaria o faturamento do clube por dez no papel.
        """
        dia = CashDayService.get_day(cash_day_id)
        agregado = CashDayService._agregar(cash_day_id)

        if dia.get("status") == "closed" and dia.get("total_rake") is not None:
            # Resultado congelado: foi contra ele que a conferência foi feita.
            # Recalcular daria um número que não bate com o que ficou assinado.
            return CashDaySummary(
                cash_day_id=cash_day_id,
                business_date=dia["business_date"],
                status=dia["status"],
                total_buy_ins=float(dia.get("total_buy_ins") or 0),
                total_cash_outs=float(dia.get("total_cash_outs") or 0),
                revenue=float(dia.get("total_rake") or 0),
                jackpot_collected=float(dia.get("total_jackpot") or 0),
                variance=float(dia.get("variance") or 0),
                tables_open=0,
                tables_total=int(dia.get("tables_count") or 0),
                players_seated=0,
                players_total=int(dia.get("players_count") or 0),
                cash_in_play=0.0,
                total_credit_issued=float(dia.get("total_credit_issued") or 0),
                total_debt_offset=float(dia.get("total_debt_offset") or 0),
                total_debt_payments=float(dia.get("total_debt_payments") or 0),
            )

        return CashDaySummary(
            cash_day_id=cash_day_id,
            business_date=dia["business_date"],
            status=dia.get("status", "open"),
            **agregado,
        )

    @staticmethod
    def _agregar(cash_day_id: str) -> dict:
        """Soma o dia a partir das linhas. Três consultas, sem laço com query
        dentro (o N+1 clássico deste projeto)."""
        # `*` e não a lista de colunas: as do fiado só existem depois da
        # migração, e pedi-las pelo nome derrubaria o resumo do dia antes dela.
        txs = supabase.table("cash_transactions").select("*") \
            .eq("cash_day_id", cash_day_id).execute().data or []

        entradas = saidas = fiado = abatido = 0.0
        for t in txs:
            if (t.get("status") or "active") != "active":
                continue  # cancelada: o dinheiro voltou para a mão do jogador
            valor = float(t.get("amount") or 0)
            if t.get("type") in ("buy_in", "rebuy"):
                entradas += valor
                if t.get("payment_source") == FIADO:
                    fiado += valor
            elif t.get("type") in ("cash_out", "jackpot_payout"):
                saidas += valor
                abatido += float(t.get("debt_settled_amount") or 0)

        recebido = 0.0
        if HouseCreditService.migrado():
            recebimentos = supabase.table("house_credit_entries").select("type, amount") \
                .eq("cash_day_id", cash_day_id).in_("type", ["payment", "payment_reversal"]) \
                .execute().data or []
            recebido = sum(
                float(r["amount"]) * (1 if r["type"] == "payment" else -1) for r in recebimentos
            )

        rakes = supabase.table("cash_rake_entries").select(
            "rake_amount, jackpot_amount"
        ).eq("cash_day_id", cash_day_id).execute().data or []
        rake = sum(float(r.get("rake_amount") or 0) for r in rakes)
        jackpot = sum(float(r.get("jackpot_amount") or 0) for r in rakes)

        mesas = supabase.table("cash_tables").select("id, status") \
            .eq("cash_day_id", cash_day_id).execute().data or []

        sessoes = supabase.table("cash_player_sessions").select(
            "id, status, total_buy_in, total_cash_out"
        ).eq("cash_day_id", cash_day_id).execute().data or []
        sentados = [s for s in sessoes if s.get("status") == "active"]
        # Fichas ainda na mesa: o que os sentados compraram e não devolveram.
        # Explica a maior parte da variância enquanto o dia está aberto.
        em_jogo = sum(
            float(s.get("total_buy_in") or 0) - float(s.get("total_cash_out") or 0)
            for s in sentados
        )

        return {
            "total_buy_ins": round(entradas, 2),
            "total_cash_outs": round(saidas, 2),
            "revenue": round(rake, 2),
            "jackpot_collected": round(jackpot, 2),
            "variance": round((entradas - saidas) - (rake + jackpot), 2),
            "tables_open": sum(1 for m in mesas if m.get("status") != "closed"),
            "tables_total": len(mesas),
            "players_seated": len(sentados),
            "players_total": len({s["id"] for s in sessoes}),
            "cash_in_play": round(em_jogo, 2),
            "total_credit_issued": round(fiado, 2),
            "total_debt_offset": round(abatido, 2),
            "total_debt_payments": round(recebido, 2),
        }

    # ============================================================
    # Fechamento
    # ============================================================

    @staticmethod
    def close_day(
        cash_day_id: str,
        auth_user_id: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> CashDayResponse:
        dia = CashDayService.get_day(cash_day_id)
        if dia.get("status") == "closed":
            raise ErroDeNegocio(
                "dia_ja_fechado", "Este dia de operação já foi fechado.", status=409
            )

        abertas = supabase.table("cash_tables").select("id, table_number") \
            .eq("cash_day_id", cash_day_id).neq("status", "closed").execute().data or []
        if abertas:
            # Fechar o dia congela o faturamento. Uma mesa aberta ainda vai
            # receber apuração de rake, e o número congelado nasceria errado
            # sem nunca mais ser recalculado.
            raise ErroDeNegocio(
                "dia_com_mesa_aberta",
                "Feche todas as mesas antes de encerrar o dia.",
                status=409,
                mesas=[m.get("table_number") for m in abertas],
                quantidade=len(abertas),
            )

        agregado = CashDayService._agregar(cash_day_id)
        atualizacao = {
            "status": "closed",
            "closed_at": _agora(),
            "closed_by": auth_user_id,
            "total_buy_ins": agregado["total_buy_ins"],
            "total_cash_outs": agregado["total_cash_outs"],
            "total_rake": agregado["revenue"],
            "total_jackpot": agregado["jackpot_collected"],
            "variance": agregado["variance"],
            "tables_count": agregado["tables_total"],
            "players_count": agregado["players_total"],
        }
        if HouseCreditService.migrado():
            # Só com a migração: as colunas não existem antes dela.
            atualizacao.update({
                "total_credit_issued": agregado["total_credit_issued"],
                "total_debt_offset": agregado["total_debt_offset"],
                "total_debt_payments": agregado["total_debt_payments"],
            })
        if notes:
            atualizacao["notes"] = notes

        resp = supabase.table("cash_days").update(atualizacao).eq("id", cash_day_id).execute()
        return CashDayResponse(**resp.data[0])

    # ============================================================
    # Guarda usada por quem movimenta dinheiro
    # ============================================================

    @staticmethod
    def require_open_day(cash_day_id: str) -> dict:
        """O dia precisa estar aberto para qualquer movimento.

        Sem esta guarda, uma tela esquecida aberta numa aba lançaria venda num
        dia já conferido e assinado — e o fechamento passaria a não bater sem
        que ninguém tivesse feito nada de errado hoje.
        """
        dia = CashDayService.get_day(cash_day_id)
        if dia.get("status") != "open":
            raise ErroDeNegocio(
                "dia_nao_aberto",
                "O dia de operação está fechado.",
                cash_day_id=cash_day_id,
            )
        return dia
