"""Modo de eliminação do torneio: por posição nas mesas ou em massa.

O diretor escolhe na criação do torneio COMO elimina jogadores. Os dois modos
seguem a mesma conta (ATIVOS = ENTRADAS − ELIMINAÇÕES; toda reentrada traz um
eliminado de volta) — muda só quem mexe no contador. Os testes da regra em si
estão em test_tournament_players.py (reentrada, eliminação no assento) e em
test_tournament_day_service.py (contador em massa); aqui fica a escolha.
"""
import pytest

from app.models.tournament import EliminationMode, TournamentCreate, TournamentUpdate
from app.services import tournament_service
from app.services.eliminacao import entradas_para_ativos, normalizar_modo, reentradas
from app.services.tournament_service import TournamentService
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"


def _monta(monkeypatch, modo=None, eliminacoes=(0,)):
    torneio = {"id": TOUR, "name": "Torneio", "created_by": "u1",
               "created_at": "2026-06-08T00:00:00Z"}
    if modo is not None:
        torneio["elimination_mode"] = modo
    fake = FakeSupabase({
        "tournaments": [torneio],
        "tournament_days": [
            {"id": f"d{i}", "tournament_id": TOUR, "eliminations_count": n}
            for i, n in enumerate(eliminacoes)
        ],
    })
    monkeypatch.setattr(tournament_service, "supabase", fake)
    return fake


class TestCriacao:
    def test_o_padrao_e_em_massa(self):
        """Torneios que já existem eram todos "em massa": o único modo que a
        tela oferecia."""
        assert TournamentCreate(name="T").elimination_mode == EliminationMode.bulk

    def test_em_massa_nao_depende_da_coluna_nova(self, monkeypatch):
        """'bulk' é o padrão do BANCO. Não mandá-lo deixa a criação funcionando
        num banco que ainda não recebeu a migração."""
        fake = _monta(monkeypatch)
        fake.store["tournaments"] = []
        TournamentService.create_tournament(TournamentCreate(name="T"), "u1")
        assert "elimination_mode" not in fake.store["tournaments"][0]

    def test_por_mesa_e_gravado(self, monkeypatch):
        fake = _monta(monkeypatch)
        fake.store["tournaments"] = []
        t = TournamentService.create_tournament(
            TournamentCreate(name="T", elimination_mode="table"), "u1"
        )
        assert fake.store["tournaments"][0]["elimination_mode"] == "table"
        assert t.elimination_mode == EliminationMode.table

    def test_modo_desconhecido_e_recusado(self):
        with pytest.raises(ValueError):
            TournamentCreate(name="T", elimination_mode="sorteio")


class TestTrocaDeModo:
    def test_em_massa_para_mesa_com_eliminacoes_lancadas_e_recusado(self, monkeypatch):
        """As eliminações em massa não dizem QUEM saiu: a primeira recontagem
        do modo mesa apagaria todas, e os ATIVOS subiriam na TV."""
        fake = _monta(monkeypatch, modo="bulk", eliminacoes=(0, 3))
        with pytest.raises(ErroDeNegocio) as erro:
            TournamentService.update_tournament(TOUR, TournamentUpdate(elimination_mode="table"))
        assert erro.value.code == "modo_de_eliminacao_bloqueado"
        assert erro.value.status == 409
        assert fake.store["tournaments"][0]["elimination_mode"] == "bulk"

    def test_em_massa_para_mesa_sem_eliminacoes_passa(self, monkeypatch):
        fake = _monta(monkeypatch, modo="bulk", eliminacoes=(0, 0))
        TournamentService.update_tournament(TOUR, TournamentUpdate(elimination_mode="table"))
        assert fake.store["tournaments"][0]["elimination_mode"] == "table"

    def test_mesa_para_em_massa_sempre_passa(self, monkeypatch):
        """O contador do modo mesa já está certo; ele só passa a ser mexido
        pelos botões."""
        fake = _monta(monkeypatch, modo="table", eliminacoes=(4,))
        TournamentService.update_tournament(TOUR, TournamentUpdate(elimination_mode="bulk"))
        assert fake.store["tournaments"][0]["elimination_mode"] == "bulk"

    def test_reenviar_o_mesmo_modo_mesa_nao_e_recusado(self, monkeypatch):
        """Salvar o torneio sem mexer no modo não pode virar recusa só porque
        já há gente eliminada no assento."""
        _monta(monkeypatch, modo="table", eliminacoes=(4,))
        TournamentService.update_tournament(TOUR, TournamentUpdate(elimination_mode="table"))

    def test_edicao_sem_o_modo_nao_o_apaga(self, monkeypatch):
        fake = _monta(monkeypatch, modo="table")
        TournamentService.update_tournament(TOUR, TournamentUpdate(name="Novo"))
        assert fake.store["tournaments"][0]["elimination_mode"] == "table"

    def test_banco_sem_a_coluna_vale_em_massa(self, monkeypatch):
        _monta(monkeypatch, modo=None)
        assert TournamentService.modo_de_eliminacao(TOUR) == "bulk"

    def test_a_rota_devolve_409_com_codigo(self, monkeypatch, client):
        _monta(monkeypatch, modo="bulk", eliminacoes=(2,))
        r = client.patch(f"/tournaments/{TOUR}", json={"elimination_mode": "table"})
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "modo_de_eliminacao_bloqueado"


class TestRegraUnica:
    """A conta que os dois modos dividem."""

    def test_entrada_e_buy_in_mais_classificado(self):
        linhas = [
            {"buy_in_count": 1, "rebuy_count": 2, "addon_count": 1},
            {"buy_in_count": 0, "is_qualified_entry": True, "status": "active"},
            {"buy_in_count": 0, "is_qualified_entry": True, "status": "cancelled"},
        ]
        assert entradas_para_ativos(linhas) == 2

    def test_reentrada_e_so_a_recompra(self):
        linhas = [{"rebuy_count": 2, "addon_count": 5}, {"rebuy_count": 1}]
        assert reentradas(linhas) == 3

    def test_dia_final_nunca_tem_menos_entradas_que_inscritos(self):
        """Avanço pelo contador soma `registered_players` sem criar linha."""
        assert entradas_para_ativos([], {"day_type": "final", "registered_players": 9}) == 9

    @pytest.mark.parametrize("valor,esperado", [
        ("table", "table"), ("bulk", "bulk"), (None, "bulk"), ("", "bulk"),
    ])
    def test_modo_desconhecido_vale_em_massa(self, valor, esperado):
        assert normalizar_modo(valor) == esperado
