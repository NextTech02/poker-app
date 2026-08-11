"""Testes de funcionarios: convite, remocao e permissoes.

Duas regras aqui foram escritas depois de problemas concretos: convite
pendente e apagado de verdade (desativar deixaria o convite aparecendo para
sempre e travaria a chave unica), e funcionario com HISTORICO nao pode ser
apagado -- os pagamentos dele entram no DRE e sumiriam junto.
"""
import pytest

from app.services import staff_service
from app.services.staff_service import StaffService
from app.models.staff import StaffCreate, StaffUpdate, PermissionGroupCreate

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
AUTH = "88888888-8888-8888-8888-888888888888"
STAFF = "99999999-9999-9999-9999-999999999999"


def _funcionario(id_=STAFF, ativo=True, status="accepted", org=ORG, auth=AUTH):
    return {
        "id": id_, "auth_user_id": auth, "name": "Fulano",
        "email": "fulano@clube.com", "permission_group_id": None,
        "active": ativo, "invite_status": status, "organization_id": org,
        "created_at": "2026-06-08T00:00:00Z", "updated_at": "2026-06-08T00:00:00Z",
    }


def _monta(monkeypatch, tabelas=None, rpcs=None):
    base = {
        "staff": [],
        "permission_groups": [],
        "cashboxes": [],
        "organizations": [{"id": ORG, "name": "NextHub", "status": "active"}],
    }
    base.update(tabelas or {})
    fake = FakeSupabase(base)
    fake.rpcs = rpcs or {}
    monkeypatch.setattr(staff_service, "supabase", fake)
    monkeypatch.setattr(staff_service, "supabase_admin", fake)
    return fake


class TestGruposDePermissao:
    def test_cria_grupo(self, monkeypatch):
        fake = _monta(monkeypatch)
        StaffService.create_group(PermissionGroupCreate(
            name="Caixa", description="Opera o caixa", permissions=["cashier"]
        ))
        assert fake.store["permission_groups"][0]["name"] == "Caixa"

    def test_lista_grupos(self, monkeypatch):
        _monta(monkeypatch, {"permission_groups": [
            {"id": "g1", "name": "Caixa", "description": "", "permissions": ["cashier"],
             "created_at": "2026-06-08T00:00:00Z"},
        ]})
        assert len(StaffService.get_groups()) == 1

    def test_grupo_inexistente_devolve_none(self, monkeypatch):
        _monta(monkeypatch)
        assert StaffService.get_group("nao-existe") is None

    def test_apaga_grupo(self, monkeypatch):
        fake = _monta(monkeypatch, {"permission_groups": [
            {"id": "g1", "name": "X", "description": "", "permissions": [],
             "created_at": "2026-06-08T00:00:00Z"},
        ]})
        assert StaffService.delete_group("g1") is True
        assert fake.store["permission_groups"] == []


class TestRemocaoDoClube:
    def test_sem_organizacao_e_recusado(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="organização"):
            StaffService.remove_from_org(STAFF, None)

    def test_sem_historico_o_vinculo_e_removido(self, monkeypatch):
        fake = _monta(monkeypatch, {"staff": [_funcionario()]},
                      rpcs={"remove_staff_member": {
                          "acao": "removido", "nome": "Fulano",
                          "auth_user_id": AUTH, "ultima_organizacao": False,
                          "outras_organizacoes": 1,
                      }})
        r = StaffService.remove_from_org(STAFF, ORG)
        assert r["acao"] == "removido"
        # nao era a ultima organizacao => a conta de acesso permanece
        assert r["conta_removida"] is False

    def test_com_historico_apenas_desativa(self, monkeypatch):
        """Apagar reescreveria resultados financeiros ja apurados."""
        _monta(monkeypatch, {"staff": [_funcionario()]},
               rpcs={"remove_staff_member": {
                   "acao": "desativado", "nome": "Fulano",
                   "movimentos": 4, "pagamentos": 1, "consignacoes": 0,
               }})
        r = StaffService.remove_from_org(STAFF, ORG)
        assert r["acao"] == "desativado"
        assert r["conta_removida"] is False

    def test_funcionario_inexistente_da_erro_claro(self, monkeypatch):
        fake = _monta(monkeypatch)

        def _estoura(params):
            raise Exception("FUNCIONARIO_NAO_ENCONTRADO")

        fake.rpcs = {"remove_staff_member": _estoura}
        with pytest.raises(ValueError, match="não encontrado"):
            StaffService.remove_from_org(STAFF, ORG)

    def test_caixa_aberto_bloqueia_a_remocao(self, monkeypatch):
        """Ninguem sai do clube segurando dinheiro."""
        _monta(monkeypatch, {"staff": [_funcionario()]})
        monkeypatch.setattr(
            StaffService, "_guard_no_open_cashbox",
            staticmethod(lambda sid: (_ for _ in ()).throw(ValueError("caixa aberto"))),
        )
        with pytest.raises(ValueError, match="caixa aberto"):
            StaffService.remove_from_org(STAFF, ORG)


