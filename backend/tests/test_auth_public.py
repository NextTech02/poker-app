"""Esqueci minha senha — rota pública, e-mail no idioma da tela.

O que o Supabase fazia por nós quando o navegador chamava
`resetPasswordForEmail` direto, e que agora é responsabilidade desta rota:

1. Captcha verificado no servidor. Sem ele, qualquer script dispara e-mails.
2. Resposta IGUAL exista ou não a conta — e o trabalho roda depois da
   resposta, em background, para nem o tempo denunciar quem é cadastrado.
3. Limite por e-mail e por IP: quem estoura recebe o mesmo 200, sem e-mail.

E o motivo de tudo isso: o e-mail sai no idioma pedido (X-Language), não no
inglês do template global do painel.
"""
import logging

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.routers import auth_public as mod

LINK = "https://xyz.supabase.co/auth/v1/verify?token=abc&type=recovery&redirect_to=x"


class _Resp:
    def __init__(self, status, corpo=None, text=""):
        self.status_code = status
        self._corpo = corpo if corpo is not None else {}
        self.text = text

    def json(self):
        return self._corpo


@pytest.fixture(autouse=True)
def _zera_o_limitador():
    mod._limitador.limpar()
    yield
    mod._limitador.limpar()


@pytest.fixture
def config(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "hcaptcha_secret", "0xsegredo", raising=False)
    monkeypatch.setattr(s, "resend_api_key", "re_teste", raising=False)
    monkeypatch.setattr(s, "leads_email_from", "AceBlind <n@x.com>", raising=False)
    monkeypatch.setattr(s, "environment", "development", raising=False)
    return s


@pytest.fixture
def anonimo():
    """Sem nenhum override de autenticação: a rota é pública de verdade."""
    with TestClient(app) as c:
        yield c


def _finge_rede(monkeypatch, *, captcha=True, status_link=200, status_email=200,
                captcha_cai=False, resend_cai=False):
    """`httpx.post` roteado por URL: hCaptcha, generate_link e Resend."""
    import httpx

    chamadas = []

    def _post(url, **kw):
        chamadas.append((url, kw))
        if "hcaptcha.com" in url:
            if captcha_cai:
                raise RuntimeError("connect timeout")
            return _Resp(200, {"success": captcha, "error-codes": [] if captcha else ["invalid-input-response"]})
        if "resend.com" in url:
            if resend_cai:
                raise RuntimeError("connect timeout")
            return _Resp(status_email, {"id": "email-1"})
        if status_link == 200:
            return _Resp(200, {"id": "user-1", "action_link": LINK})
        return _Resp(status_link, {"msg": "User not found"})

    monkeypatch.setattr(httpx, "post", _post)
    return chamadas


def _emails(chamadas):
    return [kw for url, kw in chamadas if "resend.com" in url]


def _links(chamadas):
    return [kw for url, kw in chamadas if "generate_link" in url]


def _captchas(chamadas):
    return [kw for url, kw in chamadas if "hcaptcha.com" in url]


CORPO = {"email": "ana@clube.com", "captcha_token": "tok-ok"}


