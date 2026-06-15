"""Unit tests for the per-employee cashbox feature.

Focus: the reconciliation math (the bug-prone part). `_compute_session_report`
is a pure function (no DB), so we test it directly. `get_demonstrativo`
aggregation is tested with a fake Supabase client. Endpoint auth gating is
tested via the FastAPI TestClient.
"""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import cashbox_service
from app.services.cashbox_service import CashboxService, _signed

client = TestClient(app)


# ──────────────────────────────────────────────────────────────────────
# Helpers to build session/transaction fixtures
# ──────────────────────────────────────────────────────────────────────

def _tx(ttype, amount, signed):
    return {"type": ttype, "amount": amount, "signed_amount": signed}


def _session(**kw):
    base = {
        "id": "sess-1",
        "cashbox_id": "cb-1",
        "opened_at": "2026-05-21T20:00:00Z",
        "closed_at": None,
        "initial_balance": 0,
        "actual_final_balance": None,
        "difference": None,
    }
    base.update(kw)
    return base


# ──────────────────────────────────────────────────────────────────────
# _signed
# ──────────────────────────────────────────────────────────────────────

class TestSigned:
    def test_inflows_positive(self):
        assert _signed(100, "buy_in") == 100
        assert _signed(100, "rebuy") == 100
        assert _signed(100, "addon") == 100
        assert _signed(100, "supply") == 100

    def test_outflows_negative(self):
        assert _signed(100, "prize") == -100
        assert _signed(100, "sangria") == -100

    def test_uses_absolute_value(self):
        assert _signed(-50, "buy_in") == 50
        assert _signed(-50, "sangria") == -50

    def test_adjustment_passes_sign_through(self):
        assert _signed(10, "adjustment") == 10
        assert _signed(-5, "adjustment") == -5


# ──────────────────────────────────────────────────────────────────────
# _compute_session_report — the reconciliation crown jewel
# ──────────────────────────────────────────────────────────────────────

class TestComputeSessionReport:
    def test_closed_with_shortage(self):
        """open 100, +50 supply, -30 sangria → expected 120; counted 115 → diff -5."""
        session = _session(
            closed_at="2026-05-21T21:00:00Z",
            initial_balance=100,
            actual_final_balance=115,
            difference=-5,
        )
        txs = [
            _tx("supply", 100, 100),   # opening balance booked as supply
            _tx("supply", 50, 50),
            _tx("sangria", 30, -30),
            _tx("adjustment", 5, -5),  # closing diff booked as adjustment
        ]
        r = CashboxService._compute_session_report(session, {"current_balance": 115}, txs)
        assert r.is_open is False
        assert r.initial_balance == 100
        assert r.total_supply == 50      # opening supply excluded
        assert r.total_sangria == 30
        assert r.total_adjustments == -5
        assert r.expected_balance == 120  # excludes the -5 adjustment
        assert r.actual_balance == 115
        assert r.difference == -5

    def test_closed_with_surplus(self):
        session = _session(
            closed_at="2026-05-21T21:00:00Z",
            initial_balance=0,
            actual_final_balance=110,
            difference=10,
        )
        txs = [_tx("buy_in", 100, 100), _tx("adjustment", 10, 10)]
        r = CashboxService._compute_session_report(session, {"current_balance": 110}, txs)
        assert r.expected_balance == 100   # excludes +10 adjustment
        assert r.actual_balance == 110
        assert r.difference == 10
        assert r.total_buy_ins == 100
        assert r.buy_in_count == 1

    def test_closed_exact_no_difference(self):
        session = _session(
            closed_at="2026-05-21T21:00:00Z",
            initial_balance=200,
            actual_final_balance=200,
            difference=0,
        )
        txs = [_tx("supply", 200, 200)]  # only the opening balance
        r = CashboxService._compute_session_report(session, {"current_balance": 200}, txs)
        assert r.initial_balance == 200
        assert r.total_supply == 0       # opening supply excluded
        assert r.expected_balance == 200
        assert r.actual_balance == 200
        assert r.difference == 0

    def test_open_session_uses_live_balance_and_zero_difference(self):
        session = _session(initial_balance=100)  # no closed_at → open
        txs = [_tx("supply", 100, 100), _tx("buy_in", 50, 50)]
        r = CashboxService._compute_session_report(session, {"current_balance": 150}, txs)
        assert r.is_open is True
        assert r.expected_balance == 150
        assert r.actual_balance == 150
        assert r.difference == 0
        assert r.total_buy_ins == 50

    def test_buy_ins_and_prizes_counted(self):
        session = _session(initial_balance=0)
        txs = [
            _tx("buy_in", 100, 100),
            _tx("buy_in", 100, 100),
            _tx("rebuy", 50, 50),
            _tx("addon", 25, 25),
            _tx("prize", 60, -60),
        ]
        r = CashboxService._compute_session_report(session, {"current_balance": 215}, txs)
        assert r.total_buy_ins == 200 and r.buy_in_count == 2
        assert r.total_rebuys == 50 and r.rebuy_count == 1
        assert r.total_addons == 25 and r.addon_count == 1
        assert r.total_prizes_paid == 60 and r.prize_count == 1
        assert r.expected_balance == 215  # 100+100+50+25-60

    def test_extra_supply_excludes_opening_only(self):
        session = _session(initial_balance=100)
        txs = [_tx("supply", 100, 100), _tx("supply", 30, 30), _tx("supply", 20, 20)]
        r = CashboxService._compute_session_report(session, {"current_balance": 150}, txs)
        assert r.total_supply == 50  # 150 total - 100 opening

    def test_empty_session(self):
        session = _session(initial_balance=0)
        r = CashboxService._compute_session_report(session, {"current_balance": 0}, [])
        assert r.expected_balance == 0
        assert r.actual_balance == 0
        assert r.difference == 0


