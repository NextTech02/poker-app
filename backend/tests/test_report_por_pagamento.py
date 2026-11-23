"""Relatórios por MEIO de pagamento: o quadro e o filtro.

O clube confere o caixa por meio (quanto em dinheiro, quanto em Yape). A regra é
a do Extrato Geral: linha sem meio é dinheiro, a venda dividida entra em cada
meio só com a parte dela, e crédito/misto/ticket são origens, não meios.
"""
from app.services import report_service as mod
from app.services.report_service import (
    ReportService, agrupar_por_meio_de_pagamento, filtrar_por_pagamento, partes_por_meio,
)

from tests.conftest import FakeSupabase

T1 = "00000000-0000-0000-0000-0000000000a1"
T2 = "00000000-0000-0000-0000-0000000000a2"


def _venda(id_, valor, metodo="cash", tipo="buy_in", player="p1", torneio=T1, **kw):
    return {"id": id_, "tournament_id": torneio, "player_id": player, "type": tipo, "amount": valor,
            "payment_method": metodo, "payment_source": "cash", "payment_split": None,
            "buy_type_id": None, "buy_type_name": None, "status": "active",
            "created_at": "2026-11-10T20:00:00Z", **kw}


def _dividida(id_, valor, partes, **kw):
    return _venda(id_, valor, "split", payment_split=[
        {"payment_method": m, "amount": v} for m, v in partes
    ], **kw)


VENDAS = [
    _venda("x1", 500, "cash", buy_type_name="Buy-in"),
    _dividida("x2", 500, [("cash", 300), ("yape", 200)], player="p2", buy_type_name="Buy-in"),
    _venda("x3", 300, "yape", tipo="rebuy", player="p2", torneio=T2, entry_count=2, buy_type_name="Doble"),
    _venda("x4", 20, None, tipo="addon", is_fee=True, buy_type_name="Bono Dealer"),
    _venda("x5", 0, "cash", payment_source="ticket", player="p3"),
    _venda("x6", 400, "yape", status="cancelled"),
]


def _fake(monkeypatch, vendas=None):
    fake = FakeSupabase({
        "transactions": [dict(v) for v in (vendas if vendas is not None else VENDAS)],
        "tournaments": [{"id": T1, "created_at": "2026-11-10T10:00:00Z"}],
        "tournament_players": [],
        "players": [{"id": "p1", "name": "Ana"}, {"id": "p2", "name": "Beto"}, {"id": "p3", "name": "Caio"}],
    })
    fake.rpcs["get_reports_totals"] = [{"total_revenue": 1320, "total_buy_ins": 3, "total_rebuys": 2,
                                        "total_addons": 0, "avg_buy_in": 333}]
    monkeypatch.setattr(mod, "supabase", fake)
    return fake


def test_a_venda_dividida_entra_em_cada_meio_com_a_sua_parte():
    assert [(k, float(v)) for k, v in partes_por_meio(VENDAS[1])] == [("meio:cash", 300.0), ("meio:yape", 200.0)]


def test_linha_sem_meio_e_dinheiro_e_ticket_e_origem():
    assert partes_por_meio(VENDAS[3])[0][0] == "meio:cash"
    assert partes_por_meio(VENDAS[4])[0][0] == "origem:ticket"


def test_o_quadro_soma_por_meio_do_maior_para_o_menor():
    linhas = agrupar_por_meio_de_pagamento(VENDAS[:5])
    assert [(x.method, x.source, x.count, x.amount) for x in linhas] == [
        ("cash", None, 3, 820.0), ("yape", None, 2, 500.0), (None, "ticket", 1, 0.0),
    ]


def test_o_filtro_deixa_so_a_parte_paga_no_meio():
    assert [(v["id"], v["amount"]) for v in filtrar_por_pagamento(VENDAS[:5], "meio:yape")] == [
        ("x2", 200.0), ("x3", 300.0),
    ]


def test_relatorio_filtrado_por_yape(monkeypatch):
    _fake(monkeypatch)
    r = ReportService.get_reports("2026-11-01", "2026-11-30", "meio:yape")
    assert r.paymentFilter == "meio:yape"
    assert r.totalRevenue == 500.0
    assert (r.totalBuyIns, r.totalRebuys, r.totalAddons, r.totalFees) == (1, 2, 0, 0)
    assert r.totalTournaments == 2
    assert [(p.player_name, p.total_spent, p.rebuys) for p in r.playerReports] == [("Beto", 500.0, 2)]
    assert [(b.name, b.amount) for b in r.byBuyType] == [("Buy-in", 200.0), ("Doble", 300.0)]
    # O quadro continua inteiro: é por ele que se troca de meio.
    assert {x.method for x in r.byPaymentMethod if x.method} == {"cash", "yape"}


def test_a_soma_dos_meios_fecha_com_o_total_do_periodo(monkeypatch):
    _fake(monkeypatch)
    total = sum(
        ReportService.get_reports("2026-11-01", "2026-11-30", f"meio:{m}").totalRevenue for m in ("cash", "yape")
    )
    assert total == 1320.0


def test_sem_filtro_nada_muda_e_o_quadro_vem(monkeypatch):
    _fake(monkeypatch)
    r = ReportService.get_reports("2026-11-01", "2026-11-30")
    assert r.paymentFilter is None
    assert r.totalRevenue == 1320
    assert len(r.byPaymentMethod) == 3


def test_filtro_desconhecido_e_ignorado_e_a_tela_sabe(monkeypatch):
    _fake(monkeypatch)
    r = ReportService.get_reports("2026-11-01", "2026-11-30", "yape")
    assert r.paymentFilter is None
    assert r.totalRevenue == 1320


def test_meio_sem_venda_vem_zerado(monkeypatch):
    _fake(monkeypatch)
    r = ReportService.get_reports("2026-11-01", "2026-11-30", "meio:plin")
    assert (r.totalRevenue, r.avgBuyIn, r.playerReports) == (0.0, 0.0, [])
