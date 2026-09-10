"""Jackpot / bad beat do cash game.

O JACKPOT NÃO É RECEITA DO CLUBE. É dinheiro dos JOGADORES, retido para
pagamento futuro — um passivo. Somá-lo ao faturamento faria o clube
contabilizar como lucro algo que vai devolver, e a conta só apareceria no dia
em que alguém levasse o prêmio.

Por isso:
  - o fundo tem tabela e saldo próprios, fora de qualquer soma de receita;
  - a entrada é a apuração da caixa da mesa (que separa rake de jackpot);
  - a saída é um pagamento que SAI DA GAVETA como qualquer outro dinheiro, e
    por isso passa por `cash_transactions` e é conferido no fechamento do caixa.
"""
import logging
from typing import List, Optional

from app.database import supabase
from app.models.cash_game import (
    JackpotFundResponse,
    JackpotPayoutCreate,
    JackpotPayoutResponse,
)
from app.services.cash_day_service import CashDayService
from app.services.cashbox_service import CashboxService
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger(__name__)


class CashJackpotService:

    @staticmethod
    def get_fund(organization_id: Optional[str] = None) -> JackpotFundResponse:
        query = supabase.table("cash_jackpot_fund").select("*")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        resp = query.limit(1).execute()
        if not resp.data:
            # Clube que ainda não apurou jackpot nenhum: zero é a resposta, não
            # um erro. A tela mostra o acumulado desde a primeira contagem.
            return JackpotFundResponse(
                organization_id=organization_id,
                current_balance=0, total_collected=0, total_paid=0,
            )
        return JackpotFundResponse(**resp.data[0])

    @staticmethod
    def list_payouts(
        organization_id: Optional[str] = None,
        cash_day_id: Optional[str] = None,
        limit: int = 100,
    ) -> List[JackpotPayoutResponse]:
        query = supabase.table("cash_jackpot_payouts").select("*")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        if cash_day_id:
            query = query.eq("cash_day_id", cash_day_id)
        linhas = query.order("paid_at", desc=True).limit(limit).execute().data or []
        if not linhas:
            return []

        ids = [l["player_id"] for l in linhas if l.get("player_id")]
        nomes = {}
        if ids:
            rows = supabase.table("players").select("id, name, nickname") \
                .in_("id", list(set(ids))).execute().data or []
            nomes = {r["id"]: (r.get("nickname") or r.get("name")) for r in rows}

        return [
            JackpotPayoutResponse(**l, player_name=nomes.get(l.get("player_id")))
            for l in linhas
        ]

    @staticmethod
    def pay(
        data: JackpotPayoutCreate,
        auth_user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> JackpotPayoutResponse:
        """Paga o jackpot a um jogador. O dinheiro SAI da gaveta.

        Passa por `cash_transactions` (tipo `jackpot_payout`) porque é saída
        real de caixa: o operador entrega as fichas ou o dinheiro, e isso
        precisa aparecer na conferência do fim da noite. Lançar só no fundo
        deixaria o caixa acusando falta sem explicação.
        """
        dia = CashDayService.require_open_day(data.cash_day_id)
        org = organization_id or dia.get("organization_id")

        fundo = CashJackpotService.get_fund(org)
        if data.amount > fundo.current_balance:
            # O saldo vai como dado nomeado: sem ele a tela só diria "saldo
            # insuficiente", e quem está no balcão não saberia quanto pode pagar.
            raise ErroDeNegocio(
                "jackpot_saldo_insuficiente",
                "O fundo de jackpot não tem esse saldo.",
                disponivel=fundo.current_balance,
                solicitado=data.amount,
            )

        caixa = CashboxService.require_open_cashbox_for_cash_day(
            auth_user_id, data.cash_day_id
        )

        venda = {
            "cash_day_id": data.cash_day_id,
            "table_id": data.table_id,
            "player_id": data.player_id,
            "type": "jackpot_payout",
            "amount": data.amount,
            "notes": data.description,
            "created_by": auth_user_id,
            "status": "active",
        }
        if (caixa or {}).get("id"):
            venda["cashbox_id"] = caixa["id"]
        if org:
            venda["organization_id"] = org
        movimento = supabase.table("cash_transactions").insert(venda).execute().data[0]

        payload = {
            "cash_day_id": data.cash_day_id,
            "table_id": data.table_id,
            "player_id": data.player_id,
            "kind": data.kind,
            "amount": data.amount,
            "description": data.description,
            "cash_transaction_id": movimento["id"],
            "paid_by": auth_user_id,
        }
        if org:
            payload["organization_id"] = org

        try:
            linha = supabase.table("cash_jackpot_payouts").insert(payload).execute().data[0]
        except Exception:
            # Sem o recibo do fundo, o dinheiro teria saído da gaveta sem baixa
            # no passivo — o fundo continuaria devendo o que já foi pago.
            supabase.table("cash_transactions").delete().eq("id", movimento["id"]).execute()
            raise

        nomes = {}
        if data.player_id:
            rows = supabase.table("players").select("id, name, nickname") \
                .eq("id", data.player_id).execute().data or []
            nomes = {r["id"]: (r.get("nickname") or r.get("name")) for r in rows}
        return JackpotPayoutResponse(**linha, player_name=nomes.get(data.player_id))
