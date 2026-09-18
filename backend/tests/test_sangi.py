"""Tests for the Sangi (chip consignment) feature and permission enforcement."""
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app
from app.models.staff import MyPermissions
from app.models.chip_consignment import ConsignmentRelease, SaleCreate
from app.services import chip_consignment_service
from app.services.chip_consignment_service import ChipConsignmentService
from app.services.cash_day_service import CashDayService
from app.services import staff_service
from app.services.staff_service import StaffService
from app.auth.jwt import get_current_user
from app.auth.permissions import require_permission, forbid_permission

from tests.conftest import FakeSupabase

client = TestClient(app)


# Uma mesa aberta com o jogador SENTADO. É a pré-condição nova da venda: ela
# vira um `rebuy` daquele jogador naquela mesa, então sem mesa e sem sessão não
# há de quem seja o dinheiro.
def _mesa_com_jogador(dia="d1", mesa="m1", player="p1"):
    return {
        "cash_tables": [{"id": mesa, "cash_day_id": dia, "table_number": 3,
                         "status": "open"}],
        "cash_player_sessions": [{"id": "sess1", "table_id": mesa,
                                  "player_id": player, "status": "active"}],
        "cash_transactions": [],
    }


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
        # 409: o pedido está certo, ele briga com o abate que já aconteceu.
        assert exc.value.status_code == 409
        assert exc.value.detail["code"] == "consignacao_ja_reconciliada"

    def test_release_blocks_duplicate_open(self, monkeypatch):
        tables = {
            # A sangeur precisa do grupo com a permissão `sangi`: sem ele a
            # recusa que dispara é "não é sangeur", e o teste passaria sem
            # nunca chegar na trava de consignação duplicada que ele mede.
            "staff": [{"id": "s1", "active": True,
                       "permission_groups": {"permissions": ["sangi"]}}],
            "chip_consignments": [{
                "id": "c0", "sangi_staff_id": "s1", "cash_day_id": "d1",
                "released_amount": 5000, "total_sold": 0, "status": "open",
                "opened_at": "2026-06-08T00:00:00Z", "created_at": "2026-06-08T00:00:00Z",
            }],
            "cash_days": [{"id": "d1", "status": "open"}],
        }
        monkeypatch.setattr(chip_consignment_service, "supabase", FakeSupabase(tables))
        monkeypatch.setattr(CashDayService, "require_open_day",
                            staticmethod(lambda dia: {"id": dia, "status": "open"}))
        data = ConsignmentRelease(sangi_staff_id="s1", released_amount=1000, cash_day_id="d1")
        with pytest.raises(HTTPException) as exc:
            ChipConsignmentService.release(data, cash_day_id=None, opened_by="u")
        assert exc.value.status_code == 409
        assert exc.value.detail["code"] == "consignacao_aberta_existente"

    def test_release_sem_id_cai_no_dia_aberto(self, monkeypatch):
        # A tela do caixa liberava sem mandar o dia e o serviço recusava com
        # "dia_nao_aberto" — que a tela traduz como "o dia está fechado", com o
        # dia aberto na frente do operador. Sem id, vale o dia aberto agora.
        tables = {
            "staff": [{"id": "s1", "active": True,
                       "permission_groups": {"permissions": ["sangi"]}}],
            "chip_consignments": [],
            "cash_days": [{"id": "d-aberto", "status": "open", "business_date": "2026-09-18",
                           "organization_id": "org1", "opened_at": "2026-09-18T19:00:00Z"}],
        }
        fake = FakeSupabase(tables)
        monkeypatch.setattr(chip_consignment_service, "supabase", fake)
        from app.services import cash_day_service
        monkeypatch.setattr(cash_day_service, "supabase", FakeSupabase(tables))
        monkeypatch.setattr(CashDayService, "require_open_day",
                            staticmethod(lambda dia: {"id": dia, "status": "open"}))
        monkeypatch.setattr(ChipConsignmentService, "get",
                            staticmethod(lambda cid: {"id": cid}))
        data = ConsignmentRelease(sangi_staff_id="s1", released_amount=1000)
        ChipConsignmentService.release(data, cash_day_id=None, opened_by="u", organization_id="org1")
        gravado = fake.store["chip_consignments"][-1]
        assert gravado["cash_day_id"] == "d-aberto"

    def test_release_sem_dia_aberto_recusa(self, monkeypatch):
        tables = {
            "staff": [{"id": "s1", "active": True,
                       "permission_groups": {"permissions": ["sangi"]}}],
            "chip_consignments": [],
            "cash_days": [{"id": "d-fechado", "status": "closed"}],
        }
        monkeypatch.setattr(chip_consignment_service, "supabase", FakeSupabase(tables))
        from app.services import cash_day_service
        monkeypatch.setattr(cash_day_service, "supabase", FakeSupabase(tables))
        data = ConsignmentRelease(sangi_staff_id="s1", released_amount=1000)
        with pytest.raises(HTTPException) as exc:
            ChipConsignmentService.release(data, cash_day_id=None, opened_by="u")
        assert exc.value.detail["code"] == "dia_nao_aberto"

    def test_sale_cannot_exceed_released(self, monkeypatch):
        tables = {
            "chip_consignments": [{
                "id": "c1", "sangi_staff_id": "s1", "cash_day_id": "d1",
                "released_amount": 1000, "total_sold": 900, "status": "open",
            }],
            "players": [{"id": "p1", "name": "Fulano"}],
            **_mesa_com_jogador(),
        }
        monkeypatch.setattr(chip_consignment_service, "supabase", FakeSupabase(tables))
        arg = SaleCreate(amount=200, buyer_player_id="p1", table_id="m1")
        with pytest.raises(HTTPException) as exc:
            ChipConsignmentService.register_sale("c1", arg, sold_by="u")
        assert exc.value.status_code == 400

    def test_sangi_cannot_sell_on_others_consignment(self, monkeypatch):
        tables = {
            "chip_consignments": [{
                "id": "c1", "sangi_staff_id": "sangi1", "cash_day_id": "d1",
                "released_amount": 1000, "total_sold": 0, "status": "open",
            }],
            "staff": [{"id": "other", "auth_user_id": "u", "name": "Outra"}],
            "players": [{"id": "p1", "name": "Fulano"}],
            **_mesa_com_jogador(),
        }
        monkeypatch.setattr(chip_consignment_service, "supabase", FakeSupabase(tables))
        arg = SaleCreate(amount=10, buyer_player_id="p1", table_id="m1")
        with pytest.raises(HTTPException) as exc:
            ChipConsignmentService.register_sale(
                "c1", arg,
                sold_by="u", acting_auth_user_id="u", restrict_to_self=True,
            )
        assert exc.value.status_code == 403

    def test_register_sale_happy_path(self, monkeypatch):
        tables = {
            "chip_consignments": [{
                "id": "c1", "sangi_staff_id": "s1", "cash_day_id": "d1",
                "released_amount": 1000, "total_sold": 0, "status": "open",
                "organization_id": "org1",
            }],
            "players": [{"id": "p1", "name": "Fulano"}],
            **_mesa_com_jogador(),
        }
        fake = FakeSupabase(tables)
        monkeypatch.setattr(chip_consignment_service, "supabase", fake)
        sale = ChipConsignmentService.register_sale(
            "c1", SaleCreate(amount=250, buyer_player_id="p1", table_id="m1"), sold_by="u")
        assert sale.amount == 250
        assert sale.buyer_player_id == "p1"
        assert sale.buyer_player_name == "Fulano"
        assert sale.table_number == 3

    def test_a_venda_entra_no_dinheiro_do_dia(self, monkeypatch):
        """A razão da migração.

        Sem isto o sangeur vende R$ 250 em fichas na mesa 3 e o DIA não enxerga
        esse dinheiro: o total de buy-ins fica curto, a sessão do jogador mostra
        um resultado que não é o dele, e o fechamento do dia não fecha.
        """
        tables = {
            "chip_consignments": [{
                "id": "c1", "sangi_staff_id": "s1", "cash_day_id": "d1",
                "released_amount": 1000, "total_sold": 0, "status": "open",
                "organization_id": "org1",
            }],
            "players": [{"id": "p1", "name": "Fulano"}],
            **_mesa_com_jogador(),
        }
        fake = FakeSupabase(tables)
        monkeypatch.setattr(chip_consignment_service, "supabase", fake)

        venda = ChipConsignmentService.register_sale(
            "c1", SaleCreate(amount=250, buyer_player_id="p1", table_id="m1"), sold_by="u")

        lancamentos = fake.store["cash_transactions"]
        assert len(lancamentos) == 1
        tx = lancamentos[0]
        assert tx["amount"] == 250
        assert tx["player_session_id"] == "sess1"
        assert tx["table_id"] == "m1"
        # `rebuy` e não `buy_in`: neste módulo o buy-in é o ato de SENTAR (é ele
        # que valida o mínimo da mesa e cria a sessão). Quem já está sentado e
        # compra mais fichas está recomprando.
        assert tx["type"] == "rebuy"
        # E o fio entre os dois livros, nos dois sentidos.
        assert tx["consignment_id"] == "c1"
        assert venda.cash_transaction_id == tx["id"]

    def test_o_dinheiro_da_venda_NAO_entra_na_gaveta(self, monkeypatch):
        """O dinheiro está no bolso da sangeur, não na gaveta de ninguém.

        `consignment_id` preenchido é o que faz o trigger do banco desviar. Se
        esta transação fosse espelhada num caixa, a conferência acusaria falta
        contra um operador que nunca tocou nesse dinheiro. Quem controla é a
        própria consignação (released × sold, conferidos no abate).
        """
        tables = {
            "chip_consignments": [{
                "id": "c1", "sangi_staff_id": "s1", "cash_day_id": "d1",
                "released_amount": 1000, "total_sold": 0, "status": "open",
            }],
            "players": [{"id": "p1", "name": "Fulano"}],
            **_mesa_com_jogador(),
        }
        fake = FakeSupabase(tables)
        monkeypatch.setattr(chip_consignment_service, "supabase", fake)
        ChipConsignmentService.register_sale(
            "c1", SaleCreate(amount=250, buyer_player_id="p1", table_id="m1"), sold_by="u")

        tx = fake.store["cash_transactions"][0]
        assert tx["consignment_id"] == "c1"
        assert tx.get("cashbox_id") is None

    def test_jogador_que_nao_esta_na_mesa_e_recusado(self, monkeypatch):
        """Sem sessão ativa não dá para dizer de quem é a ficha — e o resultado
        da noite do jogador sairia errado."""
        tables = {
            "chip_consignments": [{
                "id": "c1", "sangi_staff_id": "s1", "cash_day_id": "d1",
                "released_amount": 1000, "total_sold": 0, "status": "open",
            }],
            "players": [{"id": "p1", "name": "Fulano"}],
            "cash_tables": [{"id": "m1", "cash_day_id": "d1", "table_number": 3,
                             "status": "open"}],
            "cash_player_sessions": [],   # ninguém sentado
            "cash_transactions": [],
        }
        monkeypatch.setattr(chip_consignment_service, "supabase", FakeSupabase(tables))
        with pytest.raises(HTTPException) as exc:
            ChipConsignmentService.register_sale(
                "c1", SaleCreate(amount=250, buyer_player_id="p1", table_id="m1"), sold_by="u")
        assert exc.value.status_code == 400
        assert exc.value.detail["code"] == "jogador_nao_esta_na_mesa"

    def test_mesa_de_outro_dia_e_recusada(self, monkeypatch):
        """Vender ficha do dia de ontem numa mesa de hoje misturaria dois
        fechamentos."""
        tables = {
            "chip_consignments": [{
                "id": "c1", "sangi_staff_id": "s1", "cash_day_id": "d1",
                "released_amount": 1000, "total_sold": 0, "status": "open",
            }],
            "players": [{"id": "p1", "name": "Fulano"}],
            "cash_tables": [{"id": "m9", "cash_day_id": "OUTRO-DIA",
                             "table_number": 9, "status": "open"}],
            "cash_player_sessions": [],
            "cash_transactions": [],
        }
        monkeypatch.setattr(chip_consignment_service, "supabase", FakeSupabase(tables))
        with pytest.raises(HTTPException) as exc:
            ChipConsignmentService.register_sale(
                "c1", SaleCreate(amount=250, buyer_player_id="p1", table_id="m9"), sold_by="u")
        assert exc.value.detail["code"] == "mesa_de_outro_dia"


# ──────────────────────────────────────────────────────────────────────
# Endpoint enforcement (isolation of the sangi role via the API)
# ──────────────────────────────────────────────────────────────────────

@pytest.fixture
def auth_user(monkeypatch):
    # `organization_id` no usuário: a consignação agora vive sob
    # `require_module("cash")`, e a guarda recusa antes de tudo quem não está
    # vinculado a um clube.
    app.dependency_overrides[get_current_user] = lambda: {
        "sub": "user-1", "organization_id": "org-1",
    }
    # E o módulo contratado sai do caminho — sem isto a guarda iria ao BANCO DE
    # VERDADE, pelo mesmo motivo que a fixture `client` do conftest o troca.
    from app.services.module_service import ModuleService
    monkeypatch.setattr(ModuleService, "has_module",
                        staticmethod(lambda org, module: True))
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
                            staticmethod(lambda auth_user_id, cash_day_id=None: None))
        resp = client.get("/sangi/me")
        assert resp.status_code == 200
        assert resp.json() is None

    def test_unauthenticated_blocked(self):
        resp = client.get("/sangi/me")
        assert resp.status_code in (401, 403)
