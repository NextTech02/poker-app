"""PAGAMENTOS da comanda: parcial, dividido, crédito, estorno.

O que estes testes travam:

1. **Uma linha por perna**, com `client_mutation_id` derivado (`cmid:i`) —
   duplo clique não cobra duas vezes.
2. **Só dinheiro real exige a gaveta aberta** e leva `cashbox_id`; a perna de
   crédito NÃO passa pela gaveta e consome `player_credits` com o lançamento
   `credit_used_bar` apontando para a perna.
3. **Nunca acima do saldo**; crédito exige saldo suficiente (o consumo parcial
   silencioso do `use_credit` deixaria a comanda com saldo que ninguém pediu).
4. **Estorno é retomável e guardado por EFEITO**: o `refund` com
   `bar_payment_id` é o recibo; repetir não duplica; crédito não estorna.
"""
import pytest

from app.models.bar import BarPaymentLeg, BarTabPay
from app.services import bar_shift_service as turno_mod
from app.services import bar_product_service as prod_mod
from app.services import bar_tab_service as tab_mod
from app.services import cashbox_service as caixa_mod
from app.services import player_credit_service as cred_mod
from app.services.bar_tab_service import BarTabService as BTS

from tests.conftest import FakeSupabase
from tests.test_bar_comandas import (
    AUTH, COMANDA, JOGADOR, ORG, TURNO, _comanda, _item, _pagamento, _turno, recusa,
)


def _credito(restante=15.0, **extra):
    linha = {"id": "cr1", "player_id": JOGADOR, "sponsor_id": "sp1", "status": "active",
             "original_amount": restante, "remaining_amount": restante, "used_amount": 0,
             "prize_deduction_amount": 0, "sponsor_owes": 0, "created_at": "2026-09-01T00:00:00Z",
             "organization_id": ORG}
    linha.update(extra)
    return linha


