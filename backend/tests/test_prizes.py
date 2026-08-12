"""Tests for prize features: reserved pool math, release gate, and 'vaga' type."""
import pytest
from fastapi import HTTPException

from app.services import prize_allocation_service
from app.services.prize_allocation_service import PrizeAllocationService
from app.models.prize_allocation import PrizePayoutRequest

from tests.conftest import FakeSupabase

PLAYER_UUID = "00000000-0000-0000-0000-000000000001"
# O modelo PrizeSummary exige UUID. Os ids curtos que estavam aqui ("t1"/"d1")
# passaram a quebrar a validacao quando o campo foi tipado, e o teste ficou
# vermelho sem ninguem notar.
TOURNAMENT_UUID = "00000000-0000-0000-0000-0000000000a1"
DAY_UUID = "00000000-0000-0000-0000-0000000000b1"
# O PrizeAllocationResponse tipa o id como UUID; um "a1" quebra a validação.
ALLOC_UUID = "00000000-0000-0000-0000-0000000000c1"
ALLOC2_UUID = "00000000-0000-0000-0000-0000000000c2"


def _payout():
    return PrizePayoutRequest(
        player_id=PLAYER_UUID,
        document_type="national_id",
        document_number="123",
        paid_by="Caixa",
    )


class TestReservedPool:
    def test_summary_discounts_reserved(self, monkeypatch):
        tables = {
            "tournaments": [{
                "id": TOURNAMENT_UUID, "guaranteed_prize": 0,
                "reserved_prize_percentage": 10, "reserved_purpose": "ranking",
            }],
            "tournament_days": [{"id": DAY_UUID, "tournament_id": TOURNAMENT_UUID, "rake_percentage": 0, "day_type": "regular"}],
            "tournament_players": [{
                "tournament_day_id": DAY_UUID,
                "total_buy_in_amount": 1000, "total_rebuy_amount": 0, "total_addon_amount": 0,
            }],
            "transactions": [{"tournament_id": TOURNAMENT_UUID, "amount": 1000, "type": "buy_in"}],
            "prize_allocations": [],
        }
        monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(tables))
        s = PrizeAllocationService.get_prize_summary(TOURNAMENT_UUID)
        assert float(s.available_prize_pool) == 1000
        assert float(s.reserved_amount) == 100      # 10% blocked
        assert float(s.payable_pool) == 900
        assert float(s.remaining_balance) == 900    # nothing allocated yet


class TestReleaseGate:
    def test_pay_blocked_when_not_released(self, monkeypatch):
        tables = {"prize_allocations": [{
            "id": "a1", "tournament_id": TOURNAMENT_UUID, "paid": False, "released": False,
            "prize_type": "cash", "prize_amount": 100,
        }]}
        monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(tables))
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.pay_prize(TOURNAMENT_UUID, "a1", _payout(), user_id=None)
        assert exc.value.status_code == 400
        assert "liberada" in exc.value.detail.lower()

    def test_pay_blocked_for_vaga(self, monkeypatch):
        tables = {"prize_allocations": [{
            "id": "a1", "tournament_id": TOURNAMENT_UUID, "paid": False, "released": True,
            "prize_type": "vaga", "prize_amount": 100,
        }]}
        monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(tables))
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.pay_prize(TOURNAMENT_UUID, "a1", _payout(), user_id=None)
        assert exc.value.status_code == 400
        assert "vaga" in exc.value.detail.lower()


class TestVagaRelease:
    def test_release_vaga_requires_player(self, monkeypatch):
        tables = {"prize_allocations": [{
            "id": ALLOC_UUID, "tournament_id": TOURNAMENT_UUID, "paid": False, "released": False,
            "prize_type": "vaga", "player_id": None, "generated_ticket_id": None,
            "vaga_target_day_id": DAY_UUID, "vaga_target_tournament_id": TOURNAMENT_UUID,
            "position": 1,
        }]}
        monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(tables))
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.set_released(TOURNAMENT_UUID, ALLOC_UUID, released=True, user_id="u")
        assert exc.value.status_code == 400
        assert "jogador" in exc.value.detail.lower()


