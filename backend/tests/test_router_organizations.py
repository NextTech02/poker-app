"""Testes da camada HTTP do cadastro de organizações (clientes do SaaS).

Duas coisas se testam aqui e em nenhum outro lugar:

1. **A porta do platform_admin.** Estas rotas atravessam o RLS (usam
   `supabase_admin`). Se o guarda falhar, um funcionário de um clube lê e
   altera o cadastro de todos os outros clubes.
2. **A ordem convite → provisionamento.** O convite cria o usuário no auth;
   se o provisionamento falhar depois, esse usuário tem que ser removido,
   senão fica uma conta órfã que impede reconvidar o mesmo e-mail.
"""
import pytest

from app.routers import organizations as mod

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"


@pytest.fixture
def admin(client):
    """Usuário da NextHub (platform_admin)."""
    client.usuario["platform_admin"] = True
    return client


@pytest.fixture
def banco(monkeypatch):
    fake = FakeSupabase({
        "organizations": [{
            "id": ORG, "name": "Clube A", "slug": "clube-a", "status": "active",
            "plan_code": "free", "max_users_override": None,
            "created_at": "2026-06-08T00:00:00Z",
        }],
        "plans": [
            {"code": "free", "name": "Free", "sort_order": 1, "trial_days": 60,
             "max_users": 3, "max_tournaments_month": 2, "max_tables_tournament": 4,
             "max_clients": 100},
            {"code": "pro", "name": "Pro", "sort_order": 3, "trial_days": None,
             "max_users": 50, "max_tournaments_month": None,
             "max_tables_tournament": None, "max_clients": None},
        ],
        "staff": [
            {"id": "s1", "organization_id": ORG, "name": "Ana", "email": "ana@x.com",
             "active": True, "created_at": "2026-06-08T00:00:00Z",
             "permission_group_id": "g1", "permission_groups": {"name": "Caixa"}},
            {"id": "s2", "organization_id": ORG, "name": "Beto", "email": "beto@x.com",
             "active": False, "created_at": "2026-06-08T00:00:00Z",
             "permission_group_id": None, "permission_groups": None},
        ],
        "players": [], "tournaments": [],
        "org_modules": [{"id": "m1", "organization_id": ORG, "module": "tournament", "enabled": True}],
    })
    monkeypatch.setattr(mod, "supabase_admin", fake)
    return fake


class TestPortaDoPlatformAdmin:
    """Sem platform_admin no claim, nenhuma destas rotas responde."""

    @pytest.mark.parametrize("metodo,url", [
        ("get", "/organizations"),
        ("get", "/organizations/plans"),
        ("get", f"/organizations/{ORG}/staff"),
        ("get", f"/organizations/{ORG}/usage"),
        ("delete", f"/organizations/{ORG}"),
    ])
    def test_usuario_comum_recebe_403(self, client, banco, metodo, url):
        assert getattr(client, metodo)(url).status_code == 403

    def test_criar_organizacao_exige_platform_admin(self, client, banco):
        r = client.post("/organizations", json={
            "name": "Clube B", "admin_name": "Dono", "admin_email": "dono@b.com"})
        assert r.status_code == 403


class TestListagens:
    def test_lista_planos(self, admin, banco):
        r = admin.get("/organizations/plans")
        assert r.status_code == 200
        assert {p["code"] for p in r.json()} == {"free", "pro"}

    def test_lista_organizacoes_com_uso_e_limite(self, admin, banco):
        """`active_users` conta só os ATIVOS (é o que o limite do plano
        fiscaliza), enquanto `staff_count` conta todos, para o drill-down."""
        r = admin.get("/organizations")
        org = r.json()[0]
        assert org["staff_count"] == 2
        assert org["active_users"] == 1
        assert org["plan_name"] == "Free"
        assert org["max_users"] == 3

    def test_override_de_usuarios_vence_o_limite_do_plano(self, admin, banco):
        banco.store["organizations"][0]["max_users_override"] = 10
        assert admin.get("/organizations").json()[0]["max_users"] == 10

    def test_lista_funcionarios_da_organizacao(self, admin, banco):
        r = admin.get(f"/organizations/{ORG}/staff")
        assert r.status_code == 200
        nomes = {s["name"]: s["permission_group_name"] for s in r.json()}
        assert nomes["Ana"] == "Caixa"
        assert nomes["Beto"] is None

    def test_funcionarios_de_organizacao_inexistente_da_404(self, admin, banco):
        assert admin.get("/organizations/nao-existe/staff").status_code == 404

    def test_uso_atual(self, admin, banco):
        r = admin.get(f"/organizations/{ORG}/usage")
        assert r.json()["active_users"] == 1


