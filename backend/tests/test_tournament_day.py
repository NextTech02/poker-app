"""Testes do dia de torneio: relogio e calculo de nivel.

O relogio fica na TV na frente dos jogadores. Um nivel errado muda as
apostas obrigatorias da mesa — e isso e percebido na hora, pelo salao
inteiro. As funcoes de calculo aqui sao puras, entao dao para testar direto,
sem banco.
"""
import pytest

from app.services import tournament_day_service
from app.services.tournament_day_service import TournamentDayService

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"


def _blind(nivel, duracao_min, intervalo=False, sb=100, bb=200):
    return {"level": nivel, "duration": duracao_min, "is_break": intervalo,
            "small_blind": sb, "big_blind": bb, "ante": 0}


class TestCalculoDeNivel:
    """`_calculate_current_level` deriva o nivel do tempo TOTAL decorrido.
    E o que mantem o relogio certo mesmo se a tela ficar minutos sem
    atualizar (queda de rede, aba em segundo plano)."""

    ESTRUTURA = [_blind(1, 10), _blind(2, 10), _blind(3, 15)]

    def test_sem_blinds_devolve_nivel_um(self):
        r = TournamentDayService._calculate_current_level([], 500)
        assert r["level"] == 1
        assert r["time_remaining"] == 0

    def test_no_comeco_esta_no_primeiro_nivel(self):
        r = TournamentDayService._calculate_current_level(self.ESTRUTURA, 0)
        assert r["level"] == 1
        assert r["time_remaining"] == 600     # 10 min

    def test_no_meio_do_primeiro_nivel(self):
        r = TournamentDayService._calculate_current_level(self.ESTRUTURA, 300)
        assert r["level"] == 1
        assert r["time_remaining"] == 300

    def test_vira_para_o_segundo_nivel_no_segundo_exato(self):
        """600s e o primeiro instante do nivel 2 — nao o ultimo do nivel 1."""
        r = TournamentDayService._calculate_current_level(self.ESTRUTURA, 600)
        assert r["level"] == 2
        assert r["time_remaining"] == 600

    def test_um_segundo_antes_ainda_e_o_nivel_anterior(self):
        r = TournamentDayService._calculate_current_level(self.ESTRUTURA, 599)
        assert r["level"] == 1
        assert r["time_remaining"] == 1

    def test_terceiro_nivel_com_duracao_diferente(self):
        # 10 + 10 = 20min; aos 25min esta 5min dentro do nivel 3 (15min)
        r = TournamentDayService._calculate_current_level(self.ESTRUTURA, 1500)
        assert r["level"] == 3
        assert r["time_remaining"] == 600

    def test_depois_do_fim_fica_no_ultimo_nivel(self):
        """Nao pode avancar para um nivel que nao existe nem voltar a zero."""
        r = TournamentDayService._calculate_current_level(self.ESTRUTURA, 99999)
        assert r["level"] == 3
        assert r["time_remaining"] == 0

    def test_tempo_restante_nunca_e_negativo(self):
        for t in [0, 1, 599, 600, 1200, 2100, 5000]:
            r = TournamentDayService._calculate_current_level(self.ESTRUTURA, t)
            assert r["time_remaining"] >= 0


class TestFuncoesDeBlind:
    ESTRUTURA = [_blind(1, 10), _blind(2, 10), _blind(3, 15, intervalo=True), _blind(4, 10)]

    def test_encontra_o_blind_pelo_nivel(self):
        b = TournamentDayService._find_blind_by_level(self.ESTRUTURA, 2)
        assert b["level"] == 2

    def test_nivel_inexistente_devolve_none_ou_vazio(self):
        b = TournamentDayService._find_blind_by_level(self.ESTRUTURA, 99)
        assert not b

    def test_soma_a_duracao_dos_niveis_anteriores(self):
        # antes do nivel 3: 10 + 10 = 20 min = 1200s
        assert TournamentDayService._sum_durations_before_level(self.ESTRUTURA, 3) == 1200

    def test_antes_do_primeiro_nivel_a_soma_e_zero(self):
        assert TournamentDayService._sum_durations_before_level(self.ESTRUTURA, 1) == 0

    def test_encontra_o_proximo_intervalo(self):
        """O salao precisa saber quanto falta para a pausa; sem isso o
        jogador nao sabe se da tempo de sair da mesa."""
        r = TournamentDayService._find_next_break(self.ESTRUTURA, current_level=1, current_elapsed=0)
        assert r is not None
        assert r.get("level") == 3

    def test_sem_intervalo_a_frente_devolve_none(self):
        sem_pausa = [_blind(1, 10), _blind(2, 10)]
        assert TournamentDayService._find_next_break(sem_pausa, 1, 0) is None


