"""Testes dos algoritmos de alocação em mesa.

Complementa `test_allocation.py` (colisões e limites) com o que decide ONDE
o jogador senta — e com a alocação em lote, usada quando o clube abre o
salão de uma vez.

Por que a distribuição importa: mesas com números muito diferentes de
jogadores dão vantagem posicional a quem está na mesa vazia (paga menos
blinds por rodada). "Balanceado" existe justamente para isso, e é o padrão.

Os três modos:
- `sequential`     — enche a mesa 1, depois a 2. Útil quando o clube quer
  concentrar o salão e só abrir mesas conforme a procura.
- `balanced`       — mesa menos ocupada, primeiro assento livre.
- `random_balanced`— mesa menos ocupada, assento sorteado (evita que o
  primeiro a chegar fique sempre no assento 1).

O lote monta TUDO em memória e grava com um insert só; antes era um insert
por jogador. Com 200 inscritos isso era 200 idas ao banco.

O sorteio de assento usa `random.SystemRandom` (entropia do sistema
operacional), não o `random` global: veja `TestFonteDoSorteio`.
"""
import random

import pytest

from app.models.seat_allocation import SeatAllocationUpdate
from app.services import allocation_service as mod
from app.services.allocation_service import AllocationService as S

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
M1 = "66666666-6666-6666-6666-666666666661"
M2 = "66666666-6666-6666-6666-666666666662"
M3 = "66666666-6666-6666-6666-666666666663"
P1 = "44444444-4444-4444-4444-444444444441"
P2 = "44444444-4444-4444-4444-444444444442"
P3 = "44444444-4444-4444-4444-444444444443"


def _mesa(id_, numero, lugares=9, ocupados=0, dia=DIA, status="active"):
    return {"id": id_, "tournament_id": TOUR, "tournament_day_id": dia,
            "table_number": numero, "seats": lugares, "occupied_seats": ocupados,
            "status": status, "created_at": "2026-06-08T00:00:00Z"}


def _aloc(id_, mesa, assento, player=P1, dia=DIA):
    return {"id": id_, "tournament_id": TOUR, "tournament_day_id": dia,
            "table_id": mesa, "seat_number": assento, "player_id": player,
            "created_at": "2026-06-08T00:00:00Z",
            "players": {"name": "Jogador"},
            "tournament_tables": {"table_number": 1, "seats": 9},
            "tournaments": {"name": "Torneio"}}


def _inscrito(player, dia=DIA, status="active"):
    return {"id": f"tp-{player}", "tournament_id": TOUR, "tournament_day_id": dia,
            "player_id": player, "status": status, "entries": 1,
            "players": {"id": player, "name": f"Jogador {player[-1]}"}}


def _monta(monkeypatch, mesas=None, alocacoes=None, inscritos=None):
    mesas = mesas if mesas is not None else [_mesa(M1, 1)]
    fake = FakeSupabase({
        "tournament_tables": mesas,
        "seat_allocations": alocacoes or [],
        "tournament_players": inscritos or [],
        "players": [{"id": P1, "name": "Um"}, {"id": P2, "name": "Dois"},
                    {"id": P3, "name": "Tres"}],
        "tournaments": [{"id": TOUR, "name": "Torneio"}],
        "tournament_days": [{"id": DIA, "tournament_id": TOUR, "day_name": "Dia 1"}],
    })
    monkeypatch.setattr(mod, "supabase", fake)
    return fake


def _mesa_de(fake, mesa_id):
    return [t for t in fake.store["tournament_tables"] if t["id"] == mesa_id][0]


