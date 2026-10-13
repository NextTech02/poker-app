"""Testes da camada HTTP de mesas e alocação de assentos.

Estas rotas existem em duas versões: por TORNEIO (legado) e por DIA. A
versão por dia precisa primeiro descobrir o torneio a partir do dia — e é
aí que mora o 404 que o teste cobre: dia inexistente não pode virar 500,
senão o operador vê "erro de servidor" quando na verdade escolheu o dia
errado.

Do lado da alocação, a distinção entre 400 e 500 é o ponto: "assento
ocupado" é uma decisão de negócio que o operador resolve na hora (escolhe
outro lugar); um 500 diria que o sistema quebrou.
"""
import pytest

from app.models.table import Table
from app.models.seat_allocation import SeatAllocationWithDetails
from app.services.table_service import TableService as TSvc
from app.services.allocation_service import AllocationService as ASvc

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
MESA = "66666666-6666-6666-6666-666666666666"
JOGADOR = "44444444-4444-4444-4444-444444444444"
ALOC = "99999999-9999-9999-9999-999999999999"


def _mesa(numero=1, lugares=9):
    return Table(id=MESA, tournament_id=TOUR, tournament_day_id=DIA,
                 table_number=numero, seats=lugares, occupied_seats=0,
                 status="active", created_at="2026-06-08T00:00:00Z")


def _alocacao(assento=1):
    return SeatAllocationWithDetails(
        id=ALOC, tournament_id=TOUR, tournament_day_id=DIA, player_id=JOGADOR,
        table_id=MESA, seat_number=assento, created_at="2026-06-08T00:00:00Z",
        player_name="Fulano", table_number=1, tournament_name="Torneio")


@pytest.fixture
def dia_no_banco(monkeypatch):
    """As rotas por dia resolvem o torneio a partir do dia direto no banco."""
    fake = FakeSupabase({"tournament_days": [
        {"id": DIA, "tournament_id": TOUR, "allocation_mode": "balanced"},
    ]})
    monkeypatch.setattr("app.database.supabase", fake)
    return fake


@pytest.fixture
def sem_dia(monkeypatch):
    fake = FakeSupabase({"tournament_days": []})
    monkeypatch.setattr("app.database.supabase", fake)
    return fake


class TestMesasPorTorneio:
    def test_cria_mesa(self, client, stub):
        stub(TSvc, create_table=lambda tid, dados, tournament_day_id=None: _mesa())
        r = client.post(f"/tables/tournament/{TOUR}",
                        json={"table_number": 1, "seats": 9})
        assert r.status_code == 201

    def test_erro_do_service_vira_400(self, client, stub):
        def _estoura(tid, dados, tournament_day_id=None):
            raise ValueError("já existe mesa com esse número")
        stub(TSvc, create_table=_estoura)
        r = client.post(f"/tables/tournament/{TOUR}", json={"table_number": 1, "seats": 9})
        assert r.status_code == 400

    def test_cria_varias_de_uma_vez(self, client, stub):
        stub(TSvc, create_multiple_tables=lambda tid, n, s, tournament_day_id=None, **kw:
             [_mesa(numero=i + 1) for i in range(n)])
        r = client.post(f"/tables/tournament/{TOUR}/bulk?count=3&seats=9")
        assert r.status_code == 201
        assert len(r.json()) == 3

    @pytest.mark.parametrize("qs,motivo", [
        ("count=0&seats=9", "Count"),
        ("count=51&seats=9", "Count"),
        ("count=2&seats=0", "Seats"),
    ])
    def test_limites_do_lote_sao_recusados(self, client, qs, motivo):
        """Um lote de 500 mesas seria erro de digitação, não intenção — e
        criaria linhas que alguém teria de apagar na mão. Assentos NÃO têm
        teto (mesa de 12 existe no salão); só zero é recusado."""
        r = client.post(f"/tables/tournament/{TOUR}/bulk?{qs}")
        assert r.status_code == 400
        assert motivo in r.json()["detail"]["message"]

    def test_lista_mesas(self, client, stub):
        stub(TSvc, get_tournament_tables=lambda tid: [_mesa()])
        assert len(client.get(f"/tables/tournament/{TOUR}").json()) == 1

    def test_estatisticas(self, client, stub):
        stub(TSvc, get_tournament_stats=lambda tid: {"total_tables": 4, "occupied_seats": 12})
        assert client.get(f"/tables/tournament/{TOUR}/stats").json()["total_tables"] == 4