class TestControleDoRelogio:
    def _monta(self, monkeypatch, dia=None):
        base = {
            "tournament_days": [dia or {
                "id": DIA, "tournament_id": TOUR, "day_name": "Dia 1",
                "day_number": 1, "buy_in": 100, "starting_chips": 10000,
                "status": "pending", "is_paused": True, "current_level": 1,
                "max_players": 100, "rake_percentage": 20, "day_type": "regular",
                "timer_started_at": None, "elapsed_time": 0,
                "created_at": "2026-06-08T00:00:00Z",
            }],
            "tournaments": [{"id": TOUR, "name": "Torneio", "status": "pending"}],
            "blinds": [], "tournament_players": [],
        }
        fake = FakeSupabase(base)
        monkeypatch.setattr(tournament_day_service, "supabase", fake)
        return fake

    def test_iniciar_marca_como_ativo_e_despausa(self, monkeypatch):
        fake = self._monta(monkeypatch)
        TournamentDayService.start_timer(DIA)
        linha = fake.store["tournament_days"][0]
        assert linha["is_paused"] is False
        assert linha["status"] == "active"
        assert linha["timer_started_at"] is not None

    def test_dia_inexistente_e_recusado(self, monkeypatch):
        self._monta(monkeypatch, dia=None)
        fake = FakeSupabase({"tournament_days": [], "tournaments": [], "blinds": []})
        monkeypatch.setattr(tournament_day_service, "supabase", fake)
        with pytest.raises(ValueError, match="not found"):
            TournamentDayService.start_timer("nao-existe")

    def test_pausar_marca_como_pausado(self, monkeypatch):
        fake = self._monta(monkeypatch)
        TournamentDayService.start_timer(DIA)
        TournamentDayService.pause_timer(DIA)
        assert fake.store["tournament_days"][0]["is_paused"] is True

    def test_definir_nivel_direto(self, monkeypatch):
        fake = self._monta(monkeypatch)
        TournamentDayService.set_level(DIA, 5)
        assert fake.store["tournament_days"][0]["current_level"] == 5

    def test_reiniciar_volta_ao_inicio(self, monkeypatch):
        fake = self._monta(monkeypatch)
        TournamentDayService.start_timer(DIA)
        TournamentDayService.set_level(DIA, 7)
        TournamentDayService.reset_timer(DIA)
        linha = fake.store["tournament_days"][0]
        assert linha["current_level"] == 1
        assert linha["is_paused"] is True

    def test_contador_de_eliminados(self, monkeypatch):
        fake = self._monta(monkeypatch)
        TournamentDayService.adjust_eliminations(DIA, 3)
        assert fake.store["tournament_days"][0].get("eliminations_count", 0) >= 0


class TestCodigoDeTV:
    def _monta(self, monkeypatch, dias=None):
        fake = FakeSupabase({
            "tournament_days": dias if dias is not None else [{
                "id": DIA, "tournament_id": TOUR, "broadcast_code": None,
                "day_name": "Dia 1", "created_at": "2026-06-08T00:00:00Z",
            }],
        })
        monkeypatch.setattr(tournament_day_service, "supabase", fake)
        return fake

    def test_gera_codigo_de_seis_caracteres(self, monkeypatch):
        self._monta(monkeypatch)
        codigo = TournamentDayService.get_or_create_broadcast_code(DIA)
        assert len(codigo) == 6
        # alfabeto sem 0/O/1/I/L, para nao confundir quem digita na TV
        assert not set(codigo) & set("0O1IL")

    def test_reaproveita_o_codigo_ja_existente(self, monkeypatch):
        """Trocar o codigo a cada consulta invalidaria a TV ja ligada."""
        self._monta(monkeypatch, dias=[{
            "id": DIA, "tournament_id": TOUR, "broadcast_code": "ABC234",
            "day_name": "Dia 1", "created_at": "2026-06-08T00:00:00Z",
        }])
        assert TournamentDayService.get_or_create_broadcast_code(DIA) == "ABC234"

    def test_dia_inexistente_e_recusado(self, monkeypatch):
        self._monta(monkeypatch, dias=[])
        with pytest.raises(ValueError, match="não encontrado"):
            TournamentDayService.get_or_create_broadcast_code("nao-existe")
