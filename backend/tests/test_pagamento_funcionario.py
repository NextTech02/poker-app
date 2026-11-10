"""Pagamento de funcionário: o caixa geral move no servidor, de forma atômica.

A tela gravava `saldo lido − valor` por cima do caixa geral, do navegador:
duas operações juntas perdiam uma, e um erro entre as duas escritas deixava
o funcionário pago sem o dinheiro ter saído. Trava:

1. Pagar debita pela RPC atômica e marca pago; pagar de novo é recusado.
2. Sem saldo, nada muda (nem o status).
3. Estornar credita e volta a pendente; estornar duas vezes é recusado.
"""
from decimal import Decimal

import pytest

from app.services import staff_payment_service as mod
from app.services.cash_register_service import CashRegisterService
from app.services.staff_payment_service import StaffPaymentService as P
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase

ETAPA = "11111111-1111-1111-1111-111111111111"
STAFF = "99999999-9999-9999-9999-999999999999"
AUTOR = "88888888-8888-8888-8888-888888888888"


class _Caixa:
    def __init__(self, saldo):
        self.id = "gc1"
        self.current_balance = Decimal(str(saldo))


def _monta(monkeypatch, saldo=1000, pagamentos=None):
    fake = FakeSupabase({"staff_payments": pagamentos or []})
    fake.caixa_geral = Decimal(str(saldo))

    def debitar(params):
        valor = Decimal(str(params["p_amount"]))
        if fake.caixa_geral < valor:
            return None
        fake.caixa_geral -= valor
        return float(fake.caixa_geral)

    def creditar(params):
        fake.caixa_geral += Decimal(str(params["p_amount"]))
        return float(fake.caixa_geral)

    fake.rpcs["debit_general_cash_register"] = debitar
    fake.rpcs["credit_general_cash_register"] = creditar
    monkeypatch.setattr(mod, "supabase", fake)
    monkeypatch.setattr(CashRegisterService, "get_general_cash",
                        staticmethod(lambda: _Caixa(fake.caixa_geral)))
    return fake


def _pendente(valor=300):
    return {"id": "sp1", "stage_id": ETAPA, "staff_id": STAFF, "amount": valor,
            "status": "pending", "paid_at": None, "paid_by": None}


def test_pagar_debita_o_caixa_geral_e_marca_pago(monkeypatch):
    fake = _monta(monkeypatch, pagamentos=[_pendente()])
    linha = P.pay(ETAPA, STAFF, 300, AUTOR)
    assert fake.caixa_geral == Decimal("700")
    assert linha["status"] == "paid" and linha["paid_by"] == AUTOR
    assert fake.rpc_calls[0][0] == "debit_general_cash_register"


def test_pagar_sem_registro_previo_cria_o_pagamento(monkeypatch):
    fake = _monta(monkeypatch)
    P.pay(ETAPA, STAFF, 250, AUTOR)
    assert fake.caixa_geral == Decimal("750")
    assert fake.store["staff_payments"][0]["status"] == "paid"


def test_pagar_duas_vezes_nao_debita_duas_vezes(monkeypatch):
    fake = _monta(monkeypatch, pagamentos=[_pendente()])
    P.pay(ETAPA, STAFF, 300, AUTOR)
    with pytest.raises(ErroDeNegocio) as exc:
        P.pay(ETAPA, STAFF, 300, AUTOR)
    assert exc.value.code == "pagamento_de_funcionario_ja_registrado"
    assert fake.caixa_geral == Decimal("700")


def test_sem_saldo_nada_muda(monkeypatch):
    fake = _monta(monkeypatch, saldo=100, pagamentos=[_pendente()])
    with pytest.raises(ErroDeNegocio) as exc:
        P.pay(ETAPA, STAFF, 300, AUTOR)
    assert exc.value.code == "saldo_insuficiente_no_caixa_geral"
    assert fake.store["staff_payments"][0]["status"] == "pending"
    assert fake.caixa_geral == Decimal("100")


def test_saldo_que_acaba_entre_a_conferencia_e_o_debito_desfaz_a_reserva(monkeypatch):
    """Outro pagamento levou o saldo no meio do caminho: a RPC recusa e o
    funcionário volta a pendente (e, se o registro era novo, ele some)."""
    fake = _monta(monkeypatch, saldo=1000)
    fake.rpcs["debit_general_cash_register"] = lambda params: None
    with pytest.raises(ErroDeNegocio):
        P.pay(ETAPA, STAFF, 300, AUTOR)
    assert fake.store["staff_payments"] == []


def test_estornar_credita_e_volta_a_pendente(monkeypatch):
    fake = _monta(monkeypatch, saldo=700,
                  pagamentos=[dict(_pendente(), status="paid", paid_at="2026-11-10T20:00:00Z")])
    linha = P.reverse("sp1", AUTOR)
    assert fake.caixa_geral == Decimal("1000")
    assert linha["status"] == "pending" and linha["paid_at"] is None


def test_estornar_duas_vezes_nao_credita_duas_vezes(monkeypatch):
    fake = _monta(monkeypatch, saldo=700,
                  pagamentos=[dict(_pendente(), status="paid", paid_at="2026-11-10T20:00:00Z")])
    P.reverse("sp1", AUTOR)
    with pytest.raises(ErroDeNegocio) as exc:
        P.reverse("sp1", AUTOR)
    assert exc.value.code == "pagamento_de_funcionario_nao_pago"
    assert fake.caixa_geral == Decimal("1000")


def test_valor_zero_e_recusado(monkeypatch):
    _monta(monkeypatch)
    with pytest.raises(ErroDeNegocio) as exc:
        P.pay(ETAPA, STAFF, 0, AUTOR)
    assert exc.value.code == "valor_do_pagamento_obrigatorio"


class TestRotas:
    def test_pagar_vai_ao_servidor_com_a_etapa_do_header(self, client, monkeypatch):
        chamadas = []
        monkeypatch.setattr(P, "pay", staticmethod(
            lambda etapa, staff, valor, autor: chamadas.append((etapa, staff, valor)) or {"id": "sp1"}))
        r = client.post(f"/staff/payments/{STAFF}/pay", json={"amount": 300},
                        headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 200
        assert chamadas == [(ETAPA, STAFF, 300)]

    def test_pagar_sem_etapa_e_recusado(self, client):
        r = client.post(f"/staff/payments/{STAFF}/pay", json={"amount": 300})
        assert r.status_code == 400

    def test_recusa_do_servico_sai_com_codigo(self, client, monkeypatch):
        def recusa(*a):
            raise ErroDeNegocio("pagamento_de_funcionario_nao_pago", "x", status=409)
        monkeypatch.setattr(P, "reverse", staticmethod(recusa))
        r = client.post("/staff/payments/sp1/reverse")
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "pagamento_de_funcionario_nao_pago"
