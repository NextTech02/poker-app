"""Tests for the Sangi (chip consignment) feature and permission enforcement."""
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app
from app.models.staff import MyPermissions
from app.models.chip_consignment import ConsignmentRelease, SaleCreate
from app.services import chip_consignment_service
from app.services.chip_consignment_service import ChipConsignmentService
from app.services import staff_service
from app.services.staff_service import StaffService
from app.auth.jwt import get_current_user
from app.auth.permissions import require_permission, forbid_permission

from tests.conftest import FakeSupabase

client = TestClient(app)


def _perms(monkeypatch, is_admin=False, permissions=None):
    mp = MyPermissions(is_admin=is_admin, permissions=permissions or [], group_name="g")
    monkeypatch.setattr(StaffService, "get_my_permissions", staticmethod(lambda auth_user_id: mp))


# ──────────────────────────────────────────────────────────────────────
# require_permission / forbid_permission (pure dependency logic)
# ──────────────────────────────────────────────────────────────────────

class TestRequirePermission:
    def test_admin_bypasses(self, monkeypatch):
        _perms(monkeypatch, is_admin=True)
        dep = require_permission("cashier")
        assert dep(current_user={"sub": "u"}) == {"sub": "u"}

    def test_has_required_permission(self, monkeypatch):
        _perms(monkeypatch, permissions=["sangi"])
        dep = require_permission("sangi", "cashier")
        assert dep(current_user={"sub": "u"}) == {"sub": "u"}

    def test_missing_permission_403(self, monkeypatch):
        _perms(monkeypatch, permissions=["players"])
        dep = require_permission("cashier", "general_cash")
        with pytest.raises(HTTPException) as exc:
            dep(current_user={"sub": "u"})
        assert exc.value.status_code == 403


class TestForbidPermission:
    def test_sangi_only_is_blocked(self, monkeypatch):
        _perms(monkeypatch, permissions=["sangi"])
        dep = forbid_permission("sangi")
        with pytest.raises(HTTPException) as exc:
            dep(current_user={"sub": "u"})
        assert exc.value.status_code == 403

    def test_admin_bypasses(self, monkeypatch):
        _perms(monkeypatch, is_admin=True)
        dep = forbid_permission("sangi")
        assert dep(current_user={"sub": "u"}) == {"sub": "u"}

    def test_mixed_permissions_allowed(self, monkeypatch):
        # A user with sangi + cashier still has legitimate financial access
        _perms(monkeypatch, permissions=["sangi", "cashier"])
        dep = forbid_permission("sangi")
        assert dep(current_user={"sub": "u"}) == {"sub": "u"}


# ──────────────────────────────────────────────────────────────────────
# Consignment service logic
# ──────────────────────────────────────────────────────────────────────