class TestMesasPorDia:
    def test_cria_mesa_no_dia(self, client, stub, dia_no_banco):
        stub(TSvc, create_table=lambda tid, dados, tournament_day_id=None: _mesa())
        r = client.post(f"/tables/day/{DIA}", json={"table_number": 1, "seats": 9})
        assert r.status_code == 201

    def test_dia_inexistente_da_404(self, client, sem_dia):
        r = client.post(f"/tables/day/{DIA}", json={"table_number": 1, "seats": 9})
        assert r.status_code == 404

    def test_lote_no_dia(self, client, stub, dia_no_banco):
        stub(TSvc, create_multiple_tables=lambda tid, n, s, tournament_day_id=None, **kw:
             [_mesa(numero=i + 1) for i in range(n)])
        r = client.post(f"/tables/day/{DIA}/bulk?count=2&seats=8")
        assert len(r.json()) == 2

    def test_lote_em_dia_inexistente_da_404(self, client, sem_dia):
        assert client.post(f"/tables/day/{DIA}/bulk?count=2&seats=8").status_code == 404

    def test_lote_no_dia_respeita_os_limites(self, client, dia_no_banco):
        assert client.post(f"/tables/day/{DIA}/bulk?count=99&seats=9").status_code == 400

    def test_lista_mesas_do_dia(self, client, stub):
        stub(TSvc, get_day_tables=lambda did: [_mesa()])
        assert len(client.get(f"/tables/day/{DIA}").json()) == 1

    def test_estatisticas_do_dia(self, client, stub):
        stub(TSvc, get_day_stats=lambda did: {"total_tables": 2})
        assert client.get(f"/tables/day/{DIA}/stats").json()["total_tables"] == 2


class TestMesaIndividual:
    def test_busca(self, client, stub):
        stub(TSvc, get_table=lambda mid: _mesa())
        assert client.get(f"/tables/{MESA}").status_code == 200

    def test_inexistente_da_404(self, client, stub):
        stub(TSvc, get_table=lambda mid: None)
        assert client.get(f"/tables/{MESA}").status_code == 404

    def test_atualiza(self, client, stub):
        stub(TSvc, update_table=lambda mid, d: _mesa(lugares=8))
        r = client.patch(f"/tables/{MESA}", json={"seats": 8})
        assert r.json()["seats"] == 8

    def test_atualizar_inexistente_da_404(self, client, stub):
        stub(TSvc, update_table=lambda mid, d: None)
        assert client.patch(f"/tables/{MESA}", json={"seats": 8}).status_code == 404

    def test_apaga(self, client, stub):
        stub(TSvc, delete_table=lambda mid: True)
        assert client.delete(f"/tables/{MESA}").status_code == 204

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(TSvc, delete_table=lambda mid: False)
        assert client.delete(f"/tables/{MESA}").status_code == 404

    def test_mesa_com_jogador_sentado_da_400(self, client, stub):
        """Apagar a mesa deixaria jogadores sem lugar no meio do torneio."""
        def _estoura(mid):
            raise ValueError("mesa possui jogadores alocados")
        stub(TSvc, delete_table=_estoura)
        assert client.delete(f"/tables/{MESA}").status_code == 400

    def test_quebra_a_mesa(self, client, stub):
        stub(TSvc, break_table=lambda mid: _mesa())
        assert client.post(f"/tables/{MESA}/break").status_code == 200

    def test_quebrar_inexistente_da_404(self, client, stub):
        stub(TSvc, break_table=lambda mid: None)
        assert client.post(f"/tables/{MESA}/break").status_code == 404


class TestAlocacaoPorTorneio:
    def test_alocacao_automatica(self, client, stub):
        stub(ASvc, auto_allocate_player=lambda tid, pid: _alocacao())
        r = client.post(f"/allocations/tournament/{TOUR}/auto?player_id={JOGADOR}")
        assert r.status_code == 201

    def test_sem_assento_livre_da_400(self, client, stub):
        """Decisão do operador (abrir mesa nova), não falha de servidor."""
        def _estoura(tid, pid):
            raise ValueError("No available seats")
        stub(ASvc, auto_allocate_player=_estoura)
        r = client.post(f"/allocations/tournament/{TOUR}/auto?player_id={JOGADOR}")
        assert r.status_code == 400

    def test_falha_inesperada_da_500(self, client, stub):
        def _estoura(tid, pid):
            raise RuntimeError("banco fora do ar")
        stub(ASvc, auto_allocate_player=_estoura)
        r = client.post(f"/allocations/tournament/{TOUR}/auto?player_id={JOGADOR}")
        assert r.status_code == 500

    def test_alocacao_manual(self, client, stub):
        stub(ASvc, manual_allocate_player=lambda tid, pid, mesa, assento: _alocacao(assento))
        r = client.post(f"/allocations/tournament/{TOUR}/manual",
                        json={"player_id": JOGADOR, "table_id": MESA, "seat_number": 5})
        assert r.status_code == 201
        assert r.json()["seat_number"] == 5

    def test_assento_ocupado_da_400(self, client, stub):
        def _estoura(tid, pid, mesa, assento):
            raise ValueError("Seat already occupied")
        stub(ASvc, manual_allocate_player=_estoura)
        r = client.post(f"/allocations/tournament/{TOUR}/manual",
                        json={"player_id": JOGADOR, "table_id": MESA, "seat_number": 5})
        assert r.status_code == 400

    def test_falha_inesperada_na_manual_da_500(self, client, stub):
        def _estoura(tid, pid, mesa, assento):
            raise RuntimeError("boom")
        stub(ASvc, manual_allocate_player=_estoura)
        r = client.post(f"/allocations/tournament/{TOUR}/manual",
                        json={"player_id": JOGADOR, "table_id": MESA, "seat_number": 5})
        assert r.status_code == 500

    def test_lista_alocacoes(self, client, stub):
        stub(ASvc, get_tournament_allocations=lambda tid: [{"id": ALOC}])
        assert len(client.get(f"/allocations/tournament/{TOUR}").json()) == 1

    def test_lista_quem_falta_sentar(self, client, stub):
        stub(ASvc, get_unallocated_players=lambda tid: [{"player_id": JOGADOR}])
        assert len(client.get(f"/allocations/tournament/{TOUR}/unallocated").json()) == 1


