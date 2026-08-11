"""Testes da inscricao de jogador, rebuy, addon e eliminacao.

E a operacao mais repetida do evento: cada uma dessas chamadas movimenta
dinheiro e fichas. Os pontos sensiveis sao os limites (dia cheio, inscricao
duplicada) e o rake, que desde os tipos de buy passou a ser por transacao.
"""
import pytest

from app.services import tournament_player_service
from app.services.tournament_player_service import TournamentPlayerService
from app.services.cashbox_service import CashboxService
from app.models.tournament_player import TournamentPlayerCreate, TournamentPlayerUpdate

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
PLAYER = "44444444-4444-4444-4444-444444444444"
TP = "66666666-6666-6666-6666-666666666666"


def _dia(buy_in=100, chips=10000, rake=20, max_players=None, registrados=0):
    return {
        "id": DIA, "tournament_id": TOUR, "buy_in": buy_in,
        "starting_chips": chips, "rake_percentage": rake,
        "max_players": max_players, "registered_players": registrados,
        "rebuy_amount": buy_in, "addon_amount": buy_in,
        "rebuy_chips": chips, "addon_chips": chips,
        "created_at": "2026-06-08T00:00:00Z",
    }


def _monta(monkeypatch, dia=None, jogadores=None, tabelas=None):
    base = {
        "tournaments": [{"id": TOUR, "name": "Torneio A"}],
        "tournament_days": [dia or _dia()],
        "tournament_players": jogadores if jogadores is not None else [],
        "players": [{"id": PLAYER, "name": "Fulano", "nickname": "fu"}],
        "transactions": [],
        "buy_types": [],
    }
    base.update(tabelas or {})
    fake = FakeSupabase(base)
    monkeypatch.setattr(tournament_player_service, "supabase", fake)
    monkeypatch.setattr(CashboxService, "require_open_cashbox_for_tournament",
                        staticmethod(lambda *a, **k: None))
    return fake


def _inscricao(**kw):
    dados = dict(tournament_id=TOUR, tournament_day_id=DIA, player_id=PLAYER)
    dados.update(kw)
    return TournamentPlayerCreate(**dados)


class TestInscricao:
    def test_registra_e_cobra_o_buy_in(self, monkeypatch):
        fake = _monta(monkeypatch)
        r = TournamentPlayerService.register_player(_inscricao(), "u1")
        assert r.player_id == PLAYER
        # gera a transacao de entrada
        entradas = [t for t in fake.store["transactions"] if t["type"] == "buy_in"]
        assert len(entradas) == 1
        assert float(entradas[0]["amount"]) == 100.0

    def test_rake_vem_do_dia_quando_nao_ha_tipo_de_buy(self, monkeypatch):
        fake = _monta(monkeypatch, dia=_dia(buy_in=100, rake=20))
        TournamentPlayerService.register_player(_inscricao(), "u1")
        entrada = fake.store["transactions"][0]
        assert float(entrada["rake_amount"]) == 20.0

    def test_rake_do_tipo_de_buy_tem_precedencia(self, monkeypatch):
        """Cada tipo de buy tem o proprio rake; ignorar isso faria o rake da
        etapa fechar diferente do combinado."""
        fake = _monta(monkeypatch, dia=_dia(buy_in=100, rake=20), tabelas={
            "buy_types": [{"id": "bt1", "name": "Turbo", "rake_percentage": 5,
                           "amount": 100, "category": "buy_in"}],
        })
        TournamentPlayerService.register_player(_inscricao(buy_type_id="bt1"), "u1")
        entrada = fake.store["transactions"][0]
        assert float(entrada["rake_amount"]) == 5.0

    def test_inscricao_duplicada_no_mesmo_dia_e_recusada(self, monkeypatch):
        _monta(monkeypatch, jogadores=[{
            "id": TP, "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": PLAYER, "status": "active",
        }])
        with pytest.raises(ValueError, match="já está registrado"):
            TournamentPlayerService.register_player(_inscricao(), "u1")

    def test_dia_cheio_recusa_novo_jogador(self, monkeypatch):
        """Aceitar acima do limite deixaria alguem sem assento."""
        _monta(monkeypatch, dia=_dia(max_players=10, registrados=10))
        with pytest.raises(ValueError, match="cheio"):
            TournamentPlayerService.register_player(_inscricao(), "u1")

    def test_torneio_inexistente_e_recusado(self, monkeypatch):
        _monta(monkeypatch, tabelas={"tournaments": []})
        with pytest.raises(ValueError, match="Tournament not found"):
            TournamentPlayerService.register_player(_inscricao(), "u1")

    def test_dia_inexistente_e_recusado(self, monkeypatch):
        _monta(monkeypatch, tabelas={"tournament_days": []})
        with pytest.raises(ValueError, match="Tournament day not found"):
            TournamentPlayerService.register_player(_inscricao(), "u1")

    def test_entrega_as_fichas_iniciais(self, monkeypatch):
        fake = _monta(monkeypatch, dia=_dia(chips=25000))
        TournamentPlayerService.register_player(_inscricao(), "u1")
        assert fake.store["tournament_players"][0]["total_chips"] == 25000


