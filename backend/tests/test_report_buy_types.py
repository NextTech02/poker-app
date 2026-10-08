"""Relatórios por MEIO de entrada.

O diretor cadastra os meios do torneio ("Buy-in", "Doble", "Rebuy", "Tasa"…)
e os relatórios só mostravam as três categorias fixas. Agora o relatório do
torneio (por torneio e por dia) e o resumo do período trazem as vendas por
meio — pelo nome gravado NA VENDA (o da época), com a venda antiga sem meio
caindo no rótulo da categoria, e sem as canceladas.
"""
from types import SimpleNamespace

from app.services import report_service as mod
from app.services.report_service import ReportService, agrupar_vendas_por_meio
from app.services.prize_allocation_service import PrizeAllocationService as PAS

from tests.conftest import FakeSupabase

TOUR = "00000000-0000-0000-0000-0000000000a1"
D1 = "00000000-0000-0000-0000-0000000000b1"
D2 = "00000000-0000-0000-0000-0000000000b2"
BT_BUYIN = "bt-buyin"
BT_DOBLE = "bt-doble"
BT_REBUY = "bt-rebuy"


def _venda(id_, tp, tipo, bid, nome, valor, player="p1", status="active"):
    return {"id": id_, "tournament_id": TOUR, "tournament_player_id": tp, "player_id": player,
            "type": tipo, "amount": valor, "buy_type_id": bid, "buy_type_name": nome,
            "status": status, "created_at": "2026-10-08T20:00:00Z"}


def _tabelas():
    return {
        "tournaments": [{"id": TOUR, "name": "Main", "guaranteed_prize": 0, "status": "active",
                         "created_at": "2026-10-08T10:00:00Z"}],
        "tournament_days": [
            {"id": D1, "tournament_id": TOUR, "day_name": "Dia 1A", "day_type": "regular", "status": "completed", "buy_in": 50, "created_at": "2026-10-08T10:00:00Z"},
            {"id": D2, "tournament_id": TOUR, "day_name": "Dia 1B", "day_type": "regular", "status": "active", "buy_in": 50, "created_at": "2026-10-08T11:00:00Z"},
        ],
        "tournament_players": [
            {"id": "tp1", "tournament_day_id": D1, "tournament_id": TOUR, "player_id": "p1", "status": "active",
             "buy_in_count": 1, "rebuy_count": 1, "addon_count": 0, "total_buy_in_amount": 50, "total_rebuy_amount": 20,
             "total_addon_amount": 0, "total_spent": 70, "players": {"name": "Ana"}},
            {"id": "tp2", "tournament_day_id": D2, "tournament_id": TOUR, "player_id": "p2", "status": "active",
             "buy_in_count": 1, "rebuy_count": 0, "addon_count": 0, "total_buy_in_amount": 30, "total_rebuy_amount": 0,
             "total_addon_amount": 0, "total_spent": 30, "players": {"name": "Beto"}},
        ],
        "transactions": [
            _venda("x1", "tp1", "buy_in", BT_BUYIN, "Buy-in", 50),
            _venda("x2", "tp1", "rebuy", BT_REBUY, "Rebuy", 20),
            _venda("x3", "tp2", "buy_in", BT_DOBLE, "Doble", 30, player="p2"),
            _venda("x4", "tp2", "buy_in", BT_DOBLE, "Doble", 30, player="p2", status="cancelled"),
            _venda("x5", "tp1", "addon", None, None, 25),            # venda antiga, sem meio
            {"id": "x6", "tournament_id": TOUR, "tournament_player_id": "tp1", "player_id": "p1",
             "type": "prize", "amount": 500, "status": "active", "created_at": "2026-10-08T23:00:00Z"},
        ],
        "buy_types": [
            {"id": BT_DOBLE, "tournament_id": TOUR, "sort_order": 2},
            {"id": BT_BUYIN, "tournament_id": TOUR, "sort_order": 1},
            {"id": BT_REBUY, "tournament_id": TOUR, "sort_order": 3},
        ],
        "prize_allocations": [],
    }


