"""Testes do caixa: sangria, rake pendente e o painel consolidado.

A sangria é a operação onde o dinheiro efetivamente muda de lugar (caixa da
etapa -> caixa geral + rake). Um erro de arredondamento ou de sinal aqui não
aparece na tela: aparece no fechamento do clube.
"""
from decimal import Decimal

import pytest

from app.services import cash_register_service
from app.services.cash_register_service import CashRegisterService
from app.models.cash_register import SangriaTransactionCreate

from tests.conftest import FakeSupabase


STAGE = "11111111-1111-1111-1111-111111111111"


def _mundo(saldo="1000.00", sangrias="0.00", geral="500.00", rake="0.00", transacoes=None):
    """Estado inicial dos três registradores + transações da etapa."""
    return {
        "stage_cash_register": [{
            "id": "sc1", "stage_id": STAGE, "stage_name": "Etapa",
            "current_balance": saldo, "total_entries": saldo,
            "total_sangrias": sangrias,
            "created_at": "2026-06-08T00:00:00Z", "updated_at": "2026-06-08T00:00:00Z",
        }],
        "general_cash_register": [{
            "id": "gc1", "current_balance": geral, "total_received": geral,
            "total_withdrawals": "0.00", "created_at": "2026-06-08T00:00:00Z", "updated_at": "2026-06-08T00:00:00Z",
        }],
        "rake_register": [{"id": "rr1", "total_rake": rake, "created_at": "2026-06-08T00:00:00Z", "updated_at": "2026-06-08T00:00:00Z",}],
        "sangria_transactions": [],
        "transactions": transacoes or [],
        "tournaments": [{"id": "t1", "stage_id": STAGE}],
    }


def _fake(monkeypatch, tabelas):
    fake = FakeSupabase(tabelas)
    monkeypatch.setattr(cash_register_service, "supabase", fake)
    return fake


def _sangria(valor, notes=None, client_mutation_id=None):
    kwargs = dict(stage_id=STAGE, stage_name="Etapa", amount=Decimal(valor),
                  rake_percentage=Decimal("20"), notes=notes)
    if client_mutation_id:
        kwargs["client_mutation_id"] = client_mutation_id
    return SangriaTransactionCreate(**kwargs)


