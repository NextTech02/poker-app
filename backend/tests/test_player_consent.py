"""Consentimento do jogador para contatos futuros (LGPD).

O que estes testes travam:

1. **O cadastro dispara o pedido — e não espera por ele.** Vai para o pool de
   envio; o cadastro devolve na hora.
2. **Só o hash do token vai para o banco.** O token puro existe só no link.
3. **E-mail de mentira não recebe nada** (`@placeholder.com` da base antiga).
4. **Uso único e validade.** Link usado ou vencido não grava resposta.
5. **Reenviar não insiste com quem já respondeu** e não dispara em rajada.
6. **A página pública não expõe dado pessoal** além do primeiro nome.
"""
import hashlib
from datetime import datetime, timedelta, timezone

import pytest

from app.models.player import PlayerCreate
from app.services import player_consent_service as mod
from app.services import player_service as ps_mod
from app.services.player_consent_service import PlayerConsentService as C
from app.services.player_service import PlayerService
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase

ORG = "33333333-3333-3333-3333-333333333333"
JOGADOR = "44444444-4444-4444-4444-444444444444"


def _agora():
    return datetime.now(timezone.utc)


def _jogador(**kw):
    linha = {
        "id": JOGADOR, "organization_id": ORG, "name": "Ana Souza", "first_name": "Ana",
        "email": "ana@exemplo.com", "contact_consent": None,
        "contact_consent_at": None, "contact_consent_requested_at": None,
    }
    linha.update(kw)
    return linha


def _banco(monkeypatch, jogador=None, tokens=None):
    fake = FakeSupabase({
        "players": [jogador or _jogador()],
        "player_consent_tokens": tokens or [],
        "organizations": [{"id": ORG, "name": "Clube Royal"}],
        "app_settings": [{"organization_id": ORG, "language": "es-ES"}],
    })
    monkeypatch.setattr(mod, "supabase_admin", fake)
    return fake


@pytest.fixture
def emails(monkeypatch):
    enviados = []

    def _enviar(para, assunto, html, texto, *, link=None):
        enviados.append({"para": para, "assunto": assunto, "html": html, "texto": texto, "link": link})

    monkeypatch.setattr(mod, "enviar_email", _enviar)
    monkeypatch.setattr(mod._ritmo, "esperar", lambda: None)
    return enviados


def recusa(exc):
    return exc.value.como_http().detail


# ══════════════════════════════════════════════════════════════════════
# Pedido
# ══════════════════════════════════════════════════════════════════════

def test_cadastro_agenda_o_pedido_sem_esperar(monkeypatch, envios_de_consentimento):
    fake = FakeSupabase({"players": []})
    monkeypatch.setattr(ps_mod, "supabase", fake)
    PlayerService.create_player(PlayerCreate(
        name="Ana Souza", email="ana@exemplo.com", phone="11999999999",
        nationality="BR", document_type="passport", document_number="AB123456",
    ))
    assert len(envios_de_consentimento.chamadas) == 1
    fn, args, _ = envios_de_consentimento.chamadas[0]
    assert fn == C._solicitar and args[0]["email"] == "ana@exemplo.com"


def test_email_placeholder_nao_recebe_pedido(envios_de_consentimento):
    assert C.solicitar_em_segundo_plano(_jogador(email="player_1@placeholder.com")) is False
    assert C.solicitar_em_segundo_plano(_jogador(email="")) is False
    assert envios_de_consentimento.chamadas == []


def test_quem_ja_respondeu_nao_recebe_de_novo(envios_de_consentimento):
    assert C.solicitar_em_segundo_plano(_jogador(contact_consent="denied")) is False
    assert envios_de_consentimento.chamadas == []