def _resumo_de_premiacao(tid):
    return SimpleNamespace(
        rake_percentage=20, total_entries=125, player_pool=100, guaranteed_prize=0,
        available_prize_pool=100, reserved_prize_percentage=0, reserved_purpose=None,
        reserved_amount=0, payable_pool=100, total_allocated=0,
    )


def test_agrupa_por_meio_pelo_nome_da_venda_na_ordem_do_caixa():
    linhas = [
        {"type": "rebuy", "amount": 20, "buy_type_id": BT_REBUY, "buy_type_name": "Rebuy"},
        {"type": "buy_in", "amount": 30, "buy_type_id": BT_DOBLE, "buy_type_name": "Doble"},
        {"type": "buy_in", "amount": 50, "buy_type_id": BT_BUYIN, "buy_type_name": "Buy-in"},
        {"type": "buy_in", "amount": 30, "buy_type_id": BT_DOBLE, "buy_type_name": "Doble"},
        {"type": "addon", "amount": 25, "buy_type_id": None, "buy_type_name": None},
    ]
    g = agrupar_vendas_por_meio(linhas, {BT_BUYIN: 1, BT_DOBLE: 2, BT_REBUY: 3})
    assert [(r.name, r.category, r.count, r.amount) for r in g] == [
        ("Buy-in", "buy_in", 1, 50.0), ("Doble", "buy_in", 2, 60.0),
        ("Rebuy", "rebuy", 1, 20.0), ("Add-on", "addon", 1, 25.0),
    ]


def test_relatorio_do_torneio_traz_os_meios_por_torneio_e_por_dia(monkeypatch, stub):
    monkeypatch.setattr(mod, "supabase", FakeSupabase(_tabelas()))
    stub(PAS, get_prize_summary=_resumo_de_premiacao)
    r = ReportService.get_tournament_report(TOUR)
    # Torneio: cancelada fora; prêmio não é venda; venda antiga vira "Add-on".
    assert [(b.name, b.count, b.amount) for b in r.by_buy_type] == [
        ("Buy-in", 1, 50.0), ("Doble", 1, 30.0), ("Rebuy", 1, 20.0), ("Add-on", 1, 25.0),
    ]
    por_dia = {d.day_name: [(b.name, b.count) for b in d.by_buy_type] for d in r.days}
    assert por_dia == {
        "Dia 1A": [("Buy-in", 1), ("Rebuy", 1), ("Add-on", 1)],
        "Dia 1B": [("Doble", 1)],
    }
    # Os totais antigos continuam de pé.
    assert r.total_buy_ins == 2 and r.total_rebuys == 1


def test_resumo_do_periodo_traz_os_meios_e_por_jogador(monkeypatch):
    fake = FakeSupabase(_tabelas())
    fake.rpcs["get_reports_totals"] = [{"total_revenue": 125, "total_buy_ins": 2, "total_rebuys": 1,
                                        "total_addons": 1, "avg_buy_in": 40}]
    monkeypatch.setattr(mod, "supabase", fake)
    r = ReportService.get_reports()
    assert [(b.name, b.count) for b in r.byBuyType] == [("Buy-in", 1), ("Doble", 1), ("Rebuy", 1), ("Add-on", 1)]
    por_jogador = {p.player_name: p.by_buy_type for p in r.playerReports}
    assert por_jogador["Ana"] == {"Buy-in": 1, "Rebuy": 1, "Add-on": 1}
    assert por_jogador["Beto"] == {"Doble": 1}


def test_sem_vendas_as_listas_vem_vazias(monkeypatch):
    tabelas = _tabelas()
    tabelas["transactions"] = []
    fake = FakeSupabase(tabelas)
    fake.rpcs["get_reports_totals"] = [{"total_revenue": 0, "total_buy_ins": 0, "total_rebuys": 0,
                                        "total_addons": 0, "avg_buy_in": 0}]
    monkeypatch.setattr(mod, "supabase", fake)
    r = ReportService.get_reports()
    assert r.byBuyType == []
    assert all(p.by_buy_type == {} for p in r.playerReports)