class TestAlocacaoAutomaticaPorTorneio:
    def test_escolhe_a_mesa_menos_ocupada(self, monkeypatch):
        """É o que evita a mesa de 3 contra a mesa de 9."""
        fake = _monta(monkeypatch,
                      mesas=[_mesa(M1, 1, ocupados=5), _mesa(M2, 2, ocupados=1)],
                      alocacoes=[_aloc(f"a{i}", M1, i, f"p{i}") for i in range(1, 6)]
                      + [_aloc("a9", M2, 1, "p9")])
        S.auto_allocate_player(TOUR, P1)
        nova = [a for a in fake.store["seat_allocations"] if a["player_id"] == P1][0]
        assert nova["table_id"] == M2

    def test_realoca_liberando_o_assento_anterior(self, monkeypatch):
        """Sem soltar o assento antigo, o jogador ocuparia dois lugares e a
        contagem da mesa ficaria alta para sempre."""
        fake = _monta(monkeypatch,
                      mesas=[_mesa(M1, 1, ocupados=1), _mesa(M2, 2)],
                      alocacoes=[_aloc("a1", M1, 3, P1)])
        S.auto_allocate_player(TOUR, P1)
        do_jogador = [a for a in fake.store["seat_allocations"] if a["player_id"] == P1]
        assert len(do_jogador) == 1
        # o jogador continua ocupando UM lugar no salão, não dois
        total = sum(t["occupied_seats"] for t in fake.store["tournament_tables"])
        assert total == 1

    def test_sem_mesa_ativa(self, monkeypatch):
        _monta(monkeypatch, mesas=[])
        with pytest.raises(ValueError, match="No active tables"):
            S.auto_allocate_player(TOUR, P1)

    def test_mesa_inativa_nao_recebe_jogador(self, monkeypatch):
        """Mesa quebrada continua na tabela; alocar nela sentaria alguém num
        lugar que não existe mais no salão."""
        _monta(monkeypatch, mesas=[_mesa(M1, 1, status="broken")])
        with pytest.raises(ValueError, match="No active tables"):
            S.auto_allocate_player(TOUR, P1)

    def test_todas_as_mesas_cheias(self, monkeypatch):
        _monta(monkeypatch, mesas=[_mesa(M1, 1, lugares=2)],
               alocacoes=[_aloc("a1", M1, 1, "p1"), _aloc("a2", M1, 2, "p2")])
        with pytest.raises(ValueError, match="All tables are full"):
            S.auto_allocate_player(TOUR, P1)

    def test_atualiza_a_contagem_da_mesa(self, monkeypatch):
        fake = _monta(monkeypatch)
        S.auto_allocate_player(TOUR, P1)
        assert _mesa_de(fake, M1)["occupied_seats"] == 1

    def test_so_sobra_um_assento(self, monkeypatch):
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, lugares=3)],
                      alocacoes=[_aloc("a1", M1, 1, "px"), _aloc("a2", M1, 3, "py")])
        S.auto_allocate_player(TOUR, P1)
        nova = [a for a in fake.store["seat_allocations"] if a["player_id"] == P1][0]
        assert nova["seat_number"] == 2


