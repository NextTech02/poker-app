"""Testes do DRE: o resultado da etapa.

A conta que fecha o mês do clube é
    liquido = (entradas - premios) + outras receitas - despesas
Este arquivo existe porque a versao anterior ignorava despesas: `net_result`
era igual ao operacional, e a etapa "fechava" com lucro que nao existia.
"""
import pytest

from app.services import cash_report_service
from app.services import bar_report_service
from app.services import financial_service
from app.services.financial_service import FinancialService
from app.services.expense_service import ExpenseService

from tests.conftest import FakeSupabase


STAGE = "11111111-1111-1111-1111-111111111111"
TOUR = "22222222-2222-2222-2222-222222222222"
ORG = "33333333-3333-3333-3333-333333333333"


# O ExpenseService real devolve float (nao Decimal); o fake espelha isso, senao
# o teste mediria uma combinacao de tipos que nao acontece em producao.
def _resumo_despesas(total=0, pago=0, pendente=0, por_categoria=None):
    return {"total": float(total), "paid": float(pago),
            "pending": float(pendente), "by_category": por_categoria or []}


def _resumo_receitas(total=0, recebido=0, pendente=0, por_origem=None):
    return {"total": float(total), "received": float(recebido),
            "pending": float(pendente), "by_source": por_origem or []}


def _monta(monkeypatch, transacoes=None, torneios=None, despesas=None, receitas=None):
    tabelas = {
        "transactions": transacoes if transacoes is not None else [],
        "tournaments": torneios if torneios is not None else [{"id": TOUR, "stage_id": STAGE, "name": "Torneio"}],
        "prize_allocations": [],
        "satellite_tickets": [],
        "player_credits": [],
        "bar_shifts": [],
    }
    fake = FakeSupabase(tabelas)
    monkeypatch.setattr(financial_service, "supabase", fake)
    # O DRE soma o cash game. Sem este patch o relatório iria ao banco DE
    # VERDADE atrás de `cash_days` — o teste passaria a depender de rede.
    monkeypatch.setattr(cash_report_service, "supabase", fake)
    # Idem para o bar: `bar_shifts` no fake, ou o DRE vai à rede.
    monkeypatch.setattr(bar_report_service, "supabase", fake)
    monkeypatch.setattr(ExpenseService, "summarize",
                        staticmethod(lambda *a, **k: despesas or _resumo_despesas()))
    monkeypatch.setattr(ExpenseService, "summarize_revenues",
                        staticmethod(lambda *a, **k: receitas or _resumo_receitas()))
    return fake


def _entrada(tipo="buy_in", valor=100, torneio=TOUR, jogador="p1"):
    return {
        "id": f"tx-{tipo}-{valor}", "tournament_id": torneio, "player_id": jogador,
        "type": tipo, "amount": valor, "rake_amount": 0,
        "created_at": "2026-06-08T00:00:00Z",
        "players": {"name": "Jogador"}, "tournaments": {"name": "Torneio"},
    }