class TestAtualizacaoDaFaixa:
    """Edição de uma faixa de prêmio já criada.

    Os campos de data são carimbados PELO SERVIÇO, não pelo cliente: `paid_at`
    quando a faixa vira paga, `released_at` quando vira liberada, e ambos
    voltam a nulo ao desfazer. Deixar o cliente mandar a data permitiria
    registrar um pagamento com hora inventada — e é essa hora que aparece no
    comprovante.
    """

    def _faixa(self, **kw):
        base = {
            "id": ALLOC_UUID, "tournament_id": TOURNAMENT_UUID, "position": 1,
            "prize_amount": 100, "prize_type": "cash", "paid": False,
            "released": False, "visible": True, "player_id": None,
            "created_at": "2026-06-08T00:00:00Z", "updated_at": "2026-06-08T00:00:00Z",
        }
        base.update(kw)
        return base

    def _monta(self, monkeypatch, **kw):
        fake = FakeSupabase({"prize_allocations": [self._faixa(**kw)]})
        monkeypatch.setattr(prize_allocation_service, "supabase", fake)
        return fake

    def _update(self, **kw):
        from app.models.prize_allocation import PrizeAllocationUpdate
        return PrizeAllocationUpdate(**kw)

    def test_faixa_inexistente_da_404(self, monkeypatch):
        self._monta(monkeypatch)
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.update_allocation(
                TOURNAMENT_UUID, "00000000-0000-0000-0000-0000000000ff",
                self._update(prize_amount=10))
        assert exc.value.status_code == 404

    def test_corpo_vazio_e_recusado(self, monkeypatch):
        """Sem campo nenhum, a gravação só carimbaria `updated_at` à toa."""
        self._monta(monkeypatch)
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update())
        assert exc.value.status_code == 400
        assert "No fields" in exc.value.detail

    def test_posicao_ja_ocupada_e_recusada(self, monkeypatch):
        """Duas faixas na mesma posição tornariam ambígua a premiação."""
        fake = FakeSupabase({"prize_allocations": [
            self._faixa(), self._faixa(id=ALLOC2_UUID, position=2)]})
        monkeypatch.setattr(prize_allocation_service, "supabase", fake)
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(position=2))
        assert exc.value.status_code == 400
        assert "already has" in exc.value.detail

    def test_manter_a_propria_posicao_e_permitido(self, monkeypatch):
        """A checagem exclui a própria linha, senão salvar sem mexer na posição
        daria conflito consigo mesmo."""
        self._monta(monkeypatch)
        r = PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(position=1))
        assert r.position == 1

    def test_marcar_como_paga_carimba_a_hora(self, monkeypatch):
        fake = self._monta(monkeypatch)
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(paid=True))
        linha = fake.store["prize_allocations"][0]
        assert linha["paid"] is True
        assert linha["paid_at"]

    def test_desmarcar_pagamento_limpa_a_hora(self, monkeypatch):
        """Uma faixa "não paga" com data de pagamento seria contraditória."""
        fake = self._monta(monkeypatch, paid=True, paid_at="2026-06-08T01:00:00Z")
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(paid=False))
        linha = fake.store["prize_allocations"][0]
        assert linha["paid"] is False
        assert linha["paid_at"] is None

    def test_liberar_carimba_a_hora_da_liberacao(self, monkeypatch):
        fake = self._monta(monkeypatch)
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(released=True))
        linha = fake.store["prize_allocations"][0]
        assert linha["released"] is True
        assert linha["released_at"]

    def test_revogar_liberacao_limpa_hora_e_autor(self, monkeypatch):
        """Sem limpar o autor, o histórico diria que alguém liberou algo que
        não está liberado."""
        fake = self._monta(monkeypatch, released=True,
                           released_at="2026-06-08T01:00:00Z", released_by="u1")
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(released=False))
        linha = fake.store["prize_allocations"][0]
        assert linha["released"] is False
        assert linha["released_at"] is None
        assert linha["released_by"] is None

    def test_esconder_do_publico_nao_apaga_o_valor(self, monkeypatch):
        """É como o clube segura a premiação antes da hora, sem perder o dado."""
        fake = self._monta(monkeypatch)
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(visible=False))
        linha = fake.store["prize_allocations"][0]
        assert linha["visible"] is False
        assert float(linha["prize_amount"]) == 100

    def test_alterar_o_valor_grava_como_numero(self, monkeypatch):
        fake = self._monta(monkeypatch)
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID,
                                                 self._update(prize_amount="250.50"))
        assert fake.store["prize_allocations"][0]["prize_amount"] == 250.50

    def test_toda_alteracao_carimba_updated_at(self, monkeypatch):
        fake = self._monta(monkeypatch)
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(visible=False))
        assert fake.store["prize_allocations"][0]["updated_at"] != "2026-06-08T00:00:00Z"


class TestRevogacaoDeLiberacao:
    def test_nao_da_para_revogar_liberacao_de_premio_JA_PAGO(self, monkeypatch):
        """O dinheiro já saiu; revogar deixaria o registro dizendo que o
        pagamento nunca foi autorizado."""
        tables = {"prize_allocations": [{
            "id": ALLOC_UUID, "tournament_id": TOURNAMENT_UUID, "paid": True,
            "released": True, "prize_type": "cash", "prize_amount": 100,
        }]}
        monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(tables))
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.set_released(TOURNAMENT_UUID, ALLOC_UUID, released=False)
        assert exc.value.status_code == 400
        assert "já pago" in exc.value.detail.lower()

    def test_faixa_inexistente_da_404(self, monkeypatch):
        monkeypatch.setattr(prize_allocation_service, "supabase",
                            FakeSupabase({"prize_allocations": []}))
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.set_released(TOURNAMENT_UUID, ALLOC_UUID, released=True)
        assert exc.value.status_code == 404
