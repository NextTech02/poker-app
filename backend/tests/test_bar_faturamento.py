"""FATURAMENTO do bar: relatórios por período e o resumo para o DRE.

O que trava:

1. **Receita = comandas FECHADAS**, pela `business_date` do turno. Comanda
   aberta ainda vai mudar; cancelada não vale nada.
2. **CMV inclui cortesia** (a cerveja saiu do estoque) e é INFORMATIVO no
   DRE: entra em `bar_cogs`, não sai de `net_result` — a compra da
   mercadoria já é despesa.
3. **A receita do bar entra no bruto do DRE** nos DOIS ramos: o comum e o
   de "etapa sem torneio" (o ramo de um clube só de bar).
4. **Módulo não migrado = zeros**, nunca erro: o DRE de torneio não pode
   cair por um módulo que o clube nem tem.
"""
import pytest

from app.services import bar_report_service as rel_mod
from app.services import cash_report_service, financial_service
from app.services.bar_report_service import BarReportService as BRS
from app.services.expense_service import ExpenseService
from app.services.financial_service import FinancialService

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
T1, T2 = "t-sexta", "t-sabado"
J1, J2 = "j-ana", "j-bruno"


def _tab(id, turno, jogador, status="closed", sub=0, cort=0, desc=0, pago=None):
    total = max(sub - min(desc, sub), 0)
    return {"id": id, "bar_shift_id": turno, "player_id": jogador, "status": status,
            "subtotal": sub, "courtesy_amount": cort, "discount_amount": desc,
            "total": total, "paid_amount": total if pago is None else pago}


def _item(tab, turno, produto, nome, qtd, preco, custo, cortesia=False, status="delivered"):
    return {"tab_id": tab, "bar_shift_id": turno, "product_id": produto, "product_name": nome,
            "quantity": qtd, "unit_price": preco, "unit_cost": custo,
            "line_total": round(preco * qtd, 2), "is_courtesy": cortesia, "status": status}


def _pag(tab, turno, valor, metodo="pix", fonte="cash", status="active"):
    return {"tab_id": tab, "bar_shift_id": turno, "amount": valor, "payment_method": metodo,
            "payment_source": fonte, "status": status}


def _banco(monkeypatch, **extra):
    base = {
        "bar_shifts": [
            {"id": T1, "organization_id": ORG, "business_date": "2026-09-18", "status": "closed"},
            {"id": T2, "organization_id": ORG, "business_date": "2026-09-19", "status": "open"},
            {"id": "t-fora", "organization_id": ORG, "business_date": "2026-08-01", "status": "closed"},
        ],
        "bar_tabs": [
            _tab("c1", T1, J1, sub=50),                       # A: 2 cervejas + porção
            _tab("c2", T1, J2, sub=5, desc=5),                # B: saiu sem pagar (desconto 100%)
            _tab("c3", T1, J1, sub=20),                       # C
            _tab("c4", T2, J2, status="open", sub=30, pago=0),  # aberta: fora
            _tab("c5", T2, J1, status="cancelled", sub=99),   # cancelada: fora
            _tab("c6", T2, J2, sub=10, cort=5),               # D no sábado, com uma água de cortesia
        ],
        "bar_tab_items": [
            _item("c1", T1, "p-cerveja", "Cerveja", 2, 10, 4),
            _item("c1", T1, "p-porcao", "Porção", 1, 30, 12),
            _item("c2", T1, "p-agua", "Água", 1, 5, 1.5),
            _item("c3", T1, "p-cerveja", "Cerveja", 2, 10, 4),
            _item("c3", T1, "p-cerveja", "Cerveja", 1, 10, 4, status="cancelled"),
            _item("c4", T2, "p-porcao", "Porção", 1, 30, 12),
            _item("c6", T2, "p-cerveja", "Cerveja", 1, 10, 4),
            _item("c6", T2, "p-agua", "Água", 1, 5, 1.5, cortesia=True),
        ],
        "bar_tab_payments": [
            _pag("c1", T1, 20, "pix"), _pag("c1", T1, 15, "credit", "credit"), _pag("c1", T1, 15, "cash"),
            _pag("c3", T1, 20, "cash"), _pag("c3", T1, 20, "cash", status="cancelled"),   # o estornado não conta
            _pag("c6", T2, 10, "cash"),
        ],
        "bar_products": [
            {"id": "p-cerveja", "category_id": "cat-cerv"}, {"id": "p-porcao", "category_id": None},
            {"id": "p-agua", "category_id": "cat-beb"},
        ],
        "bar_product_categories": [{"id": "cat-cerv", "name": "Cervejas"}, {"id": "cat-beb", "name": "Bebidas"}],
        "players": [{"id": J1, "name": "Ana"}, {"id": J2, "name": "Bruno"}],
    }
    base.update(extra)
    fake = FakeSupabase(base)
    monkeypatch.setattr(rel_mod, "supabase", fake)
    return fake