class TestAlocacaoAutomaticaPorDia:
    def _tres_mesas(self):
        return [_mesa(M1, 1, ocupados=3), _mesa(M2, 2, ocupados=1), _mesa(M3, 3, ocupados=5)]

    def _alocs_das_tres(self):
        return ([_aloc(f"a1{i}", M1, i, f"pa{i}") for i in range(1, 4)]
                + [_aloc("a21", M2, 1, "pb1")]
                + [_aloc(f"a3{i}", M3, i, f"pc{i}") for i in range(1, 6)])

    def test_balanceado_pega_a_menos_ocupada_e_o_menor_assento(self, monkeypatch):
        fake = _monta(monkeypatch, mesas=self._tres_mesas(),
                      alocacoes=self._alocs_das_tres())
        S.auto_allocate_player_for_day(TOUR, DIA, P1, mode="balanced")
        nova = [a for a in fake.store["seat_allocations"] if a["player_id"] == P1][0]
        assert nova["table_id"] == M2
        assert nova["seat_number"] == 2

    def test_sequencial_pega_a_mesa_de_menor_numero_com_espaco(self, monkeypatch):
        """O clube quer concentrar o salão: abre a mesa 2 só quando a 1 lotar."""
        fake = _monta(monkeypatch, mesas=self._tres_mesas(),
                      alocacoes=self._alocs_das_tres())
        S.auto_allocate_player_for_day(TOUR, DIA, P1, mode="sequential")
        nova = [a for a in fake.store["seat_allocations"] if a["player_id"] == P1][0]
        assert nova["table_id"] == M1

    def test_sequencial_pula_a_mesa_cheia(self, monkeypatch):
        fake = _monta(monkeypatch,
                      mesas=[_mesa(M1, 1, lugares=2, ocupados=2), _mesa(M2, 2)],
                      alocacoes=[_aloc("a1", M1, 1, "px"), _aloc("a2", M1, 2, "py")])
        S.auto_allocate_player_for_day(TOUR, DIA, P1, mode="sequential")
        nova = [a for a in fake.store["seat_allocations"] if a["player_id"] == P1][0]
        assert nova["table_id"] == M2

    def test_sorteio_de_assento_fica_dentro_dos_livres(self, monkeypatch):
        """Assento sorteado evita que quem chega primeiro sente sempre no 1 —
        mas não pode cair num lugar ocupado."""
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, lugares=4, ocupados=2)],
                      alocacoes=[_aloc("a1", M1, 1, "px"), _aloc("a2", M1, 3, "py")])
        S.auto_allocate_player_for_day(TOUR, DIA, P1, mode="random_balanced")
        nova = [a for a in fake.store["seat_allocations"] if a["player_id"] == P1][0]
        assert nova["seat_number"] in (2, 4)

    def test_realoca_dentro_do_dia(self, monkeypatch):
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, ocupados=1), _mesa(M2, 2)],
                      alocacoes=[_aloc("a1", M1, 5, P1)])
        S.auto_allocate_player_for_day(TOUR, DIA, P1)
        assert len([a for a in fake.store["seat_allocations"] if a["player_id"] == P1]) == 1

    def test_sem_mesa_no_dia(self, monkeypatch):
        _monta(monkeypatch, mesas=[])
        with pytest.raises(ValueError, match="No active tables"):
            S.auto_allocate_player_for_day(TOUR, DIA, P1)

    def test_dia_lotado(self, monkeypatch):
        _monta(monkeypatch, mesas=[_mesa(M1, 1, lugares=1)],
               alocacoes=[_aloc("a1", M1, 1, "px")])
        with pytest.raises(ValueError, match="All tables are full"):
            S.auto_allocate_player_for_day(TOUR, DIA, P1)

    def test_grava_o_dia_na_alocacao(self, monkeypatch):
        """Sem o dia, a alocação apareceria em todos os dias do torneio."""
        fake = _monta(monkeypatch)
        S.auto_allocate_player_for_day(TOUR, DIA, P1)
        assert fake.store["seat_allocations"][0]["tournament_day_id"] == DIA


class TestAlocacaoManual:
    def test_move_para_o_assento_escolhido(self, monkeypatch):
        fake = _monta(monkeypatch)
        S.manual_allocate_player(TOUR, P1, M1, 7)
        assert fake.store["seat_allocations"][0]["seat_number"] == 7

    def test_troca_de_lugar_solta_o_anterior(self, monkeypatch):
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, ocupados=1)],
                      alocacoes=[_aloc("a1", M1, 2, P1)])
        S.manual_allocate_player(TOUR, P1, M1, 6)
        assert len(fake.store["seat_allocations"]) == 1
        assert fake.store["seat_allocations"][0]["seat_number"] == 6

    def test_manual_por_dia(self, monkeypatch):
        fake = _monta(monkeypatch)
        S.manual_allocate_player_for_day(TOUR, DIA, P1, M1, 4)
        linha = fake.store["seat_allocations"][0]
        assert (linha["seat_number"], linha["tournament_day_id"]) == (4, DIA)

    def test_assento_ocupado_no_dia(self, monkeypatch):
        _monta(monkeypatch, alocacoes=[_aloc("a1", M1, 4, P2)])
        with pytest.raises(ValueError, match="already occupied"):
            S.manual_allocate_player_for_day(TOUR, DIA, P1, M1, 4)

    def test_mesa_inexistente_no_dia(self, monkeypatch):
        _monta(monkeypatch, mesas=[])
        with pytest.raises(ValueError, match="Table not found"):
            S.manual_allocate_player_for_day(TOUR, DIA, P1, M1, 1)

    def test_mesa_cheia_no_dia(self, monkeypatch):
        _monta(monkeypatch, mesas=[_mesa(M1, 1, lugares=9, ocupados=9)])
        with pytest.raises(ValueError, match="Table is full"):
            S.manual_allocate_player_for_day(TOUR, DIA, P1, M1, 5)

    def test_assento_acima_do_tamanho_no_dia(self, monkeypatch):
        _monta(monkeypatch, mesas=[_mesa(M1, 1, lugares=6)])
        with pytest.raises(ValueError, match="Invalid seat number"):
            S.manual_allocate_player_for_day(TOUR, DIA, P1, M1, 9)

    def test_troca_de_lugar_no_dia_solta_o_anterior(self, monkeypatch):
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, ocupados=1)],
                      alocacoes=[_aloc("a1", M1, 2, P1)])
        S.manual_allocate_player_for_day(TOUR, DIA, P1, M1, 8)
        assert len(fake.store["seat_allocations"]) == 1


