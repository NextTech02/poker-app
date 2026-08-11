"""Testes das transacoes: criacao e consultas.

Toda entrada de dinheiro no torneio passa por aqui. O ponto sensivel e o
vinculo com o `tournament_player`: sem ele o lancamento existe mas nao se
liga ao jogador, e o total gasto dele fica errado.
"""
import pytest

from app.services import transaction_service
from app.services.transaction_service import TransactionService
from app.services.cashbox_service import CashboxService
from app.models.transaction import TransactionCreate

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
PLAYER = "44444444-4444-4444-4444-444444444444"
STAGE = "11111111-1111-1111-1111-111111111111"


def _monta(monkeypatch, tabelas=None, caixa_aberto=True):
    base = {
        "transactions": [],
        "tournament_players": [],
        "tournaments": [{"id": TOUR, "name": "Torneio A", "stage_id": STAGE}],
        "players": [{"id": PLAYER, "name": "Fulano", "nickname": "fu"}],
    }
    base.update(tabelas or {})
    fake = FakeSupabase(base)
    monkeypatch.setattr(transaction_service, "supabase", fake)
    # A exigencia de caixa aberto e testada em test_cashbox; aqui ela so nao
    # pode atrapalhar o que esta sendo medido.
    monkeypatch.setattr(
        CashboxService, "require_open_cashbox_for_tournament",
        staticmethod(lambda user_id, tournament_id: None if caixa_aberto else (_ for _ in ()).throw(ValueError("caixa fechado"))),
    )
    return fake


def _nova(tipo="buy_in", valor=100):
    return TransactionCreate(
        tournament_id=TOUR, player_id=PLAYER, type=tipo, amount=valor,
        payment_method="cash",
    )


class TestCriacao:
    def test_grava_a_transacao_com_o_autor(self, monkeypatch):
        fake = _monta(monkeypatch)
        t = TransactionService.create_transaction(_nova(), user_id="operador-1")

        assert t.amount == 100
        assert t.tournament_name == "Torneio A"
        assert t.player_name == "Fulano"
        assert fake.store["transactions"][0]["created_by"] == "operador-1"

    def test_liga_ao_jogador_do_torneio_quando_ele_existe(self, monkeypatch):
        """Sem esse vinculo o lancamento fica solto e o total gasto do jogador
        nao fecha."""
        fake = _monta(monkeypatch, {
            "tournament_players": [
                {"id": "tp-9", "tournament_id": TOUR, "player_id": PLAYER},
            ],
        })
        TransactionService.create_transaction(_nova(), user_id="u1")
        assert fake.store["transactions"][0]["tournament_player_id"] == "tp-9"

    def test_sem_inscricao_nao_inventa_vinculo(self, monkeypatch):
        fake = _monta(monkeypatch)   # nenhum tournament_player
        TransactionService.create_transaction(_nova(), user_id="u1")
        assert fake.store["transactions"][0].get("tournament_player_id") is None

    def test_caixa_fechado_impede_o_lancamento(self, monkeypatch):
        _monta(monkeypatch, caixa_aberto=False)
        with pytest.raises(ValueError, match="caixa fechado"):
            TransactionService.create_transaction(_nova(), user_id="u1")

    def test_torneio_ou_jogador_ausente_nao_quebra(self, monkeypatch):
        """Dado incompleto nao pode derrubar o caixa no meio do evento."""
        _monta(monkeypatch, {"tournaments": [], "players": []})
        t = TransactionService.create_transaction(_nova(), user_id="u1")
        assert t.tournament_name == ""
        assert t.player_name == ""

    @pytest.mark.parametrize("tipo", ["buy_in", "rebuy", "addon"])
    def test_aceita_os_tipos_de_entrada(self, monkeypatch, tipo):
        _monta(monkeypatch)
        t = TransactionService.create_transaction(_nova(tipo=tipo), user_id="u1")
        assert t.type == tipo


class TestConsultas:
    def _com_transacoes(self, monkeypatch):
        return _monta(monkeypatch, {
            "transactions": [
                {"id": "x1", "tournament_id": TOUR, "player_id": PLAYER,
                 "type": "buy_in", "amount": 100, "created_at": "2026-06-08T00:00:00Z",
                 "tournaments": {"name": "Torneio A"}, "players": {"name": "Fulano", "nickname": "fu"}},
                {"id": "x2", "tournament_id": TOUR, "player_id": PLAYER,
                 "type": "rebuy", "amount": 50, "created_at": "2026-06-08T01:00:00Z",
                 "tournaments": {"name": "Torneio A"}, "players": {"name": "Fulano", "nickname": "fu"}},
            ],
        })

    def test_lista_todas(self, monkeypatch):
        self._com_transacoes(monkeypatch)
        assert len(TransactionService.get_transactions()) == 2

    def test_lista_por_torneio(self, monkeypatch):
        self._com_transacoes(monkeypatch)
        r = TransactionService.get_transactions_by_tournament(TOUR)
        assert len(r) == 2
        # Esta consulta nao traz o nome do torneio de proposito: quem chamou ja
        # sabe qual e. O que precisa vir preenchido e o jogador.
        assert all(t.player_name == "Fulano" for t in r)
        assert all(t.tournament_name == "" for t in r)

    def test_lista_por_jogador(self, monkeypatch):
        self._com_transacoes(monkeypatch)
        r = TransactionService.get_transactions_by_player(PLAYER)
        assert len(r) == 2

    def test_torneio_sem_movimento_devolve_vazio(self, monkeypatch):
        self._com_transacoes(monkeypatch)
        assert TransactionService.get_transactions_by_tournament("outro-torneio") == []