class TestSangria:
    def test_saldo_insuficiente_e_recusado(self, monkeypatch):
        _fake(monkeypatch, _mundo(saldo="100.00"))
        with pytest.raises(ValueError, match="Insufficient balance"):
            CashRegisterService.perform_sangria(_sangria("500.00"), user_id="u1")

    def test_etapa_sem_caixa_e_recusada(self, monkeypatch):
        tabelas = _mundo()
        tabelas["stage_cash_register"] = []
        _fake(monkeypatch, tabelas)
        with pytest.raises(ValueError, match="Cash register not found"):
            CashRegisterService.perform_sangria(_sangria("10.00"), user_id="u1")

    def test_move_o_dinheiro_entre_os_tres_registradores(self, monkeypatch):
        # 1000 em caixa, sem rake pendente: tudo vira líquido no caixa geral.
        fake = _fake(monkeypatch, _mundo(saldo="1000.00", geral="500.00"))

        r = CashRegisterService.perform_sangria(_sangria("400.00"), user_id="u1")

        assert r.success is True
        # sai da etapa
        assert Decimal(fake.store["stage_cash_register"][0]["current_balance"]) == Decimal("600.00")
        assert Decimal(fake.store["stage_cash_register"][0]["total_sangrias"]) == Decimal("400.00")
        # entra no geral (líquido)
        assert Decimal(fake.store["general_cash_register"][0]["current_balance"]) == Decimal("900.00")
        # nada de rake, porque não havia rake pendente
        assert Decimal(fake.store["rake_register"][0]["total_rake"]) == Decimal("0")

    def test_rake_e_proporcional_ao_valor_sangrado(self, monkeypatch):
        # 1000 em caixa com 200 de rake pendente. Sangrando metade (500),
        # metade do rake (100) deve acompanhar.
        transacoes = [{"id": "x1", "tournament_id": "t1", "rake_amount": "200.00",
                       "sangria_id": None, "type": "buy_in"}]
        fake = _fake(monkeypatch, _mundo(saldo="1000.00", transacoes=transacoes))
        monkeypatch.setattr(
            CashRegisterService, "get_stage_pending_rake",
            staticmethod(lambda stage_id: Decimal("200.00")),
        )

        r = CashRegisterService.perform_sangria(_sangria("500.00"), user_id="u1")

        assert r.sangria_transaction.rake_amount == Decimal("100.00")
        assert r.sangria_transaction.net_amount == Decimal("400.00")
        # o líquido é o que engorda o caixa geral; o rake vai para o registrador de rake
        assert Decimal(fake.store["general_cash_register"][0]["current_balance"]) == Decimal("900.00")
        assert Decimal(fake.store["rake_register"][0]["total_rake"]) == Decimal("100.00")

    def test_rake_nunca_passa_do_valor_sangrado(self, monkeypatch):
        # Rake pendente maior que o próprio caixa: o rateio é truncado, senão o
        # líquido ficaria negativo e o caixa geral perderia dinheiro.
        _fake(monkeypatch, _mundo(saldo="100.00"))
        monkeypatch.setattr(
            CashRegisterService, "get_stage_pending_rake",
            staticmethod(lambda stage_id: Decimal("999.00")),
        )

        r = CashRegisterService.perform_sangria(_sangria("100.00"), user_id="u1")

        assert r.sangria_transaction.rake_amount == Decimal("100.00")
        assert r.sangria_transaction.net_amount == Decimal("0.00")
        assert r.sangria_transaction.net_amount >= 0

    def test_percentual_registrado_bate_com_o_rake_efetivo(self, monkeypatch):
        _fake(monkeypatch, _mundo(saldo="1000.00"))
        monkeypatch.setattr(
            CashRegisterService, "get_stage_pending_rake",
            staticmethod(lambda stage_id: Decimal("200.00")),
        )
        r = CashRegisterService.perform_sangria(_sangria("500.00"), user_id="u1")
        # 100 de rake sobre 500 sangrados = 20%
        assert r.sangria_transaction.rake_percentage == Decimal("20.00")

    def test_replay_offline_nao_debita_duas_vezes(self, monkeypatch):
        """Mesma sangria reenviada pela fila offline: devolve a original."""
        tabelas = _mundo(saldo="1000.00")
        tabelas["sangria_transactions"] = [{
            "id": "s1", "stage_id": STAGE, "stage_name": "Etapa",
            "amount": "300.00", "rake_percentage": "0.00", "rake_amount": "0.00",
            "net_amount": "300.00", "notes": None, "created_by": "u1",
            "client_mutation_id": "cm-1", "created_at": "2026-06-08T00:00:00Z", "updated_at": "2026-06-08T00:00:00Z",
        }]
        fake = _fake(monkeypatch, tabelas)

        r = CashRegisterService.perform_sangria(
            _sangria("300.00", client_mutation_id="cm-1"), user_id="u1"
        )

        assert "já sincronizada" in r.message
        # o caixa não foi tocado de novo
        assert Decimal(fake.store["stage_cash_register"][0]["current_balance"]) == Decimal("1000.00")
        assert len(fake.store["sangria_transactions"]) == 1


class TestLeituras:
    def test_caixa_da_etapa_inexistente_devolve_none(self, monkeypatch):
        tabelas = _mundo()
        tabelas["stage_cash_register"] = []
        _fake(monkeypatch, tabelas)
        assert CashRegisterService.get_stage_cash(STAGE) is None

    def test_caixa_geral_e_rake_sao_lidos(self, monkeypatch):
        _fake(monkeypatch, _mundo(geral="750.50", rake="120.25"))
        assert CashRegisterService.get_general_cash().current_balance == Decimal("750.50")
        assert CashRegisterService.get_rake_register().total_rake == Decimal("120.25")

    def test_historico_de_sangrias(self, monkeypatch):
        tabelas = _mundo()
        tabelas["sangria_transactions"] = [{
            "id": "s1", "stage_id": STAGE, "stage_name": "Etapa", "amount": "50.00",
            "rake_percentage": "10.00", "rake_amount": "5.00", "net_amount": "45.00",
            "notes": None, "created_by": "u1", "created_at": "2026-06-08T00:00:00Z", "updated_at": "2026-06-08T00:00:00Z",
        }]
        _fake(monkeypatch, tabelas)
        hist = CashRegisterService.get_sangria_history(stage_id=STAGE)
        assert len(hist) == 1
        assert hist[0].net_amount == Decimal("45.00")