class TestAlocacaoEmLote:
    """Usado quando o salão abre de uma vez. Tudo é decidido em memória e
    gravado num insert só."""

    def _inscritos(self, *players):
        return [_inscrito(p) for p in players]

    def test_sequencial_enche_a_primeira_mesa_antes_de_abrir_a_segunda(self, monkeypatch):
        fake = _monta(monkeypatch,
                      mesas=[_mesa(M1, 1, lugares=2), _mesa(M2, 2, lugares=2)],
                      inscritos=self._inscritos(P1, P2, P3))
        S.bulk_allocate_players(TOUR, DIA, "sequential")
        por_mesa = {}
        for a in fake.store["seat_allocations"]:
            por_mesa.setdefault(a["table_id"], []).append(a["seat_number"])
        assert sorted(por_mesa[M1]) == [1, 2]
        assert por_mesa[M2] == [1]

    def test_balanceado_distribui_um_por_mesa(self, monkeypatch):
        """Rodízio: com 3 jogadores e 3 mesas, cada mesa fica com um."""
        fake = _monta(monkeypatch,
                      mesas=[_mesa(M1, 1), _mesa(M2, 2), _mesa(M3, 3)],
                      inscritos=self._inscritos(P1, P2, P3))
        S.bulk_allocate_players(TOUR, DIA, "balanced")
        mesas_usadas = {a["table_id"] for a in fake.store["seat_allocations"]}
        assert mesas_usadas == {M1, M2, M3}

    def test_balanceado_respeita_a_ocupacao_que_ja_existia(self, monkeypatch):
        """Quem chega depois vai para as mesas mais vazias, não recomeça do
        zero."""
        fake = _monta(monkeypatch,
                      mesas=[_mesa(M1, 1, ocupados=4), _mesa(M2, 2, ocupados=0)],
                      alocacoes=[_aloc(f"a{i}", M1, i, f"px{i}") for i in range(1, 5)],
                      inscritos=self._inscritos(P1))
        S.bulk_allocate_players(TOUR, DIA, "balanced", [P1])
        nova = [a for a in fake.store["seat_allocations"] if a["player_id"] == P1][0]
        assert nova["table_id"] == M2

    def test_sorteio_de_assento_no_lote(self, monkeypatch):
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, lugares=3)],
                      inscritos=self._inscritos(P1, P2, P3))
        S.bulk_allocate_players(TOUR, DIA, "random_balanced")
        assentos = sorted(a["seat_number"] for a in fake.store["seat_allocations"])
        assert assentos == [1, 2, 3]      # sorteados, mas sem repetir

    def test_lista_explicita_de_jogadores(self, monkeypatch):
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1)],
                      inscritos=self._inscritos(P1, P2, P3))
        S.bulk_allocate_players(TOUR, DIA, "balanced", [P1, P2])
        assert len(fake.store["seat_allocations"]) == 2

    def test_sem_ninguem_para_alocar(self, monkeypatch):
        _monta(monkeypatch, inscritos=[])
        assert S.bulk_allocate_players(TOUR, DIA, "balanced") == []

    def test_sem_mesa_ativa(self, monkeypatch):
        _monta(monkeypatch, mesas=[], inscritos=self._inscritos(P1))
        with pytest.raises(ValueError, match="No active tables"):
            S.bulk_allocate_players(TOUR, DIA, "balanced")

    def test_modo_desconhecido(self, monkeypatch):
        _monta(monkeypatch, inscritos=self._inscritos(P1))
        with pytest.raises(ValueError, match="Unknown allocation mode"):
            S.bulk_allocate_players(TOUR, DIA, "aleatorio-total")

    def test_mais_jogadores_que_lugares_para_quando_lota(self, monkeypatch):
        """Os que couberam ficam sentados; o resto continua na lista de
        espera em vez de a operação inteira falhar."""
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, lugares=2)],
                      inscritos=self._inscritos(P1, P2, P3))
        S.bulk_allocate_players(TOUR, DIA, "balanced")
        assert len(fake.store["seat_allocations"]) == 2

    def test_lote_sequencial_com_todas_as_mesas_cheias_nao_aloca(self, monkeypatch):
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, lugares=1, ocupados=1)],
                      alocacoes=[_aloc("a1", M1, 1, "px")],
                      inscritos=self._inscritos(P1))
        S.bulk_allocate_players(TOUR, DIA, "sequential", [P1])
        assert len([a for a in fake.store["seat_allocations"] if a["player_id"] == P1]) == 0

    def test_contagem_das_mesas_e_sincronizada_ao_final(self, monkeypatch):
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1), _mesa(M2, 2)],
                      inscritos=self._inscritos(P1, P2, P3))
        S.bulk_allocate_players(TOUR, DIA, "balanced")
        total = sum(t["occupied_seats"] for t in fake.store["tournament_tables"])
        assert total == 3

    def test_mesa_sem_mudanca_nao_e_reescrita(self, monkeypatch):
        """A sincronização agrupa por valor e só escreve o que mudou; mandar
        update em toda mesa seria N+1 gravações à toa."""
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, ocupados=0)])
        S._sync_table_counts(fake.store["tournament_tables"], {M1: 0})
        assert _mesa_de(fake, M1)["occupied_seats"] == 0