class TestIdioma:
    def test_email_sai_no_idioma_da_tela(self, anonimo, config, monkeypatch):
        chamadas = _finge_rede(monkeypatch)
        r = anonimo.post("/public/auth/forgot-password", json=CORPO, headers={"X-Language": "es-ES"})
        assert r.status_code == 200
        assert r.json() == {"received": True}
        (email,) = _emails(chamadas)
        assert email["json"]["to"] == ["ana@clube.com"]
        assert email["json"]["subject"] == "Restablezca su contraseña de AceBlind"
        assert LINK in email["json"]["text"]
        assert "ana@clube.com" in email["json"]["html"]

    @pytest.mark.parametrize("header,assunto", [
        ("en", "Reset your AceBlind password"),
        ("en-GB", "Reset your AceBlind password"),
        ("fr-FR", "Redefina sua senha do AceBlind"),
        (None, "Redefina sua senha do AceBlind"),
    ])
    def test_idioma_e_normalizado_e_cai_em_portugues(self, anonimo, config, monkeypatch, header, assunto):
        chamadas = _finge_rede(monkeypatch)
        headers = {"X-Language": header} if header else {}
        anonimo.post("/public/auth/forgot-password", json=CORPO, headers=headers)
        assert _emails(chamadas)[0]["json"]["subject"] == assunto

    def test_link_e_de_recuperacao_para_o_email_em_minusculo(self, anonimo, config, monkeypatch):
        chamadas = _finge_rede(monkeypatch)
        anonimo.post("/public/auth/forgot-password", json={**CORPO, "email": "ANA@Clube.COM"})
        (link,) = _links(chamadas)
        assert link["json"]["type"] == "recovery"
        assert link["json"]["email"] == "ana@clube.com"
        assert link["json"]["redirect_to"].endswith("/definir-senha")


class TestSemEnumeracao:
    def test_email_sem_conta_responde_igual_e_nao_manda_nada(self, anonimo, config, monkeypatch):
        chamadas = _finge_rede(monkeypatch, status_link=404)
        r = anonimo.post("/public/auth/forgot-password", json=CORPO)
        assert r.status_code == 200
        assert r.json() == {"received": True}
        assert _emails(chamadas) == []

    def test_limite_do_auth_responde_igual(self, anonimo, config, monkeypatch):
        chamadas = _finge_rede(monkeypatch, status_link=429)
        assert anonimo.post("/public/auth/forgot-password", json=CORPO).status_code == 200
        assert _emails(chamadas) == []

    def test_resend_fora_do_ar_responde_igual(self, anonimo, config, monkeypatch):
        _finge_rede(monkeypatch, resend_cai=True)
        assert anonimo.post("/public/auth/forgot-password", json=CORPO).json() == {"received": True}

    def test_falha_no_provedor_nao_vira_erro(self, anonimo, config, monkeypatch):
        _finge_rede(monkeypatch, status_email=500)
        assert anonimo.post("/public/auth/forgot-password", json=CORPO).status_code == 200

    def test_sem_chave_do_resend_em_dev_o_link_vai_para_o_log(self, anonimo, config, monkeypatch, caplog):
        """É assim que se testa o fluxo inteiro sem caixa de e-mail."""
        monkeypatch.setattr(config, "resend_api_key", "", raising=False)
        chamadas = _finge_rede(monkeypatch)
        with caplog.at_level(logging.INFO, logger="app.services.email_service"):
            anonimo.post("/public/auth/forgot-password", json=CORPO)
        assert LINK in caplog.text
        assert _emails(chamadas) == []


