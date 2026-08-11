"""Testes de alocacao em mesas.

Dois jogadores no mesmo assento e o erro que aparece na hora, com o salao
cheio e as pessoas ja sentadas — nao ha como desfazer discretamente. Por isso
os testes se concentram nas colisoes e nos limites, e na distribuicao
equilibrada (mesas com numeros muito diferentes de jogadores dao vantagem
posicional a quem esta na mesa vazia).
"""
import pytest

from app.services import allocation_service
from app.services.allocation_service import AllocationService
from app.models.seat_allocation import SeatAllocationUpdate

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
P1 = "44444444-4444-4444-4444-444444444441"
P2 = "44444444-4444-4444-4444-444444444442"
P3 = "44444444-4444-4444-4444-444444444443"


def _mesa(id_, numero, lugares=9, ocupados=0):
    return {"id": id_, "tournament_id": TOUR, "tournament_day_id": DIA,
            "table_number": numero, "seats": lugares, "occupied_seats": ocupados,
            "status": "active", "created_at": "2026-06-08T00:00:00Z"}


def _alocacao(id_, mesa, assento, player=P1):
    return {"id": id_, "tournament_id": TOUR, "tournament_day_id": DIA,
            "table_id": mesa, "seat_number": assento, "player_id": player,
            "created_at": "2026-06-08T00:00:00Z",
            # relacoes que o PostgREST embute no select
            "players": {"name": "Jogador"},
            "tournament_tables": {"table_number": 1},
            "tournaments": {"name": "Torneio"}}


def _monta(monkeypatch, mesas=None, alocacoes=None, jogadores=None):
    fake = FakeSupabase({
        "tournament_tables": mesas if mesas is not None else [_mesa("m1", 1)],
        "tables": mesas if mesas is not None else [_mesa("m1", 1)],
        "seat_allocations": alocacoes or [],
        "tournament_players": jogadores or [],
        "players": [{"id": P1, "name": "Um"}, {"id": P2, "name": "Dois"},
                    {"id": P3, "name": "Tres"}],
        "tournaments": [{"id": TOUR, "name": "Torneio"}],
        "tournament_days": [{"id": DIA, "tournament_id": TOUR}],
    })
    monkeypatch.setattr(allocation_service, "supabase", fake)
    return fake


class TestAlocacaoManual:
    def test_assento_ocupado_e_recusado(self, monkeypatch):
        """O erro mais grave: dois jogadores no mesmo lugar."""
        _monta(monkeypatch, alocacoes=[_alocacao("a1", "m1", 3)])
        with pytest.raises(ValueError, match="already occupied"):
            AllocationService.manual_allocate_player(TOUR, P2, "m1", 3)

    def test_mesa_inexistente_e_recusada(self, monkeypatch):
        _monta(monkeypatch, mesas=[])
        with pytest.raises(ValueError, match="Table not found"):
            AllocationService.manual_allocate_player(TOUR, P1, "m-nao-existe", 1)

    def test_mesa_cheia_e_recusada(self, monkeypatch):
        _monta(monkeypatch, mesas=[_mesa("m1", 1, lugares=9, ocupados=9)])
        with pytest.raises(ValueError, match="Table is full"):
            AllocationService.manual_allocate_player(TOUR, P1, "m1", 5)

    def test_assento_acima_do_tamanho_da_mesa(self, monkeypatch):
        """Mesa de 9 nao tem assento 12; aceitar geraria um lugar inexistente."""
        _monta(monkeypatch, mesas=[_mesa("m1", 1, lugares=9)])
        with pytest.raises(ValueError, match="Invalid seat number"):
            AllocationService.manual_allocate_player(TOUR, P1, "m1", 12)

    def test_aloca_em_assento_livre(self, monkeypatch):
        fake = _monta(monkeypatch)
        AllocationService.manual_allocate_player(TOUR, P1, "m1", 4)
        assert len(fake.store["seat_allocations"]) == 1
        assert fake.store["seat_allocations"][0]["seat_number"] == 4


class TestConsultas:
    def test_lista_alocacoes_do_torneio(self, monkeypatch):
        _monta(monkeypatch, alocacoes=[_alocacao("a1", "m1", 1), _alocacao("a2", "m1", 2, P2)])
        assert len(AllocationService.get_tournament_allocations(TOUR)) == 2

    def test_lista_por_mesa(self, monkeypatch):
        _monta(monkeypatch, mesas=[_mesa("m1", 1), _mesa("m2", 2)],
               alocacoes=[_alocacao("a1", "m1", 1), _alocacao("a2", "m2", 1, P2)])
        assert len(AllocationService.get_table_allocations("m1")) == 1

    def test_lista_por_dia(self, monkeypatch):
        _monta(monkeypatch, alocacoes=[_alocacao("a1", "m1", 1)])
        assert len(AllocationService.get_day_allocations(DIA)) == 1

    def test_torneio_sem_alocacao_devolve_vazio(self, monkeypatch):
        _monta(monkeypatch)
        assert AllocationService.get_tournament_allocations(TOUR) == []


class TestRemocaoEMovimentacao:
    def test_remove_a_alocacao(self, monkeypatch):
        fake = _monta(monkeypatch, alocacoes=[_alocacao("a1", "m1", 1)])
        assert AllocationService.remove_allocation("a1") is True
        assert fake.store["seat_allocations"] == []

    def test_remover_inexistente_devolve_false(self, monkeypatch):
        _monta(monkeypatch)
        assert AllocationService.remove_allocation("nao-existe") is False

    def test_move_para_outro_assento(self, monkeypatch):
        fake = _monta(monkeypatch, mesas=[_mesa("m1", 1), _mesa("m2", 2)],
                      alocacoes=[_alocacao("a1", "m1", 1)])
        AllocationService.update_allocation(
            "a1", SeatAllocationUpdate(table_id="m2", seat_number=5)
        )
        linha = fake.store["seat_allocations"][0]
        assert linha["table_id"] == "m2"
        assert linha["seat_number"] == 5


class TestJogadoresSemMesa:
    def test_lista_quem_ainda_nao_sentou(self, monkeypatch):
        _monta(monkeypatch,
               jogadores=[
                   {"id": "tp1", "tournament_id": TOUR, "tournament_day_id": DIA,
                    "player_id": P1, "status": "active",
                    "players": {"id": P1, "name": "Um"}},
                   {"id": "tp2", "tournament_id": TOUR, "tournament_day_id": DIA,
                    "player_id": P2, "status": "active",
                    "players": {"id": P2, "name": "Dois"}},
               ],
               alocacoes=[_alocacao("a1", "m1", 1, P1)])
        r = AllocationService.get_unallocated_players(TOUR)
        ids = [x.get("player_id") or x.get("id") for x in r]
        assert P2 in str(ids)

    def test_todos_sentados_devolve_vazio(self, monkeypatch):
        _monta(monkeypatch,
               jogadores=[{"id": "tp1", "tournament_id": TOUR, "tournament_day_id": DIA,
                           "player_id": P1, "status": "active",
                           "players": {"id": P1, "name": "Um"}}],
               alocacoes=[_alocacao("a1", "m1", 1, P1)])
        assert AllocationService.get_unallocated_players(TOUR) == []