def test_pedido_grava_so_o_hash_marca_pendente_e_manda_no_idioma_do_clube(monkeypatch, emails):
    fake = _banco(monkeypatch)
    C._solicitar(_jogador())

    assert len(emails) == 1
    link = emails[0]["link"]
    token = link.rsplit("/", 1)[1]
    assert "/consentimento/" in link

    tok = fake.store["player_consent_tokens"][0]
    assert tok["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert token not in str(tok)                      # o token puro não fica no banco
    assert tok["organization_id"] == ORG and tok["player_id"] == JOGADOR

    j = fake.store["players"][0]
    assert j["contact_consent"] == "pending" and j["contact_consent_requested_at"]

    # Espanhol, porque é o idioma do CLUBE; nome do clube e primeiro nome.
    assert emails[0]["assunto"] == "Clube Royal: ¿podemos contactarlo?"
    assert "Hola, Ana." in emails[0]["texto"]


def test_falha_no_pedido_nao_levanta(monkeypatch, emails):
    class Quebrado:
        def table(self, *_):
            raise RuntimeError("relation player_consent_tokens does not exist")

    monkeypatch.setattr(mod, "supabase_admin", Quebrado())
    assert C._solicitar(_jogador()) == "falhou"
    assert emails == []


# ══════════════════════════════════════════════════════════════════════
# Reenvio
# ══════════════════════════════════════════════════════════════════════

def test_reenviar_agenda_novo_pedido(monkeypatch, envios_de_consentimento):
    _banco(monkeypatch, _jogador(contact_consent="pending",
                                 contact_consent_requested_at=(_agora() - timedelta(hours=1)).isoformat()))
    assert C.reenviar(JOGADOR)["sent"] is True
    assert len(envios_de_consentimento.chamadas) == 1


def test_reenviar_recusa_quem_ja_respondeu(monkeypatch):
    _banco(monkeypatch, _jogador(contact_consent="granted"))
    with pytest.raises(ErroDeNegocio) as exc:
        C.reenviar(JOGADOR)
    d = recusa(exc)
    assert d["code"] == "consentimento_ja_respondido" and d["status_atual"] == "granted"


def test_reenviar_em_rajada_e_recusado(monkeypatch, envios_de_consentimento):
    _banco(monkeypatch, _jogador(contact_consent="pending",
                                 contact_consent_requested_at=_agora().isoformat()))
    with pytest.raises(ErroDeNegocio) as exc:
        C.reenviar(JOGADOR)
    assert recusa(exc)["code"] == "consentimento_reenviado_recentemente"
    assert envios_de_consentimento.chamadas == []


def test_reenviar_sem_email_valido(monkeypatch):
    _banco(monkeypatch, _jogador(email="player_9@placeholder.com"))
    with pytest.raises(ErroDeNegocio) as exc:
        C.reenviar(JOGADOR)
    assert recusa(exc)["code"] == "jogador_sem_email_valido"


# ══════════════════════════════════════════════════════════════════════
# Resposta (página pública)
# ══════════════════════════════════════════════════════════════════════

def _token(token="abc123", **kw):
    linha = {
        "id": "t1", "organization_id": ORG, "player_id": JOGADOR,
        "token_hash": hashlib.sha256(token.encode()).hexdigest(),
        "expires_at": (_agora() + timedelta(days=10)).isoformat(),
        "used_at": None,
    }
    linha.update(kw)
    return linha


def test_pagina_mostra_clube_e_primeiro_nome_sem_dado_pessoal(monkeypatch):
    _banco(monkeypatch, _jogador(contact_consent="pending"), [_token()])
    r = C.resolver("abc123")
    assert r["organization_name"] == "Clube Royal"
    assert r["player_first_name"] == "Ana"
    assert r["status"] == "pending" and r["used"] is False and r["expired"] is False
    assert "ana@exemplo.com" not in str(r) and "Souza" not in str(r)


def test_token_desconhecido(monkeypatch):
    _banco(monkeypatch, tokens=[_token()])
    with pytest.raises(ErroDeNegocio) as exc:
        C.resolver("outro")
    assert recusa(exc)["code"] == "link_invalido"


def test_autorizar_grava_granted_e_queima_o_token(monkeypatch):
    fake = _banco(monkeypatch, _jogador(contact_consent="pending"), [_token()])
    r = C.responder("abc123", True)
    assert r["status"] == "granted"
    j = fake.store["players"][0]
    assert j["contact_consent"] == "granted" and j["contact_consent_at"]
    assert fake.store["player_consent_tokens"][0]["used_at"]


def test_recusar_grava_denied(monkeypatch):
    fake = _banco(monkeypatch, _jogador(contact_consent="pending"), [_token()])
    assert C.responder("abc123", False)["status"] == "denied"
    assert fake.store["players"][0]["contact_consent"] == "denied"


def test_link_usado_nao_responde_de_novo(monkeypatch):
    fake = _banco(monkeypatch, _jogador(contact_consent="granted"),
                  [_token(used_at=_agora().isoformat())])
    with pytest.raises(ErroDeNegocio) as exc:
        C.responder("abc123", False)
    assert recusa(exc)["code"] == "link_ja_usado"
    assert fake.store["players"][0]["contact_consent"] == "granted"


def test_link_vencido(monkeypatch):
    _banco(monkeypatch, _jogador(contact_consent="pending"),
           [_token(expires_at=(_agora() - timedelta(days=1)).isoformat())])
    assert C.resolver("abc123")["expired"] is True
    with pytest.raises(ErroDeNegocio) as exc:
        C.responder("abc123", True)
    assert recusa(exc)["code"] == "link_expirado"


# ══════════════════════════════════════════════════════════════════════
# Rotas públicas
# ══════════════════════════════════════════════════════════════════════

def test_rota_publica_responde_sem_login(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routers import public_consent

    public_consent._limite.limpar()
    _banco(monkeypatch, _jogador(contact_consent="pending"), [_token()])
    c = TestClient(app)
    assert c.get("/public/consent/abc123").json()["organization_name"] == "Clube Royal"
    r = c.post("/public/consent/abc123", json={"accept": True})
    assert r.status_code == 200 and r.json()["status"] == "granted"
    r2 = c.post("/public/consent/abc123", json={"accept": False})
    assert r2.status_code == 409 and r2.json()["detail"]["code"] == "link_ja_usado"
