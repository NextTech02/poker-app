"""Leitura de mil em mil (app/database/paginacao.py).

O PostgREST do Supabase devolve no máximo 1000 linhas e corta EM SILÊNCIO
(medido em produção). Um clube já estava com 893 vendas: passando de mil,
toda soma feita em Python — gaveta, DRE, bounty do KO — sairia menor que o
real, sem erro nenhum na tela. Os testes cercam:

- o laço pede página por página até vir uma incompleta;
- a linha repetida entre páginas (venda nova empurrando tudo) não conta duas vezes;
- os lugares que somam dinheiro passam a ver as 2500 linhas, não 1000.

O banco falso de `conftest` fatia `.range()` como o PostgREST; aqui ele também
CORTA em 1000 sem `.range()`, como o servidor de verdade.
"""
from types import SimpleNamespace

from app.database.paginacao import PAGINA, todas_as_linhas
from app.services import financial_service, cash_report_service, bar_report_service
from app.services.financial_service import FinancialService
from app.services.expense_service import ExpenseService
from app.services import transaction_service
from app.services.transaction_service import TransactionService

from tests.conftest import FakeQuery, FakeSupabase

STAGE = "11111111-1111-1111-1111-111111111111"
TOUR = "22222222-2222-2222-2222-222222222222"
ORG = "33333333-3333-3333-3333-333333333333"


class _ConsultaComTeto(FakeQuery):
    """Como o servidor: sem `.range()`, devolve no máximo 1000 linhas."""
    def execute(self):
        r = super().execute()
        if self._op == "select" and self._range is None and isinstance(r.data, list):
            return SimpleNamespace(data=r.data[:PAGINA], count=r.count)
        return r


class _BancoComTeto(FakeSupabase):
    def __init__(self, tabelas):
        super().__init__(tabelas)
        self.paginas = 0

    def table(self, name):
        self.paginas += 1
        return _ConsultaComTeto(self.store, name)

    from_ = table


def _vendas(n):
    return [{
        "id": f"tx-{i:05d}", "tournament_id": TOUR, "player_id": "p1", "type": "buy_in",
        "amount": 100, "rake_amount": 10, "created_at": "2026-11-01T20:00:00Z",
        "players": {"name": "Ana", "nickname": None}, "tournaments": {"name": "Main", "stage_id": STAGE},
    } for i in range(n)]


class TestLaco:
    def test_le_todas_as_paginas_ate_a_incompleta(self):
        banco = _BancoComTeto({"t": [{"id": i} for i in range(2500)]})
        linhas = todas_as_linhas(lambda: banco.table("t").select("*").order("id"))
        assert len(linhas) == 2500
        assert banco.paginas == 3    # 1000 + 1000 + 500

    def test_ate_mil_custa_uma_ida_so(self):
        banco = _BancoComTeto({"t": [{"id": i} for i in range(300)]})
        assert len(todas_as_linhas(lambda: banco.table("t").select("*"))) == 300
        assert banco.paginas == 1

    def test_linha_repetida_entre_paginas_nao_conta_duas_vezes(self):
        # Uma venda nova entre a página 1 e a 2 empurra tudo uma posição: a
        # página 2 começaria repetindo a última linha da página 1.
        paginas = iter([
            [{"id": i} for i in range(1000)],
            [{"id": 999}] + [{"id": i} for i in range(1000, 1200)],
        ])

        class _Consulta:
            def range(self, *_):
                return self

            def execute(self):
                return SimpleNamespace(data=next(paginas))

        linhas = todas_as_linhas(lambda: _Consulta())
        assert len(linhas) == 1200
        assert len({l["id"] for l in linhas}) == 1200


class TestOndeODinheiroESomado:
    def test_lista_do_caixa_traz_todas_as_vendas(self, monkeypatch):
        # Os totais da gaveta são somados na tela a partir desta lista.
        # (Sem etapa: o banco falso não entende o filtro pela coluna embutida
        # `tournaments.stage_id`; o laço é o mesmo com ou sem ela.)
        banco = _BancoComTeto({"transactions": _vendas(2500)})
        monkeypatch.setattr(transaction_service, "supabase", banco)
        assert len(TransactionService.get_transactions()) == 2500

    def test_lista_com_limit_continua_cortando_no_banco(self, monkeypatch):
        banco = _BancoComTeto({"transactions": _vendas(2500)})
        monkeypatch.setattr(transaction_service, "supabase", banco)
        assert len(TransactionService.get_transactions(limit=5)) == 5

    def test_dre_soma_todas_as_vendas(self, monkeypatch):
        banco = _BancoComTeto({
            "transactions": _vendas(2500),
            "tournaments": [{"id": TOUR, "stage_id": STAGE, "name": "Main"}],
            "satellite_tickets": [], "player_credits": [], "prize_allocations": [], "bar_shifts": [],
        })
        for mod in (financial_service, cash_report_service, bar_report_service):
            monkeypatch.setattr(mod, "supabase", banco)
        vazio = {"total": 0.0, "paid": 0.0, "pending": 0.0, "by_category": []}
        monkeypatch.setattr(ExpenseService, "summarize", staticmethod(lambda *a, **k: vazio))
        monkeypatch.setattr(ExpenseService, "summarize_revenues", staticmethod(
            lambda *a, **k: {"total": 0.0, "received": 0.0, "pending": 0.0, "by_source": []}))
        s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
        assert s.revenue.buy_ins == 250000       # 2500 × 100, não 1000 × 100
        assert s.rake == 25000
