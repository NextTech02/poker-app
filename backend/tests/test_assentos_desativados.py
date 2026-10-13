"""Assento desativado: o floor tira UM lugar de circulação sem mexer no
tamanho da mesa.

Cadeira quebrada, mesa encostada na parede, lugar do dealer de reforço.
Diminuir `seats` não resolve: tira sempre o ÚLTIMO assento, e o problema
costuma ser o 4 ou o 7. O assento desativado continua existindo (o número
não muda), mas:

- nenhuma escolha de cadeira cai nele — automática, em massa, manual ou
  mudança de lugar;
- não conta na capacidade da mesa nem nas estatísticas do dia;
- não pode ser desativado com alguém sentado (o jogador ficaria numa
  cadeira que o sistema diz não existir).
"""
import pytest

from app.models.seat_allocation import SeatAllocationUpdate
from app.models.table import TableUpdate
from app.services import allocation_service as mod_aloc
from app.services import table_service as mod_mesa
from app.services.allocation_service import AllocationService as A
from app.services.table_service import TableService as T
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
M1 = "66666666-6666-6666-6666-666666666661"
M2 = "66666666-6666-6666-6666-666666666662"
P1 = "44444444-4444-4444-4444-444444444441"
P2 = "44444444-4444-4444-4444-444444444442"
P3 = "44444444-4444-4444-4444-444444444443"


def _mesa(id_, numero, lugares=3, bloqueados=None, ocupados=0):
    return {"id": id_, "tournament_id": TOUR, "tournament_day_id": DIA,
            "table_number": numero, "seats": lugares, "occupied_seats": ocupados,
            "status": "active", "blocked_seats": list(bloqueados or []),
            "created_at": "2026-06-08T00:00:00Z"}


def _aloc(id_, mesa, assento, player=P1):
    return {"id": id_, "tournament_id": TOUR, "tournament_day_id": DIA,
            "table_id": mesa, "seat_number": assento, "player_id": player,
            "created_at": "2026-06-08T00:00:00Z",
            "players": {"name": "Jogador"},
            "tournament_tables": {"table_number": 1, "seats": 3},
            "tournaments": {"name": "Torneio"}}


def _inscrito(player):
    return {"id": f"tp-{player}", "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": player, "status": "active", "entries": 1,
            "players": {"id": player, "name": f"Jogador {player[-1]}"}}


@pytest.fixture
def banco(monkeypatch):
    def montar(mesas, alocacoes=None, inscritos=None):
        fake = FakeSupabase({
            "tournament_tables": mesas,
            "seat_allocations": alocacoes or [],
            "tournament_players": inscritos or [],
            "players": [{"id": P1, "name": "Um"}, {"id": P2, "name": "Dois"}, {"id": P3, "name": "Tres"}],
            "tournaments": [{"id": TOUR, "name": "Torneio"}],
            "tournament_days": [{"id": DIA, "tournament_id": TOUR, "day_name": "Dia 1"}],
        })
        monkeypatch.setattr(mod_aloc, "supabase", fake)
        monkeypatch.setattr(mod_mesa, "supabase", fake)
        return fake
    return montar


def _mesa_de(fake, mesa_id):
    return next(t for t in fake.store["tournament_tables"] if t["id"] == mesa_id)


# ─────────────────────────────────────────────────────────────────────────────
# Ligar e desligar
# ─────────────────────────────────────────────────────────────────────────────