class TestPlanoEStatus:
    def test_troca_de_plano(self, admin, banco):
        r = admin.patch(f"/organizations/{ORG}/plan", json={"plan_code": "pro"})
        assert r.status_code == 200
        assert banco.store["organizations"][0]["plan_code"] == "pro"

    def test_plano_sem_trial_limpa_a_data_de_trial(self, admin, banco):
        banco.store["organizations"][0]["trial_ends_at"] = "2026-09-01T00:00:00Z"
        admin.patch(f"/organizations/{ORG}/plan", json={"plan_code": "pro"})
        assert banco.store["organizations"][0]["trial_ends_at"] is None

    def test_plano_com_trial_recomputa_a_data(self, admin, banco):
        banco.store["organizations"][0]["plan_code"] = "pro"
        admin.patch(f"/organizations/{ORG}/plan", json={"plan_code": "free"})
        assert banco.store["organizations"][0]["trial_ends_at"] is not None

    def test_plano_inexistente_da_400(self, admin, banco):
        r = admin.patch(f"/organizations/{ORG}/plan", json={"plan_code": "diamante"})
        assert r.status_code == 400

    def test_plano_de_organizacao_inexistente_da_404(self, admin, banco):
        r = admin.patch("/organizations/nao-existe/plan", json={"plan_code": "pro"})
        assert r.status_code == 404

    def test_suspende(self, admin, banco):
        """Suspender corta o acesso do clube na próxima query (o RLS depende
        de `current_org_id()`, que só devolve org ATIVA)."""
        r = admin.patch(f"/organizations/{ORG}/status", json={"status": "suspended"})
        assert r.status_code == 200
        assert banco.store["organizations"][0]["status"] == "suspended"

    def test_status_fora_da_lista_da_422(self, admin, banco):
        r = admin.patch(f"/organizations/{ORG}/status", json={"status": "ferias"})
        assert r.status_code == 422

    def test_status_de_organizacao_inexistente_da_404(self, admin, banco):
        r = admin.patch("/organizations/nao-existe/status", json={"status": "active"})
        assert r.status_code == 404


class TestExclusao:
    def test_exclui(self, admin, banco):
        banco.rpcs["delete_organization"] = {"deleted": True}
        assert admin.delete(f"/organizations/{ORG}").status_code == 200

    def test_organizacao_ativa_precisa_ser_suspensa_antes(self, admin, banco):
        """Obriga um passo intermediário reversível antes do irreversível."""
        def _estoura(_):
            raise Exception("Suspenda a organização antes de excluí-la")
        banco.rpcs["delete_organization"] = _estoura
        r = admin.delete(f"/organizations/{ORG}")
        assert r.status_code == 409

    def test_inexistente_da_404(self, admin, banco):
        def _estoura(_):
            raise Exception("organização não encontrada")
        banco.rpcs["delete_organization"] = _estoura
        assert admin.delete(f"/organizations/{ORG}").status_code == 404

    def test_outro_erro_do_banco_da_400(self, admin, banco):
        def _estoura(_):
            raise Exception("deadlock detected")
        banco.rpcs["delete_organization"] = _estoura
        assert admin.delete(f"/organizations/{ORG}").status_code == 400