class TestFonteDoSorteio:
    """De onde vem o acaso do sorteio de lugar.

    Posição na mesa vale dinheiro — sentar à esquerda de um jogador
    específico é vantagem real, e jogador de clube reclama de sorteio. O
    `random` global do Python é o Mersenne Twister: quem observar saídas
    suficientes prevê as próximas e, com a semente, reproduz a noite inteira.
    Aqui o sorteio usa `SystemRandom`, que lê a entropia do sistema
    operacional e não tem estado que dê para semear.
    """

    def test_usa_o_gerador_do_sistema_operacional(self):
        assert isinstance(mod._sorteio, random.SystemRandom)

    def test_nao_passa_pelo_random_global(self, monkeypatch):
        """Se o sorteio caísse no `random` global, esta armadilha estouraria."""
        def armadilha(*_args, **_kwargs):
            raise AssertionError("sorteio caiu no Mersenne Twister global")

        monkeypatch.setattr(random, "choice", armadilha)
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, lugares=4)])
        S.auto_allocate_player_for_day(TOUR, DIA, P1, mode="random_balanced")
        assert len(fake.store["seat_allocations"]) == 1

    def test_semear_o_random_nao_reproduz_a_mesa(self, monkeypatch):
        """A mesma semente tem que dar salões diferentes.

        É o que o clube precisa poder afirmar: ninguém reproduz o sorteio de
        ontem para saber onde vai sentar hoje.
        """
        def uma_rodada():
            fake = _monta(monkeypatch,
                          mesas=[_mesa(M1, 1, lugares=9), _mesa(M2, 2, lugares=9)],
                          inscritos=[_inscrito(f"p{i}") for i in range(18)])
            S.bulk_allocate_players(TOUR, DIA, "random_balanced")
            return [(a["table_id"], a["seat_number"]) for a in fake.store["seat_allocations"]]

        random.seed(20260814)
        primeira = uma_rodada()
        random.seed(20260814)
        segunda = uma_rodada()
        assert primeira != segunda

    def test_sorteio_cobre_os_lugares_ao_longo_das_rodadas(self, monkeypatch):
        """Sorteio que sempre cai no mesmo assento não é sorteio.

        Em 40 rodadas de uma mesa de 9, o primeiro a chegar precisa ter
        sentado em mais de um lugar.
        """
        primeiros = set()
        for _ in range(40):
            fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, lugares=9)])
            S.auto_allocate_player_for_day(TOUR, DIA, P1, mode="random_balanced")
            primeiros.add(fake.store["seat_allocations"][0]["seat_number"])
        assert len(primeiros) > 1