class TestCaptcha:
    def test_captcha_recusado_da_400_e_nao_gera_link(self, anonimo, config, monkeypatch):
        chamadas = _finge_rede(monkeypatch, captcha=False)
        r = anonimo.post("/public/auth/forgot-password", json=CORPO)
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "captcha_invalido"
        assert _links(chamadas) == []

    def test_sem_token_com_secret_configurado_da_400(self, anonimo, config, monkeypatch):
        chamadas = _finge_rede(monkeypatch)
        r = anonimo.post("/public/auth/forgot-password", json={"email": "ana@clube.com"})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "captcha_invalido"
        assert _captchas(chamadas) == [] and _links(chamadas) == []

    def test_verifica_com_o_secret_o_token_e_o_ip(self, anonimo, config, monkeypatch):
        chamadas = _finge_rede(monkeypatch)
        anonimo.post("/public/auth/forgot-password", json=CORPO,
                     headers={"CF-Connecting-IP": "203.0.113.9"})
        (captcha,) = _captchas(chamadas)
        assert captcha["data"] == {"secret": "0xsegredo", "response": "tok-ok", "remoteip": "203.0.113.9"}

    def test_sem_secret_configurado_a_verificacao_e_pulada(self, anonimo, config, monkeypatch):
        """Ambiente de desenvolvimento: sem o secret, o fluxo segue (com
        aviso no log). Em produção o secret é obrigatório."""
        monkeypatch.setattr(config, "hcaptcha_secret", "", raising=False)
        chamadas = _finge_rede(monkeypatch)
        r = anonimo.post("/public/auth/forgot-password", json={"email": "ana@clube.com"})
        assert r.status_code == 200
        assert _captchas(chamadas) == []
        assert len(_emails(chamadas)) == 1

    def test_hcaptcha_fora_do_ar_e_falha_fechada(self, anonimo, config, monkeypatch):
        """Sem conseguir verificar, não manda: é a mesma porta que protege o
        login."""
        chamadas = _finge_rede(monkeypatch, captcha_cai=True)
        r = anonimo.post("/public/auth/forgot-password", json=CORPO)
        assert r.status_code == 503
        assert r.json()["detail"]["code"] == "verificacao_indisponivel"
        assert _links(chamadas) == []

    def test_captcha_vem_antes_do_limitador(self, anonimo, config, monkeypatch):
        """Um robô sem captcha válido não pode queimar o cooldown de uma
        vítima e deixá-la sem o link."""
        chamadas = _finge_rede(monkeypatch, captcha=False)
        anonimo.post("/public/auth/forgot-password", json=CORPO)
        _finge_rede(monkeypatch, captcha=True)
        chamadas2 = _finge_rede(monkeypatch)
        anonimo.post("/public/auth/forgot-password", json=CORPO)
        assert len(_emails(chamadas2)) == 1


class TestLimites:
    def test_mesmo_email_dentro_do_cooldown_nao_manda_de_novo(self, anonimo, config, monkeypatch):
        chamadas = _finge_rede(monkeypatch)
        for _ in range(3):
            r = anonimo.post("/public/auth/forgot-password", json=CORPO)
            assert r.status_code == 200
        assert len(_emails(chamadas)) == 1

    def test_ip_estourando_a_janela_para_de_mandar(self, anonimo, config, monkeypatch):
        chamadas = _finge_rede(monkeypatch)
        for i in range(mod._Limitador.MAX_POR_IP + 3):
            r = anonimo.post("/public/auth/forgot-password",
                             json={**CORPO, "email": f"pessoa{i}@clube.com"},
                             headers={"X-Forwarded-For": "198.51.100.7"})
            assert r.status_code == 200
        assert len(_emails(chamadas)) == mod._Limitador.MAX_POR_IP

    def test_cooldown_expira(self):
        lim = mod._Limitador()
        assert lim.permitir("a@b.com", "1.1.1.1", agora=1000.0) is True
        assert lim.permitir("a@b.com", "1.1.1.1", agora=1030.0) is False
        assert lim.permitir("a@b.com", "1.1.1.1", agora=1061.0) is True

    def test_janela_por_ip_desliza(self):
        lim = mod._Limitador()
        for i in range(lim.MAX_POR_IP):
            assert lim.permitir(f"p{i}@x.com", "2.2.2.2", agora=1000.0 + i) is True
        assert lim.permitir("outro@x.com", "2.2.2.2", agora=1020.0) is False
        assert lim.permitir("outro@x.com", "2.2.2.2", agora=1000.0 + lim.JANELA_IP + 1) is True


class TestPreenchimento:
    def test_email_invalido_da_422(self, anonimo, config, monkeypatch):
        chamadas = _finge_rede(monkeypatch)
        assert anonimo.post("/public/auth/forgot-password", json={**CORPO, "email": "sem-arroba"}).status_code == 422
        assert chamadas == []

    def test_nao_exige_autenticacao(self, anonimo, config, monkeypatch):
        _finge_rede(monkeypatch)
        assert anonimo.post("/public/auth/forgot-password", json=CORPO).status_code == 200