class TestConsignmentService:
    def test_reconcile_computes_divergence(self, monkeypatch):
        tables = {"chip_consignments": [{
            "id": "c1", "sangi_staff_id": "s1", "stage_id": "st1",
            "released_amount": 10000, "total_sold": 4000, "divergence": None,
            "status": "open", "opened_at": "2026-06-08T00:00:00Z",
            "created_at": "2026-06-08T00:00:00Z",
        }]}
        monkeypatch.setattr(chip_consignment_service, "supabase", FakeSupabase(tables))
        out = ChipConsignmentService.reconcile("c1", reconciled_by="u")
        assert out.status == "reconciled"
        assert out.divergence == 6000  # released 10000 - sold 4000
        assert out.remaining == 6000

    def test_reconcile_twice_blocked(self, monkeypatch):
        tables = {"chip_consignments": [{
            "id": "c1", "sangi_staff_id": "s1", "stage_id": "st1",
            "released_amount": 1000, "total_sold": 1000, "divergence": 0,
            "status": "reconciled", "opened_at": "2026-06-08T00:00:00Z",
            "created_at": "2026-06-08T00:00:00Z",
        }]}
        monkeypatch.setattr(chip_consignment_service, "supabase", FakeSupabase(tables))
        with pytest.raises(HTTPException) as exc:
            ChipConsignmentService.reconcile("c1", reconciled_by="u")
        assert exc.value.status_code == 400

    def test_release_blocks_duplicate_open(self, monkeypatch):
        tables = {
            "staff": [{"id": "s1", "active": True}],
            "chip_consignments": [{
                "id": "c0", "sangi_staff_id": "s1", "stage_id": "st1",
                "released_amount": 5000, "total_sold": 0, "status": "open",
                "opened_at": "2026-06-08T00:00:00Z", "created_at": "2026-06-08T00:00:00Z",
            }],
        }
        monkeypatch.setattr(chip_consignment_service, "supabase", FakeSupabase(tables))
        data = ConsignmentRelease(sangi_staff_id="s1", released_amount=1000, stage_id="st1")
        with pytest.raises(HTTPException) as exc:
            ChipConsignmentService.release(data, stage_id=None, opened_by="u")
        assert exc.value.status_code == 400

    def test_sale_cannot_exceed_released(self, monkeypatch):
        tables = {
            "chip_consignments": [{
                "id": "c1", "sangi_staff_id": "s1", "stage_id": "st1",
                "released_amount": 1000, "total_sold": 900, "status": "open",
            }],
            "players": [{"id": "p1", "name": "Fulano"}],
        }
        monkeypatch.setattr(chip_consignment_service, "supabase", FakeSupabase(tables))
        arg = SaleCreate(amount=200, buyer_player_id="p1")
        with pytest.raises(HTTPException) as exc:
            ChipConsignmentService.register_sale("c1", arg, sold_by="u")
        assert exc.value.status_code == 400

    def test_sangi_cannot_sell_on_others_consignment(self, monkeypatch):
        tables = {
            "chip_consignments": [{
                "id": "c1", "sangi_staff_id": "sangi1", "stage_id": "st1",
                "released_amount": 1000, "total_sold": 0, "status": "open",
            }],
            "staff": [{"id": "other", "auth_user_id": "u", "name": "Outra"}],
            "players": [{"id": "p1", "name": "Fulano"}],
        }
        monkeypatch.setattr(chip_consignment_service, "supabase", FakeSupabase(tables))
        arg = SaleCreate(amount=10, buyer_player_id="p1")
        with pytest.raises(HTTPException) as exc:
            ChipConsignmentService.register_sale(
                "c1", arg,
                sold_by="u", acting_auth_user_id="u", restrict_to_self=True,
            )
        assert exc.value.status_code == 403

    def test_register_sale_happy_path(self, monkeypatch):
        tables = {
            "chip_consignments": [{
                "id": "c1", "sangi_staff_id": "s1", "stage_id": "st1",
                "released_amount": 1000, "total_sold": 0, "status": "open",
            }],
            "players": [{"id": "p1", "name": "Fulano"}],
        }
        monkeypatch.setattr(chip_consignment_service, "supabase", FakeSupabase(tables))
        sale = ChipConsignmentService.register_sale("c1", SaleCreate(amount=250, buyer_player_id="p1"), sold_by="u")
        assert sale.amount == 250
        assert sale.buyer_player_id == "p1"
        assert sale.buyer_player_name == "Fulano"


# ──────────────────────────────────────────────────────────────────────
# Endpoint enforcement (isolation of the sangi role via the API)
# ──────────────────────────────────────────────────────────────────────

@pytest.fixture
def auth_user():
    app.dependency_overrides[get_current_user] = lambda: {"sub": "user-1"}
    yield
    app.dependency_overrides.pop(get_current_user, None)


class TestSangiIsolation:
    def test_sangi_blocked_from_reports(self, monkeypatch, auth_user):
        _perms(monkeypatch, permissions=["sangi"])
        resp = client.get("/reports/tournament/abc")
        assert resp.status_code == 403

    def test_sangi_blocked_from_prizes(self, monkeypatch, auth_user):
        _perms(monkeypatch, permissions=["sangi"])
        resp = client.get("/tournaments/abc/prizes/summary")
        assert resp.status_code == 403

    def test_sangi_allowed_on_own_screen(self, monkeypatch, auth_user):
        _perms(monkeypatch, permissions=["sangi"])
        monkeypatch.setattr(ChipConsignmentService, "get_my_open",
                            staticmethod(lambda auth_user_id, stage_id=None: None))
        resp = client.get("/sangi/me")
        assert resp.status_code == 200
        assert resp.json() is None

    def test_unauthenticated_blocked(self):
        resp = client.get("/sangi/me")
        assert resp.status_code in (401, 403)
