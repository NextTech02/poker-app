"""Relatórios do bar e o resumo para o DRE.

Tudo por PERÍODO, agrupado pela `business_date` do turno — a data que o
barman escolheu na abertura, nunca `created_at`. Uma noite que atravessa a
meia-noite é um turno só, e é assim que "quanto o bar rendeu na sexta?" tem
resposta certa.

NÚMEROS QUE NÃO SE MISTURAM:
  - `net` (receita): Σ total das comandas fechadas — o que o jogador devia,
    depois do desconto. Comanda só fecha quitada, então `net == paid`.
  - `paid_cash` / `paid_credit`: como entrou. Só o `paid_cash` passou pela
    gaveta; o crédito é cobrado do patrocinador.
  - `cogs` (CMV): Σ custo × quantidade dos itens ativos, CORTESIA INCLUSA
    (a cerveja saiu do estoque). É INFORMATIVO no DRE: a compra da
    mercadoria já entra como despesa, e subtrair o CMV também contaria duas
    vezes — mesmo princípio de `guarantee_committed`. A margem vive aqui.
"""
import logging
from collections import defaultdict
from typing import Dict, List, Optional

from app.database import supabase
from app.models.bar import (
    BarDailyRow,
    BarPaymentMethodTotal,
    BarPlayerRow,
    BarProductRow,
    BarReportSummary,
)

logger = logging.getLogger(__name__)


def _r2(valor) -> float:
    return round(float(valor or 0), 2)


