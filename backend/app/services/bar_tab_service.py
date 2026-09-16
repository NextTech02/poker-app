"""A COMANDA do bar: abrir, lançar itens, entregar, receber, fechar.

O que este serviço garante, e que uma refatoração distraída desfaz:

1. **Comanda única por jogador.** `open_tab` devolve a aberta se já existir;
   o índice parcial do banco resolve a corrida de dois operadores, e o
   serviço relê em vez de falhar.

2. **Totais recontados, nunca incrementados.** O banco reconta por trigger;
   a RESPOSTA é recontada aqui, em Python, a partir das linhas — assim o
   FakeSupabase (sem trigger) exercita a conta, e a tela nunca vê um número
   que o ledger não sustente.

3. **Nunca há saldo devedor.** `paid_amount <= total` sempre: o banco recusa
   pagamento acima do saldo (trigger, com lock), e o serviço recusa cancelar
   item, dar cortesia ou desconto que deixasse a comanda PAGA A MAIS — o
   gerente estorna um pagamento primeiro. Fechar exige saldo zero.

4. **Só dinheiro real toca a gaveta.** Perna `cash` (qualquer meio) exige a
   gaveta do barman aberta e é espelhada pelo trigger; perna `credit`
   consome `player_credits` e não passa pela gaveta.

5. **Estorno é lógico e retomável** (padrão de cash_transaction_service):
   `cancelling` → recibo (`refund` com bar_payment_id, guardado por EFEITO)
   → `cancelled`. Perna de crédito não é estornável no MVP, como no torneio.
"""
import logging
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional

from app.database import supabase
from app.models.bar import (
    BarItemCourtesy,
    BarPaymentResponse,
    BarPendingOrder,
    BarTabClose,
    BarTabDetail,
    BarTabDiscount,
    BarTabItemCreate,
    BarTabItemResponse,
    BarTabOpen,
    BarTabPay,
    BarTabResponse,
)
from app.services.bar_shift_service import BarShiftService
from app.services.cashbox_service import CashboxService
from app.services.player_credit_service import PlayerCreditService
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger(__name__)

PASSO_CAIXA = "caixa"
PASSO_MARCAR = "marcar"

# Marcadores levantados pelos triggers do banco (REGRA_BAR:<code>) → recusa
# com nome. O código é o MESMO que o serviço usaria: a tela não distingue.
_REGRAS_DO_BANCO = {
    "turno_nao_aberto": ("O turno do bar está fechado.", 400),
    "comanda_nao_aberta": ("A comanda não está aberta.", 409),
    "comanda_nao_encontrada": ("Comanda não encontrada.", 404),
    "produto_nao_encontrado": ("Produto não encontrado.", 404),
    "pagamento_acima_do_saldo": ("O pagamento excede o saldo da comanda.", 400),
}


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _r2(valor) -> float:
    return round(float(valor or 0), 2)


def _eh_duplicidade(exc: Exception) -> bool:
    texto = str(exc).lower()
    return "duplicate key" in texto or "23505" in texto


def _traduzir_erro_do_banco(exc: Exception) -> None:
    """Se a exceção veio de um trigger nosso, vira ErroDeNegocio; senão, sobe."""
    m = re.search(r"REGRA_BAR:([a-z_]+)", str(exc))
    if m:
        code = m.group(1)
        mensagem, status = _REGRAS_DO_BANCO.get(code, ("Operação recusada pelo banco.", 400))
        raise ErroDeNegocio(code, mensagem, status=status)
    raise exc


