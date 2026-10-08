"""Inscrição ESTORNADA (`status = 'cancelled'`) na lista de jogadores do dia.

O cancelamento de venda grava `cancelled` em `tournament_players` (o banco
aceita no CHECK), mas o enum do modelo não tinha o valor: qualquer dia com um
estorno derrubava `GET /tournament-players/day/{id}` em 500 — e com ele o
telão daquele dia, que mostrava "Erro" para o salão inteiro.
"""
import pytest

from app.models.tournament_player import TournamentPlayer, TournamentPlayerStatus
from app.services import tournament_player_service
from app.services.tournament_player_service import TournamentPlayerService

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"


def _inscrito(tp_id, nome, status, buy_ins=1):
    return {
        "id": tp_id, "tournament_id": TOUR, "tournament_day_id": DIA, "player_id": f"p-{tp_id}",
        "status": status, "buy_in_count": buy_ins, "rebuy_count": 0, "addon_count": 0,
        "total_buy_in_amount": 100 * buy_ins, "total_rebuy_amount": 0, "total_addon_amount": 0,
        "total_chips": 10000 * buy_ins, "total_spent": 100 * buy_ins,
        "registered_at": "2026-06-08T20:00:00Z",
        "players": {"name": nome, "nickname": None},
        "tournaments": {"name": "Main Event"},
    }


@pytest.fixture
def banco(monkeypatch):
    fake = FakeSupabase({
        "tournament_players": [
            _inscrito("tp1", "Ana", "active"),
            _inscrito("tp2", "Beto", "cancelled", buy_ins=0),
            _inscrito("tp3", "Caio", "eliminated"),
        ],
        "tournament_days": [{"id": DIA, "tournament_id": TOUR, "day_name": "Dia 1"}],
    })
    monkeypatch.setattr(tournament_player_service, "supabase", fake)
    return fake


class TestStatusCancelado:

    def test_o_modelo_aceita_cancelled(self):
        assert TournamentPlayerStatus("cancelled") is TournamentPlayerStatus.cancelled
        tp = TournamentPlayer(**{k: v for k, v in _inscrito("x", "Zé", "cancelled").items()
                                 if k not in ("players", "tournaments")})
        assert tp.status == TournamentPlayerStatus.cancelled

    def test_a_lista_do_dia_nao_cai_por_causa_de_um_estorno(self, banco):
        """Era 500 (validação do modelo): a tela do caixa e o telão do dia
        paravam por causa de UMA venda cancelada."""
        lista = TournamentPlayerService.get_tournament_day_players(DIA)
        assert [p.player_name for p in lista] == ["Ana", "Beto", "Caio"]
        estornado = next(p for p in lista if p.player_name == "Beto")
        assert estornado.status == TournamentPlayerStatus.cancelled
        assert estornado.buy_in_count == 0

    def test_a_rota_publica_do_dia_responde_200(self, client, banco):
        r = client.get(f"/tournament-players/day/{DIA}")
        assert r.status_code == 200
        assert [p["status"] for p in r.json()] == ["active", "cancelled", "eliminated"]
