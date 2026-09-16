"""Turno do bar.

O turno é a unidade que abre, fecha, é conferida e é MEDIDA — o espelho do
dia de cash (cash_day_service.py). Duas diferenças deliberadas:

1. **Sem UNIQUE (org, data).** O bar pode ter o turno da tarde e o da noite
   no mesmo dia. O que continua único é o turno ABERTO por organização.

2. **Fechar exige comandas quitadas E gavetas fechadas.** O cliente decidiu
   que comanda não vira dívida: comanda aberta bloqueia o fechamento. E a
   gaveta ancorada no turno também, porque o turno é a unidade de conferência —
   uma sessão de caixa eternamente aberta sobraria no demonstrativo.
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from app.database import supabase
from app.models.bar import (
    BarPaymentMethodTotal,
    BarShiftCreate,
    BarShiftResponse,
    BarShiftSummary,
)
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger(__name__)


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _r2(valor) -> float:
    return round(float(valor or 0), 2)


class BarShiftService:

    # ============================================================
    # Leitura
    # ============================================================

    @staticmethod
    def get_shift(bar_shift_id: str) -> dict:
        resp = supabase.table("bar_shifts").select("*").eq("id", bar_shift_id).execute()
        if not resp.data:
            # 404 também cobre "turno de outra organização": o RLS não devolve a
            # linha, e daqui isso é indistinguível de não existir.
            raise ErroDeNegocio("turno_nao_encontrado", "Turno do bar não encontrado.", status=404)
        return resp.data[0]

    @staticmethod
    def get_current(organization_id: Optional[str] = None) -> Optional[BarShiftResponse]:
        query = supabase.table("bar_shifts").select("*").eq("status", "open")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        resp = query.limit(1).execute()
        return BarShiftResponse(**resp.data[0]) if resp.data else None

    @staticmethod
    def list_shifts(
        organization_id: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 90,
    ) -> List[BarShiftResponse]:
        query = supabase.table("bar_shifts").select("*")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        if date_from:
            query = query.gte("business_date", date_from)
        if date_to:
            query = query.lte("business_date", date_to)
        if status:
            query = query.eq("status", status)
        resp = query.order("business_date", desc=True).order("opened_at", desc=True) \
            .limit(limit).execute()
        return [BarShiftResponse(**r) for r in (resp.data or [])]

    # ============================================================
    # Abertura
    # ============================================================

    @staticmethod
    def open_shift(
        data: BarShiftCreate,
        auth_user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> BarShiftResponse:
        aberto = BarShiftService.get_current(organization_id)
        if aberto:
            raise ErroDeNegocio(
                "turno_ja_aberto",
                "Já existe um turno do bar aberto. Feche-o antes de abrir outro.",
                status=409,
                bar_shift_id=aberto.id,
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
            resp = supabase.table("bar_shifts").insert(payload).execute()
        except Exception as exc:
            # Dois operadores abrindo ao mesmo tempo: o índice parcial
            # (um aberto por org) decide, e o segundo recebe o nome do erro.
            if "duplicate key" in str(exc).lower() or "23505" in str(exc):
                atual = BarShiftService.get_current(organization_id)
                raise ErroDeNegocio(
                    "turno_ja_aberto",
                    "Já existe um turno do bar aberto. Feche-o antes de abrir outro.",
                    status=409,
                    bar_shift_id=atual.id if atual else None,
                    business_date=str(atual.business_date) if atual else None,
                )
            raise
        return BarShiftResponse(**resp.data[0])

    # ============================================================
    # Números do turno
    # ============================================================

    @staticmethod
    def summary(bar_shift_id: str) -> BarShiftSummary:
        """Agrega o turno ao vivo. Depois de fechado, devolve o congelado —
        foi contra ele que a conferência foi feita."""
        turno = BarShiftService.get_shift(bar_shift_id)
        agregado = BarShiftService._agregar(bar_shift_id, turno.get("organization_id"))

        if turno.get("status") == "closed" and turno.get("total_net") is not None:
            por_metodo = turno.get("totals_by_method") or {}
            return BarShiftSummary(
                bar_shift_id=bar_shift_id,
                business_date=turno["business_date"],
                status=turno["status"],
                total_gross=_r2(turno.get("total_gross")),
                total_discounts=_r2(turno.get("total_discounts")),
                total_courtesy=_r2(turno.get("total_courtesy")),
                total_net=_r2(turno.get("total_net")),
                total_paid=_r2(turno.get("total_paid")),
                total_paid_cash=_r2(turno.get("total_paid_cash")),
                total_paid_credit=_r2(turno.get("total_paid_credit")),
                total_cogs=_r2(turno.get("total_cogs")),
                gross_margin=_r2(_r2(turno.get("total_net")) - _r2(turno.get("total_cogs"))),
                tabs_open=0,
                tabs_total=int(turno.get("tabs_count") or 0),
                items_pending=0,
                items_count=int(turno.get("items_count") or 0),
                balance_due=0.0,
                by_method=[
                    BarPaymentMethodTotal(payment_method=m, amount=_r2(v.get("amount")), count=int(v.get("count") or 0))
                    if isinstance(v, dict) else BarPaymentMethodTotal(payment_method=m, amount=_r2(v))
                    for m, v in por_metodo.items()
                ],
                low_stock_count=agregado["low_stock_count"],
            )

        return BarShiftSummary(
            bar_shift_id=bar_shift_id,
            business_date=turno["business_date"],
            status=turno.get("status", "open"),
            **agregado,
        )

    @staticmethod
    def _agregar(bar_shift_id: str, organization_id: Optional[str] = None) -> dict:
        """Soma o turno a partir das linhas. Quatro consultas, sem laço com
        query dentro."""
        comandas = supabase.table("bar_tabs").select(
            "id, status, subtotal, courtesy_amount, discount_amount, total, paid_amount"
        ).eq("bar_shift_id", bar_shift_id).execute().data or []

        bruto = desconto = cortesia = liquido = pago = saldo = 0.0
        abertas = 0
        validas = 0
        for c in comandas:
            if c.get("status") == "cancelled":
                continue  # anulada: os itens voltaram, nada foi cobrado
            validas += 1
            sub = float(c.get("subtotal") or 0)
            tot = float(c.get("total") or 0)
            pg = float(c.get("paid_amount") or 0)
            bruto += sub
            cortesia += float(c.get("courtesy_amount") or 0)
            # Desconto EFETIVO (o gravado pode exceder o subtotal; o total já
            # está limitado).
            desconto += max(sub - tot, 0)
            liquido += tot
            pago += pg
            if c.get("status") == "open":
                abertas += 1
                saldo += max(tot - pg, 0)

        itens = supabase.table("bar_tab_items").select(
            "status, quantity, unit_cost"
        ).eq("bar_shift_id", bar_shift_id).execute().data or []
        cmv = 0.0
        pendentes = 0
        qtd_itens = 0
        for i in itens:
            if i.get("status") == "cancelled":
                continue
            qtd_itens += 1
            cmv += float(i.get("unit_cost") or 0) * int(i.get("quantity") or 0)
            if i.get("status") == "pending":
                pendentes += 1

        pagamentos = supabase.table("bar_tab_payments").select(
            "amount, payment_method, payment_source, status"
        ).eq("bar_shift_id", bar_shift_id).execute().data or []
        pago_dinheiro = pago_credito = 0.0
        por_metodo: dict = {}
        for p in pagamentos:
            if (p.get("status") or "active") != "active":
                continue
            valor = float(p.get("amount") or 0)
            if p.get("payment_source") == "credit":
                pago_credito += valor
            else:
                pago_dinheiro += valor
            chave = p.get("payment_method") or "cash"
            acum = por_metodo.setdefault(chave, {"amount": 0.0, "count": 0})
            acum["amount"] += valor
            acum["count"] += 1

        # Estoque baixo é do CATÁLOGO (não do turno), mas a tela do turno é
        # onde o barman olha; import tardio evita ciclo.
        from app.services.bar_product_service import BarProductService
        try:
            baixos = len(BarProductService.low_stock(organization_id))
        except Exception:
            baixos = 0

        return {
            "total_gross": _r2(bruto),
            "total_discounts": _r2(desconto),
            "total_courtesy": _r2(cortesia),
            "total_net": _r2(liquido),
            "total_paid": _r2(pago),
            "total_paid_cash": _r2(pago_dinheiro),
            "total_paid_credit": _r2(pago_credito),
            "total_cogs": _r2(cmv),
            "gross_margin": _r2(liquido - cmv),
            "tabs_open": abertas,
            "tabs_total": validas,
            "items_pending": pendentes,
            "items_count": qtd_itens,
            "balance_due": _r2(saldo),
            "by_method": [
                BarPaymentMethodTotal(payment_method=m, amount=_r2(v["amount"]), count=v["count"])
                for m, v in sorted(por_metodo.items(), key=lambda kv: -kv[1]["amount"])
            ],
            "low_stock_count": baixos,
        }

    # ============================================================
    # Fechamento
    # ============================================================

    @staticmethod
    def close_shift(
        bar_shift_id: str,
        auth_user_id: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> BarShiftResponse:
        turno = BarShiftService.get_shift(bar_shift_id)
        if turno.get("status") == "closed":
            raise ErroDeNegocio(
                "turno_ja_fechado", "Este turno do bar já foi fechado.", status=409
            )

        abertas = supabase.table("bar_tabs").select("id, number, player_id, total, paid_amount") \
            .eq("bar_shift_id", bar_shift_id).eq("status", "open").execute().data or []
        if abertas:
            # Comanda não vira dívida (decisão do cliente): quita ou o gerente
            # dá desconto/cancela — antes de o turno fechar.
            nomes = BarShiftService._nomes_de_jogadores([c["player_id"] for c in abertas])
            raise ErroDeNegocio(
                "turno_com_comanda_aberta",
                "Há comandas abertas. Quite ou encerre todas antes de fechar o turno.",
                status=409,
                comandas=[
                    {
                        "id": c["id"],
                        "number": c.get("number"),
                        "player_name": nomes.get(c["player_id"]),
                        "balance_due": _r2(float(c.get("total") or 0) - float(c.get("paid_amount") or 0)),
                    }
                    for c in abertas
                ],
                quantidade=len(abertas),
            )

        gavetas = supabase.table("cashboxes").select("id, staff_id") \
            .eq("bar_shift_id", bar_shift_id).eq("status", "open").execute().data or []
        if gavetas:
            nomes_staff: dict = {}
            ids = [g["staff_id"] for g in gavetas if g.get("staff_id")]
            if ids:
                rows = supabase.table("staff").select("id, name").in_("id", ids).execute().data or []
                nomes_staff = {r["id"]: r.get("name") for r in rows}
            raise ErroDeNegocio(
                "turno_com_caixa_aberto",
                "Há caixas do bar abertos. Feche-os (contagem) antes de encerrar o turno.",
                status=409,
                caixas=[nomes_staff.get(g.get("staff_id")) for g in gavetas],
                quantidade=len(gavetas),
            )

        agregado = BarShiftService._agregar(bar_shift_id, turno.get("organization_id"))
        atualizacao = {
            "status": "closed",
            "closed_at": _agora(),
            "closed_by": auth_user_id,
            "total_gross": agregado["total_gross"],
            "total_discounts": agregado["total_discounts"],
            "total_courtesy": agregado["total_courtesy"],
            "total_net": agregado["total_net"],
            "total_paid": agregado["total_paid"],
            "total_paid_cash": agregado["total_paid_cash"],
            "total_paid_credit": agregado["total_paid_credit"],
            "total_cogs": agregado["total_cogs"],
            "tabs_count": agregado["tabs_total"],
            "items_count": agregado["items_count"],
            "totals_by_method": {
                m.payment_method: {"amount": m.amount, "count": m.count}
                for m in agregado["by_method"]
            },
        }
        if notes:
            atualizacao["notes"] = notes

        resp = supabase.table("bar_shifts").update(atualizacao).eq("id", bar_shift_id).execute()
        return BarShiftResponse(**resp.data[0])

    # ============================================================
    # Guarda usada por quem movimenta a comanda
    # ============================================================

    @staticmethod
    def require_open_shift(bar_shift_id: str) -> dict:
        turno = BarShiftService.get_shift(bar_shift_id)
        if turno.get("status") != "open":
            raise ErroDeNegocio(
                "turno_nao_aberto",
                "O turno do bar está fechado.",
                bar_shift_id=bar_shift_id,
            )
        return turno

    @staticmethod
    def require_current_open(organization_id: Optional[str] = None) -> dict:
        """O turno aberto AGORA — a POS não escolhe turno, ela opera no que
        está aberto."""
        atual = BarShiftService.get_current(organization_id)
        if not atual:
            raise ErroDeNegocio(
                "turno_nao_aberto",
                "Abra o turno do bar antes de operar.",
            )
        return atual.model_dump()

    @staticmethod
    def _nomes_de_jogadores(ids: List[str]) -> dict:
        ids = list({i for i in ids if i})
        if not ids:
            return {}
        rows = supabase.table("players").select("id, name").in_("id", ids).execute().data or []
        return {r["id"]: r.get("name") for r in rows}