class BarReportService:

    # ============================================================
    # Leitura bruta do período
    # ============================================================

    @staticmethod
    def _modulo_migrado() -> bool:
        """As tabelas do bar existem? O deploy do código precede o da
        migração; sem a guarda, o DRE de um clube só de torneio cairia."""
        try:
            supabase.table("bar_shifts").select("id").limit(1).execute()
            return True
        except Exception:
            logger.warning("bar_shifts indisponível; o DRE segue sem os números do bar")
            return False

    @staticmethod
    def _turnos(organization_id: Optional[str], date_from: Optional[str], date_to: Optional[str]) -> List[dict]:
        q = supabase.table("bar_shifts").select("id, business_date, status")
        if organization_id:
            q = q.eq("organization_id", organization_id)
        if date_from:
            q = q.gte("business_date", str(date_from)[:10])
        if date_to:
            q = q.lte("business_date", str(date_to)[:10])
        return q.order("business_date").execute().data or []

    @staticmethod
    def _carregar(organization_id: Optional[str], date_from: Optional[str], date_to: Optional[str]) -> dict:
        turnos = BarReportService._turnos(organization_id, date_from, date_to)
        ids = [t["id"] for t in turnos]
        if not ids:
            return {"turnos": [], "tabs": [], "itens": [], "pagamentos": []}
        tabs = supabase.table("bar_tabs").select(
            "id, bar_shift_id, player_id, status, subtotal, courtesy_amount, discount_amount, total, paid_amount"
        ).in_("bar_shift_id", ids).execute().data or []
        itens = supabase.table("bar_tab_items").select(
            "tab_id, bar_shift_id, product_id, product_name, quantity, unit_price, unit_cost, line_total, is_courtesy, status"
        ).in_("bar_shift_id", ids).execute().data or []
        pagamentos = supabase.table("bar_tab_payments").select(
            "tab_id, bar_shift_id, amount, payment_method, payment_source, status"
        ).in_("bar_shift_id", ids).execute().data or []
        return {"turnos": turnos, "tabs": tabs, "itens": itens, "pagamentos": pagamentos}

    @staticmethod
    def _por_dia(dados: dict) -> List[dict]:
        data_do_turno = {t["id"]: str(t["business_date"]) for t in dados["turnos"]}
        dias: Dict[str, dict] = {}

        def dia(chave):
            if chave not in dias:
                dias[chave] = {"business_date": chave, "shifts": set(), "tabs": 0, "items": 0,
                               "gross": 0.0, "discounts": 0.0, "courtesy": 0.0, "net": 0.0,
                               "paid": 0.0, "paid_cash": 0.0, "paid_credit": 0.0, "cogs": 0.0}
            return dias[chave]

        for t in dados["turnos"]:
            dia(str(t["business_date"]))["shifts"].add(t["id"])

        # Receita = comandas FECHADAS (as abertas ainda vão mudar; as canceladas
        # não valem nada).
        tabs_validas = set()
        for c in dados["tabs"]:
            if c.get("status") != "closed":
                continue
            tabs_validas.add(c["id"])
            d = dia(data_do_turno.get(c["bar_shift_id"], ""))
            sub = float(c.get("subtotal") or 0)
            tot = float(c.get("total") or 0)
            d["tabs"] += 1
            d["gross"] += sub
            d["discounts"] += max(sub - tot, 0)
            d["courtesy"] += float(c.get("courtesy_amount") or 0)
            d["net"] += tot
            d["paid"] += float(c.get("paid_amount") or 0)

        for i in dados["itens"]:
            if i.get("status") == "cancelled" or i["tab_id"] not in tabs_validas:
                continue
            d = dia(data_do_turno.get(i["bar_shift_id"], ""))
            d["items"] += 1
            d["cogs"] += float(i.get("unit_cost") or 0) * int(i.get("quantity") or 0)

        for p in dados["pagamentos"]:
            if (p.get("status") or "active") != "active" or p["tab_id"] not in tabs_validas:
                continue
            d = dia(data_do_turno.get(p["bar_shift_id"], ""))
            if p.get("payment_source") == "credit":
                d["paid_credit"] += float(p.get("amount") or 0)
            else:
                d["paid_cash"] += float(p.get("amount") or 0)

        saida = []
        for chave in sorted(dias):
            d = dias[chave]
            saida.append({
                "business_date": chave,
                "shifts": len(d["shifts"]),
                "tabs": d["tabs"],
                "items": d["items"],
                "gross": _r2(d["gross"]),
                "discounts": _r2(d["discounts"]),
                "courtesy": _r2(d["courtesy"]),
                "net": _r2(d["net"]),
                "paid": _r2(d["paid"]),
                "paid_cash": _r2(d["paid_cash"]),
                "paid_credit": _r2(d["paid_credit"]),
                "cogs": _r2(d["cogs"]),
                "margin": _r2(d["net"] - d["cogs"]),
            })
        return saida

    # ============================================================
    # Relatórios
    # ============================================================

    @staticmethod
    def daily(organization_id: Optional[str], date_from: Optional[str], date_to: Optional[str]) -> List[BarDailyRow]:
        dados = BarReportService._carregar(organization_id, date_from, date_to)
        return [BarDailyRow(**l) for l in BarReportService._por_dia(dados)]

    @staticmethod
    def products(organization_id: Optional[str], date_from: Optional[str], date_to: Optional[str],
                 limit: int = 50) -> List[BarProductRow]:
        dados = BarReportService._carregar(organization_id, date_from, date_to)
        fechadas = {c["id"] for c in dados["tabs"] if c.get("status") == "closed"}
        acum: Dict[str, dict] = {}
        for i in dados["itens"]:
            if i.get("status") == "cancelled" or i["tab_id"] not in fechadas:
                continue
            a = acum.setdefault(i["product_id"], {"product_id": i["product_id"], "product_name": i.get("product_name"),
                                                  "quantity": 0, "courtesy_quantity": 0, "revenue": 0.0, "cogs": 0.0})
            qtd = int(i.get("quantity") or 0)
            if i.get("is_courtesy"):
                a["courtesy_quantity"] += qtd
            else:
                a["quantity"] += qtd
                a["revenue"] += float(i.get("line_total") or 0)
            a["cogs"] += float(i.get("unit_cost") or 0) * qtd

        nomes_cat: Dict[str, Optional[str]] = {}
        if acum:
            prods = supabase.table("bar_products").select("id, category_id") \
                .in_("id", list(acum.keys())).execute().data or []
            cat_ids = list({p["category_id"] for p in prods if p.get("category_id")})
            cats = {}
            if cat_ids:
                rows = supabase.table("bar_product_categories").select("id, name").in_("id", cat_ids).execute().data or []
                cats = {r["id"]: r.get("name") for r in rows}
            nomes_cat = {p["id"]: cats.get(p.get("category_id")) for p in prods}

        linhas = [
            BarProductRow(
                product_id=a["product_id"], product_name=a["product_name"] or "",
                category_name=nomes_cat.get(a["product_id"]),
                quantity=a["quantity"], courtesy_quantity=a["courtesy_quantity"],
                revenue=_r2(a["revenue"]), cogs=_r2(a["cogs"]), margin=_r2(a["revenue"] - a["cogs"]),
            )
            for a in acum.values()
        ]
        linhas.sort(key=lambda l: (-l.revenue, -l.quantity))
        return linhas[:limit]

    @staticmethod
    def players(organization_id: Optional[str], date_from: Optional[str], date_to: Optional[str],
                limit: int = 50) -> List[BarPlayerRow]:
        dados = BarReportService._carregar(organization_id, date_from, date_to)
        acum: Dict[str, dict] = {}
        fechadas = {}
        for c in dados["tabs"]:
            if c.get("status") != "closed":
                continue
            fechadas[c["id"]] = c["player_id"]
            a = acum.setdefault(c["player_id"], {"tabs": 0, "items": 0, "spent": 0.0})
            a["tabs"] += 1
            a["spent"] += float(c.get("total") or 0)
        for i in dados["itens"]:
            if i.get("status") == "cancelled" or i["tab_id"] not in fechadas:
                continue
            acum[fechadas[i["tab_id"]]]["items"] += 1
        nomes = {}
        if acum:
            rows = supabase.table("players").select("id, name").in_("id", list(acum.keys())).execute().data or []
            nomes = {r["id"]: r.get("name") for r in rows}
        linhas = [
            BarPlayerRow(player_id=pid, player_name=nomes.get(pid), tabs=a["tabs"], items=a["items"], spent=_r2(a["spent"]))
            for pid, a in acum.items()
        ]
        linhas.sort(key=lambda l: -l.spent)
        return linhas[:limit]

    @staticmethod
    def summary(organization_id: Optional[str], date_from: Optional[str], date_to: Optional[str]) -> BarReportSummary:
        dados = BarReportService._carregar(organization_id, date_from, date_to)
        dias = BarReportService._por_dia(dados)
        fechadas = {c["id"] for c in dados["tabs"] if c.get("status") == "closed"}

        por_metodo: Dict[str, dict] = defaultdict(lambda: {"amount": 0.0, "count": 0})
        for p in dados["pagamentos"]:
            if (p.get("status") or "active") != "active" or p["tab_id"] not in fechadas:
                continue
            m = por_metodo[p.get("payment_method") or "cash"]
            m["amount"] += float(p.get("amount") or 0)
            m["count"] += 1

        soma = {k: _r2(sum(d[k] for d in dias)) for k in
                ("gross", "discounts", "courtesy", "net", "paid", "paid_cash", "paid_credit", "cogs")}
        tabs = sum(d["tabs"] for d in dias)
        return BarReportSummary(
            date_from=str(date_from)[:10] if date_from else None,
            date_to=str(date_to)[:10] if date_to else None,
            shifts=len(dados["turnos"]), tabs=tabs, items=sum(d["items"] for d in dias),
            **soma,
            margin=_r2(soma["net"] - soma["cogs"]),
            average_tab=_r2(soma["net"] / tabs) if tabs else 0.0,
            by_method=[
                BarPaymentMethodTotal(payment_method=k, amount=_r2(v["amount"]), count=v["count"])
                for k, v in sorted(por_metodo.items(), key=lambda kv: -kv[1]["amount"])
            ],
            daily=[BarDailyRow(**d) for d in dias],
            top_products=BarReportService.products(organization_id, date_from, date_to, limit=10),
        )

    # ============================================================
    # Para o DRE
    # ============================================================

    @staticmethod
    def summarize(
        organization_id: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> dict:
        """Os números do bar no período, prontos para o DRE (chaves = campos de
        FinancialSummary). Zeros quando o módulo não está migrado ou a consulta
        falha: o DRE de torneio não pode cair por causa de um módulo que este
        clube talvez nem tenha."""
        zero = {"bar_revenue": 0.0, "bar_gross": 0.0, "bar_discounts": 0.0, "bar_cogs": 0.0,
                "bar_gross_margin": 0.0, "bar_tabs_count": 0, "bar_shifts_count": 0}
        try:
            if not BarReportService._modulo_migrado():
                return zero
            dados = BarReportService._carregar(organization_id, date_from, date_to)
            dias = BarReportService._por_dia(dados)
        except Exception:
            logger.warning("resumo do bar indisponível; o DRE segue sem ele")
            return zero
        net = _r2(sum(d["net"] for d in dias))
        cogs = _r2(sum(d["cogs"] for d in dias))
        return {
            "bar_revenue": net,
            "bar_gross": _r2(sum(d["gross"] for d in dias)),
            "bar_discounts": _r2(sum(d["discounts"] + d["courtesy"] for d in dias)),
            "bar_cogs": cogs,
            "bar_gross_margin": _r2(net - cogs),
            "bar_tabs_count": sum(d["tabs"] for d in dias),
            "bar_shifts_count": len(dados["turnos"]),
        }
