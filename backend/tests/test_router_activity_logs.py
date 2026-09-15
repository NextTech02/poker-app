"""Camada HTTP do log de acessos.

O que importa aqui são as duas portas: o admin do clube só lê a PRÓPRIA
organização (vinda do claim, nunca de parâmetro) e o platform_admin é o único
que lê qualquer uma. E o que a rota valida antes de chegar ao PostgREST.
"""
import pytest

from app.models.staff import MyPermissions
from app.routers import organizations as org_mod
from app.services.activity_log_service import ActivityLogService
from app.services.staff_service import StaffService

from tests.conftest import FakeSupabase, USUARIO_TESTE


ORG = USUARIO_TESTE["organization_id"]


@pytest.fixture
def listagem(stub):
    chamadas = []

    def _list(org_id, **filtros):
        chamadas.append((org_id, filtros))
        return {"items": [{"id": "1"}], "total": 1, "page": filtros.get("page", 1),
                "page_size": filtros.get("page_size", 50)}

    stub(ActivityLogService, list=_list)
    return chamadas


class TestMinhaOrganizacao:
    def test_lista_com_a_org_do_claim(self, client, listagem):
        r = client.get("/activity-logs", params={"event_type": "login", "page": 2, "page_size": 10})
        assert r.status_code == 200
        assert r.json()["items"] == [{"id": "1"}]
        org, filtros = listagem[0]
        assert org == ORG
        assert filtros["event_type"] == "login"
        assert filtros["page"] == 2 and filtros["page_size"] == 10

    def test_pagina_grande_demais_e_422(self, client, listagem):
        assert client.get("/activity-logs", params={"page_size": 500}).status_code == 422
        assert listagem == []

    def test_evento_e_data_malformados_sao_422(self, client, listagem):
        assert client.get("/activity-logs", params={"event_type": "x;drop"}).status_code == 422
        assert client.get("/activity-logs", params={"date_from": "01/09/2026"}).status_code == 422
        assert listagem == []

    def test_sem_a_permissao_nao_le(self, client, listagem, monkeypatch):
        # Gerenciar a equipe não basta: a chave é `access_log`, que o clube
        # pode dar ou tirar de qualquer grupo.
        monkeypatch.setattr(
            StaffService, "get_my_permissions",
            staticmethod(lambda uid: MyPermissions(is_admin=False, permissions=["employees"])),
        )
        r = client.get("/activity-logs")
        assert r.status_code == 403
        assert listagem == []

    def test_dono_do_clube_le_sem_ser_admin_da_plataforma(self, client, listagem, monkeypatch):
        monkeypatch.setattr(
            StaffService, "get_my_permissions",
            staticmethod(lambda uid: MyPermissions(is_admin=False, permissions=["access_log"])),
        )
        assert client.get("/activity-logs").status_code == 200
        assert listagem[0][0] == ORG

    def test_logout_registra_e_devolve_204(self, client, stub):
        eventos = []
        stub(ActivityLogService, record=lambda tipo, payload, **kw: eventos.append((tipo, payload["sub"])))
        r = client.post("/activity-logs/logout")
        assert r.status_code == 204
        assert eventos == [("logout", USUARIO_TESTE["sub"])]


class TestPlatformAdmin:
    @pytest.fixture
    def banco(self, monkeypatch):
        fake = FakeSupabase({"organizations": [{"id": "org-b", "name": "Clube B", "status": "active"}]})
        monkeypatch.setattr(org_mod, "supabase_admin", fake)
        return fake

    def test_sem_claim_e_403(self, client, banco, listagem):
        assert client.get("/organizations/org-b/activity-logs").status_code == 403
        assert listagem == []

    def test_le_qualquer_org(self, client, banco, listagem):
        client.usuario["platform_admin"] = True
        r = client.get("/organizations/org-b/activity-logs", params={"user_id": "u1"})
        assert r.status_code == 200
        org, filtros = listagem[0]
        assert org == "org-b"
        assert filtros["user_id"] == "u1"

    def test_org_inexistente_e_404(self, client, banco, listagem):
        client.usuario["platform_admin"] = True
        assert client.get("/organizations/nao-existe/activity-logs").status_code == 404
        assert listagem == []

    def test_entrar_na_org_fica_no_log_dela(self, client, banco, stub):
        banco.rpcs["set_active_organization"] = lambda params: None
        eventos = []
        stub(
            ActivityLogService,
            record=lambda tipo, payload, **kw: eventos.append((tipo, kw.get("organization_id"))),
        )
        r = client.post("/organizations/switch", json={"organization_id": "org-b"})
        assert r.status_code == 200
        assert eventos == [("org.switch", "org-b")]