class TestExclusaoEDesativacao:
    def test_convite_pendente_e_apagado_de_verdade(self, monkeypatch):
        """Desativar deixaria o convite marcado como pendente aparecendo para
        a pessoa, e travaria a chave unica num futuro reconvite."""
        fake = _monta(monkeypatch, {"staff": [_funcionario(status="pending", ativo=False)]})
        assert StaffService.delete_staff(STAFF) is True
        assert fake.store["staff"] == []

    def test_membro_efetivo_e_apenas_desativado(self, monkeypatch):
        fake = _monta(monkeypatch, {"staff": [_funcionario(status="accepted")]})
        StaffService.delete_staff(STAFF)
        assert len(fake.store["staff"]) == 1
        assert fake.store["staff"][0]["active"] is False

    def test_atualiza_nome_e_grupo(self, monkeypatch):
        fake = _monta(monkeypatch, {"staff": [_funcionario()]})
        StaffService.update_staff(STAFF, StaffUpdate(name="Novo Nome"))
        assert fake.store["staff"][0]["name"] == "Novo Nome"

    def test_funcionario_inexistente_devolve_none(self, monkeypatch):
        _monta(monkeypatch)
        assert StaffService.update_staff("nao-existe", StaffUpdate(name="X")) is None


class TestReenvioDeConvite:
    def test_quem_ja_concluiu_nao_recebe_reenvio(self, monkeypatch):
        _monta(monkeypatch, {"staff": [_funcionario(status="accepted")]})
        with pytest.raises(ValueError, match="já concluiu"):
            StaffService.resend_invite(STAFF, ORG)

    def test_funcionario_de_outra_organizacao_nao_e_encontrado(self, monkeypatch):
        _monta(monkeypatch, {"staff": [_funcionario(org="outra", status="awaiting_signup")]})
        with pytest.raises(ValueError, match="não encontrado"):
            StaffService.resend_invite(STAFF, ORG)

    def test_inexistente_da_erro(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="não encontrado"):
            StaffService.resend_invite("nao-existe", ORG)


class TestPermissoes:
    def test_sem_vinculo_nao_recebe_acesso(self, monkeypatch):
        """FAIL-CLOSED: autenticado mas sem linha em staff e fora da allowlist
        => nenhum acesso. O comportamento antigo dava super-admin a qualquer
        conta sem vinculo; num SaaS isso faria o funcionario de um cliente
        virar dono de tudo."""
        _monta(monkeypatch)
        p = StaffService.get_my_permissions("usuario-sem-vinculo")
        assert p.is_admin is False
        assert p.permissions == []

    def test_desativado_perde_o_acesso(self, monkeypatch):
        _monta(monkeypatch, {"staff": [_funcionario(ativo=False)]})
        p = StaffService.get_my_permissions(AUTH)
        assert p.is_admin is False
        assert p.permissions == []

    def test_com_grupo_devolve_as_permissoes_do_grupo(self, monkeypatch):
        f = _funcionario()
        f["permission_group_id"] = "g1"
        f["permission_groups"] = {"name": "Caixa", "permissions": ["cashier", "reports"]}
        _monta(monkeypatch, {"staff": [f]})
        p = StaffService.get_my_permissions(AUTH)
        assert p.is_admin is False
        assert "cashier" in p.permissions

    def test_sem_grupo_nao_recebe_permissao_nenhuma(self, monkeypatch):
        _monta(monkeypatch, {"staff": [_funcionario()]})
        p = StaffService.get_my_permissions(AUTH)
        assert p.permissions == []