# ══════════════════════════════════════════════════════════════════════
# Por dia
# ══════════════════════════════════════════════════════════════════════

def test_serie_diaria_conta_so_comandas_fechadas_do_periodo(monkeypatch):
    _banco(monkeypatch)
    dias = {str(d.business_date): d for d in BRS.daily(ORG, "2026-09-18", "2026-09-19")}
    assert list(dias) == ["2026-09-18", "2026-09-19"]        # agosto ficou fora
    sexta = dias["2026-09-18"]
    assert sexta.tabs == 3 and sexta.gross == 75 and sexta.discounts == 5 and sexta.net == 70
    assert sexta.paid_cash == 55 and sexta.paid_credit == 15   # o cancelado não conta
    # CMV: A (2×4 + 12) + B (1,5) + C (2×4; o item cancelado não) = 29,5
    assert sexta.cogs == 29.5 and sexta.margin == 40.5
    sabado = dias["2026-09-19"]
    assert sabado.tabs == 1 and sabado.net == 10          # a aberta e a cancelada ficam fora
    assert sabado.courtesy == 5 and sabado.cogs == 5.5    # a cortesia custou 1,5


def test_resumo_soma_o_periodo_e_calcula_ticket_medio(monkeypatch):
    _banco(monkeypatch)
    r = BRS.summary(ORG, "2026-09-18", "2026-09-19")
    assert r.shifts == 2 and r.tabs == 4 and r.net == 80 and r.gross == 85
    assert r.cogs == 35 and r.margin == 45
    assert r.average_tab == 20
    assert {m.payment_method: m.amount for m in r.by_method} == {"pix": 20, "credit": 15, "cash": 45}
    assert r.top_products[0].product_name == "Cerveja" and r.top_products[0].quantity == 5
    assert str(r.date_from) == "2026-09-18"


def test_por_produto_separa_cortesia_e_traz_a_categoria(monkeypatch):
    _banco(monkeypatch)
    por_nome = {p.product_name: p for p in BRS.products(ORG, "2026-09-18", "2026-09-19")}
    cerveja = por_nome["Cerveja"]
    assert cerveja.quantity == 5 and cerveja.revenue == 50 and cerveja.cogs == 20 and cerveja.margin == 30
    assert cerveja.category_name == "Cervejas"
    agua = por_nome["Água"]
    assert agua.quantity == 1 and agua.courtesy_quantity == 1
    assert agua.revenue == 5 and agua.cogs == 3.0           # as duas custaram
    assert "Porção" in por_nome and por_nome["Porção"].category_name is None


def test_por_jogador(monkeypatch):
    _banco(monkeypatch)
    por_nome = {p.player_name: p for p in BRS.players(ORG, "2026-09-18", "2026-09-19")}
    assert por_nome["Ana"].tabs == 2 and por_nome["Ana"].spent == 70 and por_nome["Ana"].items == 3
    assert por_nome["Bruno"].tabs == 2 and por_nome["Bruno"].spent == 10


