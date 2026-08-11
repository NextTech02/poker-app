"""Testes do pagamento de premio — a saida de dinheiro do caixa geral.

Ha varios portoes antes do dinheiro sair, e cada um existe por um motivo:
premio ja pago (pagar duas vezes), nao liberado (pagar antes de conferir),
tipo 'vaga' (nao e dinheiro), saldo insuficiente e documento divergente
(pagar para a pessoa errada).
"""
import pytest
from fastapi import HTTPException

from app.services import prize_allocation_service
from app.services.prize_allocation_service import PrizeAllocationService
from app.services.cash_register_service import CashRegisterService
from app.models.prize_allocation import PrizePayoutRequest

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
ALLOC = "55555555-5555-5555-5555-555555555555"
PLAYER = "44444444-4444-4444-4444-444444444444"


class _Caixa:
    def __init__(self, saldo):
        from decimal import Decimal
        self.current_balance = Decimal(str(saldo))
        self.id = "gc1"
        self.total_received = Decimal("0")


def _alocacao(paid=False, released=True, tipo="dinheiro", valor=500):
    return {
        "id": ALLOC, "tournament_id": TOUR, "position": 1,
        "prize_amount": valor, "percentage": 50, "paid": paid,
        "released": released, "prize_type": tipo, "player_id": PLAYER,
        "created_at": "2026-06-08T00:00:00Z",
    }


def _monta(monkeypatch, alocacao=None, saldo=10000, documento="123456", tabelas=None):
    base = {
        "prize_allocations": [alocacao if alocacao is not None else _alocacao()],
        "players": [{"id": PLAYER, "name": "Fulano",
                     "document_type": "national_id", "document_number": documento}],
        # Ha um portao a mais: o premio nao pode exceder o prize pool. Sem
        # entradas o pool e zero e QUALQUER pagamento seria recusado, entao o
        # cenario precisa de dinheiro entrando no torneio.
        "transactions": [
            {"id": "tx1", "tournament_id": TOUR, "type": "buy_in",
             "amount": 2000, "rake_amount": 0, "created_at": "2026-06-08T00:00:00Z"},
        ],
        "tournament_days": [{"id": "d1", "tournament_id": TOUR,
                             "rake_percentage": 0, "day_type": "regular"}],
        "tournaments": [{"id": TOUR, "guaranteed_prize": 0, "name": "Torneio",
                         "reserved_prize_percentage": 0, "reserved_purpose": None}],
        "general_cash_register": [{"id": "gc1", "current_balance": saldo,
                                   "total_received": 0, "total_withdrawals": 0}],
    }
    base.update(tabelas or {})
    fake = FakeSupabase(base)
    monkeypatch.setattr(prize_allocation_service, "supabase", fake)
    monkeypatch.setattr(CashRegisterService, "get_general_cash",
                        staticmethod(lambda: _Caixa(saldo)))
    return fake


def _pedido(documento="123456"):
    return PrizePayoutRequest(
        player_id=PLAYER, document_type="national_id",
        document_number=documento, paid_by="Caixa",
    )


class TestPortoesDoPagamento:
    def test_alocacao_inexistente_da_404(self, monkeypatch):
        _monta(monkeypatch, tabelas={"prize_allocations": []})
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)
        assert e.value.status_code == 404

    def test_premio_ja_pago_nao_paga_de_novo(self, monkeypatch):
        _monta(monkeypatch, alocacao=_alocacao(paid=True))
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)
        assert e.value.status_code == 400
        assert "already been paid" in e.value.detail

    def test_premio_nao_liberado_e_bloqueado(self, monkeypatch):
        _monta(monkeypatch, alocacao=_alocacao(released=False))
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)
        assert "não liberada" in e.value.detail

    def test_premio_do_tipo_vaga_nao_sai_em_dinheiro(self, monkeypatch):
        _monta(monkeypatch, alocacao=_alocacao(tipo="vaga"))
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)
        assert "Vaga" in e.value.detail

    def test_saldo_insuficiente_no_caixa_geral(self, monkeypatch):
        _monta(monkeypatch, alocacao=_alocacao(valor=5000), saldo=100)
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)
        assert e.value.status_code == 400

    def test_documento_divergente_bloqueia(self, monkeypatch):
        """Confere o documento apresentado contra o cadastrado: e o que evita
        pagar o premio para a pessoa errada."""
        _monta(monkeypatch, documento="999999")
        with pytest.raises(HTTPException):
            PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido("123456"), user_id=None)

    def test_documento_com_pontuacao_diferente_e_aceito(self, monkeypatch):
        """'123.456-78' e '12345678' sao o mesmo documento; recusar seria
        travar o pagamento por formatacao."""
        _monta(monkeypatch, documento="123.456-78")
        r = PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido("12345678"), user_id=None)
        assert r.paid is True


class TestPagamentoEfetivo:
    def test_marca_como_pago_e_registra_o_documento(self, monkeypatch):
        fake = _monta(monkeypatch)
        r = PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)

        assert r.paid is True
        linha = fake.store["prize_allocations"][0]
        assert linha["paid"] is True
        assert linha["document_number"] == "123456"

    def test_gera_transacao_de_premio_para_rastreio(self, monkeypatch):
        """A transacao 'prize' e o que faz o premio aparecer como deducao no
        DRE; sem ela o resultado da etapa ficaria inflado."""
        fake = _monta(monkeypatch)
        PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)

        prizes = [t for t in fake.store["transactions"] if t.get("type") == "prize"]
        assert len(prizes) == 1
        assert float(prizes[0]["amount"]) == 500.0