class TestLigarEDesligar:
    def test_desativa_um_assento_livre(self, banco):
        fake = banco([_mesa(M1, 1, lugares=9)])
        mesa = T.set_seat_active(M1, 4, active=False)
        assert mesa.blocked_seats == [4]
        assert _mesa_de(fake, M1)["blocked_seats"] == [4]

    def test_lista_fica_ordenada_e_sem_repeticao(self, banco):
        banco([_mesa(M1, 1, lugares=9, bloqueados=[7])])
        T.set_seat_active(M1, 2, active=False)
        mesa = T.set_seat_active(M1, 2, active=False)  # repetir não duplica
        assert mesa.blocked_seats == [2, 7]

    def test_reativa(self, banco):
        banco([_mesa(M1, 1, lugares=9, bloqueados=[2, 7])])
        assert T.set_seat_active(M1, 7, active=True).blocked_seats == [2]

    def test_reativar_assento_que_ja_esta_ativo_nao_muda_nada(self, banco):
        banco([_mesa(M1, 1, lugares=9)])
        assert T.set_seat_active(M1, 3, active=True).blocked_seats == []

    def test_assento_com_jogador_nao_pode_ser_desativado(self, banco):
        banco([_mesa(M1, 1)], alocacoes=[_aloc("a1", M1, 2)])
        with pytest.raises(ErroDeNegocio) as exc:
            T.set_seat_active(M1, 2, active=False)
        assert exc.value.code == "assento_ocupado"
        assert exc.value.status == 409

    @pytest.mark.parametrize("assento", [0, 4, -1])
    def test_assento_fora_da_mesa_e_recusado(self, banco, assento):
        banco([_mesa(M1, 1, lugares=3)])
        with pytest.raises(ErroDeNegocio) as exc:
            T.set_seat_active(M1, assento, active=False)
        assert exc.value.code == "assento_invalido"
        assert exc.value.dados["seats"] == 3

    def test_mesa_inexistente_devolve_none(self, banco):
        banco([])
        assert T.set_seat_active(M1, 1, active=False) is None

    def test_mesa_que_encolhe_leva_junto_os_desativados_que_sumiram(self, banco):
        # "Assento 9 desativado" numa mesa de 8 contaria contra a capacidade
        # sem aparecer na tela.
        fake = banco([_mesa(M1, 1, lugares=9, bloqueados=[3, 9])])
        T.update_table(M1, TableUpdate(seats=8))
        assert _mesa_de(fake, M1)["blocked_seats"] == [3]

    def test_estatisticas_do_dia_descontam_os_desativados(self, banco):
        banco([_mesa(M1, 1, lugares=9, bloqueados=[1, 2]), _mesa(M2, 2, lugares=9)])
        stats = T.get_day_stats(DIA)
        assert stats["total_seats"] == 16
        assert stats["available_seats"] == 16


# ─────────────────────────────────────────────────────────────────────────────
# Ninguém senta no assento desativado
# ─────────────────────────────────────────────────────────────────────────────

