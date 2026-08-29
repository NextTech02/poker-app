"""O resumo do torneio: quantos JOGADORES, quantas ENTRADAS, quantas REENTRADAS.

Este arquivo nasceu de um defeito em produção: o card de um torneio com DEZ
inscritos e o timer rodando mostrava "0 jogadores".

A causa vale mais que o conserto. A mesma regra existe em DOIS lugares — a
função SQL `get_tournament_summary` (o caminho principal) e
`_get_tournament_summary_batched` (o fallback em Python). A contagem foi
corrigida só no Python, e como o RPC responde primeiro, a correção nunca chegou
à tela. Pior: a função SQL não devolvia `total_players`, e o Pydantic preenchia
com o padrão do modelo — ZERO — sem erro em lugar nenhum.

Por isso os testes abaixo protegem duas coisas:
  1. o cálculo em si (jogador, entrada e reentrada são três números distintos);
  2. a guarda que detecta a função SQL desatualizada e prefere o caminho lento a
     exibir zero.
"""
import pytest

from app.services import tournament_service as mod
from app.services.tournament_service import TournamentService as S

from tests.conftest import FakeSupabase


TOUR = "11111111-1111-1111-1111-111111111111"
DIA = "22222222-2222-2222-2222-222222222222"
FINAL = "33333333-3333-3333-3333-333333333333"


def _torneio(**kw):
    base = {
        "id": TOUR, "name": "Torneio de sábado", "stage_id": "etapa-1",
        "status": "active", "created_by": "u1", "created_at": "2026-08-29T00:00:00Z",
    }
    base.update(kw)
    return base


def _dia(id_=DIA, tipo="regular", **kw):
    base = {"id": id_, "tournament_id": TOUR, "day_type": tipo, "status": "active"}
    base.update(kw)
    return base


def _inscrito(dia=DIA, buy=1, rebuy=0, addon=0, status="active"):
    return {
        "tournament_day_id": dia, "buy_in_count": buy, "rebuy_count": rebuy,
        "addon_count": addon, "status": status,
    }


@pytest.fixture
def banco(monkeypatch):
    fake = FakeSupabase({
        "tournaments": [_torneio()],
        "tournament_days": [_dia()],
        "tournament_players": [],
        "sponsors": [],
    })
    monkeypatch.setattr(mod, "supabase", fake)
    return fake


class TestOsTresNumeros:
    """Jogador, entrada e reentrada não são a mesma coisa."""

    def test_quem_recompra_continua_sendo_um_jogador(self, banco):
        """O caso do print: dez inscritos, cada um com uma recompra.

        Antes o card dizia "0 jogadores" e "20 entradas" — nem uma coisa nem
        outra."""
        banco.store["tournament_players"] = [_inscrito(rebuy=1) for _ in range(10)]
        r = S._get_tournament_summary_batched(tournament_id=TOUR)[0]
        assert r.total_players == 10     # dez pessoas na mesa
        assert r.total_entries == 10     # dez entradas, não vinte
        assert r.total_reentries == 10   # as recompras, em campo próprio

    def test_inscricao_estornada_nao_conta_como_gente(self, banco):
        """Cancelar a venda tira a pessoa do evento; deixá-la no número faria o
        clube pagar premiação para um campo que não existe."""
        banco.store["tournament_players"] = [
            _inscrito(), _inscrito(), _inscrito(status="cancelled"),
        ]
        r = S._get_tournament_summary_batched(tournament_id=TOUR)[0]
        assert r.total_players == 2

    def test_add_on_nao_cria_jogador_nem_entrada(self, banco):
        banco.store["tournament_players"] = [_inscrito(addon=3)]
        r = S._get_tournament_summary_batched(tournament_id=TOUR)[0]
        assert (r.total_players, r.total_entries, r.total_reentries) == (1, 1, 3)

    def test_o_dia_final_nao_soma_de_novo(self, banco):
        """Quem chega ao dia final veio classificado do dia anterior. Contá-lo
        somaria a mesma pessoa duas vezes."""
        banco.store["tournament_days"] = [_dia(), _dia(FINAL, tipo="final")]
        banco.store["tournament_players"] = [_inscrito(), _inscrito(dia=FINAL)]
        r = S._get_tournament_summary_batched(tournament_id=TOUR)[0]
        assert r.total_players == 1


class TestFuncaoSqlDesatualizada:
    """A guarda que faltava quando o defeito aconteceu.

    Sem ela, uma função SQL de versão anterior responde sem os agregados, o
    Pydantic preenche com zero e a tela mostra "0 jogadores" — sem erro, sem
    log, sem nada que denuncie.
    """

    def _resposta_do_rpc(self, banco, linhas):
        banco.rpcs["get_tournament_summary"] = linhas

    def test_rpc_completo_e_usado(self, banco):
        self._resposta_do_rpc(banco, [dict(
            _torneio(), total_entries=10, total_players=10,
            total_reentries=4, total_days=1, sponsor_name=None,
        )])
        r = S.get_tournament_summary(tournament_id=TOUR)[0]
        assert (r.total_players, r.total_entries, r.total_reentries) == (10, 10, 4)

    @pytest.mark.parametrize("faltando", [
        "total_players", "total_reentries", "total_entries", "total_days",
    ])
    def test_rpc_sem_um_agregado_cai_no_caminho_em_python(self, banco, faltando):
        """Preferir a consulta lenta a exibir zero: número errado no card é pior
        que um round-trip a mais."""
        linha = dict(_torneio(), total_entries=99, total_players=99,
                     total_reentries=99, total_days=1, sponsor_name=None)
        del linha[faltando]
        self._resposta_do_rpc(banco, [linha])
        banco.store["tournament_players"] = [_inscrito(), _inscrito()]

        r = S.get_tournament_summary(tournament_id=TOUR)[0]
        assert r.total_players == 2      # veio do Python, não os 99 do RPC
        assert r.total_entries == 2

    def test_lista_vazia_do_rpc_e_resposta_legitima(self, banco):
        """Nenhum torneio na etapa não é função desatualizada — e cair no
        fallback aqui seria uma consulta inteira à toa, em toda troca de etapa."""
        self._resposta_do_rpc(banco, [])
        assert S.get_tournament_summary(stage_id="etapa-vazia") == []

    def test_rpc_ausente_no_banco_cai_no_python(self, banco):
        """Cliente que ainda não aplicou a migração continua com a tela certa."""
        banco.store["tournament_players"] = [_inscrito(), _inscrito(), _inscrito()]
        # `banco.rpcs` sem a chave faz o fake estourar, como o Postgres faria.
        r = S.get_tournament_summary(tournament_id=TOUR)[0]
        assert r.total_players == 3