class TestMultiOrganizacao:
    """Rotas do USUÁRIO, não de uma organização: filtram sempre pelo `sub` do
    token, então não passam pelo guarda de platform_admin."""

    def test_lista_minhas_organizacoes(self, client, banco):
        banco.rpcs["list_my_organizations"] = [{"id": ORG, "name": "Clube A"}]
        assert client.get("/organizations/mine").json()[0]["id"] == ORG

    def test_lista_meus_convites(self, client, banco):
        banco.rpcs["list_my_pending_invites"] = [{"staff_id": "s9", "org_name": "Clube B"}]
        assert len(client.get("/organizations/invites").json()) == 1

    def test_aceita_convite(self, client, banco):
        banco.rpcs["accept_org_invite"] = {"accepted": True}
        assert client.post("/organizations/invites/s9/accept").status_code == 200

    def test_convite_estoura_o_limite_do_plano_da_409(self, client, banco):
        """409 e não 500: o clube precisa ler que é o PLANO que barrou, não
        um defeito — a ação dele é liberar uma vaga ou fazer upgrade."""
        def _estoura(_):
            raise Exception("PLANO_LIMITE_USUARIOS")
        banco.rpcs["accept_org_invite"] = _estoura
        r = client.post("/organizations/invites/s9/accept")
        assert r.status_code == 409
        assert "limite de usuários" in r.json()["detail"]["message"]

    def test_convite_ja_respondido_da_404(self, client, banco):
        def _estoura(_):
            raise Exception("CONVITE_INVALIDO")
        banco.rpcs["accept_org_invite"] = _estoura
        assert client.post("/organizations/invites/s9/accept").status_code == 404

    def test_falha_generica_ao_aceitar_da_400(self, client, banco):
        def _estoura(_):
            raise Exception("erro qualquer")
        banco.rpcs["accept_org_invite"] = _estoura
        assert client.post("/organizations/invites/s9/accept").status_code == 400

    def test_recusa_convite(self, client, banco):
        banco.rpcs["decline_org_invite"] = [{"id": "s9"}]
        assert client.post("/organizations/invites/s9/decline").json() == {"declined": True}

    def test_recusar_convite_inexistente_da_404(self, client, banco):
        banco.rpcs["decline_org_invite"] = None
        assert client.post("/organizations/invites/s9/decline").status_code == 404

    def test_troca_de_organizacao_pede_refresh_do_token(self, client, banco):
        """O claim só muda no próximo token — por isso a resposta avisa o
        frontend para renovar a sessão."""
        banco.rpcs["set_active_organization"] = None
        r = client.post("/organizations/switch", json={"organization_id": ORG})
        assert r.json() == {"organization_id": ORG, "refresh_required": True}

    def test_organizacao_sem_vinculo_da_403(self, client, banco):
        def _estoura(_):
            raise Exception("sem vínculo")
        banco.rpcs["set_active_organization"] = _estoura
        r = client.post("/organizations/switch", json={"organization_id": "outra"})
        assert r.status_code == 403
        assert "não pertence" in r.json()["detail"]["message"]

    def test_mensagem_de_erro_e_diferente_para_o_platform_admin(self, admin, banco):
        """Ele PODE entrar em qualquer org ativa; se falhou, o motivo é outro."""
        def _estoura(_):
            raise Exception("inativa")
        banco.rpcs["set_active_organization"] = _estoura
        r = admin.post("/organizations/switch", json={"organization_id": "outra"})
        assert "inexistente ou inativa" in r.json()["detail"]["message"]


class _RespostaFalsa:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


