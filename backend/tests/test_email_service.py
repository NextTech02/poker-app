"""E-mails transacionais redigidos pelo app, no idioma de quem pediu.

O que estes testes travam:

1. Os três e-mails existem nos três idiomas, completos e sem marcador solto —
   um clube colombiano não pode receber "{org}" no assunto.
2. O link vai no botão E na linha "copie e cole" (HTML), e cru no texto puro.
3. Nome de clube e de pessoa passam por escape no HTML: são texto digitado
   pelo admin, não marcação.
4. O envio NUNCA levanta: devolve um motivo curto, e sem chave em
   desenvolvimento o link vai para o log — é assim que se testa o fluxo
   inteiro sem caixa de e-mail. Em produção o link é credencial e não aparece.
"""
import logging
import re

import pytest

from app.config import get_settings
from app.services import email_service as mod
from app.services.email_textos import COMUNS, TEXTOS
from app.utils.idioma import IDIOMAS_SUPORTADOS, normalizar_idioma

LINK = "https://xyz.supabase.co/auth/v1/verify?token=abc&type=recovery&redirect_to=https://app/definir-senha"
_MARCADOR = re.compile(r"\{(nome|org|email)\}")


class TestNormalizarIdioma:
    @pytest.mark.parametrize("entrada,esperado", [
        (None, "pt-BR"),
        ("", "pt-BR"),
        ("   ", "pt-BR"),
        ("pt-BR", "pt-BR"),
        ("en-US", "en-US"),
        ("es-ES", "es-ES"),
        ("EN-us", "en-US"),
        ("pt_BR", "pt-BR"),
        ("pt", "pt-BR"),
        ("en", "en-US"),
        ("es", "es-ES"),
        ("es-419", "es-ES"),
        ("en-GB", "en-US"),
        ("pt-PT", "pt-BR"),
        ("fr-FR", "pt-BR"),
        (42, "pt-BR"),
    ])
    def test_cai_sempre_num_dos_tres(self, entrada, esperado):
        assert normalizar_idioma(entrada) == esperado


class TestTextos:
    @pytest.mark.parametrize("tipo", sorted(TEXTOS))
    @pytest.mark.parametrize("idioma", IDIOMAS_SUPORTADOS)
    def test_todo_tipo_existe_completo_em_todo_idioma(self, tipo, idioma):
        t = TEXTOS[tipo][idioma]
        assert set(t) == {"assunto", "titulo", "paragrafos", "cta", "aviso", "rodape"}
        assert len(t["paragrafos"]) == 2
        assert all(v for v in t.values())
        assert set(COMUNS[idioma]) == {"se_nao_funcionar", "marca"}

    @pytest.mark.parametrize("tipo", sorted(TEXTOS))
    @pytest.mark.parametrize("idioma", IDIOMAS_SUPORTADOS)
    def test_nenhum_marcador_sobra_depois_de_renderizar(self, tipo, idioma):
        assunto, html, texto = mod.renderizar(
            tipo, idioma, link=LINK, nome="Ana", org="Clube Royal", email="ana@x.com"
        )
        for parte in (assunto, html, texto):
            assert not _MARCADOR.search(parte), parte
        assert "**" not in html and "**" not in texto and "**" not in assunto


class TestRenderizar:
    def test_devolve_assunto_html_e_texto_no_idioma_pedido(self):
        assunto, html, texto = mod.renderizar(
            "convite_funcionario", "es-ES", link=LINK, org="Clube Royal"
        )
        assert assunto == "Fue invitado al equipo de Clube Royal"
        assert "Definir mi contraseña" in html
        assert "Definir mi contraseña" in texto

    def test_link_vai_no_botao_e_na_linha_de_copiar_e_colar(self):
        _, html, texto = mod.renderizar("redefinir_senha", "pt-BR", link=LINK, email="a@b.com")
        escapado = LINK.replace("&", "&amp;")
        # Duas vezes no HTML (botão e texto visível), sempre escapado.
        assert html.count(f'href="{escapado}"') == 2
        assert LINK not in html
        # Cru no texto puro, onde não há o que escapar.
        assert LINK in texto

    def test_valores_digitados_sao_escapados_no_html_e_crus_no_texto(self):
        org = '<b>Clube & "Cia"</b>'
        assunto, html, texto = mod.renderizar("convite_funcionario", "pt-BR", link=LINK, org=org)
        assert "&lt;b&gt;Clube &amp; &quot;Cia&quot;&lt;/b&gt;" in html
        assert "<b>Clube" not in html
        assert org in texto
        assert org in assunto

    def test_negrito_vira_strong_no_html_e_some_no_texto(self):
        _, html, texto = mod.renderizar("convite_organizacao", "en-US", link=LINK, nome="Ann", org="Royal")
        assert "<strong" in html
        assert "**" not in texto
        assert "Royal" in texto

    def test_valor_com_chaves_nao_vira_marcador_nem_erro(self):
        _, _, texto = mod.renderizar("convite_funcionario", "pt-BR", link=LINK, org="Clube {A}")
        assert "Clube {A}" in texto

    def test_idioma_desconhecido_cai_em_portugues(self):
        assunto, _, _ = mod.renderizar("redefinir_senha", "fr-FR", link=LINK, email="a@b.com")
        assert assunto == "Redefina sua senha do AceBlind"

    def test_tipo_desconhecido_e_erro_de_programacao(self):
        with pytest.raises(KeyError):
            mod.renderizar("boas_vindas", "pt-BR", link=LINK)

    def test_valor_ausente_vira_vazio_e_nao_None(self):
        _, html, _ = mod.renderizar("convite_organizacao", "pt-BR", link=LINK, nome=None, org="X")
        assert "None" not in html