class TestAlocacaoPorDia:
    def test_automatica_usa_o_modo_configurado_no_dia(self, client, stub, dia_no_banco):
        """O modo de distribuição é do DIA, não um parâmetro da chamada — quem
        opera não escolhe a cada jogador."""
        recebidos = {}

        def _aloca(tid, did, pid, mode="balanced"):
            recebidos["mode"] = mode
            return _alocacao()

        dia_no_banco.store["tournament_days"][0]["allocation_mode"] = "random_balanced"
        stub(ASvc, auto_allocate_player_for_day=_aloca)
        client.post(f"/allocations/day/{DIA}/auto?player_id={JOGADOR}")
        assert recebidos["mode"] == "random_balanced"

    def test_sem_modo_configurado_cai_no_balanceado(self, client, stub, dia_no_banco):
        recebidos = {}

        def _aloca(tid, did, pid, mode="x"):
            recebidos["mode"] = mode
            return _alocacao()

        dia_no_banco.store["tournament_days"][0]["allocation_mode"] = None
        stub(ASvc, auto_allocate_player_for_day=_aloca)
        client.post(f"/allocations/day/{DIA}/auto?player_id={JOGADOR}")
        assert recebidos["mode"] == "balanced"

    def test_dia_inexistente_da_404(self, client, sem_dia):
        r = client.post(f"/allocations/day/{DIA}/auto?player_id={JOGADOR}")
        assert r.status_code == 404

    def test_erro_de_regra_da_400(self, client, stub, dia_no_banco):
        def _estoura(tid, did, pid, mode="balanced"):
            raise ValueError("mesas travadas")
        stub(ASvc, auto_allocate_player_for_day=_estoura)
        r = client.post(f"/allocations/day/{DIA}/auto?player_id={JOGADOR}")
        assert r.status_code == 400

    def test_falha_inesperada_da_500(self, client, stub, dia_no_banco):
        def _estoura(tid, did, pid, mode="balanced"):
            raise RuntimeError("boom")
        stub(ASvc, auto_allocate_player_for_day=_estoura)
        r = client.post(f"/allocations/day/{DIA}/auto?player_id={JOGADOR}")
        assert r.status_code == 500

    def test_manual_no_dia(self, client, stub, dia_no_banco):
        stub(ASvc, manual_allocate_player_for_day=lambda tid, did, pid, m, a: _alocacao(a))
        r = client.post(f"/allocations/day/{DIA}/manual",
                        json={"player_id": JOGADOR, "table_id": MESA, "seat_number": 3})
        assert r.json()["seat_number"] == 3

    def test_manual_em_dia_inexistente_da_404(self, client, sem_dia):
        r = client.post(f"/allocations/day/{DIA}/manual",
                        json={"player_id": JOGADOR, "table_id": MESA, "seat_number": 3})
        assert r.status_code == 404

    def test_manual_com_assento_ocupado_da_400(self, client, stub, dia_no_banco):
        def _estoura(tid, did, pid, m, a):
            raise ValueError("Seat already occupied")
        stub(ASvc, manual_allocate_player_for_day=_estoura)
        r = client.post(f"/allocations/day/{DIA}/manual",
                        json={"player_id": JOGADOR, "table_id": MESA, "seat_number": 3})
        assert r.status_code == 400

    def test_manual_com_falha_inesperada_da_500(self, client, stub, dia_no_banco):
        def _estoura(tid, did, pid, m, a):
            raise RuntimeError("boom")
        stub(ASvc, manual_allocate_player_for_day=_estoura)
        r = client.post(f"/allocations/day/{DIA}/manual",
                        json={"player_id": JOGADOR, "table_id": MESA, "seat_number": 3})
        assert r.status_code == 500

    def test_lote_sem_lista_aloca_todos_os_pendentes(self, client, stub, dia_no_banco):
        recebidos = {}

        def _lote(tid, did, modo, ids):
            recebidos["ids"] = ids
            return [{"id": ALOC}]

        stub(ASvc, bulk_allocate_players=_lote)
        r = client.post(f"/allocations/day/{DIA}/bulk",
                        json={"mode": "balanced", "player_ids": []})
        assert r.status_code == 201
        assert recebidos["ids"] is None      # None = "todo mundo que falta"

    def test_lote_com_lista_explicita(self, client, stub, dia_no_banco):
        recebidos = {}

        def _lote(tid, did, modo, ids):
            recebidos["ids"] = ids
            return []

        stub(ASvc, bulk_allocate_players=_lote)
        client.post(f"/allocations/day/{DIA}/bulk",
                    json={"mode": "sequential", "player_ids": [JOGADOR]})
        assert recebidos["ids"] == [JOGADOR]

    def test_lote_em_dia_inexistente_da_404(self, client, sem_dia):
        r = client.post(f"/allocations/day/{DIA}/bulk", json={"mode": "balanced"})
        assert r.status_code == 404

    def test_modo_desconhecido_da_400(self, client, stub, dia_no_banco):
        def _estoura(tid, did, modo, ids):
            raise ValueError("modo de alocação inválido")
        stub(ASvc, bulk_allocate_players=_estoura)
        r = client.post(f"/allocations/day/{DIA}/bulk", json={"mode": "aleatorio-total"})
        assert r.status_code == 400

    def test_falha_inesperada_no_lote_da_500(self, client, stub, dia_no_banco):
        def _estoura(tid, did, modo, ids):
            raise RuntimeError("boom")
        stub(ASvc, bulk_allocate_players=_estoura)
        r = client.post(f"/allocations/day/{DIA}/bulk", json={"mode": "balanced"})
        assert r.status_code == 500

    def test_lista_alocacoes_do_dia(self, client, stub):
        stub(ASvc, get_day_allocations=lambda did: [{"id": ALOC}])
        assert len(client.get(f"/allocations/day/{DIA}").json()) == 1

    def test_quem_falta_sentar_no_dia(self, client, stub, dia_no_banco):
        stub(ASvc, get_unallocated_players_for_day=lambda tid, did: [{"player_id": JOGADOR}])
        assert len(client.get(f"/allocations/day/{DIA}/unallocated").json()) == 1

    def test_quem_falta_sentar_em_dia_inexistente_da_404(self, client, sem_dia):
        assert client.get(f"/allocations/day/{DIA}/unallocated").status_code == 404

    def test_falha_ao_listar_pendentes_da_500(self, client, stub, dia_no_banco):
        def _estoura(tid, did):
            raise RuntimeError("boom")
        stub(ASvc, get_unallocated_players_for_day=_estoura)
        assert client.get(f"/allocations/day/{DIA}/unallocated").status_code == 500


