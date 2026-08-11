"""Testes de despesas e outras receitas — o que completa o DRE da etapa.

O ponto sensivel nao e o CRUD: e a relacao com o caixa geral. Uma despesa so
debita o caixa via RPC (atomico e idempotente), e apagar uma despesa PAGA
precisa devolver o dinheiro — senao o saldo fica debitado para sempre por um
lancamento que nao existe mais.
"""
import pytest

from app.services import expense_service
from app.services.expense_service import ExpenseService

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
STAGE = "11111111-1111-1111-1111-111111111111"


def _monta(monkeypatch, tabelas=None, rpcs=None):
    base = {
        "expenses": [],
        "expense_categories": [],
        "expense_templates": [],
        "expense_attachments": [],
        "other_revenues": [],
        "staff_payments": [],
        "staff": [],
    }
    base.update(tabelas or {})
    fake = FakeSupabase(base)
    fake.rpcs = rpcs or {}
    monkeypatch.setattr(expense_service, "supabase", fake)
    # O expurgo de anexos fala com o Storage; aqui interessa a regra, nao o I/O.
    monkeypatch.setattr(ExpenseService, "_purge_attachment_files",
                        staticmethod(lambda org_id, expense_id: None))
    return fake


def _despesa(id_="e1", valor=100, status="pendente", categoria=None, stage=STAGE):
    return {
        "id": id_, "organization_id": ORG, "stage_id": stage,
        "description": "Dealers", "amount": valor, "status": status,
        "category_id": categoria, "created_at": "2026-06-08T00:00:00Z",
    }


class TestCriacao:
    def test_nasce_sempre_pendente(self, monkeypatch):
        """Gravar 'pago' direto criaria uma despesa paga que nunca saiu do
        caixa. A transicao e do RPC, que e quem debita."""
        fake = _monta(monkeypatch)
        ExpenseService.create_expense(ORG, {"description": "Aluguel", "amount": 500}, "u1")
        assert fake.store["expenses"][0]["status"] == "pendente"

    def test_marcada_como_paga_passa_pelo_rpc(self, monkeypatch):
        fake = _monta(monkeypatch, rpcs={"expense_set_status": {"ok": True}})
        ExpenseService.create_expense(
            ORG, {"description": "Dealers", "amount": 800, "status": "pago"}, "u1"
        )
        chamados = [c[0] for c in fake.rpc_calls]
        assert "expense_set_status" in chamados
        # e o status pedido foi "pago"
        params = dict(fake.rpc_calls[0][1])
        assert params["p_status"] == "pago"

    def test_guarda_autor_e_organizacao(self, monkeypatch):
        fake = _monta(monkeypatch)
        ExpenseService.create_expense(ORG, {"description": "X", "amount": 10}, "operador")
        linha = fake.store["expenses"][0]
        assert linha["organization_id"] == ORG
        assert linha["created_by"] == "operador"


class TestExclusao:
    def test_apagar_despesa_paga_estorna_o_caixa(self, monkeypatch):
        """Sem o estorno o saldo fica debitado por um lancamento inexistente."""
        fake = _monta(monkeypatch,
                      {"expenses": [_despesa(status="pago")]},
                      rpcs={"expense_set_status": {"ok": True}})

        assert ExpenseService.delete_expense(ORG, "e1") is True

        chamados = [(c[0], c[1].get("p_status")) for c in fake.rpc_calls]
        assert ("expense_set_status", "pendente") in chamados
        assert fake.store["expenses"] == []

    def test_apagar_despesa_pendente_nao_mexe_no_caixa(self, monkeypatch):
        fake = _monta(monkeypatch, {"expenses": [_despesa(status="pendente")]})
        ExpenseService.delete_expense(ORG, "e1")
        assert fake.rpc_calls == []

    def test_sem_caixa_configurado_a_exclusao_continua(self, monkeypatch):
        """Se o estorno falhar, a despesa ainda tem que sair — senao fica
        impossivel apagar."""
        fake = _monta(monkeypatch, {"expenses": [_despesa(status="pago")]})
        # nenhum rpc registrado => o fake estoura => o servico engole e segue
        assert ExpenseService.delete_expense(ORG, "e1") is True
        assert fake.store["expenses"] == []

    def test_despesa_de_outra_organizacao_nao_e_apagada(self, monkeypatch):
        outra = _despesa()
        outra["organization_id"] = "outra-org"
        fake = _monta(monkeypatch, {"expenses": [outra]})
        assert ExpenseService.delete_expense(ORG, "e1") is False
        assert len(fake.store["expenses"]) == 1