class _Resp:
    def __init__(self, status, text=""):
        self.status_code = status
        self.text = text


@pytest.fixture
def config(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "resend_api_key", "re_teste", raising=False)
    monkeypatch.setattr(s, "leads_email_from", "AceBlind <n@x.com>", raising=False)
    monkeypatch.setattr(s, "environment", "development", raising=False)
    return s


class TestEnviarEmail:
    def test_envia_com_html_e_texto(self, config, monkeypatch):
        chamadas = []

        def _post(url, **kw):
            chamadas.append((url, kw))
            return _Resp(200)

        monkeypatch.setattr(mod.httpx, "post", _post)
        motivo = mod.enviar_email("a@b.com", "Assunto", "<p>oi</p>", "oi", link=LINK)
        assert motivo is None
        url, kw = chamadas[0]
        assert "resend.com" in url
        assert kw["json"] == {
            "from": "AceBlind <n@x.com>", "to": ["a@b.com"], "subject": "Assunto",
            "html": "<p>oi</p>", "text": "oi",
        }
        assert kw["headers"]["Authorization"] == "Bearer re_teste"

    def test_sem_chave_nem_tenta_e_devolve_o_motivo(self, config, monkeypatch):
        monkeypatch.setattr(config, "resend_api_key", "", raising=False)
        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: pytest.fail("não devia chamar"))
        assert mod.enviar_email("a@b.com", "A", "<p/>", "t") == "sem_chave"

    def test_sem_chave_em_desenvolvimento_o_link_vai_para_o_log(self, config, monkeypatch, caplog):
        """É o jeito de testar convite e esqueci-senha ponta a ponta sem
        caixa de e-mail."""
        monkeypatch.setattr(config, "resend_api_key", "", raising=False)
        with caplog.at_level(logging.INFO, logger="app.services.email_service"):
            mod.enviar_email("a@b.com", "Assunto X", "<p/>", "t", link=LINK)
        assert LINK in caplog.text
        assert "Assunto X" in caplog.text

    def test_sem_chave_em_producao_o_link_NAO_vai_para_o_log(self, config, monkeypatch, caplog):
        """O link é credencial: quem lê o log de produção não pode virar dono
        da conta."""
        monkeypatch.setattr(config, "resend_api_key", "", raising=False)
        monkeypatch.setattr(config, "environment", "production", raising=False)
        with caplog.at_level(logging.INFO, logger="app.services.email_service"):
            assert mod.enviar_email("a@b.com", "A", "<p/>", "t", link=LINK) == "sem_chave"
        assert LINK not in caplog.text

    def test_recusa_do_provedor_vira_motivo_e_fica_no_log(self, config, monkeypatch, caplog):
        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: _Resp(422, '{"message":"from inválido"}'))
        with caplog.at_level(logging.WARNING, logger="app.services.email_service"):
            assert mod.enviar_email("a@b.com", "A", "<p/>", "t") == "recusado"
        assert "from inválido" in caplog.text

    def test_provedor_fora_do_ar_nao_levanta(self, config, monkeypatch):
        def _cai(*a, **k):
            raise RuntimeError("connect timeout")
        monkeypatch.setattr(mod.httpx, "post", _cai)
        assert mod.enviar_email("a@b.com", "A", "<p/>", "t") == "indisponivel"