class TestCriacao:
    """Ordem: gerar o link (cria o auth user, NAO envia) → provisionar → enviar.

    O e-mail e o unico passo irreversivel, entao e o ultimo. Ver a docstring de
    `create_organization` para o incidente que essa ordem evita.
    """

    def _corpo(self, **kw):
        base = {"name": "Clube Novo", "admin_name": "Dono", "admin_email": "dono@novo.com"}
        base.update(kw)
        return base

    def _post_falso(self, chamadas, status_link=200, status_email=200):
        """Um `httpx.post` que sabe distinguir gerar-o-link de enviar-o-e-mail."""
        def _post(url, **kw):
            chamadas.append(url)
            if "resend.com" in url:
                return _RespostaFalsa(status_email, {"id": "email-1"})
            return _RespostaFalsa(status_link, {
                "id": "auth-1",
                "action_link": "https://exemplo/definir-senha#token=abc",
            })
        return _post

    @staticmethod
    def _com_resend(monkeypatch):
        """Sem chave, o envio nem e tentado — e metade dos testes ficaria cega."""
        monkeypatch.setattr(mod.settings, "resend_api_key", "re_teste", raising=False)
        monkeypatch.setattr(mod.settings, "leads_email_from", "AceBlind <n@x.com>", raising=False)

    def test_cria_e_convida(self, admin, banco, monkeypatch):
        chamadas = []
        self._com_resend(monkeypatch)
        monkeypatch.setattr(mod.httpx, "post", self._post_falso(chamadas))
        banco.rpcs["provision_organization"] = "org-nova"

        r = admin.post("/organizations", json=self._corpo())
        assert r.status_code == 201
        assert r.json()["invite_sent"] is True
        assert r.json()["slug"] == "clube-novo"

        # `generate_link` e nao `invite`: aquele CRIA o usuario e devolve o
        # link sem enviar; este enviaria na hora, antes de a organizacao
        # existir.
        assert any("/auth/v1/admin/generate_link" in u for u in chamadas)
        assert not any("/auth/v1/invite" in u for u in chamadas)

    def test_o_email_so_sai_DEPOIS_de_a_organizacao_existir(self, admin, banco, monkeypatch):
        """A ordem e a correcao inteira: o passo irreversivel vem por ultimo."""
        chamadas = []
        self._com_resend(monkeypatch)
        monkeypatch.setattr(mod.httpx, "post", self._post_falso(chamadas))

        momento_do_email = {}

        def _provisiona(_):
            # Quando o banco e chamado, o e-mail ainda nao pode ter saido.
            momento_do_email["email_antes"] = any("resend.com" in u for u in chamadas)
            return "org-nova"

        banco.rpcs["provision_organization"] = _provisiona

        assert admin.post("/organizations", json=self._corpo()).status_code == 201
        assert momento_do_email["email_antes"] is False
        assert any("resend.com" in u for u in chamadas)   # saiu, mas depois

    def test_provisionamento_falho_NAO_manda_email(self, admin, banco, monkeypatch):
        """O BUG que isto protege.

        `provision_organization` ficou ambigua (duas sobrecargas) e toda criacao
        passou a falhar. Como o e-mail era enviado ANTES, cada tentativa mandava
        um convite para um cliente cuja organizacao nunca existiu -- com um link
        para um usuario que o rollback apagava em seguida.

        Usuario apagado tem rollback. E-mail nao tem. Por isso ele e o ultimo.
        """
        chamadas = []
        self._com_resend(monkeypatch)
        monkeypatch.setattr(mod.httpx, "post", self._post_falso(chamadas))
        monkeypatch.setattr(mod.httpx, "delete", lambda url, **k: _RespostaFalsa(200))

        def _estoura(_):
            raise Exception("function is not unique")
        banco.rpcs["provision_organization"] = _estoura

        r = admin.post("/organizations", json=self._corpo())
        assert r.status_code == 400
        assert not any("resend.com" in u for u in chamadas)

    def test_organizacao_criada_sobrevive_a_falha_do_email(self, admin, banco, monkeypatch):
        """Convite que nao sai e problema de reenviar; organizacao fantasma e
        problema de suporte. Entao a falha do envio NAO derruba a criacao --
        ela e relatada."""
        chamadas = []
        self._com_resend(monkeypatch)
        monkeypatch.setattr(mod.httpx, "post", self._post_falso(chamadas, status_email=500))
        banco.rpcs["provision_organization"] = "org-nova"

        r = admin.post("/organizations", json=self._corpo())
        assert r.status_code == 201
        assert r.json()["invite_sent"] is False
        assert "criada" in r.json()["invite_error"]

    def test_sem_chave_de_email_a_organizacao_ainda_e_criada(self, admin, banco, monkeypatch):
        chamadas = []
        monkeypatch.setattr(mod.settings, "resend_api_key", "", raising=False)
        monkeypatch.setattr(mod.httpx, "post", self._post_falso(chamadas))
        banco.rpcs["provision_organization"] = "org-nova"

        r = admin.post("/organizations", json=self._corpo())
        assert r.status_code == 201
        assert r.json()["invite_sent"] is False
        assert "RESEND_API_KEY" in r.json()["invite_error"]
        assert not any("resend.com" in u for u in chamadas)

    def test_idioma_vai_para_o_provisionamento(self, admin, banco, monkeypatch):
        """O idioma nao e so a interface: o provisionamento grava os nomes dos
        cargos e das formas de pagamento NELE, direto no banco. Se o parametro
        se perder no caminho, um clube colombiano nasce com "Caixa" e "Cartao"
        em portugues, e consertar depois e editar registro por registro."""
        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: _RespostaFalsa(200, {"id": "auth-1"}))
        banco.rpcs["provision_organization"] = "org-nova"
        r = admin.post("/organizations", json=self._corpo(language="es-ES"))
        assert r.status_code == 201
        params = dict(banco.rpc_calls[-1][1])
        assert params["p_language"] == "es-ES"

    def test_sem_idioma_o_padrao_e_portugues(self, admin, banco, monkeypatch):
        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: _RespostaFalsa(200, {"id": "auth-1"}))
        banco.rpcs["provision_organization"] = "org-nova"
        admin.post("/organizations", json=self._corpo())
        assert dict(banco.rpc_calls[-1][1])["p_language"] == "pt-BR"

    def test_idioma_que_nao_falamos_e_recusado(self, admin, banco, monkeypatch):
        """Recusa na borda: um idioma sem traducao gravaria cargos vazios ou em
        portugues sem ninguem perceber. O banco tambem tem CHECK, mas o erro la
        chega como falha generica de provisionamento."""
        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: _RespostaFalsa(200, {"id": "auth-1"}))
        r = admin.post("/organizations", json=self._corpo(language="fr-FR"))
        assert r.status_code == 422

    def test_slug_repetido_da_409(self, admin, banco, monkeypatch):
        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: _RespostaFalsa(200, {"id": "x"}))
        r = admin.post("/organizations", json=self._corpo(name="Clube A"))
        assert r.status_code == 409

    def test_slug_e_derivado_do_nome_quando_nao_informado(self, admin, banco, monkeypatch):
        """Acento e pontuação viram separador e são colapsados: "Zé!!" vira
        "z" (o "é" não é [a-zA-Z0-9], então some junto com os "!"). Não é
        transliteração — o slug só precisa ser único e URL-safe."""
        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: _RespostaFalsa(200, {"id": "auth-1"}))
        banco.rpcs["provision_organization"] = "org-nova"
        r = admin.post("/organizations", json=self._corpo(name="Clube  do  Zé!!"))
        assert r.json()["slug"] == "clube-do-z"

    def test_limite_do_supabase_vira_mensagem_acionavel(self, admin, banco, monkeypatch):
        """429: o operador precisa saber que e limite e que a saida e esperar --
        nao um "erro" generico sem acao possivel."""
        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: _RespostaFalsa(429))
        r = admin.post("/organizations", json=self._corpo())
        assert r.status_code == 400
        assert "Limite" in r.json()["detail"]["message"]

    def test_usuario_ja_existente_no_auth_e_reaproveitado(self, admin, banco, monkeypatch):
        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: _RespostaFalsa(422))
        monkeypatch.setattr(mod.httpx, "get", lambda *a, **k: _RespostaFalsa(
            200, {"users": [{"id": "auth-antigo", "email": "DONO@novo.com"}]}))
        banco.rpcs["provision_organization"] = "org-nova"
        r = admin.post("/organizations", json=self._corpo())
        assert r.status_code == 201
        assert r.json()["invite_sent"] is False
        assert "já existia" in r.json()["invite_error"]

    def test_sem_usuario_no_auth_nao_provisiona(self, admin, banco, monkeypatch):
        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: _RespostaFalsa(422))
        monkeypatch.setattr(mod.httpx, "get", lambda *a, **k: _RespostaFalsa(200, {"users": []}))
        r = admin.post("/organizations", json=self._corpo())
        assert r.status_code == 400

    def test_falha_de_rede_no_convite_da_503(self, admin, banco, monkeypatch):
        def _cai(*a, **k):
            raise OSError("connection refused")
        monkeypatch.setattr(mod.httpx, "post", _cai)
        assert admin.post("/organizations", json=self._corpo()).status_code == 503

    def test_erro_do_supabase_no_convite_da_400(self, admin, banco, monkeypatch):
        monkeypatch.setattr(mod.httpx, "post",
                            lambda *a, **k: _RespostaFalsa(500, text="boom"))
        assert admin.post("/organizations", json=self._corpo()).status_code == 400

    def test_provisionamento_falho_apaga_o_usuario_criado(self, admin, banco, monkeypatch):
        """Sem esse rollback fica uma conta órfã no auth, e o mesmo e-mail não
        pode mais ser convidado."""
        apagados = []
        self._com_resend(monkeypatch)
        monkeypatch.setattr(mod.httpx, "post", self._post_falso([]))
        monkeypatch.setattr(mod.httpx, "delete",
                            lambda url, **k: apagados.append(url) or _RespostaFalsa(200))

        def _estoura(_):
            raise Exception("limite do plano")
        banco.rpcs["provision_organization"] = _estoura

        r = admin.post("/organizations", json=self._corpo())
        assert r.status_code == 400
        assert any("auth-1" in u for u in apagados)

    def test_email_invalido_da_422(self, admin, banco):
        r = admin.post("/organizations", json=self._corpo(admin_email="nao-e-email"))
        assert r.status_code == 422


