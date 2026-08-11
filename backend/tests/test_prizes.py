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
            "id": "a1", "tournament_id": TOURNAMENT_UUID, "paid": False, "released": False,
            "prize_type": "vaga", "player_id": None, "generated_ticket_id": None,
            "vaga_target_day_id": DAY_UUID, "vaga_target_tournament_id": TOURNAMENT_UUID,
            "position": 1,
        }]}
        monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(tables))
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.set_released(TOURNAMENT_UUID, "a1", released=True, user_id="u")
        assert exc.value.status_code == 400
        assert "jogador" in exc.value.detail.lower()