class TestDistribuicaoDoSorteio:
    """Trocar o gerador não pode mexer em quem senta onde: as mesas continuam
    equilibradas e nenhum lugar sai duas vezes."""

    def test_lote_sorteado_mantem_as_mesas_equilibradas(self, monkeypatch):
        """27 jogadores em 3 mesas de 9 têm que virar 9 + 9 + 9. Mesa com
        menos gente paga menos blinds por rodada — desequilíbrio é vantagem."""
        fake = _monta(monkeypatch,
                      mesas=[_mesa(M1, 1, lugares=9), _mesa(M2, 2, lugares=9),
                             _mesa(M3, 3, lugares=9)],
                      inscritos=[_inscrito(f"p{i}") for i in range(27)])
        S.bulk_allocate_players(TOUR, DIA, "random_balanced")
        por_mesa = {}
        for a in fake.store["seat_allocations"]:
            por_mesa.setdefault(a["table_id"], []).append(a["seat_number"])
        assert sorted(len(v) for v in por_mesa.values()) == [9, 9, 9]

    def test_nenhum_lugar_sai_duas_vezes(self, monkeypatch):
        """Dois jogadores no mesmo assento é o erro que para a mesa no salão.
        Repetido 30 vezes porque o sorteio muda a cada rodada."""
        for _ in range(30):
            fake = _monta(monkeypatch,
                          mesas=[_mesa(M1, 1, lugares=6), _mesa(M2, 2, lugares=6)],
                          inscritos=[_inscrito(f"p{i}") for i in range(12)])
            S.bulk_allocate_players(TOUR, DIA, "random_balanced")
            por_mesa = {}
            for a in fake.store["seat_allocations"]:
                por_mesa.setdefault(a["table_id"], []).append(a["seat_number"])
            for assentos in por_mesa.values():
                assert sorted(assentos) == [1, 2, 3, 4, 5, 6]

    def test_sorteio_nao_invade_assento_ja_ocupado(self, monkeypatch):
        """Com a mesa quase cheia, o sorteado só pode ser um dos livres."""
        for _ in range(30):
            fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, lugares=9, ocupados=7)],
                          alocacoes=[_aloc(f"a{i}", M1, i, f"px{i}") for i in (1, 2, 3, 5, 6, 8, 9)])
            S.auto_allocate_player_for_day(TOUR, DIA, P1, mode="random_balanced")
            nova = [a for a in fake.store["seat_allocations"] if a["player_id"] == P1][0]
            assert nova["seat_number"] in (4, 7)