# ──────────────────────────────────────────────────────────────────────
# get_demonstrativo aggregation — with a fake Supabase
# ──────────────────────────────────────────────────────────────────────

class _FakeQuery:
    def __init__(self, rows):
        self._rows = rows

    # All filter/order ops are no-ops for these aggregation tests (we supply
    # exactly the rows we want returned and assert on the rollup).
    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def in_(self, *a, **k):
        return self

    def gte(self, *a, **k):
        return self

    def lte(self, *a, **k):
        return self

    def order(self, *a, **k):
        return self

    def execute(self):
        return SimpleNamespace(data=self._rows)


class _FakeSupabase:
    def __init__(self, tables):
        self._tables = tables

    def table(self, name):
        return _FakeQuery(self._tables.get(name, []))


class TestDemonstrativoAggregation:
    def test_grand_totals_across_sessions(self, monkeypatch):
        tables = {
            "cashboxes": [
                {"id": "cb-1", "staff_id": "s1", "stage_id": "st1", "status": "closed", "current_balance": 0},
                {"id": "cb-2", "staff_id": "s2", "stage_id": "st1", "status": "open", "current_balance": 150},
            ],
            "cashbox_sessions": [
                {  # closed with shortage
                    "id": "sess-1", "cashbox_id": "cb-1",
                    "opened_at": "2026-05-21T20:00:00Z", "closed_at": "2026-05-21T21:00:00Z",
                    "initial_balance": 100, "actual_final_balance": 115, "difference": -5,
                },
                {  # open
                    "id": "sess-2", "cashbox_id": "cb-2",
                    "opened_at": "2026-05-21T22:00:00Z", "closed_at": None,
                    "initial_balance": 100, "actual_final_balance": None, "difference": None,
                },
            ],
            "cashbox_transactions": [
                {"session_id": "sess-1", "type": "supply", "amount": 100, "signed_amount": 100},
                {"session_id": "sess-1", "type": "supply", "amount": 50, "signed_amount": 50},
                {"session_id": "sess-1", "type": "sangria", "amount": 30, "signed_amount": -30},
                {"session_id": "sess-1", "type": "adjustment", "amount": 5, "signed_amount": -5},
                {"session_id": "sess-2", "type": "supply", "amount": 100, "signed_amount": 100},
                {"session_id": "sess-2", "type": "buy_in", "amount": 50, "signed_amount": 50},
            ],
            "staff": [{"id": "s1", "name": "Ana"}, {"id": "s2", "name": "Bruno"}],
            "stages": [{"id": "st1", "name": "São Paulo"}],
        }
        monkeypatch.setattr(cashbox_service, "supabase", _FakeSupabase(tables))

        out = CashboxService.get_demonstrativo(stage_id="st1")

        assert len(out.sessions) == 2
        assert out.open_session_count == 1
        # sess-1: initial 100, +50 supply, -30 sangria; sess-2: +50 buy_in
        assert out.grand_initial == 200          # 100 + 100
        assert out.grand_supply == 50            # additional only
        assert out.grand_sangria == 30
        assert out.grand_buy_ins == 50
        assert out.grand_expected == 270         # 120 (sess1) + 150 (sess2)
        # actual: sess1 counted 115, sess2 live 150
        assert out.grand_actual == 265
        # difference: sess1 -5, sess2 open (0)
        assert out.grand_difference == -5

    def test_no_cashboxes_returns_empty(self, monkeypatch):
        monkeypatch.setattr(cashbox_service, "supabase", _FakeSupabase({}))
        out = CashboxService.get_demonstrativo(stage_id="nope")
        assert out.sessions == []
        assert out.grand_difference == 0.0


# ──────────────────────────────────────────────────────────────────────
# Endpoint auth gating
# ──────────────────────────────────────────────────────────────────────

class TestDemonstrativoEndpointAuth:
    def test_requires_authentication(self):
        resp = client.get("/cashboxes/demonstrativo")
        assert resp.status_code in (401, 403)