# ══════════════════════════════════════════════════════════════════════
# DRE
# ══════════════════════════════════════════════════════════════════════

def test_resumo_para_o_dre(monkeypatch):
    _banco(monkeypatch)
    r = BRS.summarize(ORG, "2026-09-18", "2026-09-19")
    assert r == {
        "bar_revenue": 80.0, "bar_gross": 85.0, "bar_discounts": 10.0,   # 5 desconto + 5 cortesia
        "bar_cogs": 35.0, "bar_gross_margin": 45.0, "bar_tabs_count": 4, "bar_shifts_count": 2,
    }


def test_modulo_nao_migrado_devolve_zeros(monkeypatch):
    class BancoSemBar:
        def table(self, nome):
            raise RuntimeError('relation "bar_shifts" does not exist')

    monkeypatch.setattr(rel_mod, "supabase", BancoSemBar())
    r = BRS.summarize(ORG, "2026-09-01", "2026-09-30")
    assert r["bar_revenue"] == 0 and r["bar_tabs_count"] == 0


def _dre(monkeypatch, fake):
    monkeypatch.setattr(financial_service, "supabase", fake)
    monkeypatch.setattr(cash_report_service, "supabase", fake)
    monkeypatch.setattr(ExpenseService, "summarize", staticmethod(
        lambda *a, **k: {"total": 100.0, "paid": 100.0, "pending": 0.0, "by_category": []}))
    monkeypatch.setattr(ExpenseService, "summarize_revenues", staticmethod(
        lambda *a, **k: {"total": 0.0, "received": 0.0, "pending": 0.0, "by_source": []}))
    monkeypatch.setattr(ExpenseService, "guarantee_committed", staticmethod(lambda *a, **k: 0.0))


def test_dre_de_clube_so_de_bar_soma_o_bar_no_bruto(monkeypatch):
    """Etapa sem torneio = o ramo de saída antecipada. Um clube só de bar cai
    SEMPRE aqui; sem o bar nesse ramo o DRE dele mostraria zero para sempre."""
    fake = _banco(monkeypatch, transactions=[], tournaments=[], prize_allocations=[],
                  satellite_tickets=[], player_credits=[], cash_days=[])
    _dre(monkeypatch, fake)
    resumo = FinancialService.get_financial_summary(stage_id="etapa-vazia", organization_id=ORG,
                                                    start_date="2026-09-18", end_date="2026-09-19")
    assert resumo.bar_revenue == 80 and resumo.gross_revenue == 80
    assert resumo.bar_cogs == 35
    # CMV informativo: NÃO sai do resultado (a compra já é despesa).
    assert resumo.net_result == 80 - 100


def test_dre_comum_soma_o_bar_ao_torneio(monkeypatch):
    fake = _banco(monkeypatch,
                  transactions=[{"id": "tx1", "type": "buy_in", "amount": 200, "status": "active",
                                 "tournament_id": "tour-1", "player_id": J1, "created_at": "2026-09-18T20:00:00Z",
                                 "players": {"name": "Ana"}, "tournaments": {"name": "Torneio"}}],
                  tournaments=[{"id": "tour-1", "stage_id": "etapa-1", "name": "Torneio"}],
                  prize_allocations=[], satellite_tickets=[], player_credits=[], cash_days=[])
    _dre(monkeypatch, fake)
    resumo = FinancialService.get_financial_summary(stage_id="etapa-1", organization_id=ORG,
                                                    start_date="2026-09-18", end_date="2026-09-19")
    assert resumo.revenue.total == 200
    assert resumo.bar_revenue == 80
    assert resumo.gross_revenue == 280
    assert resumo.rake == 0                       # o rake NÃO recebe bar
    assert resumo.net_result == 280 - 100