def _banco(monkeypatch, **tabelas):
    base = {
        "bar_shifts": [_turno()],
        "bar_tabs": [_comanda()],
        "bar_tab_items": [_item(status="delivered"), _item(id="i2", product_id="p-porcao",
                          product_name="Porção", unit_price=30, unit_cost=12, quantity=1,
                          line_total=30, status="delivered")],          # total 50
        "bar_tab_payments": [],
        "bar_products": [],
        "players": [{"id": JOGADOR, "name": "Ana", "nickname": None}],
        "player_credits": [],
        "credit_transactions": [],
        "staff": [{"id": "s1", "auth_user_id": AUTH, "name": "Barman", "active": True,
                   "permission_groups": {"permissions": ["bar.operate", "cashbox.operate"]}}],
        "cashboxes": [{"id": "cb1", "staff_id": "s1", "bar_shift_id": TURNO, "stage_id": None,
                       "cash_day_id": None, "status": "open", "current_balance": 100,
                       "current_session_id": "cs1", "created_at": "2026-09-16T19:00:00Z"}],
        "cashbox_sessions": [{"id": "cs1", "cashbox_id": "cb1", "initial_balance": 100,
                              "opened_at": "2026-09-16T19:00:00Z"}],
        "cashbox_transactions": [],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    for mod in (turno_mod, prod_mod, tab_mod, caixa_mod, cred_mod):
        monkeypatch.setattr(mod, "supabase", fake)
    return fake


def _pagar(pernas, cmid=None):
    return BarTabPay(legs=[BarPaymentLeg(**p) for p in pernas], client_mutation_id=cmid)


# ══════════════════════════════════════════════════════════════════════
# Pagar
# ══════════════════════════════════════════════════════════════════════

def test_pagamento_parcial_deixa_a_comanda_aberta_com_saldo(monkeypatch):
    fake = _banco(monkeypatch)
    d = BTS.pay(COMANDA, _pagar([{"payment_method": "pix", "amount": 20}]), AUTH, ORG)
    assert d.tab.status == "open"
    assert d.tab.paid_amount == 20 and d.tab.balance_due == 30
    perna = fake.store["bar_tab_payments"][0]
    assert perna["payment_source"] == "cash" and perna["cashbox_id"] == "cb1"
    assert perna["created_by"] == AUTH and perna["organization_id"] == ORG


def test_pagamento_dividido_e_uma_linha_por_perna_com_mutation_derivado(monkeypatch):
    fake = _banco(monkeypatch)
    dados = _pagar([{"payment_method": "pix", "amount": 20}, {"payment_method": "cash", "amount": 30}], cmid="cm-9")
    d = BTS.pay(COMANDA, dados, AUTH, ORG)
    assert d.tab.paid_amount == 50 and d.tab.balance_due == 0
    ids = [p["client_mutation_id"] for p in fake.store["bar_tab_payments"]]
    assert ids == ["cm-9:0", "cm-9:1"]

    # Duplo clique: nada novo.
    BTS.pay(COMANDA, dados, AUTH, ORG)
    assert len(fake.store["bar_tab_payments"]) == 2


def test_acima_do_saldo_e_recusado_antes_de_gravar(monkeypatch):
    fake = _banco(monkeypatch)
    with pytest.raises(Exception) as exc:
        BTS.pay(COMANDA, _pagar([{"payment_method": "pix", "amount": 60}]), AUTH, ORG)
    d = recusa(exc)
    assert d["code"] == "pagamento_acima_do_saldo"
    assert d["saldo"] == 50 and d["solicitado"] == 60
    assert fake.store["bar_tab_payments"] == []


def test_pagamento_vazio_e_recusado(monkeypatch):
    _banco(monkeypatch)
    with pytest.raises(Exception) as exc:
        BTS.pay(COMANDA, BarTabPay(legs=[BarPaymentLeg(payment_method="pix", amount=0.001)]), AUTH, ORG)
    assert recusa(exc)["code"] == "pagamento_vazio"


def test_dinheiro_exige_a_gaveta_aberta(monkeypatch):
    fake = _banco(monkeypatch)
    fake.store["cashboxes"][0]["status"] = "closed"
    with pytest.raises(Exception) as exc:
        BTS.pay(COMANDA, _pagar([{"payment_method": "cash", "amount": 10}]), AUTH, ORG)
    assert recusa(exc)["code"] == "caixa_fechado"
    assert fake.store["bar_tab_payments"] == []


def test_credito_nao_passa_pela_gaveta_e_consome_o_credito(monkeypatch):
    fake = _banco(monkeypatch, player_credits=[_credito(15)])
    fake.store["cashboxes"][0]["status"] = "closed"   # gaveta fechada NÃO impede crédito
    d = BTS.pay(COMANDA, _pagar([{"payment_method": "credit", "amount": 15, "payment_source": "credit"}]), AUTH, ORG)
    assert d.tab.paid_amount == 15
    perna = fake.store["bar_tab_payments"][0]
    assert perna["payment_source"] == "credit" and perna["cashbox_id"] is None
    assert float(fake.store["player_credits"][0]["remaining_amount"]) == 0
    lanc = fake.store["credit_transactions"][0]
    assert lanc["type"] == "credit_used_bar" and lanc["bar_payment_id"] == perna["id"]
    assert lanc["tournament_id"] is None
    assert d.player_available_credit == 0


def test_credito_insuficiente_e_recusado_sem_consumir(monkeypatch):
    fake = _banco(monkeypatch, player_credits=[_credito(10)])
    with pytest.raises(Exception) as exc:
        BTS.pay(COMANDA, _pagar([{"payment_method": "credit", "amount": 15, "payment_source": "credit"}]), AUTH, ORG)
    d = recusa(exc)
    assert d["code"] == "credito_insuficiente" and d["disponivel"] == 10 and d["solicitado"] == 15
    assert fake.store["bar_tab_payments"] == []
    assert float(fake.store["player_credits"][0]["remaining_amount"]) == 10


def test_split_com_credito_e_dinheiro(monkeypatch):
    fake = _banco(monkeypatch, player_credits=[_credito(15)])
    BTS.pay(COMANDA, _pagar([{"payment_method": "pix", "amount": 20}]), AUTH, ORG)
    d = BTS.pay(COMANDA, _pagar([
        {"payment_method": "credit", "amount": 15, "payment_source": "credit"},
        {"payment_method": "cash", "amount": 15},
    ]), AUTH, ORG)
    assert d.tab.paid_amount == 50 and d.tab.balance_due == 0
    fontes = sorted((p["payment_source"], p["cashbox_id"]) for p in fake.store["bar_tab_payments"])
    assert fontes == [("cash", "cb1"), ("cash", "cb1"), ("credit", None)]


def test_comanda_fechada_nao_recebe_pagamento(monkeypatch):
    _banco(monkeypatch, bar_tabs=[_comanda(status="closed")])
    with pytest.raises(Exception) as exc:
        BTS.pay(COMANDA, _pagar([{"payment_method": "pix", "amount": 1}]), AUTH, ORG)
    assert recusa(exc)["code"] == "comanda_nao_aberta"


def test_super_admin_sem_gaveta_paga_em_dinheiro(monkeypatch):
    """Sem linha em staff mas na allowlist: passa sem gaveta, como no torneio."""
    fake = _banco(monkeypatch, staff=[])
    from app.config import get_settings
    monkeypatch.setattr(type(get_settings()), "super_admin_ids", property(lambda self: {AUTH}), raising=False)
    d = BTS.pay(COMANDA, _pagar([{"payment_method": "pix", "amount": 20}]), AUTH, ORG)
    assert d.tab.paid_amount == 20
    assert fake.store["bar_tab_payments"][0]["cashbox_id"] is None


# ══════════════════════════════════════════════════════════════════════
# Estorno
# ══════════════════════════════════════════════════════════════════════

def test_estorno_grava_o_recibo_na_gaveta_e_marca(monkeypatch):
    fake = _banco(monkeypatch, bar_tab_payments=[_pagamento(amount=20)])
    d = BTS.cancel_payment(COMANDA, "p1", "cobrado errado", AUTH)
    assert d.tab.paid_amount == 0 and d.tab.balance_due == 50
    perna = fake.store["bar_tab_payments"][0]
    assert perna["status"] == "cancelled" and perna["cancel_reason"] == "cobrado errado"
    assert perna["cancel_steps"] == ["caixa", "marcar"]
    recibo = fake.store["cashbox_transactions"][0]
    assert recibo["type"] == "refund" and recibo["signed_amount"] == -20
    assert recibo["bar_payment_id"] == "p1" and recibo["cashbox_id"] == "cb1"
    assert recibo["organization_id"] == ORG


def test_estorno_repetido_nao_devolve_duas_vezes(monkeypatch):
    """A guarda é o EFEITO (o recibo existe?), não o marcador."""
    fake = _banco(monkeypatch, bar_tab_payments=[_pagamento(amount=20, status="cancelling", cancel_steps=[])])
    BTS.cancel_payment(COMANDA, "p1", "x", AUTH)
    BTS.cancel_payment(COMANDA, "p1", "x", AUTH)
    assert len(fake.store["cashbox_transactions"]) == 1


def test_estorno_retoma_do_meio(monkeypatch):
    """Recibo já gravado, status ainda 'cancelling' (o processo caiu entre os
    passos): a retentativa NÃO duplica o recibo e conclui."""
    fake = _banco(monkeypatch,
                  bar_tab_payments=[_pagamento(amount=20, status="cancelling", cancel_steps=["caixa"])],
                  cashbox_transactions=[{"id": "r1", "cashbox_id": "cb1", "type": "refund", "amount": 20,
                                         "signed_amount": -20, "bar_payment_id": "p1"}])
    BTS.cancel_payment(COMANDA, "p1", "x", AUTH)
    assert len(fake.store["cashbox_transactions"]) == 1
    assert fake.store["bar_tab_payments"][0]["status"] == "cancelled"


def test_perna_de_credito_nao_e_estornavel(monkeypatch):
    _banco(monkeypatch, bar_tab_payments=[_pagamento(payment_method="credit", payment_source="credit", cashbox_id=None)])
    with pytest.raises(Exception) as exc:
        BTS.cancel_payment(COMANDA, "p1", "x", AUTH)
    assert recusa(exc)["code"] == "pagamento_com_credito_nao_estornavel"


def test_comanda_fechada_exige_reabrir_para_estornar(monkeypatch):
    _banco(monkeypatch, bar_tabs=[_comanda(status="closed")], bar_tab_payments=[_pagamento()])
    with pytest.raises(Exception) as exc:
        BTS.cancel_payment(COMANDA, "p1", "x", AUTH)
    assert exc.value.status == 409
    assert recusa(exc)["code"] == "comanda_fechada"