class TestModulos:
    """O toggle de módulos do painel. A lista enviada é a lista COMPLETA do
    que a org passa a ter; módulo fora dela é DESABILITADO, não apagado."""

    def test_lista_vem_na_ordem_canonica(self, admin, banco):
        banco.store["org_modules"].append({"id": "m2", "organization_id": ORG, "module": "bar", "enabled": True})
        banco.store["org_modules"].append({"id": "m3", "organization_id": ORG, "module": "cash", "enabled": True})
        assert admin.get("/organizations").json()[0]["modules"] == ["tournament", "cash", "bar"]

    def test_liga_o_bar(self, admin, banco):
        r = admin.patch(f"/organizations/{ORG}/modules", json={"modules": ["tournament", "bar"]})
        assert r.status_code == 200
        assert r.json()["modules"] == ["bar", "tournament"]      # o endpoint ordena por nome
        linhas = {m["module"]: m["enabled"] for m in banco.store["org_modules"]}
        assert linhas == {"tournament": True, "bar": True}

    def test_desligar_desabilita_sem_apagar(self, admin, banco):
        banco.store["org_modules"].append({"id": "m2", "organization_id": ORG, "module": "bar", "enabled": True})
        r = admin.patch(f"/organizations/{ORG}/modules", json={"modules": ["tournament"]})
        assert r.status_code == 200
        linhas = {m["module"]: m["enabled"] for m in banco.store["org_modules"]}
        assert linhas == {"tournament": True, "bar": False}   # a linha ficou, como histórico

    def test_modulo_desconhecido_da_400_nomeando(self, admin, banco):
        r = admin.patch(f"/organizations/{ORG}/modules", json={"modules": ["tournament", "sinuca"]})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "modulo_invalido"
        assert r.json()["detail"]["modulos"] == ["sinuca"]

    def test_lista_vazia_da_422(self, admin, banco):
        assert admin.patch(f"/organizations/{ORG}/modules", json={"modules": []}).status_code == 422

    def test_exige_platform_admin(self, client, banco):
        assert client.patch(f"/organizations/{ORG}/modules", json={"modules": ["bar"]}).status_code == 403
