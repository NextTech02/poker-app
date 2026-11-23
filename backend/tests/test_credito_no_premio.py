"""Crédito de patrocinador × pagamento de prêmio de posição.

O desconto existia (`deduct_from_prize`), mas nada o chamava: "Desc. Prêmio"
e "Quitado (Prêmio)" nunca mudavam e o clube cobrava do patrocinador um
crédito que o ganhador podia ter devolvido. Trava:

1. Quem usou crédito recebe o prêmio menos o crédito usado; o caixa geral
   sai pelo líquido e o prêmio fica BRUTO na transação.
2. Com fiado, o fiado sai primeiro (proposto sobre o bruto, como as telas
   mandam) e o crédito desconta do que sobra.
3. Crédito da Fidelidade não volta pelo prêmio (é brinde do clube).
4. Se o pagamento falha, nenhum crédito é baixado.
"""
from decimal import Decimal

import pytest

from app.models.prize_allocation import PrizePayoutRequest
from app.services import player_credit_service as credmod
from app.services.player_credit_service import PlayerCreditService
from app.services.prize_allocation_service import PrizeAllocationService

from tests.conftest import FakeSupabase
from tests.test_fiado_premio import _deve
from tests.test_prize_payout import ALLOC, PLAYER, TOUR, _monta

PATRO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"
FIDELIDADE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2"


def _credito(id_="c1", usado=150.0, restante=0.0, sponsor=PATRO, status="fully_used"):
    return {"id": id_, "player_id": PLAYER, "sponsor_id": sponsor, "stage_id": None,
            "original_amount": usado + restante, "remaining_amount": restante,
            "used_amount": usado, "prize_deduction_amount": 0, "sponsor_owes": usado,
            "status": status, "created_at": "2026-06-01T00:00:00Z"}


def _usou_credito(monkeypatch, creditos, fidelidade=None):
    fake = FakeSupabase({
        "player_credits": creditos,
        "credit_transactions": [],
        "loyalty_settings": [{"organization_id": "o1", "system_sponsor_id": fidelidade}] if fidelidade else [],
    })
    monkeypatch.setattr(credmod, "supabase", fake)
    return fake


def _pedido(**extra):
    return PrizePayoutRequest(player_id=PLAYER, document_type="national_id",
                              document_number="123456", paid_by="Caixa", **extra)


def test_credito_usado_volta_pelo_premio(monkeypatch):
    fake = _monta(monkeypatch)
    creditos = _usou_credito(monkeypatch, [_credito(usado=150)])
    r = PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)

    assert fake.caixa_geral == Decimal("9650")          # 10000 − (500 − 150)
    premio = [t for t in fake.store["transactions"] if t.get("type") == "prize"][0]
    assert float(premio["amount"]) == 500.0             # o prêmio fica bruto
    assert fake.store["prize_allocations"][0]["net_paid"] == 350
    assert r.credit_deduction == 150 and r.net_paid == 350

    credito = creditos.store["player_credits"][0]
    assert float(credito["prize_deduction_amount"]) == 150
    assert float(credito["sponsor_owes"]) == 0
    assert credito["status"] == "settled_by_prize"
    lanc = creditos.store["credit_transactions"][0]
    assert lanc["type"] == "prize_deduction" and lanc["tournament_id"] == TOUR


def test_credito_maior_que_o_premio_desconta_so_o_premio(monkeypatch):
    """O resto continua com o patrocinador, não vira dívida do jogador."""
    fake = _monta(monkeypatch)
    creditos = _usou_credito(monkeypatch, [_credito(usado=800)])
    PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)
    assert fake.caixa_geral == Decimal("10000")
    assert fake.store["prize_allocations"][0]["net_paid"] == 0
    assert float(creditos.store["player_credits"][0]["sponsor_owes"]) == 300


def test_fiado_sai_primeiro_e_o_credito_desconta_do_resto(monkeypatch):
    """Prêmio 500, fiado 400, crédito 150: o fiado leva 400 (proposto sobre o
    bruto) e o crédito só os 100 que sobram; 50 seguem com o patrocinador."""
    fake = _monta(monkeypatch)
    _deve(monkeypatch, 400)
    creditos = _usou_credito(monkeypatch, [_credito(usado=150)])
    r = PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(debt_offset_amount=400), user_id=None)

    assert fake.caixa_geral == Decimal("10000")
    linha = fake.store["prize_allocations"][0]
    assert linha["debt_offset"] == 400 and linha["net_paid"] == 0
    assert r.credit_deduction == 100
    credito = creditos.store["player_credits"][0]
    assert float(credito["prize_deduction_amount"]) == 100
    assert float(credito["sponsor_owes"]) == 50


def test_credito_da_fidelidade_nao_volta_pelo_premio(monkeypatch):
    fake = _monta(monkeypatch)
    creditos = _usou_credito(monkeypatch, [_credito(usado=150, sponsor=FIDELIDADE)],
                             fidelidade=FIDELIDADE)
    r = PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)
    assert fake.caixa_geral == Decimal("9500")
    assert r.credit_deduction is None
    assert "net_paid" not in fake.store["prize_allocations"][0]
    assert creditos.store["credit_transactions"] == []


def test_pagamento_recusado_nao_baixa_o_credito(monkeypatch):
    fake = _monta(monkeypatch, saldo=100)              # caixa geral sem saldo para 350
    creditos = _usou_credito(monkeypatch, [_credito(usado=150)])
    with pytest.raises(Exception):
        PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)
    assert float(creditos.store["player_credits"][0]["prize_deduction_amount"]) == 0
    assert creditos.store["credit_transactions"] == []
    assert fake.store["prize_allocations"][0]["paid"] is False


def test_previa_do_desconto_ignora_a_fidelidade_e_o_ja_descontado(monkeypatch):
    _usou_credito(monkeypatch, [
        _credito("c1", usado=150),
        dict(_credito("c2", usado=100), prize_deduction_amount=100),
        _credito("c3", usado=70, sponsor=FIDELIDADE),
        _credito("c4", usado=30, restante=20, status="active"),
    ], fidelidade=FIDELIDADE)
    assert PlayerCreditService.outstanding_for_prize(PLAYER) == 180


def test_sem_credito_o_pagamento_segue_igual(monkeypatch):
    fake = _monta(monkeypatch)
    r = PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)
    assert fake.caixa_geral == Decimal("9500")
    assert r.credit_deduction is None