class TestResultadoDaEtapa:
    def test_sem_movimento_nenhum_zera(self, monkeypatch):
        _monta(monkeypatch, transacoes=[], torneios=[])
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        assert s.gross_revenue == 0
        assert s.net_result == 0

    def test_despesa_sem_torneio_ainda_aparece_no_resultado(self, monkeypatch):
        """Etapa sem torneio mas com aluguel lancado: o DRE tem que mostrar o
        prejuizo. Devolver zerado esconderia dinheiro ja gasto."""
        _monta(monkeypatch, transacoes=[], torneios=[],
               despesas=_resumo_despesas(total=800, pago=800))
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        assert s.expenses == 800
        assert s.net_result == -800

    def test_premio_de_ko_e_premio_e_aparece_separado(self, monkeypatch):
        """O KO sai do mesmo pozo (entra em `prizes`); `knockout_prizes`
        mostra quanto disso foi por eliminação."""
        ko = _entrada("prize", 150)
        ko["id"] = "tx-ko"
        ko["prize_kind"] = "knockout"
        _monta(monkeypatch, transacoes=[_entrada("buy_in", 1000), _entrada("prize", 400), ko])
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        assert s.prizes == 550
        assert s.knockout_prizes == 150
        assert s.operational_result == 450

    def test_entradas_menos_premios_dao_o_operacional(self, monkeypatch):
        _monta(monkeypatch, transacoes=[
            _entrada("buy_in", 1000),
            _entrada("prize", 400),
        ])
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        assert s.gross_revenue == 1000
        assert s.prizes == 400
        assert s.operational_result == 600

    def test_despesas_e_outras_receitas_fecham_o_liquido(self, monkeypatch):
        # 1000 de entradas, 400 de premios, 1500 de bar, 800 de despesa
        # liquido = (1000 - 400) + 1500 - 800 = 1300
        _monta(monkeypatch,
               transacoes=[_entrada("buy_in", 1000), _entrada("prize", 400)],
               despesas=_resumo_despesas(total=800, pago=800),
               receitas=_resumo_receitas(total=1500, recebido=1500))
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        assert s.operational_result == 600
        assert s.net_result == 1300

    def test_cada_modulo_tem_o_seu_resultado(self, monkeypatch):
        # O DRE e por modulo: o de torneio fecha com entradas, premios, outras
        # receitas e despesas da etapa; o do cash e o rake; o do bar e a margem.
        # O consolidado continua somando os tres brutos.
        _monta(monkeypatch,
               transacoes=[_entrada("buy_in", 1000), _entrada("prize", 400)],
               despesas=_resumo_despesas(total=800, pago=800),
               receitas=_resumo_receitas(total=1500, recebido=1500))
        monkeypatch.setattr(cash_report_service.CashReportService, "summarize",
                            staticmethod(lambda *a, **k: {
                                "cash_revenue": 250.0, "cash_jackpot_collected": 30.0, "cash_jackpot_paid": 0.0,
                                "cash_buy_ins": 5000.0, "cash_cash_outs": 4700.0, "cash_days_count": 1,
                                "cash_tables_count": 2, "cash_players_count": 9}))
        monkeypatch.setattr(bar_report_service.BarReportService, "summarize",
                            staticmethod(lambda *a, **k: {
                                "bar_revenue": 300.0, "bar_gross": 320.0, "bar_discounts": 20.0,
                                "bar_cogs": 120.0, "bar_gross_margin": 180.0, "bar_tabs_count": 6, "bar_shifts_count": 1}))
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        assert s.tournament_gross_revenue == 1000
        assert s.tournament_operational_result == 600
        assert s.tournament_net_result == 600 + 1500 - 800
        assert s.cash_net_result == 250
        assert s.bar_gross_margin == 180
        # consolidado: os brutos dos tres somados
        assert s.gross_revenue == 1000 + 250 + 300

    def test_despesa_pendente_conta_no_resultado(self, monkeypatch):
        """DRE por competencia: o que foi assumido pesa, mesmo sem ter sido pago."""
        _monta(monkeypatch,
               transacoes=[_entrada("buy_in", 1000)],
               despesas=_resumo_despesas(total=300, pago=100, pendente=200))
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        assert s.expenses_pending == 200
        assert s.net_result == 700   # 1000 - 300, e nao 1000 - 100

    def test_rebuys_e_addons_somam_na_receita(self, monkeypatch):
        _monta(monkeypatch, transacoes=[
            _entrada("buy_in", 100), _entrada("rebuy", 50), _entrada("addon", 30),
        ])
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        assert s.revenue.buy_ins == 100
        assert s.revenue.rebuys == 50
        assert s.revenue.addons == 30
        assert s.gross_revenue == 180

    def test_prejuizo_e_reportado_como_negativo(self, monkeypatch):
        _monta(monkeypatch,
               transacoes=[_entrada("buy_in", 100)],
               despesas=_resumo_despesas(total=500, pago=500))
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        assert s.net_result == -400

    def test_quebra_por_torneio(self, monkeypatch):
        _monta(monkeypatch, transacoes=[
            _entrada("buy_in", 1000), _entrada("prize", 300),
        ])
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        assert len(s.by_tournament) == 1
        t = s.by_tournament[0]
        assert t.revenue == 1000
        assert t.prizes == 300
        assert t.net == 700