class BarTabService:

    # ============================================================
    # Leitura
    # ============================================================

    @staticmethod
    def get_tab(tab_id: str) -> dict:
        resp = supabase.table("bar_tabs").select("*").eq("id", tab_id).execute()
        if not resp.data:
            raise ErroDeNegocio("comanda_nao_encontrada", "Comanda não encontrada.", status=404)
        return resp.data[0]

    @staticmethod
    def _itens(tab_id: str) -> List[dict]:
        return supabase.table("bar_tab_items").select("*").eq("tab_id", tab_id) \
            .order("created_at").execute().data or []

    @staticmethod
    def _pagamentos(tab_id: str) -> List[dict]:
        return supabase.table("bar_tab_payments").select("*").eq("tab_id", tab_id) \
            .order("created_at").execute().data or []

    @staticmethod
    def _totais(tab: dict, itens: List[dict], pagamentos: List[dict]) -> dict:
        """A conta da comanda, a partir das linhas. É a mesma de bar_recalc_tab."""
        subtotal = cortesia = 0.0
        qtd = pendentes = 0
        for i in itens:
            if i.get("status") == "cancelled":
                continue
            qtd += 1
            if i.get("status") == "pending":
                pendentes += 1
            linha = i.get("line_total")
            if linha is None:
                linha = float(i.get("unit_price") or 0) * int(i.get("quantity") or 0)
            if i.get("is_courtesy"):
                cortesia += float(linha)
            else:
                subtotal += float(linha)
        desconto = min(float(tab.get("discount_amount") or 0), subtotal)
        total = max(subtotal - desconto, 0.0)
        pago = sum(
            float(p.get("amount") or 0) for p in pagamentos
            if (p.get("status") or "active") == "active"
        )
        return {
            "subtotal": _r2(subtotal),
            "courtesy_amount": _r2(cortesia),
            "discount_amount": _r2(tab.get("discount_amount")),
            "total": _r2(total),
            "paid_amount": _r2(pago),
            "balance_due": _r2(total - pago),
            "items_count": qtd,
            "pending_count": pendentes,
        }

    @staticmethod
    def _resposta(tab: dict, itens: List[dict], pagamentos: List[dict],
                  nomes: Optional[Dict[str, dict]] = None) -> BarTabResponse:
        jogador = (nomes or {}).get(tab.get("player_id")) or {}
        return BarTabResponse(
            **{k: v for k, v in tab.items()
               if k not in ("subtotal", "courtesy_amount", "discount_amount", "total", "paid_amount")},
            player_name=jogador.get("name"),
            player_nickname=jogador.get("nickname"),
            **BarTabService._totais(tab, itens, pagamentos),
        )

    @staticmethod
    def _nomes(player_ids: List[str]) -> Dict[str, dict]:
        ids = list({i for i in player_ids if i})
        if not ids:
            return {}
        rows = supabase.table("players").select("id, name, nickname").in_("id", ids).execute().data or []
        return {r["id"]: r for r in rows}

    @staticmethod
    def detail(tab_id: str) -> BarTabDetail:
        tab = BarTabService.get_tab(tab_id)
        itens = BarTabService._itens(tab_id)
        pagamentos = BarTabService._pagamentos(tab_id)
        nomes = BarTabService._nomes([tab["player_id"]])
        # SEM filtro de etapa: o endpoint de saldo filtra por X-Stage-ID, e uma
        # etapa selecionada por acaso esconderia crédito na POS.
        try:
            credito = PlayerCreditService.get_player_available_credit(tab["player_id"])
        except Exception:
            credito = 0.0
        return BarTabDetail(
            tab=BarTabService._resposta(tab, itens, pagamentos, nomes),
            items=[BarTabItemResponse(**i) for i in itens],
            payments=[BarPaymentResponse(**p) for p in pagamentos],
            player_available_credit=_r2(credito),
        )

    @staticmethod
    def list_tabs(
        organization_id: Optional[str] = None,
        bar_shift_id: Optional[str] = None,
        status: Optional[str] = None,
        player_id: Optional[str] = None,
        limit: int = 200,
    ) -> List[BarTabResponse]:
        query = supabase.table("bar_tabs").select("*")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        if bar_shift_id:
            query = query.eq("bar_shift_id", bar_shift_id)
        if status:
            query = query.eq("status", status)
        if player_id:
            query = query.eq("player_id", player_id)
        tabs = query.order("opened_at", desc=True).limit(limit).execute().data or []
        if not tabs:
            return []

        ids = [t["id"] for t in tabs]
        itens = supabase.table("bar_tab_items").select(
            "tab_id, status, is_courtesy, line_total, unit_price, quantity"
        ).in_("tab_id", ids).execute().data or []
        pagamentos = supabase.table("bar_tab_payments").select(
            "tab_id, amount, status"
        ).in_("tab_id", ids).execute().data or []
        por_tab_itens: dict = {}
        for i in itens:
            por_tab_itens.setdefault(i["tab_id"], []).append(i)
        por_tab_pag: dict = {}
        for p in pagamentos:
            por_tab_pag.setdefault(p["tab_id"], []).append(p)
        nomes = BarTabService._nomes([t["player_id"] for t in tabs])

        return [
            BarTabService._resposta(t, por_tab_itens.get(t["id"], []), por_tab_pag.get(t["id"], []), nomes)
            for t in tabs
        ]

    @staticmethod
    def pending_orders(organization_id: Optional[str], bar_shift_id: str) -> List[BarPendingOrder]:
        query = supabase.table("bar_tab_items").select("*") \
            .eq("bar_shift_id", bar_shift_id).eq("status", "pending")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        itens = query.order("created_at").execute().data or []
        if not itens:
            return []
        tab_ids = list({i["tab_id"] for i in itens})
        tabs = supabase.table("bar_tabs").select("id, number, player_id").in_("id", tab_ids).execute().data or []
        por_id = {t["id"]: t for t in tabs}
        nomes = BarTabService._nomes([t["player_id"] for t in tabs])
        saida = []
        for i in itens:
            t = por_id.get(i["tab_id"], {})
            saida.append(BarPendingOrder(
                item_id=i["id"], tab_id=i["tab_id"], tab_number=int(t.get("number") or 0),
                player_name=(nomes.get(t.get("player_id")) or {}).get("name"),
                product_name=i.get("product_name") or "", quantity=int(i.get("quantity") or 0),
                notes=i.get("notes"), created_at=i.get("created_at"),
            ))
        return saida

    @staticmethod
    def player_history(player_id: str, limit: int = 50) -> List[BarTabResponse]:
        return BarTabService.list_tabs(player_id=player_id, limit=limit)

    # ============================================================
    # Abertura
    # ============================================================

    @staticmethod
    def open_tab(
        data: BarTabOpen,
        auth_user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> BarTabResponse:
        turno = BarShiftService.require_current_open(organization_id)

        jogador = supabase.table("players").select("id, name, nickname").eq("id", data.player_id).execute()
        if not jogador.data:
            raise ErroDeNegocio("jogador_nao_encontrado", "Jogador não encontrado.", status=404)

        aberta = BarTabService._aberta_do_jogador(data.player_id, organization_id)
        if aberta:
            # Comanda ÚNICA por jogador: reaproveita, não duplica.
            return BarTabService._resposta(aberta, BarTabService._itens(aberta["id"]),
                                           BarTabService._pagamentos(aberta["id"]),
                                           {data.player_id: jogador.data[0]})

        payload = {
            "bar_shift_id": turno["id"],
            "player_id": data.player_id,
            "status": "open",
            "opened_by": auth_user_id,
            "notes": data.notes,
            "client_mutation_id": data.client_mutation_id,
            "organization_id": organization_id or turno.get("organization_id"),
        }
        try:
            resp = supabase.table("bar_tabs").insert(payload).execute()
        except Exception as exc:
            if _eh_duplicidade(exc):
                # Dois operadores abriram ao mesmo tempo: o índice decidiu.
                aberta = BarTabService._aberta_do_jogador(data.player_id, organization_id)
                if aberta:
                    return BarTabService._resposta(aberta, [], [], {data.player_id: jogador.data[0]})
            _traduzir_erro_do_banco(exc)
        return BarTabService._resposta(resp.data[0], [], [], {data.player_id: jogador.data[0]})

    @staticmethod
    def _aberta_do_jogador(player_id: str, organization_id: Optional[str]) -> Optional[dict]:
        q = supabase.table("bar_tabs").select("*").eq("player_id", player_id).eq("status", "open")
        if organization_id:
            q = q.eq("organization_id", organization_id)
        rows = q.limit(1).execute().data or []
        return rows[0] if rows else None

    @staticmethod
    def _require_open_tab(tab_id: str) -> dict:
        tab = BarTabService.get_tab(tab_id)
        if tab.get("status") != "open":
            raise ErroDeNegocio(
                "comanda_nao_aberta", "A comanda não está aberta.",
                status=409, status_atual=tab.get("status"),
            )
        BarShiftService.require_open_shift(tab["bar_shift_id"])
        return tab

    # ============================================================
    # Itens
    # ============================================================

    @staticmethod
    def add_item(
        tab_id: str, data: BarTabItemCreate, auth_user_id: Optional[str] = None
    ) -> BarTabDetail:
        if data.client_mutation_id:
            repetido = supabase.table("bar_tab_items").select("id") \
                .eq("client_mutation_id", data.client_mutation_id).limit(1).execute().data or []
            if repetido:
                return BarTabService.detail(tab_id)

        tab = BarTabService._require_open_tab(tab_id)
        produto = supabase.table("bar_products").select("*").eq("id", data.product_id).execute()
        if not produto.data:
            raise ErroDeNegocio("produto_nao_encontrado", "Produto não encontrado.", status=404)
        produto = produto.data[0]
        if not produto.get("active"):
            raise ErroDeNegocio("produto_inativo", "Este produto está inativo.", produto=produto.get("name"))

        preco = _r2(produto.get("price"))
        payload = {
            "tab_id": tab_id,
            "bar_shift_id": tab["bar_shift_id"],
            "product_id": data.product_id,
            # SNAPSHOT: mudar o preço amanhã não reescreve a comanda de hoje.
            "product_name": produto.get("name"),
            "unit_price": preco,
            "unit_cost": _r2(produto.get("cost_price")),
            "quantity": int(data.quantity),
            "line_total": _r2(preco * int(data.quantity)),
            "status": "pending",
            "notes": data.notes,
            "client_mutation_id": data.client_mutation_id,
            "created_by": auth_user_id,
            "organization_id": tab.get("organization_id"),
        }
        try:
            supabase.table("bar_tab_items").insert(payload).execute()
        except Exception as exc:
            if _eh_duplicidade(exc) and data.client_mutation_id:
                return BarTabService.detail(tab_id)
            _traduzir_erro_do_banco(exc)
        return BarTabService.detail(tab_id)

    @staticmethod
    def _item(tab_id: str, item_id: str) -> dict:
        resp = supabase.table("bar_tab_items").select("*").eq("id", item_id).eq("tab_id", tab_id).execute()
        if not resp.data:
            raise ErroDeNegocio("item_nao_encontrado", "Item não encontrado.", status=404)
        return resp.data[0]

    @staticmethod
    def deliver_item(tab_id: str, item_id: str, auth_user_id: Optional[str] = None) -> BarTabDetail:
        item = BarTabService._item(tab_id, item_id)
        if item.get("status") == "cancelled":
            raise ErroDeNegocio("item_cancelado", "O item foi cancelado.", status=409)
        if item.get("status") == "pending":
            supabase.table("bar_tab_items").update({
                "status": "delivered", "delivered_at": _agora(), "delivered_by": auth_user_id,
            }).eq("id", item_id).execute()
        return BarTabService.detail(tab_id)

    @staticmethod
    def deliver_all(tab_id: str, auth_user_id: Optional[str] = None) -> BarTabDetail:
        BarTabService.get_tab(tab_id)
        supabase.table("bar_tab_items").update({
            "status": "delivered", "delivered_at": _agora(), "delivered_by": auth_user_id,
        }).eq("tab_id", tab_id).eq("status", "pending").execute()
        return BarTabService.detail(tab_id)

    @staticmethod
    def cancel_item(
        tab_id: str, item_id: str, reason: str,
        auth_user_id: Optional[str] = None, pode_admin: bool = False,
    ) -> BarTabDetail:
        tab = BarTabService._require_open_tab(tab_id)
        item = BarTabService._item(tab_id, item_id)
        if item.get("status") == "cancelled":
            return BarTabService.detail(tab_id)
        if item.get("status") == "delivered" and not pode_admin:
            # O item já saiu do balcão: tirá-lo da conta é decisão de gerente.
            raise ErroDeNegocio(
                "item_entregue_requer_admin",
                "Item já entregue só pode ser cancelado por um administrador do bar.",
                status=403,
            )
        BarTabService._recusar_se_ficar_pago_a_mais(tab, excluir_item=item_id)
        supabase.table("bar_tab_items").update({
            "status": "cancelled", "cancelled_at": _agora(),
            "cancelled_by": auth_user_id, "cancel_reason": reason,
        }).eq("id", item_id).execute()
        return BarTabService.detail(tab_id)

    @staticmethod
    def set_courtesy(
        tab_id: str, item_id: str, data: BarItemCourtesy, auth_user_id: Optional[str] = None
    ) -> BarTabDetail:
        tab = BarTabService._require_open_tab(tab_id)
        item = BarTabService._item(tab_id, item_id)
        if item.get("status") == "cancelled":
            raise ErroDeNegocio("item_cancelado", "O item foi cancelado.", status=409)
        if data.courtesy:
            if not (data.reason or "").strip():
                raise ErroDeNegocio("motivo_obrigatorio", "Informe o motivo da cortesia.")
            BarTabService._recusar_se_ficar_pago_a_mais(tab, cortesia_item=item_id)
            mudancas = {"is_courtesy": True, "courtesy_reason": data.reason.strip()}
        else:
            mudancas = {"is_courtesy": False, "courtesy_reason": None}
        supabase.table("bar_tab_items").update(mudancas).eq("id", item_id).execute()
        return BarTabService.detail(tab_id)

    @staticmethod
    def _recusar_se_ficar_pago_a_mais(
        tab: dict, excluir_item: Optional[str] = None, cortesia_item: Optional[str] = None,
        desconto: Optional[float] = None,
    ) -> None:
        """Nunca há saldo devedor — nem para o lado do clube. Se a mudança
        deixasse `paid > total`, o gerente estorna um pagamento primeiro."""
        itens = BarTabService._itens(tab["id"])
        simulados = []
        for i in itens:
            if i["id"] == excluir_item:
                continue
            if i["id"] == cortesia_item:
                i = {**i, "is_courtesy": True}
            simulados.append(i)
        tab_simulada = dict(tab)
        if desconto is not None:
            tab_simulada["discount_amount"] = desconto
        totais = BarTabService._totais(tab_simulada, simulados, BarTabService._pagamentos(tab["id"]))
        if totais["paid_amount"] > totais["total"] + 0.005:
            raise ErroDeNegocio(
                "comanda_ficaria_paga_a_mais",
                "A comanda já recebeu mais do que ficaria devendo. Estorne um pagamento antes.",
                pago=totais["paid_amount"], total_apos=totais["total"],
            )

    # ============================================================
    # Desconto
    # ============================================================

    @staticmethod
    def set_discount(tab_id: str, data: BarTabDiscount, auth_user_id: Optional[str] = None) -> BarTabDetail:
        tab = BarTabService._require_open_tab(tab_id)
        valor = _r2(data.amount)
        totais = BarTabService._totais(tab, BarTabService._itens(tab_id), BarTabService._pagamentos(tab_id))
        if valor > 0 and not (data.reason or "").strip():
            raise ErroDeNegocio("motivo_obrigatorio", "Informe o motivo do desconto.")
        if valor > totais["subtotal"] + 0.005:
            raise ErroDeNegocio(
                "desconto_acima_do_subtotal", "O desconto não pode passar do subtotal.",
                subtotal=totais["subtotal"], solicitado=valor,
            )
        if totais["paid_amount"] > _r2(totais["subtotal"] - valor) + 0.005:
            raise ErroDeNegocio(
                "desconto_abaixo_do_pago",
                "A comanda já recebeu mais do que ficaria devendo com este desconto.",
                pago=totais["paid_amount"],
            )
        motivo = (data.reason or "").strip() or None
        supabase.table("bar_tabs").update({
            "discount_amount": valor,
            "discount_reason": motivo if valor > 0 else None,
        }).eq("id", tab_id).execute()
        return BarTabService.detail(tab_id)

    # ============================================================
    # Pagamentos
    # ============================================================

    @staticmethod
    def pay(
        tab_id: str, data: BarTabPay, auth_user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> BarTabDetail:
        cmid = data.client_mutation_id
        if cmid:
            repetido = supabase.table("bar_tab_payments").select("id") \
                .eq("client_mutation_id", f"{cmid}:0").limit(1).execute().data or []
            if repetido:
                return BarTabService.detail(tab_id)

        tab = BarTabService._require_open_tab(tab_id)
        totais = BarTabService._totais(tab, BarTabService._itens(tab_id), BarTabService._pagamentos(tab_id))

        pernas = [p for p in data.legs if _r2(p.amount) > 0]
        if not pernas:
            raise ErroDeNegocio("pagamento_vazio", "Informe ao menos uma forma de pagamento com valor.")
        solicitado = _r2(sum(_r2(p.amount) for p in pernas))
        if solicitado > totais["balance_due"] + 0.005:
            raise ErroDeNegocio(
                "pagamento_acima_do_saldo", "O pagamento excede o saldo da comanda.",
                saldo=totais["balance_due"], solicitado=solicitado,
            )

        credito_pedido = _r2(sum(_r2(p.amount) for p in pernas if p.payment_source == "credit"))
        if credito_pedido > 0:
            disponivel = _r2(PlayerCreditService.get_player_available_credit(tab["player_id"]))
            if credito_pedido > disponivel + 0.005:
                raise ErroDeNegocio(
                    "credito_insuficiente", "O jogador não tem crédito suficiente.",
                    disponivel=disponivel, solicitado=credito_pedido,
                )

        caixa = None
        if any(p.payment_source == "cash" for p in pernas):
            # Só dinheiro real exige a gaveta aberta; super-admin passa (None).
            caixa = CashboxService.require_open_cashbox_for_bar_shift(auth_user_id, tab["bar_shift_id"])

        for i, perna in enumerate(pernas):
            payload = {
                "tab_id": tab_id,
                "bar_shift_id": tab["bar_shift_id"],
                "amount": _r2(perna.amount),
                "payment_method": perna.payment_method,
                "payment_source": perna.payment_source,
                "cashbox_id": (caixa or {}).get("id") if perna.payment_source == "cash" else None,
                "status": "active",
                "notes": data.notes,
                "client_mutation_id": f"{cmid}:{i}" if cmid else None,
                "created_by": auth_user_id,
                "organization_id": organization_id or tab.get("organization_id"),
            }
            try:
                resp = supabase.table("bar_tab_payments").insert(payload).execute()
            except Exception as exc:
                if _eh_duplicidade(exc) and cmid:
                    continue  # perna já gravada numa tentativa anterior
                _traduzir_erro_do_banco(exc)
            linha = resp.data[0]

            if perna.payment_source == "credit":
                try:
                    PlayerCreditService.use_credit(
                        tab["player_id"], _r2(perna.amount), None, None, "bar", auth_user_id,
                        bar_payment_id=linha["id"],
                    )
                except Exception:
                    # O recibo sem o consumo seria um pagamento fantasma:
                    # desfaz a perna e sobe a recusa.
                    supabase.table("bar_tab_payments").delete().eq("id", linha["id"]).execute()
                    raise

        return BarTabService.detail(tab_id)

    @staticmethod
    def cancel_payment(
        tab_id: str, payment_id: str, reason: str, auth_user_id: Optional[str] = None
    ) -> BarTabDetail:
        tab = BarTabService.get_tab(tab_id)
        if tab.get("status") != "open":
            # Fechada ⇒ paga. Reabrir primeiro mantém o invariante.
            raise ErroDeNegocio(
                "comanda_fechada", "Reabra a comanda antes de estornar um pagamento.",
                status=409, status_atual=tab.get("status"),
            )
        resp = supabase.table("bar_tab_payments").select("*").eq("id", payment_id).eq("tab_id", tab_id).execute()
        if not resp.data:
            raise ErroDeNegocio("pagamento_nao_encontrado", "Pagamento não encontrado.", status=404)
        pagamento = resp.data[0]
        if pagamento.get("status") == "cancelled":
            return BarTabService.detail(tab_id)
        if pagamento.get("payment_source") == "credit":
            # Mesmo precedente do torneio (venda_com_credito_nao_estornavel):
            # devolver crédito ao jogador é tarefa futura.
            raise ErroDeNegocio(
                "pagamento_com_credito_nao_estornavel",
                "Pagamento com crédito do jogador não pode ser estornado.",
            )

        passos = list(pagamento.get("cancel_steps") or [])
        if pagamento.get("status") != "cancelling":
            supabase.table("bar_tab_payments").update({
                "status": "cancelling", "cancel_reason": reason, "cancelled_by": auth_user_id,
            }).eq("id", payment_id).execute()

        # PASSO 1 — o dinheiro sai da gaveta. Guarda pelo EFEITO (o recibo
        # existe?), nunca por marcador — a lição de cancelamento-de-venda.
        if pagamento.get("cashbox_id"):
            ja = supabase.table("cashbox_transactions").select("id") \
                .eq("bar_payment_id", payment_id).eq("type", "refund").limit(1).execute().data or []
            if not ja:
                caixa = supabase.table("cashboxes").select("current_session_id") \
                    .eq("id", pagamento["cashbox_id"]).execute()
                sessao = (caixa.data or [{}])[0].get("current_session_id")
                supabase.table("cashbox_transactions").insert({
                    "cashbox_id": pagamento["cashbox_id"],
                    "session_id": sessao,
                    "type": "refund",
                    "amount": pagamento["amount"],
                    "signed_amount": -abs(float(pagamento["amount"])),
                    "bar_payment_id": payment_id,
                    "performed_by": auth_user_id,
                    "notes": f"Estorno de comanda: {reason}",
                    "organization_id": pagamento.get("organization_id"),
                }).execute()
        if PASSO_CAIXA not in passos:
            passos.append(PASSO_CAIXA)

        # PASSO 2 — marcar, por último: enquanto não estiver 'cancelled', uma
        # retentativa refaz o que faltou.
        if PASSO_MARCAR not in passos:
            passos.append(PASSO_MARCAR)
        supabase.table("bar_tab_payments").update({
            "status": "cancelled", "cancelled_at": _agora(), "cancelled_by": auth_user_id,
            "cancel_reason": reason, "cancel_steps": passos,
        }).eq("id", payment_id).execute()
        return BarTabService.detail(tab_id)

    # ============================================================
    # Fechamento / reabertura / cancelamento
    # ============================================================

    @staticmethod
    def close_tab(tab_id: str, data: BarTabClose, auth_user_id: Optional[str] = None) -> BarTabResponse:
        tab = BarTabService.get_tab(tab_id)
        if tab.get("status") == "closed":
            return BarTabService._resposta(tab, BarTabService._itens(tab_id), BarTabService._pagamentos(tab_id),
                                           BarTabService._nomes([tab["player_id"]]))
        if tab.get("status") == "cancelled":
            raise ErroDeNegocio("comanda_cancelada", "A comanda foi cancelada.", status=409)
        BarShiftService.require_open_shift(tab["bar_shift_id"])

        itens = BarTabService._itens(tab_id)
        totais = BarTabService._totais(tab, itens, BarTabService._pagamentos(tab_id))
        if totais["balance_due"] > 0.005:
            raise ErroDeNegocio(
                "comanda_com_saldo", "A comanda ainda tem saldo a receber.",
                saldo=totais["balance_due"],
            )
        if totais["pending_count"] > 0:
            if not data.deliver_pending:
                raise ErroDeNegocio(
                    "comanda_com_pedido_pendente",
                    "Há itens ainda não entregues. Entregue-os ou marque para entregar ao fechar.",
                    status=409, pendentes=totais["pending_count"],
                )
            supabase.table("bar_tab_items").update({
                "status": "delivered", "delivered_at": _agora(), "delivered_by": auth_user_id,
            }).eq("tab_id", tab_id).eq("status", "pending").execute()

        atualizacao = {"status": "closed", "closed_at": _agora(), "closed_by": auth_user_id}
        if data.notes:
            atualizacao["notes"] = data.notes
        resp = supabase.table("bar_tabs").update(atualizacao).eq("id", tab_id).execute()
        return BarTabService._resposta(resp.data[0], BarTabService._itens(tab_id),
                                       BarTabService._pagamentos(tab_id),
                                       BarTabService._nomes([tab["player_id"]]))

    @staticmethod
    def reopen_tab(tab_id: str, auth_user_id: Optional[str] = None) -> BarTabResponse:
        tab = BarTabService.get_tab(tab_id)
        if tab.get("status") == "open":
            return BarTabService._resposta(tab, BarTabService._itens(tab_id), BarTabService._pagamentos(tab_id),
                                           BarTabService._nomes([tab["player_id"]]))
        if tab.get("status") == "cancelled":
            raise ErroDeNegocio("comanda_cancelada_nao_reabre", "Comanda cancelada não pode ser reaberta.", status=409)
        BarShiftService.require_open_shift(tab["bar_shift_id"])
        outra = BarTabService._aberta_do_jogador(tab["player_id"], tab.get("organization_id"))
        if outra and outra["id"] != tab_id:
            raise ErroDeNegocio(
                "jogador_com_comanda_aberta",
                "O jogador já tem outra comanda aberta.",
                status=409, comanda=outra["id"], numero=outra.get("number"),
            )
        try:
            resp = supabase.table("bar_tabs").update({
                "status": "open", "closed_at": None, "closed_by": None,
            }).eq("id", tab_id).execute()
        except Exception as exc:
            if _eh_duplicidade(exc):
                raise ErroDeNegocio(
                    "jogador_com_comanda_aberta", "O jogador já tem outra comanda aberta.", status=409,
                )
            _traduzir_erro_do_banco(exc)
        return BarTabService._resposta(resp.data[0], BarTabService._itens(tab_id),
                                       BarTabService._pagamentos(tab_id),
                                       BarTabService._nomes([tab["player_id"]]))

    @staticmethod
    def cancel_tab(tab_id: str, reason: str, auth_user_id: Optional[str] = None) -> BarTabResponse:
        tab = BarTabService.get_tab(tab_id)
        if tab.get("status") == "cancelled":
            return BarTabService._resposta(tab, BarTabService._itens(tab_id), BarTabService._pagamentos(tab_id),
                                           BarTabService._nomes([tab["player_id"]]))
        totais = BarTabService._totais(tab, BarTabService._itens(tab_id), BarTabService._pagamentos(tab_id))
        if totais["paid_amount"] > 0.005:
            raise ErroDeNegocio(
                "comanda_com_pagamento",
                "A comanda já recebeu pagamento. Estorne antes de cancelar.",
                status=409, pago=totais["paid_amount"],
            )
        # Itens ativos são cancelados um a um: é o UPDATE de status que faz o
        # trigger devolver o estoque.
        supabase.table("bar_tab_items").update({
            "status": "cancelled", "cancelled_at": _agora(),
            "cancelled_by": auth_user_id, "cancel_reason": reason,
        }).eq("tab_id", tab_id).neq("status", "cancelled").execute()
        resp = supabase.table("bar_tabs").update({
            "status": "cancelled", "cancelled_at": _agora(),
            "cancelled_by": auth_user_id, "cancel_reason": reason,
        }).eq("id", tab_id).execute()
        return BarTabService._resposta(resp.data[0], BarTabService._itens(tab_id),
                                       BarTabService._pagamentos(tab_id),
                                       BarTabService._nomes([tab["player_id"]]))