class TestAlocacaoIndividual:
    def test_lista_por_mesa(self, client, stub):
        stub(ASvc, get_table_allocations=lambda mid: [{"id": ALOC}])
        assert len(client.get(f"/allocations/table/{MESA}").json()) == 1

    def test_move_o_jogador(self, client, stub):
        stub(ASvc, update_allocation=lambda aid, d: _alocacao(assento=7))
        r = client.patch(f"/allocations/{ALOC}", json={"seat_number": 7})
        assert r.json()["seat_number"] == 7

    def test_mover_para_assento_ocupado_da_400(self, client, stub):
        def _estoura(aid, d):
            raise ValueError("Seat already occupied")
        stub(ASvc, update_allocation=_estoura)
        assert client.patch(f"/allocations/{ALOC}", json={"seat_number": 7}).status_code == 400

    def test_remove(self, client, stub):
        stub(ASvc, remove_allocation=lambda aid: True)
        assert client.delete(f"/allocations/{ALOC}").status_code == 204

    def test_remover_inexistente_da_404(self, client, stub):
        stub(ASvc, remove_allocation=lambda aid: False)
        assert client.delete(f"/allocations/{ALOC}").status_code == 404

    def test_detalhes(self, client, stub):
        stub(ASvc, get_allocation_with_details=lambda aid: _alocacao())
        assert client.get(f"/allocations/{ALOC}").json()["player_name"] == "Fulano"

    def test_detalhes_de_inexistente_da_404(self, client, stub):
        def _estoura(aid):
            raise ValueError("Allocation not found")
        stub(ASvc, get_allocation_with_details=_estoura)
        assert client.get(f"/allocations/{ALOC}").status_code == 404