class TestEscolhaDeCadeira:
    def test_automatica_balanceada_pula_o_desativado(self, banco):
        banco([_mesa(M1, 1, lugares=3, bloqueados=[1])])
        r = A.auto_allocate_player_for_day(TOUR, DIA, P1, mode="balanced")
        assert r.seat_number == 2

    def test_sorteio_nunca_cai_no_desativado(self, banco):
        for _ in range(20):
            banco([_mesa(M1, 1, lugares=3, bloqueados=[1, 3])])
            assert A.auto_allocate_player_for_day(TOUR, DIA, P1, mode="random_balanced").seat_number == 2

    def test_mesa_so_com_desativados_livres_conta_como_cheia(self, banco):
        # Mesa 1: assento 1 ocupado, 2 e 3 desativados. A próxima vai para a 2.
        banco([_mesa(M1, 1, lugares=3, bloqueados=[2, 3], ocupados=1), _mesa(M2, 2, lugares=3)],
              alocacoes=[_aloc("a1", M1, 1, player=P2)])
        r = A.auto_allocate_player_for_day(TOUR, DIA, P1, mode="sequential")
        assert r.table_id == M2

    def test_dia_lotado_quando_so_sobram_desativados(self, banco):
        banco([_mesa(M1, 1, lugares=2, bloqueados=[2], ocupados=1)],
              alocacoes=[_aloc("a1", M1, 1, player=P2)])
        with pytest.raises(ValueError, match="full"):
            A.auto_allocate_player_for_day(TOUR, DIA, P1)

    def test_legado_por_torneio_tambem_pula(self, banco):
        banco([_mesa(M1, 1, lugares=2, bloqueados=[1, 2]), _mesa(M2, 2, lugares=2, bloqueados=[1])])
        r = A.auto_allocate_player(TOUR, P1)
        assert (r.table_id, r.seat_number) == (M2, 2)

    def test_lote_sequencial_pula_e_passa_para_a_proxima_mesa(self, banco):
        fake = banco([_mesa(M1, 1, lugares=3, bloqueados=[2]), _mesa(M2, 2, lugares=3)],
                     inscritos=[_inscrito(P1), _inscrito(P2), _inscrito(P3)])
        A.bulk_allocate_players(TOUR, DIA, "sequential", [P1, P2, P3])
        lugares = sorted((a["table_id"], a["seat_number"]) for a in fake.store["seat_allocations"])
        assert lugares == [(M1, 1), (M1, 3), (M2, 1)]

    def test_lote_balanceado_pula(self, banco):
        fake = banco([_mesa(M1, 1, lugares=3, bloqueados=[1]), _mesa(M2, 2, lugares=3, bloqueados=[1])],
                     inscritos=[_inscrito(P1), _inscrito(P2)])
        A.bulk_allocate_players(TOUR, DIA, "balanced", [P1, P2])
        assert all(a["seat_number"] != 1 for a in fake.store["seat_allocations"])

    def test_manual_no_desativado_e_recusado(self, banco):
        banco([_mesa(M1, 1, lugares=3, bloqueados=[2])])
        with pytest.raises(ErroDeNegocio) as exc:
            A.manual_allocate_player_for_day(TOUR, DIA, P1, M1, 2)
        assert exc.value.code == "assento_indisponivel"
        assert exc.value.status == 409

    def test_manual_legado_no_desativado_e_recusado(self, banco):
        banco([_mesa(M1, 1, lugares=3, bloqueados=[2])])
        with pytest.raises(ErroDeNegocio) as exc:
            A.manual_allocate_player(TOUR, P1, M1, 2)
        assert exc.value.code == "assento_indisponivel"

    def test_mudar_de_lugar_para_o_desativado_e_recusado(self, banco):
        fake = banco([_mesa(M1, 1, lugares=3, bloqueados=[3], ocupados=1)],
                     alocacoes=[_aloc("a1", M1, 1)])
        with pytest.raises(ErroDeNegocio) as exc:
            A.update_allocation("a1", SeatAllocationUpdate(seat_number=3))
        assert exc.value.code == "assento_indisponivel"
        assert fake.store["seat_allocations"][0]["seat_number"] == 1  # nada mudou

    def test_mudar_de_lugar_para_assento_ativo_continua_funcionando(self, banco):
        banco([_mesa(M1, 1, lugares=3, bloqueados=[3], ocupados=1)],
              alocacoes=[_aloc("a1", M1, 1)])
        assert A.update_allocation("a1", SeatAllocationUpdate(seat_number=2)).seat_number == 2


# ─────────────────────────────────────────────────────────────────────────────
# Rota
# ─────────────────────────────────────────────────────────────────────────────

class TestRota:
    def test_desativa_pela_rota(self, client, banco):
        banco([_mesa(M1, 1, lugares=9)])
        r = client.patch(f"/tables/{M1}/seats/5", json={"active": False})
        assert r.status_code == 200
        assert r.json()["blocked_seats"] == [5]

    def test_reativa_pela_rota(self, client, banco):
        banco([_mesa(M1, 1, lugares=9, bloqueados=[5])])
        r = client.patch(f"/tables/{M1}/seats/5", json={"active": True})
        assert r.status_code == 200
        assert r.json()["blocked_seats"] == []

    def test_assento_ocupado_vira_409_com_codigo(self, client, banco):
        banco([_mesa(M1, 1)], alocacoes=[_aloc("a1", M1, 2)])
        r = client.patch(f"/tables/{M1}/seats/2", json={"active": False})
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "assento_ocupado"

    def test_mesa_inexistente_vira_404(self, client, banco):
        banco([])
        r = client.patch(f"/tables/{M1}/seats/2", json={"active": False})
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "mesa_nao_encontrada"

    def test_corpo_sem_active_e_422(self, client, banco):
        banco([_mesa(M1, 1)])
        assert client.patch(f"/tables/{M1}/seats/2", json={}).status_code == 422

    def test_lista_de_mesas_traz_os_desativados(self, client, banco):
        banco([_mesa(M1, 1, lugares=9, bloqueados=[4])])
        r = client.get(f"/tables/day/{DIA}")
        assert r.json()[0]["blocked_seats"] == [4]