class TestDescricaoNoExtrato:
    def test_extrato_traz_o_meio_de_entrada_e_se_e_taxa(self, monkeypatch):
        """Pedido do NSOP: no Financeiro não aparecia "Bono Dealer" nem "Doble"
        — só a categoria (Add-on, Rebuy)."""
        doble = {**_entrada("rebuy", 1200), "buy_type_name": "Doble Recompra"}
        bono = {**_entrada("addon", 50), "buy_type_name": "Bono Dealer", "is_fee": True}
        antiga = _entrada("buy_in", 600)
        _monta(monkeypatch, transacoes=[doble, bono, antiga])
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        por_id = {t.id: t for t in s.transactions}
        assert por_id[doble["id"]].buy_type_name == "Doble Recompra"
        assert (por_id[bono["id"]].buy_type_name, por_id[bono["id"]].is_fee) == ("Bono Dealer", True)
        assert por_id[antiga["id"]].buy_type_name is None and por_id[antiga["id"]].is_fee is False


class TestMeiosDeEntradaPorTorneio:
    """Pedido do NSOP: a exportação dos relatórios só trazia Buy-ins, Rebuys e
    Add-ons por torneio — sem a "Tasa", o "Doble" e os demais itens cobrados.
    Cada torneio passa a trazer as vendas por MEIO de entrada."""

    def _venda(self, n, tipo, valor, meio, nome, torneio=TOUR, taxa=False):
        return {**_entrada(tipo, valor, torneio=torneio), "id": f"tx-{n}",
                "buy_type_id": meio, "buy_type_name": nome, "is_fee": taxa}

    def test_cada_torneio_traz_as_vendas_por_meio_na_ordem_do_caixa(self, monkeypatch):
        outro = "44444444-4444-4444-4444-444444444444"
        fake = _monta(monkeypatch, transacoes=[
            self._venda(1, "buy_in", 200, "bt-buy", "Buy-in"),
            self._venda(2, "buy_in", 200, "bt-buy", "Buy-in"),
            self._venda(3, "rebuy", 300, "bt-doble", "Doble"),
            self._venda(4, "addon", 50, "bt-tasa", "Tasa", taxa=True),
            self._venda(5, "buy_in", 100, "bt-buy2", "Buy-in", torneio=outro),
            _entrada("prize", 400),   # prêmio não é venda
        ], torneios=[
            {"id": TOUR, "stage_id": STAGE, "name": "Main"},
            {"id": outro, "stage_id": STAGE, "name": "Turbo"},
        ])
        fake.store["buy_types"] = [
            {"id": "bt-doble", "tournament_id": TOUR, "sort_order": 2},
            {"id": "bt-buy", "tournament_id": TOUR, "sort_order": 1},
            {"id": "bt-tasa", "tournament_id": TOUR, "sort_order": 3},
        ]
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        por_torneio = {t.tournament_id: t for t in s.by_tournament}
        assert [(m.name, m.category, m.count, m.amount) for m in por_torneio[TOUR].by_buy_type] == [
            ("Buy-in", "buy_in", 2, 400.0),
            ("Doble", "rebuy", 1, 300.0),
            ("Tasa", "fee", 1, 50.0),
        ]
        assert [(m.name, m.count) for m in por_torneio[outro].by_buy_type] == [("Buy-in", 1)]

    def test_sem_a_tabela_de_meios_os_grupos_saem_mesmo_assim(self, monkeypatch):
        fake = _monta(monkeypatch, transacoes=[self._venda(1, "rebuy", 300, "bt-doble", "Doble")])
        original = fake.table

        def table(nome):
            if nome == "buy_types":
                raise RuntimeError("timeout")
            return original(nome)

        monkeypatch.setattr(fake, "table", table)
        [t] = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG).by_tournament
        assert [(m.name, m.count) for m in t.by_buy_type] == [("Doble", 1)]
