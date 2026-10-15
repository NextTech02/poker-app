"""Meio de entrada da categoria TAXA ('fee').

Os "Bono Dealer" eram add-on com rake 100%: o dinheiro dava certo, mas a
venda contava como ADD-ON no jogador, no relatório, no DRE e na fidelidade.
A taxa vende pelo mesmo caminho do add-on (o dinheiro não muda: caixa, pool,
sangria e estorno seguem iguais) e conta à parte, com fichas e rake próprios.
"""
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.models.buy_type import BuyTypeItem
from app.services import report_service as rep
from app.services import transaction_service as txs
from app.services.financial_service import FinancialService
from app.services.report_service import ReportService, agrupar_vendas_por_meio, categoria_da_venda
from app.services.tournament_player_service import TournamentPlayerService
from app.services.transaction_service import TransactionService
from app.services.prize_allocation_service import PrizeAllocationService as PAS

from tests.conftest import FakeSupabase
from tests.test_tournament_players import TOUR, TP, TestRebuyEAddon
from tests.test_financial import STAGE, ORG, _entrada, _monta as _monta_dre
from tests.test_report_buy_types import TOUR as TOUR_REPORT

BONO = {
    "id": "bt-bono", "tournament_id": TOUR, "name": "Bono Dealer", "category": "fee",
    "amount": 50, "rake_percentage": 100, "chips": 10000, "active": True,
}


class TestVendaDeTaxa:
    def _com_bono(self, monkeypatch, **meio):
        fake = TestRebuyEAddon._com_jogador(self, monkeypatch)
        fake.store["buy_types"].append({**BONO, **meio})
        return fake

    def test_conta_como_taxa_nao_como_add_on(self, monkeypatch):
        fake = self._com_bono(monkeypatch)
        TournamentPlayerService.add_addon(TP, "u1", buy_type_id="bt-bono")
        inscrito = fake.store["tournament_players"][0]
        assert inscrito["fee_count"] == 1
        assert float(inscrito["total_fee_amount"]) == 50.0
        assert inscrito["addon_count"] == 0
        assert float(inscrito["total_addon_amount"]) == 0.0
        # As fichas do meio entram na pilha, como os Bonos de hoje.
        assert inscrito["total_chips"] == 20000

    def test_a_venda_e_addon_marcada_como_taxa(self, monkeypatch):
        """O type continua 'addon': caixa, pool, sangria e estorno não mudam."""
        fake = self._com_bono(monkeypatch)
        TournamentPlayerService.add_addon(TP, "u1", buy_type_id="bt-bono")
        [venda] = fake.store["transactions"]
        assert venda["type"] == "addon"
        assert venda["is_fee"] is True
        assert venda["buy_type_name"] == "Bono Dealer"
        assert float(venda["amount"]) == 50.0
        assert float(venda["rake_amount"]) == 50.0
        assert venda["chips"] == 10000
        assert venda["bounty_amount"] == 0.0

    def test_rake_configuravel_como_os_outros_meios(self, monkeypatch):
        fake = self._com_bono(monkeypatch, rake_percentage=40, chips=0)
        TournamentPlayerService.add_addon(TP, "u1", buy_type_id="bt-bono")
        [venda] = fake.store["transactions"]
        assert float(venda["rake_amount"]) == 20.0
        assert fake.store["tournament_players"][0]["total_chips"] == 10000  # 0 fichas

    def test_taxa_nao_tem_parte_ko(self, monkeypatch):
        fake = self._com_bono(monkeypatch, rake_percentage=0)
        fake.store["tournaments"][0].update({"ko_format": "pko", "ko_percentage": 40, "ko_cash_share": 50})
        TournamentPlayerService.add_addon(TP, "u1", buy_type_id="bt-bono")
        assert fake.store["transactions"][0]["bounty_amount"] == 0.0

    def test_add_on_comum_nao_leva_a_marca(self, monkeypatch):
        """Venda comum não depende da coluna nova (deploy antes da migração)."""
        fake = TestRebuyEAddon._com_jogador(self, monkeypatch)
        TournamentPlayerService.add_addon(TP, "u1")
        assert "is_fee" not in fake.store["transactions"][0]
        assert fake.store["tournament_players"][0]["addon_count"] == 1


