"""Camada HTTP do crédito de patrocinador.

Estes testes existem por um defeito específico: o router lia o id do usuário
autenticado em `user["id"]`, mas `get_current_user` devolve o PAYLOAD do JWT do
Supabase, onde o id vem em `sub`. O resultado era `KeyError: 'id'` — um 500 em
TODA escrita de crédito (conceder, acertar com o patrocinador, cancelar).

A tabela `player_credits` em produção tinha zero linhas: ninguém nunca
conseguiu conceder um crédito. Os testes abaixo passam pelo `client` real (o
mesmo usuário do conftest, que tem `sub` e NÃO tem `id`), então uma volta ao
padrão antigo derruba a suíte.

Quem paga a conta desse crédito é o patrocinador; o `created_by` é o registro
de quem autorizou. Gravá-lo errado — ou não gravar — apaga a autoria da
concessão.
"""
import pytest

from app.routers import player_credits as mod
from app.services.player_credit_service import PlayerCreditService

from tests.conftest import USUARIO_TESTE


JOGADOR = "44444444-4444-4444-4444-444444444444"
PATRO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"
CREDITO = "cccccccc-cccc-cccc-cccc-ccccccccccc1"


@pytest.fixture
def espiao(monkeypatch):
    """Troca o service por um dublê que só guarda o autor recebido."""
    registro = {}

    def _resposta():
        return {
            "id": CREDITO, "player_id": JOGADOR, "sponsor_id": PATRO,
            "stage_id": None, "original_amount": 500.0, "remaining_amount": 500.0,
            "used_amount": 0.0, "status": "active", "prize_deduction_amount": 0,
            "sponsor_owes": 0, "notes": None, "created_by": registro.get("autor"),
            "created_at": "2026-06-08T00:00:00Z",
        }

    def _conceder(data, user_id):
        registro["autor"] = user_id
        return _resposta()

    def _acertar(credit_id, data, user_id):
        registro["autor"] = user_id
        return _resposta()

    def _cancelar(credit_id, user_id):
        registro["autor"] = user_id
        return _resposta()

    monkeypatch.setattr(PlayerCreditService, "grant_credit", staticmethod(_conceder))
    monkeypatch.setattr(PlayerCreditService, "settle_sponsor_payment", staticmethod(_acertar))
    monkeypatch.setattr(PlayerCreditService, "cancel_credit", staticmethod(_cancelar))
    return registro


CORPO = {"player_id": JOGADOR, "sponsor_id": PATRO, "amount": 500}


class TestAutorDaOperacao:
    def test_conceder_credito_responde_201_e_nao_500(self, client, espiao):
        """Era 500: o router lia uma chave que o JWT não tem."""
        r = client.post("/player-credits", json=CORPO)
        assert r.status_code == 200

    def test_o_autor_gravado_e_o_sub_do_token(self, client, espiao):
        """`sub` é o id do usuário no JWT do Supabase; `id` não existe lá."""
        client.post("/player-credits", json=CORPO)
        assert espiao["autor"] == USUARIO_TESTE["sub"]

    def test_acerto_com_o_patrocinador_tambem_registra_o_autor(self, client, espiao):
        r = client.post(f"/player-credits/{CREDITO}/settle", json={"amount": 100})
        assert r.status_code == 200
        assert espiao["autor"] == USUARIO_TESTE["sub"]

    def test_cancelamento_tambem_registra_o_autor(self, client, espiao):
        r = client.post(f"/player-credits/{CREDITO}/cancel")
        assert r.status_code == 200
        assert espiao["autor"] == USUARIO_TESTE["sub"]

    def test_token_que_traz_id_em_vez_de_sub_continua_funcionando(self, client, espiao):
        """Tolerância a um token de formato diferente: o id ainda é resolvido."""
        client.usuario.pop("sub")
        client.usuario["id"] = "99999999-9999-9999-9999-999999999999"
        client.post("/player-credits", json=CORPO)
        assert espiao["autor"] == "99999999-9999-9999-9999-999999999999"


class TestValidacaoDoCorpo:
    def test_valor_zero_e_recusado(self, client, espiao):
        """Crédito de zero não é crédito; deixaria uma linha inútil no razão."""
        r = client.post("/player-credits", json={**CORPO, "amount": 0})
        assert r.status_code == 422

    def test_valor_negativo_e_recusado(self, client, espiao):
        r = client.post("/player-credits", json={**CORPO, "amount": -50})
        assert r.status_code == 422

    def test_sem_patrocinador_e_recusado(self, client, espiao):
        """Sem patrocinador não há de quem cobrar depois."""
        r = client.post("/player-credits", json={"player_id": JOGADOR, "amount": 500})
        assert r.status_code == 422


class TestErrosDeRegra:
    def test_jogador_inexistente_vira_400_com_o_motivo(self, client, monkeypatch):
        def _explode(data, user_id):
            raise ValueError("Jogador não encontrado")

        monkeypatch.setattr(PlayerCreditService, "grant_credit", staticmethod(_explode))
        r = client.post("/player-credits", json=CORPO)
        assert r.status_code == 400
        # ValueError simples (ainda sem código próprio) chega embrulhado no
        # código genérico, para a tela ter UM formato só de recusa.
        assert r.json()["detail"] == {
            "code": "regra_de_negocio",
            "message": "Jogador não encontrado",
        }
