"""Log de acessos: o que o backend grava e como lê.

O ponto delicado não é a leitura — é que registrar NUNCA pode quebrar a
operação que está sendo registrada. Um login que falha por causa do log de
login seria o pior resultado possível; por isso metade dos testes aqui é
sobre engolir erro.
"""
from types import SimpleNamespace

import pytest

from app.services import activity_log_service as mod
from app.services.activity_log_service import ActivityLogService

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
USER = "88888888-8888-8888-8888-888888888888"
SESSAO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


def _request(headers=None, host="10.0.0.9"):
    return SimpleNamespace(headers=headers or {}, client=SimpleNamespace(host=host))


def _payload(**extra):
    base = {"sub": USER, "email": "ana@x.com", "organization_id": ORG, "session_id": SESSAO}
    base.update(extra)
    return base


@pytest.fixture
def banco(monkeypatch):
    fake = FakeSupabase({"activity_logs": []})
    monkeypatch.setattr(mod, "supabase_admin", fake)
    mod._seen.clear()
    yield fake
    mod._seen.clear()


class TestIpDoCliente:
    def test_cloudflare_vence_o_resto(self):
        req = _request({"cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2, 3.3.3.3"})
        assert ActivityLogService.client_ip(req) == "1.1.1.1"

    def test_primeiro_do_x_forwarded_for(self):
        req = _request({"x-forwarded-for": "2.2.2.2, 3.3.3.3"})
        assert ActivityLogService.client_ip(req) == "2.2.2.2"

    def test_sem_proxy_usa_o_socket(self):
        assert ActivityLogService.client_ip(_request()) == "10.0.0.9"

    def test_sem_request(self):
        assert ActivityLogService.client_ip(None) is None
        assert ActivityLogService.user_agent(None) is None


class TestPrimeiraRequisicaoDaSessao:
    def test_grava_login_uma_vez_por_sessao(self, banco):
        req = _request({"user-agent": "Chrome/1"})
        ActivityLogService.touch_session(_payload(), req)
        ActivityLogService.touch_session(_payload(), req)
        ActivityLogService.touch_session(_payload(), req)

        linhas = banco.store["activity_logs"]
        assert len(linhas) == 1
        assert linhas[0]["event_type"] == "login"
        assert linhas[0]["session_id"] == SESSAO
        assert linhas[0]["auth_user_id"] == USER
        assert linhas[0]["user_email"] == "ana@x.com"
        assert linhas[0]["organization_id"] == ORG
        assert linhas[0]["ip"] == "10.0.0.9"
        assert linhas[0]["user_agent"] == "Chrome/1"

    def test_sessao_nova_gera_login_novo(self, banco):
        ActivityLogService.touch_session(_payload(), _request())
        ActivityLogService.touch_session(
            _payload(session_id="bbbbbbbb-0000-0000-0000-000000000000"), _request()
        )
        assert len(banco.store["activity_logs"]) == 2

    def test_token_sem_session_id_nao_grava(self, banco):
        ActivityLogService.touch_session(_payload(session_id=None), _request())
        assert banco.store["activity_logs"] == []

    def test_cache_nao_cresce_sem_limite(self, banco, monkeypatch):
        monkeypatch.setattr(mod, "_SEEN_MAX", 3)
        for i in range(10):
            ActivityLogService.touch_session(_payload(session_id=f"s{i}"), _request())
        assert len(mod._seen) == 3
        assert len(banco.store["activity_logs"]) == 10


class _Explode:
    def __init__(self, exc):
        self.exc = exc

    def table(self, *_):
        return self

    def insert(self, *_):
        return self

    def execute(self):
        raise self.exc


class TestRegistrarNuncaQuebra:
    def test_duplicado_e_silencioso(self, monkeypatch, caplog):
        exc = Exception("duplicate key value violates unique constraint")
        exc.code = "23505"
        monkeypatch.setattr(mod, "supabase_admin", _Explode(exc))
        ActivityLogService.record("login", _payload())
        assert "activity log falhou" not in caplog.text

    def test_outro_erro_vira_warning(self, monkeypatch, caplog):
        monkeypatch.setattr(mod, "supabase_admin", _Explode(RuntimeError("banco fora")))
        ActivityLogService.record("logout", _payload())
        assert "activity log falhou" in caplog.text

    def test_record_aceita_org_e_entidade_explicitas(self, banco):
        ActivityLogService.record(
            "org.switch", _payload(organization_id=None), organization_id="org-destino",
            entity_table="organizations", entity_label="Clube B",
        )
        linha = banco.store["activity_logs"][0]
        assert linha["organization_id"] == "org-destino"
        assert linha["entity_label"] == "Clube B"
        assert linha["session_id"] == SESSAO  # cai no claim quando não informado


class TestListar:
    @pytest.fixture
    def cheio(self, banco):
        banco.store["activity_logs"].extend([
            {"id": "1", "organization_id": ORG, "auth_user_id": USER, "event_type": "login",
             "created_at": "2026-09-01T10:00:00"},
            {"id": "2", "organization_id": ORG, "auth_user_id": USER, "event_type": "tournaments.insert",
             "created_at": "2026-09-05T10:00:00"},
            {"id": "3", "organization_id": ORG, "auth_user_id": "outro", "event_type": "tournaments.update",
             "created_at": "2026-09-10T10:00:00"},
            {"id": "4", "organization_id": "outra-org", "auth_user_id": USER, "event_type": "login",
             "created_at": "2026-09-10T10:00:00"},
        ])
        return banco

    def test_so_a_org_pedida_do_mais_recente_ao_mais_antigo(self, cheio):
        res = ActivityLogService.list(ORG)
        assert [r["id"] for r in res["items"]] == ["3", "2", "1"]
        assert res["total"] == 3
        assert res["page"] == 1 and res["page_size"] == 50

    def test_filtro_por_usuario(self, cheio):
        res = ActivityLogService.list(ORG, user_id=USER)
        assert [r["id"] for r in res["items"]] == ["2", "1"]

    def test_filtro_por_evento_exato(self, cheio):
        res = ActivityLogService.list(ORG, event_type="login")
        assert [r["id"] for r in res["items"]] == ["1"]

    def test_filtro_por_tabela_vira_prefixo(self, cheio, monkeypatch):
        # O FakeQuery ignora like(); aqui se garante que a chamada sai como
        # prefixo — é isso que faz "tournaments.*" pegar insert/update/delete.
        chamadas = []
        classe = type(mod.supabase_admin.table("activity_logs"))
        original = classe.like

        def _like(self, col, val):
            chamadas.append((col, val))
            return original(self, col, val)

        monkeypatch.setattr(classe, "like", _like)
        ActivityLogService.list(ORG, event_type="tournaments.*")
        assert chamadas == [("event_type", "tournaments.%")]

    def test_filtro_por_periodo(self, cheio):
        res = ActivityLogService.list(ORG, date_from="2026-09-02", date_to="2026-09-06")
        assert [r["id"] for r in res["items"]] == ["2"]