class TestCadastro:
    def test_categoria_taxa_e_aceita(self):
        meio = BuyTypeItem(name="Bono Dealer", category="fee", amount=50, rake_percentage=100, chips=10000)
        assert meio.category == "fee"

    def test_categoria_desconhecida_e_recusada(self):
        with pytest.raises(ValidationError):
            BuyTypeItem(name="X", category="bono", amount=50)


class TestEstornoNaMao:
    def test_estorno_de_taxa_devolve_os_contadores_de_taxa(self, monkeypatch):
        tp = {"id": TP, "tournament_id": TOUR, "fee_count": 2, "total_fee_amount": 100,
              "addon_count": 1, "total_addon_amount": 70, "total_chips": 40000,
              "total_buy_in_amount": 100, "total_rebuy_amount": 0}
        fake = FakeSupabase({"tournament_players": [dict(tp)], "transaction_counter_refunds": []})
        monkeypatch.setattr(txs, "supabase", fake)
        tx = {"id": "x1", "type": "addon", "is_fee": True, "chips": 10000, "amount": 50}
        TransactionService._acertar_contadores_na_mao(tx, tp, {"addon_chips": 30000}, None, 50.0)
        linha = fake.store["tournament_players"][0]
        assert linha["fee_count"] == 1
        assert linha["total_fee_amount"] == 50.0
        assert linha["addon_count"] == 1          # o add-on de verdade fica
        assert linha["total_chips"] == 30000      # só as fichas que a TAXA deu
        assert linha["total_spent"] == 100 + 70 + 50


class TestRelatorios:
    def test_categoria_da_venda(self):
        assert categoria_da_venda({"type": "addon", "is_fee": True}) == "fee"
        assert categoria_da_venda({"type": "addon"}) == "addon"
        assert categoria_da_venda({}) == "buy_in"

    def test_por_meio_a_taxa_tem_categoria_e_rotulo_proprios(self):
        linhas = [
            {"type": "buy_in", "amount": 600, "buy_type_id": "b1", "buy_type_name": "Buy-in"},
            {"type": "addon", "amount": 50, "buy_type_id": "f1", "buy_type_name": "Bono Dealer", "is_fee": True},
            {"type": "addon", "amount": 50, "buy_type_id": None, "buy_type_name": None, "is_fee": True},
            {"type": "addon", "amount": 200, "buy_type_id": "a1", "buy_type_name": "Add-on"},
        ]
        r = [(g.name, g.category, g.count) for g in agrupar_vendas_por_meio(linhas)]
        # Ordem: buy-in, add-on, taxa; a taxa sem meio cai no rótulo "Taxa".
        assert r == [("Buy-in", "buy_in", 1), ("Add-on", "addon", 1), ("Bono Dealer", "fee", 1), ("Taxa", "fee", 1)]

    def test_relatorio_do_torneio_conta_taxas_a_parte(self, monkeypatch, stub):
        from tests.test_report_buy_types import _tabelas, _resumo_de_premiacao
        tabelas = _tabelas()
        tabelas["tournament_players"][0].update({"fee_count": 2, "total_fee_amount": 100})
        monkeypatch.setattr(rep, "supabase", FakeSupabase(tabelas))
        stub(PAS, get_prize_summary=_resumo_de_premiacao)
        r = ReportService.get_tournament_report(TOUR_REPORT)
        assert r.total_fees == 2
        dia = [d for d in r.days if d.day_name == "Dia 1A"][0]
        assert dia.revenue == 50 + 20 + 100   # buy-in + rebuy + taxas (sem add-on nesse jogador)


class TestDre:
    def test_taxa_tem_linha_propria_e_soma_na_receita(self, monkeypatch):
        taxa = _entrada("addon", 50)
        taxa["id"] = "tx-taxa"
        taxa["is_fee"] = True
        _monta_dre(monkeypatch, transacoes=[_entrada("buy_in", 1000), _entrada("addon", 200), taxa])
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        assert s.revenue.addons == 200
        assert s.revenue.fees == 50
        assert s.revenue.total == 1250
        [t] = s.by_tournament
        assert (t.addons_count, t.fees_count) == (1, 1)