class TestResumoParaDRE:
    def test_sem_despesa_devolve_zerado(self, monkeypatch):
        _monta(monkeypatch)
        r = ExpenseService.summarize(ORG, STAGE)
        assert r["total"] == 0.0
        assert r["by_category"] == []

    def test_separa_pago_de_pendente(self, monkeypatch):
        _monta(monkeypatch, {"expenses": [
            _despesa("e1", 300, "pago"),
            _despesa("e2", 200, "pendente"),
        ]})
        r = ExpenseService.summarize(ORG, STAGE)
        assert r["total"] == 500.0
        assert r["paid"] == 300.0
        assert r["pending"] == 200.0

    def test_agrupa_por_categoria(self, monkeypatch):
        d1 = _despesa("e1", 300, "pago"); d1["expense_categories"] = {"name": "Dealers", "kind": "variavel"}
        d2 = _despesa("e2", 100, "pago"); d2["expense_categories"] = {"name": "Dealers", "kind": "variavel"}
        d3 = _despesa("e3", 50, "pago");  d3["expense_categories"] = {"name": "Bar", "kind": "variavel"}
        _monta(monkeypatch, {"expenses": [d1, d2, d3]})

        r = ExpenseService.summarize(ORG, STAGE)
        por_cat = {c["category"]: c["amount"] for c in r["by_category"]}
        assert por_cat["Dealers"] == 400.0
        assert por_cat["Bar"] == 50.0
        # maior primeiro
        assert r["by_category"][0]["category"] == "Dealers"

    def test_sem_categoria_vira_rotulo_proprio(self, monkeypatch):
        _monta(monkeypatch, {"expenses": [_despesa("e1", 70, "pago")]})
        r = ExpenseService.summarize(ORG, STAGE)
        assert r["by_category"][0]["category"] == "Sem categoria"

    def test_pagamentos_de_equipe_entram_como_categoria_propria(self, monkeypatch):
        """Ja eram custo real (debitam o caixa) mas ficavam fora do DRE. A
        categoria e nomeada de forma distinta para nao duplicar com uma
        despesa manual 'Dealers'."""
        _monta(monkeypatch, {"expenses": [_despesa("e1", 100, "pago")]})
        monkeypatch.setattr(ExpenseService, "_staff_payments",
                            staticmethod(lambda *a, **k: (900.0, 900.0, 0.0)))
        r = ExpenseService.summarize(ORG, STAGE)
        assert r["total"] == 1000.0
        nomes = [c["category"] for c in r["by_category"]]
        assert "Equipe (pagamentos)" in nomes


class TestOutrasReceitas:
    def test_resumo_separa_recebido_de_pendente(self, monkeypatch):
        _monta(monkeypatch, {"other_revenues": [
            {"id": "r1", "organization_id": ORG, "stage_id": STAGE,
             "amount": 1500, "status": "recebido", "source": "Bar",
             "created_at": "2026-06-08T00:00:00Z"},
            {"id": "r2", "organization_id": ORG, "stage_id": STAGE,
             "amount": 500, "status": "pendente", "source": "Patrocinio",
             "created_at": "2026-06-08T00:00:00Z"},
        ]})
        r = ExpenseService.summarize_revenues(ORG, STAGE)
        assert r["total"] == 2000.0
        assert r["received"] == 1500.0
        assert r["pending"] == 500.0

    def test_agrupa_por_origem(self, monkeypatch):
        _monta(monkeypatch, {"other_revenues": [
            {"id": "r1", "organization_id": ORG, "stage_id": STAGE, "amount": 100,
             "status": "recebido", "source": "Bar", "created_at": "2026-06-08T00:00:00Z"},
            {"id": "r2", "organization_id": ORG, "stage_id": STAGE, "amount": 300,
             "status": "recebido", "source": "Bar", "created_at": "2026-06-08T00:00:00Z"},
        ]})
        r = ExpenseService.summarize_revenues(ORG, STAGE)
        assert r["by_source"][0]["category"] == "Bar"
        assert r["by_source"][0]["amount"] == 400.0

    def test_receita_nasce_pendente_e_o_rpc_credita(self, monkeypatch):
        fake = _monta(monkeypatch, rpcs={"revenue_set_status": {"ok": True}})
        ExpenseService.create_revenue(
            ORG, {"source": "Bar", "amount": 1500, "status": "recebido", "stage_id": STAGE}, "u1"
        )
        chamados = [(c[0], c[1].get("p_status")) for c in fake.rpc_calls]
        assert ("revenue_set_status", "recebido") in chamados


class TestCategoriasEModelos:
    def test_categoria_de_outra_organizacao_nao_e_alterada(self, monkeypatch):
        cat = {"id": "c1", "organization_id": "outra", "name": "X", "active": True}
        _monta(monkeypatch, {"expense_categories": [cat]})
        assert ExpenseService.update_category(ORG, "c1", {"name": "Y"}) is None

    def test_modelo_e_criado_e_apagado(self, monkeypatch):
        fake = _monta(monkeypatch)
        ExpenseService.create_template(ORG, {"name": "Dealers do sabado", "amount": 800})
        assert len(fake.store["expense_templates"]) == 1
        tid = fake.store["expense_templates"][0]["id"]
        assert ExpenseService.delete_template(ORG, tid) is True
        assert fake.store["expense_templates"] == []
