"""Testes do DRE: o resultado da etapa.

A conta que fecha o mês do clube é
    liquido = (entradas - premios) + outras receitas - despesas
Este arquivo existe porque a versao anterior ignorava despesas: `net_result`
era igual ao operacional, e a etapa "fechava" com lucro que nao existia.
"""
import pytest

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
    }
    fake = FakeSupabase(tabelas)
    monkeypatch.setattr(financial_service, "supabase", fake)
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
