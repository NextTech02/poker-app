"""Leituras independentes ao mesmo tempo (app/utils/paralelo.py) e o DRE.

O que importa:
- a tarefa roda com o CONTEXTO de quem chamou — o JWT da requisição vai junto,
  senão a consulta na outra thread rodaria com a chave de serviço e
  enxergaria todos os clubes;
- a exceção de uma tarefa sobe para quem pede o resultado;
- o DRE de fato espera as leituras juntas, não em fila.
"""
import threading
import time

import pytest

from app.database.supabase_client import _request_jwt, reset_request_jwt, set_request_jwt
from app.services import bar_report_service, cash_report_service, financial_service
from app.services.expense_service import ExpenseService
from app.services.financial_service import FinancialService
from app.services.house_credit_service import HouseCreditService
from app.utils.paralelo import iniciar

from tests.conftest import FakeSupabase

STAGE = "11111111-1111-1111-1111-111111111111"
TOUR = "22222222-2222-2222-2222-222222222222"
ORG = "33333333-3333-3333-3333-333333333333"


def test_a_tarefa_ve_o_token_da_requisicao():
    token = set_request_jwt("jwt-do-operador")
    try:
        r = iniciar(quem=lambda: _request_jwt.get()).resultados()
    finally:
        reset_request_jwt(token)
    assert r["quem"] == "jwt-do-operador"


def test_excecao_da_tarefa_sobe_para_quem_pede():
    def estoura():
        raise RuntimeError("banco fora")

    paralelas = iniciar(ok=lambda: 1, ruim=estoura)
    with pytest.raises(RuntimeError, match="banco fora"):
        paralelas.resultados()


def test_as_tarefas_rodam_ao_mesmo_tempo():
    em_curso = {"agora": 0, "maximo": 0}
    trava = threading.Lock()

    def lenta():
        with trava:
            em_curso["agora"] += 1
            em_curso["maximo"] = max(em_curso["maximo"], em_curso["agora"])
        time.sleep(0.05)
        with trava:
            em_curso["agora"] -= 1
        return True

    iniciar(**{f"t{i}": lenta for i in range(4)}).resultados()
    assert em_curso["maximo"] >= 2


class _BancoLento(FakeSupabase):
    """Cada consulta espera um pouco e conta quantas estão no ar ao mesmo tempo."""
    def __init__(self, tabelas):
        super().__init__(tabelas)
        self.em_curso = 0
        self.maximo = 0
        self._trava = threading.Lock()

    def table(self, name):
        with self._trava:
            self.em_curso += 1
            self.maximo = max(self.maximo, self.em_curso)
        try:
            time.sleep(0.03)
            return super().table(name)
        finally:
            with self._trava:
                self.em_curso -= 1


def test_dre_le_o_que_nao_depende_das_vendas_em_paralelo(monkeypatch):
    banco = _BancoLento({
        "tournaments": [{"id": TOUR, "stage_id": STAGE, "name": "Main"}],
        "transactions": [], "satellite_tickets": [], "player_credits": [],
        "prize_allocations": [], "bar_shifts": [],
    })
    for mod in (financial_service, cash_report_service, bar_report_service):
        monkeypatch.setattr(mod, "supabase", banco)
    # Despesas, receitas e fiado também esperam, como uma consulta de verdade.
    def devagar(valor):
        def _f(*a, **k):
            time.sleep(0.03)
            return valor
        return staticmethod(_f)
    monkeypatch.setattr(ExpenseService, "summarize",
                        devagar({"total": 0.0, "paid": 0.0, "pending": 0.0, "by_category": []}))
    monkeypatch.setattr(ExpenseService, "summarize_revenues",
                        devagar({"total": 0.0, "received": 0.0, "pending": 0.0, "by_source": []}))
    monkeypatch.setattr(ExpenseService, "guarantee_committed", devagar(0.0))
    monkeypatch.setattr(HouseCreditService, "summarize", devagar(
        {"house_credit_write_offs": 0.0, "house_credit_open": 0.0, "house_credit_overdue": 0.0}))

    s = FinancialService.get_financial_summary(stage_id=STAGE, organization_id=ORG)
    assert s.net_result == 0
    assert banco.maximo >= 2      # antes: sempre 1 (tudo em fila)