class TestRebuyEAddon:
    def _com_jogador(self, monkeypatch, **kw):
        jogador = {
            "id": TP, "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": PLAYER, "status": "active", "rebuy_count": 0, "addon_count": 0,
            "total_chips": 10000, "total_spent": 100,
            "total_buy_in_amount": 100, "total_rebuy_amount": 0, "total_addon_amount": 0,
            "created_at": "2026-06-08T00:00:00Z", "registered_at": "2026-06-08T00:00:00Z",
        }
        jogador.update(kw)
        return _monta(monkeypatch, jogadores=[jogador])

    def test_rebuy_soma_valor_fichas_e_contador(self, monkeypatch):
        fake = self._com_jogador(monkeypatch)
        TournamentPlayerService.add_rebuy(TP, "u1", skip_level_gate=True)
        linha = fake.store["tournament_players"][0]
        assert linha["rebuy_count"] == 1
        assert linha["total_chips"] == 20000
        rebuys = [t for t in fake.store["transactions"] if t["type"] == "rebuy"]
        assert len(rebuys) == 1

    def test_addon_soma_contador_proprio(self, monkeypatch):
        fake = self._com_jogador(monkeypatch)
        TournamentPlayerService.add_addon(TP, "u1")
        assert fake.store["tournament_players"][0]["addon_count"] == 1

    def test_jogador_inexistente_e_recusado(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError):
            TournamentPlayerService.add_rebuy("nao-existe", "u1", skip_level_gate=True)

    def test_dois_rebuys_acumulam(self, monkeypatch):
        """Dois rebuys seguidos no mesmo jogador nao podem se sobrescrever."""
        fake = self._com_jogador(monkeypatch)
        TournamentPlayerService.add_rebuy(TP, "u1", skip_level_gate=True)
        TournamentPlayerService.add_rebuy(TP, "u1", skip_level_gate=True)
        assert fake.store["tournament_players"][0]["rebuy_count"] == 2


class TestEliminacao:
    def _ativo(self, monkeypatch):
        return _monta(monkeypatch, jogadores=[{
            "id": TP, "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": PLAYER, "status": "active", "rebuy_count": 0, "addon_count": 0,
            "total_chips": 10000, "total_spent": 100,
            "total_buy_in_amount": 100, "total_rebuy_amount": 0, "total_addon_amount": 0,
            "created_at": "2026-06-08T00:00:00Z", "registered_at": "2026-06-08T00:00:00Z",
        }])

    def test_marca_como_eliminado(self, monkeypatch):
        fake = self._ativo(monkeypatch)
        TournamentPlayerService.eliminate_player(TP, "u1")
        assert fake.store["tournament_players"][0]["status"] == "eliminated"

    def test_eliminar_duas_vezes_com_idempotente_nao_estoura(self, monkeypatch):
        """O replay da fila offline pode reenviar a mesma eliminacao."""
        self._ativo(monkeypatch)
        TournamentPlayerService.eliminate_player(TP, "u1")
        TournamentPlayerService.eliminate_player(TP, "u1", idempotent=True)

    def test_atualizacao_direta_muda_o_status(self, monkeypatch):
        fake = self._ativo(monkeypatch)
        TournamentPlayerService.eliminate_player(TP, "u1")
        TournamentPlayerService.update_tournament_player(
            TP, TournamentPlayerUpdate(status="active")
        )
        assert fake.store["tournament_players"][0]["status"] == "active"


class TestListagens:
    def test_lista_por_torneio(self, monkeypatch):
        _monta(monkeypatch, jogadores=[{
            "id": TP, "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": PLAYER, "status": "active", "rebuy_count": 0, "addon_count": 0,
            "total_chips": 10000, "total_spent": 100,
            "total_buy_in_amount": 100, "total_rebuy_amount": 0, "total_addon_amount": 0,
            "created_at": "2026-06-08T00:00:00Z", "registered_at": "2026-06-08T00:00:00Z",
            "players": {"name": "Fulano", "nickname": "fu"},
        }])
        r = TournamentPlayerService.get_tournament_players(TOUR)
        assert len(r) == 1

    def test_torneio_vazio_devolve_lista_vazia(self, monkeypatch):
        _monta(monkeypatch)
        assert TournamentPlayerService.get_tournament_players(TOUR) == []
