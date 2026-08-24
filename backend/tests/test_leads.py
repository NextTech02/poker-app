"""Formulário público da landing page.

É a ÚNICA porta do sistema aberta para a internet inteira escrever, e o que
está em jogo não é dado do clube: é um cliente em potencial. As duas regras que
os testes aqui protegem:

1. Lead recebido é lead GRAVADO. O e-mail é aviso, não registro.
2. Nada do que acontece depois de gravar pode virar erro na tela. Quem
   preencheu já fez a parte dele; dizer "deu errado" faz desistir de algo que
   funcionou.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import leads as mod


CORPO = {
    "name": "José Felipe",
    "club": "Clube Royal",
    "whatsapp": "+55 11 99999-8888",
    "email": "dono@clube.com",
    "city": "São Paulo / SP",
    "events_per_month": "5 a 12",
}


class _Tabela:
    """Mínimo do encadeamento do supabase-py usado pela rota."""

    def __init__(self, banco, nome):
        self._banco = banco
        self._nome = nome
        self._payload = None
        self._id = None

    def insert(self, payload):
        self._payload = payload
        return self

    def update(self, payload):
        self._payload = ("update", payload)
        return self

    def eq(self, _coluna, valor):
        self._id = valor
        return self

    def execute(self):
        if self._banco.erro_no_insert and not isinstance(self._payload, tuple):
            raise RuntimeError(self._banco.erro_no_insert)
        if isinstance(self._payload, tuple):
            self._banco.updates.append((self._id, self._payload[1]))
            return type("R", (), {"data": []})()
        self._banco.gravados.append(self._payload)
        return type("R", (), {"data": [{"id": "lead-1", **self._payload}]})()


class _Banco:
    def __init__(self):
        self.gravados = []
        self.updates = []
        self.erro_no_insert = None

    def table(self, nome):
        return _Tabela(self, nome)


@pytest.fixture
def banco(monkeypatch):
    b = _Banco()
    monkeypatch.setattr(mod, "supabase_admin", b)
    # Sem chave configurada o aviso nem é tentado — é o estado de quem ainda
    # não colocou a credencial, e o formulário tem de funcionar assim mesmo.
    monkeypatch.setattr(mod, "get_settings", lambda: type("S", (), {
        "resend_api_key": "", "leads_email_to": "", "leads_email_from": "x",
    })())
    return b


@pytest.fixture
def anonimo():
    """Sem nenhum override de autenticação: a rota é pública de verdade."""
    with TestClient(app) as c:
        yield c


class TestRegistro:
    def test_grava_o_lead_e_confirma(self, anonimo, banco):
        r = anonimo.post("/public/leads", json=CORPO)
        assert r.status_code == 201
        assert r.json() == {"received": True}
        assert banco.gravados[0]["club"] == "Clube Royal"

    def test_nao_exige_autenticacao(self, anonimo, banco):
        """Quem preenche a landing não tem conta — esse é o ponto."""
        assert anonimo.post("/public/leads", json=CORPO).status_code == 201

    def test_email_e_gravado_em_minusculo(self, anonimo, banco):
        anonimo.post("/public/leads", json={**CORPO, "email": "DONO@Clube.COM"})
        assert banco.gravados[0]["email"] == "dono@clube.com"

    def test_espacos_das_pontas_somem(self, anonimo, banco):
        anonimo.post("/public/leads", json={**CORPO, "name": "  José  ", "club": " Royal "})
        assert (banco.gravados[0]["name"], banco.gravados[0]["club"]) == ("José", "Royal")

    def test_campos_opcionais_viram_nulo_e_nao_string_vazia(self, anonimo, banco):
        anonimo.post("/public/leads", json={**CORPO, "city": "", "events_per_month": ""})
        assert banco.gravados[0]["city"] is None
        assert banco.gravados[0]["events_per_month"] is None

    def test_origem_padrao_e_a_landing(self, anonimo, banco):
        anonimo.post("/public/leads", json=CORPO)
        assert banco.gravados[0]["source"] == "landing"

    def test_origem_da_campanha_e_preservada(self, anonimo, banco):
        anonimo.post("/public/leads", json={**CORPO, "source": "instagram-set"})
        assert banco.gravados[0]["source"] == "instagram-set"


class TestPreenchimentoRuim:
    @pytest.mark.parametrize("campo", ["name", "club", "whatsapp", "email"])
    def test_campo_obrigatorio_ausente_e_recusado(self, anonimo, banco, campo):
        corpo = {k: v for k, v in CORPO.items() if k != campo}
        assert anonimo.post("/public/leads", json=corpo).status_code == 422
        assert banco.gravados == []

    def test_email_invalido_e_recusado(self, anonimo, banco):
        assert anonimo.post("/public/leads", json={**CORPO, "email": "sem-arroba"}).status_code == 422

    def test_texto_gigante_e_recusado(self, anonimo, banco):
        """Campo livre aberto para a internet é onde entra spam com quilobytes
        de link."""
        r = anonimo.post("/public/leads", json={**CORPO, "club": "x" * 5000})
        assert r.status_code == 422
        assert banco.gravados == []


class TestRoboERepeticao:
    def test_a_armadilha_descarta_sem_gravar(self, anonimo, banco):
        """Campo escondido na página: gente não preenche, robô preenche tudo."""
        r = anonimo.post("/public/leads", json={**CORPO, "website": "http://spam.example"})
        assert r.status_code == 201
        assert banco.gravados == []

    def test_a_armadilha_responde_como_sucesso(self, anonimo, banco):
        """Dizer "recusado" só ensina o próximo robô a não preencher."""
        r = anonimo.post("/public/leads", json={**CORPO, "website": "spam"})
        assert r.json() == {"received": True}

    def test_repetido_no_mesmo_dia_nao_vira_erro(self, anonimo, banco):
        """Clique duplo e reenvio da rede batem no índice único. Do lado de quem
        preencheu isso é sucesso: o pedido já está registrado."""
        banco.erro_no_insert = 'duplicate key value violates unique constraint "uq_leads_email_dia"'
        r = anonimo.post("/public/leads", json=CORPO)
        assert r.status_code == 201
        assert r.json() == {"received": True}


class TestQuandoAlgoFalha:
    def test_banco_fora_do_ar_avisa_de_verdade(self, anonimo, banco):
        """Aqui SIM é erro: o lead não ficou registrado em lugar nenhum, e
        responder "recebemos" perderia o cliente em silêncio."""
        banco.erro_no_insert = "connection refused"
        r = anonimo.post("/public/leads", json=CORPO)
        assert r.status_code == 503
        assert "WhatsApp" in r.json()["detail"]

    def test_falha_no_email_nao_derruba_o_lead(self, anonimo, banco, monkeypatch):
        """O pedido já está guardado. Quem preencheu não tem nada a ver com a
        cota do provedor de e-mail."""
        monkeypatch.setattr(mod, "get_settings", lambda: type("S", (), {
            "resend_api_key": "re_x", "leads_email_to": "eu@clube.com",
            "leads_email_from": "AceBlind <noreply@aceblind.net>",
        })())

        def _explode(*a, **k):
            raise RuntimeError("Resend fora do ar")

        monkeypatch.setattr(mod.httpx, "post", _explode)
        r = anonimo.post("/public/leads", json=CORPO)
        assert r.status_code == 201
        assert banco.gravados  # o que importa ficou guardado

    def test_sem_chave_configurada_o_email_nem_e_tentado(self, anonimo, banco, monkeypatch):
        """Estado de quem ainda não colocou a credencial: não é erro."""
        chamou = []
        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: chamou.append(1))
        anonimo.post("/public/leads", json=CORPO)
        assert chamou == []
        assert banco.gravados


class TestAvisoPorEmail:
    @pytest.fixture
    def com_resend(self, monkeypatch):
        enviados = []

        monkeypatch.setattr(mod, "get_settings", lambda: type("S", (), {
            "resend_api_key": "re_x",
            "leads_email_to": "eu@clube.com, socio@clube.com",
            "leads_email_from": "AceBlind <noreply@aceblind.net>",
        })())

        def _post(url, **kw):
            enviados.append(kw.get("json"))
            return type("R", (), {"status_code": 200, "text": "ok"})()

        monkeypatch.setattr(mod.httpx, "post", _post)
        return enviados

    def test_manda_o_aviso_com_os_dados_do_lead(self, anonimo, banco, com_resend):
        anonimo.post("/public/leads", json=CORPO)
        corpo = com_resend[0]
        assert "Clube Royal" in corpo["subject"]
        assert "+55 11 99999-8888" in corpo["text"]

    def test_responder_o_aviso_cai_em_quem_pediu_contato(self, anonimo, banco, com_resend):
        """Sem isto, responder o e-mail volta para o remetente automático."""
        anonimo.post("/public/leads", json=CORPO)
        assert com_resend[0]["reply_to"] == "dono@clube.com"

    def test_varios_destinos_separados_por_virgula(self, anonimo, banco, com_resend):
        anonimo.post("/public/leads", json=CORPO)
        assert com_resend[0]["to"] == ["eu@clube.com", "socio@clube.com"]

    def test_carimba_quando_o_aviso_saiu(self, anonimo, banco, com_resend):
        """`notified_at` é como se descobre quais leads ficaram sem aviso."""
        anonimo.post("/public/leads", json=CORPO)
        assert banco.updates
        gravado = banco.updates[0][1]["notified_at"]
        assert gravado != "now()"      # string literal gravaria "now()" na coluna
        assert gravado.startswith("20")

    def test_recusa_do_provedor_nao_carimba_nem_derruba(self, anonimo, banco, monkeypatch):
        monkeypatch.setattr(mod, "get_settings", lambda: type("S", (), {
            "resend_api_key": "re_x", "leads_email_to": "eu@clube.com",
            "leads_email_from": "x",
        })())
        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: type(
            "R", (), {"status_code": 422, "text": "domínio não verificado"})())
        r = anonimo.post("/public/leads", json=CORPO)
        assert r.status_code == 201
        assert banco.updates == []