class TestConsultasEMovimentacao:
    def test_detalhes_trazem_nome_do_jogador_mesa_e_dia(self, monkeypatch):
        _monta(monkeypatch, alocacoes=[_aloc("a1", M1, 1, P1)])
        r = S.get_allocation_with_details("a1")
        assert r.player_name == "Jogador"
        assert r.table_number == 1
        assert r.day_name == "Dia 1"

    def test_alocacao_sem_dia_nao_busca_o_nome_do_dia(self, monkeypatch):
        alocacao = _aloc("a1", M1, 1, P1)
        alocacao["tournament_day_id"] = None
        _monta(monkeypatch, alocacoes=[alocacao])
        assert S.get_allocation_with_details("a1").day_name is None

    def test_detalhes_de_alocacao_inexistente(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="Allocation not found"):
            S.get_allocation_with_details("nao-existe")

    def test_lista_por_mesa(self, monkeypatch):
        _monta(monkeypatch, mesas=[_mesa(M1, 1), _mesa(M2, 2)],
               alocacoes=[_aloc("a1", M1, 1, P1), _aloc("a2", M2, 1, P2)])
        assert len(S.get_table_allocations(M1)) == 1

    def test_move_de_mesa_ajusta_as_duas_contagens(self, monkeypatch):
        """Sem ajustar as duas, a mesa de origem fica "cheia" para sempre e a
        de destino aceita mais gente do que cabe."""
        fake = _monta(monkeypatch,
                      mesas=[_mesa(M1, 1, ocupados=1), _mesa(M2, 2, ocupados=0)],
                      alocacoes=[_aloc("a1", M1, 1, P1)])
        S.update_allocation("a1", SeatAllocationUpdate(table_id=M2, seat_number=3))
        assert _mesa_de(fake, M1)["occupied_seats"] == 0
        assert _mesa_de(fake, M2)["occupied_seats"] == 1

    def test_mover_para_assento_ocupado(self, monkeypatch):
        _monta(monkeypatch, mesas=[_mesa(M1, 1, ocupados=2)],
               alocacoes=[_aloc("a1", M1, 1, P1), _aloc("a2", M1, 5, P2)])
        arg = SeatAllocationUpdate(seat_number=5)
        with pytest.raises(ValueError, match="already occupied"):
            S.update_allocation("a1", arg)

    def test_salvar_no_mesmo_assento_e_permitido(self, monkeypatch):
        """A checagem precisa ignorar a própria linha, senão salvar sem mexer
        no lugar daria conflito consigo mesmo."""
        _monta(monkeypatch, alocacoes=[_aloc("a1", M1, 4, P1)])
        assert S.update_allocation("a1", SeatAllocationUpdate(seat_number=4)) is not None

    def test_atualizar_inexistente(self, monkeypatch):
        _monta(monkeypatch)
        arg = SeatAllocationUpdate(seat_number=1)
        with pytest.raises(ValueError, match="Allocation not found"):
            S.update_allocation("nao-existe", arg)

    def test_remover_devolve_o_lugar_para_a_mesa(self, monkeypatch):
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, ocupados=1)],
                      alocacoes=[_aloc("a1", M1, 1, P1)])
        assert S.remove_allocation("a1") is True
        assert _mesa_de(fake, M1)["occupied_seats"] == 0

    def test_contagem_nao_fica_negativa(self, monkeypatch):
        """Dado inconsistente (contagem já zerada) não pode virar −1, que
        deixaria a mesa aceitando um jogador a mais para sempre."""
        fake = _monta(monkeypatch, mesas=[_mesa(M1, 1, ocupados=0)],
                      alocacoes=[_aloc("a1", M1, 1, P1)])
        S.remove_allocation("a1")
        assert _mesa_de(fake, M1)["occupied_seats"] == 0


class TestQuemFaltaSentar:
    def test_lista_por_torneio(self, monkeypatch):
        _monta(monkeypatch,
               inscritos=[_inscrito(P1), _inscrito(P2)],
               alocacoes=[_aloc("a1", M1, 1, P1)])
        r = S.get_unallocated_players(TOUR)
        assert [p["player_id"] for p in r] == [P2]

    def test_eliminado_nao_precisa_de_lugar(self, monkeypatch):
        _monta(monkeypatch, inscritos=[_inscrito(P1, status="eliminated")])
        assert S.get_unallocated_players(TOUR) == []

    def test_lista_por_dia(self, monkeypatch):
        _monta(monkeypatch,
               inscritos=[_inscrito(P1), _inscrito(P2)],
               alocacoes=[_aloc("a1", M1, 1, P2)])
        r = S.get_unallocated_players_for_day(TOUR, DIA)
        assert [p["player_id"] for p in r] == [P1]

    def test_traz_o_nome_para_a_tela(self, monkeypatch):
        _monta(monkeypatch, inscritos=[_inscrito(P1)])
        assert S.get_unallocated_players_for_day(TOUR, DIA)[0]["player_name"] == "Jogador 1"

    def test_todos_sentados(self, monkeypatch):
        _monta(monkeypatch, inscritos=[_inscrito(P1)],
               alocacoes=[_aloc("a1", M1, 1, P1)])
        assert S.get_unallocated_players_for_day(TOUR, DIA) == []
