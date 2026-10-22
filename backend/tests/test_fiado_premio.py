"""FIADO × prêmio de torneio (posição e KO) — conta única do jogador.

Trava:
1. Ganhador que deve fiado: sem o abatimento explícito, 409 e NADA muda.
2. O caixa geral sai só pelo LÍQUIDO; a transação do prêmio fica BRUTA, com
   o abatido ao lado (o DRE, o pool e o KO fecham no bruto).
3. Abatimento total: nada sai do caixa geral, e o prêmio ainda é registrado.
4. Se o banco recusa a baixa (corrida), o caixa geral volta e o prêmio volta
   a ficar a pagar.
5. Prêmio pago pelo caixa não se desmarca (reabriria o pagamento).
"""
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.models.prize_allocation import PrizeAllocationUpdate, PrizePayoutRequest
from app.services import house_credit_service as fiado_mod
from app.services.house_credit_service import HouseCreditService
from app.services.prize_allocation_service import PrizeAllocationService
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase
from tests.test_prize_payout import ALLOC, PLAYER, TOUR, _alocacao, _monta

ORG = "33333333-3333-3333-3333-333333333333"


def _deve(monkeypatch, saldo):
    fake = FakeSupabase({
        "house_credit_accounts": [{"id": "c1", "organization_id": ORG, "player_id": PLAYER,
                                   "enabled": True, "credit_limit": 1000, "balance": saldo}],
        "house_credit_entries": [], "house_credit_settings": [],
    })
    monkeypatch.setattr(fiado_mod, "supabase", fake)
    monkeypatch.setattr(HouseCreditService, "_tabelas_ok", None)
    return fake


def _pedido(**extra):
    return PrizePayoutRequest(player_id=PLAYER, document_type="national_id",
                              document_number="123456", paid_by="Caixa", **extra)


def _premios(fake):
    return [t for t in fake.store["transactions"] if t.get("type") == "prize"]


def test_devedor_sem_abatimento_explicito_nao_recebe(monkeypatch):
    fake = _monta(monkeypatch)
    _deve(monkeypatch, 200)
    with pytest.raises(ErroDeNegocio) as exc:
        PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)
    assert exc.value.code == "jogador_com_fiado" and exc.value.status == 409
    assert exc.value.dados["abatimento_sugerido"] == 200
    assert _premios(fake) == []
    assert not fake.store["prize_allocations"][0]["paid"]
    assert fake.caixa_geral == Decimal("10000")


def test_caixa_geral_sai_pelo_liquido_e_o_premio_fica_bruto(monkeypatch):
    fake = _monta(monkeypatch)
    _deve(monkeypatch, 200)
    r = PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(debt_offset_amount=200), user_id=None)
    assert fake.caixa_geral == Decimal("9700")          # 10000 − (500 − 200)
    premio = _premios(fake)[0]
    assert float(premio["amount"]) == 500.0
    assert premio["house_debt_offset"] == 200 and premio["house_debt_offset_expected"] == 200
    linha = fake.store["prize_allocations"][0]
    assert linha["paid"] is True and linha["debt_offset"] == 200 and linha["net_paid"] == 300
    assert r.paid is True


def test_abatimento_total_nao_tira_nada_do_caixa_geral(monkeypatch):
    fake = _monta(monkeypatch)
    _deve(monkeypatch, 900)
    PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(debt_offset_amount=500), user_id=None)
    assert fake.caixa_geral == Decimal("10000")
    assert float(_premios(fake)[0]["amount"]) == 500.0
    assert fake.store["prize_allocations"][0]["net_paid"] == 0


def test_abater_menos_exige_motivo(monkeypatch):
    _monta(monkeypatch)
    _deve(monkeypatch, 200)
    with pytest.raises(ErroDeNegocio) as exc:
        PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(debt_offset_amount=50), user_id=None)
    assert exc.value.code == "motivo_do_abatimento_obrigatorio"


def test_recusa_do_banco_desfaz_o_caixa_e_a_reserva(monkeypatch):
    fake = _monta(monkeypatch)
    _deve(monkeypatch, 200)
    original = fake.table

    def tabela(nome):
        q = original(nome)
        if nome == "transactions":
            def estoura(payload):
                raise Exception("REGRA_FIADO:valor_maior_que_a_divida devido=100.00 solicitado=200.00")
            q.insert = estoura
        return q
    monkeypatch.setattr(fake, "table", tabela)
    with pytest.raises(ErroDeNegocio) as exc:
        PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(debt_offset_amount=200), user_id=None)
    assert exc.value.code == "valor_maior_que_a_divida"
    assert fake.caixa_geral == Decimal("10000")
    assert fake.store["prize_allocations"][0]["paid"] is False


def test_sem_fiado_o_pagamento_nao_manda_coluna_nova(monkeypatch):
    fake = _monta(monkeypatch)
    PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)
    premio = _premios(fake)[0]
    assert "house_debt_offset" not in premio
    assert "net_paid" not in fake.store["prize_allocations"][0]
    assert fake.caixa_geral == Decimal("9500")


def test_premio_pago_pelo_caixa_nao_se_desmarca(monkeypatch):
    pago = {**_alocacao(paid=True), "document_number": "123456"}
    _monta(monkeypatch, alocacao=pago)
    with pytest.raises(HTTPException) as exc:
        PrizeAllocationService.update_allocation(TOUR, ALLOC, PrizeAllocationUpdate(paid=False))
    assert exc.value.detail["code"] == "premio_pago_pelo_caixa_nao_se_desmarca"
