"""Mystery Bounty: envelopes cadastrados pelo clube, sorteados pelo sistema.

Antes da fase, eliminar não paga nada (o pozo ainda cresce com as vendas).
Ao iniciar, o pozo KO CONGELA em envelopes — um por jogador vivo, somando
exatamente o pozo. Cada eliminação sorteia um; o campeão leva o que sobrar.
Vendas depois do início são recusadas (não teriam envelope).
"""
from decimal import Decimal

import pytest

from app.models.tournament_player import TournamentPlayerCreate
from app.services.knockout_service import KnockoutService as K
from app.services.tournament_player_service import TournamentPlayerService as TPS
from app.utils.erros import ErroDeNegocio

from tests.test_knockouts import DIA, TOUR, _pagos, _torneio, _tp, _venda, cenario  # noqa: F401

D = Decimal
ENVELOPES = [{"value": 100, "quantity": 2}, {"value": 30, "quantity": 1}, {"value": 10, "quantity": 1}]


def _mystery(**extra):
    return _torneio(formato="mystery", share=100, **extra)


@pytest.fixture
def mystery(cenario):
    """4 vivos, pozo KO 240 (4 vendas de 60)."""
    t = _mystery()
    return cenario(torneio=t, inscritos=[_tp(f"tp{i}", torneio=t) for i in range(1, 5)],
                   vendas=[_venda(f"tp{i}", 60) for i in range(1, 5)])


def _iniciar(fake, envelopes=ENVELOPES):
    resumo = K.iniciar_mystery(TOUR, envelopes)
    # O fake não relê o torneio embutido na inscrição: espelha o início nele.
    for tp in fake.store["tournament_players"]:
        tp["tournaments"].update({k: fake.store["tournaments"][0][k]
                                  for k in ("mystery_started_at", "mystery_pool")})
    return resumo


class TestAntesDaFase:
    def test_eliminar_antes_da_fase_nao_paga_nem_exige_eliminador(self, mystery):
        tp, ko = TPS.eliminar("tp1", "u1")
        assert tp.status == "eliminated" and ko is None
        assert mystery.store["tournament_knockouts"] == []

    def test_vendas_ainda_alimentam_o_pozo(self, mystery):
        assert K.resumo(TOUR)["ko_pool"] == D("240.00")


class TestInicioDaFase:
    def test_congela_o_pozo_em_envelopes(self, mystery):
        r = _iniciar(mystery)
        t = mystery.store["tournaments"][0]
        assert t["mystery_pool"] == 240 and t["mystery_players_at_start"] == 4
        assert sorted(e["value"] for e in mystery.store["tournament_mystery_envelopes"]) == [10, 30, 100, 100]
        assert r["mystery"]["envelopes_remaining"] == 4
        assert [(g["value"], g["count"]) for g in r["mystery"]["remaining"]] == [(D("100.00"), 2), (D("30.00"), 1), (D("10.00"), 1)]

    def test_envelopes_que_nao_fecham_sao_recusados(self, mystery):
        with pytest.raises(ErroDeNegocio) as e:
            K.iniciar_mystery(TOUR, [{"value": 60, "quantity": 3}])
        assert e.value.code == "envelopes_soma_errada"
        assert mystery.store["tournaments"][0].get("mystery_started_at") is None

    def test_mais_envelopes_que_vivos_e_recusado(self, mystery):
        with pytest.raises(ErroDeNegocio) as e:
            K.iniciar_mystery(TOUR, [{"value": 48, "quantity": 5}])
        assert e.value.code == "envelopes_quantidade_errada"

    def test_menos_envelopes_que_vivos_inicia(self, mystery):
        """4 vivos, 3 envelopes somando o pozo (240): vale."""
        r = K.iniciar_mystery(TOUR, [{"value": 120, "quantity": 1}, {"value": 80, "quantity": 1}, {"value": 40, "quantity": 1}])
        assert r["mystery"]["envelopes_total"] == 3
        assert mystery.store["tournaments"][0]["mystery_players_at_start"] == 4

    def test_nao_inicia_duas_vezes(self, mystery):
        _iniciar(mystery)
        with pytest.raises(ErroDeNegocio) as e:
            K.iniciar_mystery(TOUR, ENVELOPES)
        assert e.value.code == "mystery_ja_iniciado"

    def test_so_torneio_mystery(self, cenario):
        cenario()
        with pytest.raises(ErroDeNegocio) as e:
            K.iniciar_mystery(TOUR, ENVELOPES)
        assert e.value.code == "torneio_nao_e_mystery"

    def test_desfazer_inicio_sem_sorteio(self, mystery):
        _iniciar(mystery)
        K.desfazer_mystery(TOUR)
        assert mystery.store["tournament_mystery_envelopes"] == []
        assert mystery.store["tournaments"][0]["mystery_started_at"] is None

    def test_desfazer_inicio_depois_de_sortear_e_recusado(self, mystery):
        _iniciar(mystery)
        TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        with pytest.raises(ErroDeNegocio) as e:
            K.desfazer_mystery(TOUR)
        assert e.value.code == "mystery_com_envelope_sorteado"


class TestSorteio:
    def test_cada_eliminacao_sorteia_um_envelope_diferente(self, mystery):
        _iniciar(mystery)
        valores = []
        for vitima, autor in (("tp1", "tp4"), ("tp2", "tp4"), ("tp3", "tp4")):
            _, ko = TPS.eliminar(vitima, "u1", eliminated_by=[autor])
            assert ko["format"] == "mystery"
            [p] = ko["payouts"]
            assert p["added_to_bounty"] == 0 and p["cash_amount"] == ko["bounty_value"]
            valores.append(ko["bounty_value"])
        sorteados = [e for e in mystery.store["tournament_mystery_envelopes"] if e.get("drawn_at")]
        assert len(sorteados) == 3
        assert len({e["id"] for e in sorteados}) == 3
        assert sum(valores) == sum(D(str(e["value"])) for e in sorteados)

    def test_na_fase_o_eliminador_e_obrigatorio(self, mystery):
        _iniciar(mystery)
        with pytest.raises(ErroDeNegocio) as e:
            TPS.eliminar("tp1", "u1")
        assert e.value.code == "eliminador_obrigatorio"

    def test_sem_autor_nao_sorteia(self, mystery):
        _iniciar(mystery)
        _, ko = TPS.eliminar("tp1", "u1", no_eliminator=True)
        assert ko["bounty_value"] == 0 and ko["payouts"] == []
        assert not [e for e in mystery.store["tournament_mystery_envelopes"] if e.get("drawn_at")]

    def test_pote_dividido_divide_o_envelope(self, mystery):
        _iniciar(mystery, [{"value": 60, "quantity": 4}])
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp2", "tp3"])
        assert [p["cash_amount"] for p in ko["payouts"]] == [D("30.00"), D("30.00")]

    def test_desfazer_eliminacao_devolve_o_envelope(self, mystery):
        _iniciar(mystery)
        TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        TPS.uneliminate_player("tp1")
        assert not [e for e in mystery.store["tournament_mystery_envelopes"] if e.get("drawn_at")]


class TestVendasNaFase:
    def test_venda_nova_e_recusada(self, mystery):
        _iniciar(mystery)
        with pytest.raises(ErroDeNegocio) as e:
            TPS.add_addon("tp1", "u1")
        assert e.value.code == "vendas_encerradas_fase_mystery"

    def test_inscricao_nova_e_recusada(self, mystery):
        _iniciar(mystery)
        with pytest.raises(ErroDeNegocio) as e:
            TPS.register_player(TournamentPlayerCreate(tournament_id=TOUR, tournament_day_id=DIA, player_id="p5"), "u1")
        assert e.value.code == "vendas_encerradas_fase_mystery"

    def test_replay_offline_entra_com_parte_ko_zero(self, mystery):
        """A venda aconteceu no balcão antes do sync: entra, mas vai para as posições."""
        _iniciar(mystery)
        TPS.add_addon("tp1", "u1", skip_sales_block=True)
        nova = mystery.store["transactions"][-1]
        assert nova["type"] == "addon" and nova["bounty_amount"] == 0


class TestEncerramentoMystery:
    def test_campeao_leva_os_envelopes_restantes_e_fecha_com_o_pozo(self, mystery):
        _iniciar(mystery)
        TPS.eliminar("tp1", "u1", eliminated_by=["tp4"])
        TPS.eliminar("tp2", "u1", no_eliminator=True)   # envelope fica para o campeão
        TPS.eliminar("tp3", "u1", eliminated_by=["tp4"])
        r = K.encerrar(TOUR, "tp4", "u1")
        for p in list(mystery.store["tournament_knockout_payouts"]):
            if not p.get("paid"):
                K.pagar(TOUR, p["id"], "u1")
        assert sum(D(str(p["cash_amount"])) for p in _pagos(mystery)) == D("240.00") == r["ko_pool"]
        assert r["mystery"]["envelopes_remaining"] == 0

    def test_encerrar_sem_iniciar_a_fase_e_recusado(self, mystery):
        with pytest.raises(ErroDeNegocio) as e:
            K.encerrar(TOUR, "tp1", "u1")
        assert e.value.code == "mystery_fase_nao_iniciada"


class TestRotasMystery:
    def test_iniciar_e_desfazer_pela_rota(self, client, mystery):
        r = client.post(f"/tournaments/{TOUR}/mystery/start", json={"envelopes": ENVELOPES})
        assert r.status_code == 200, r.text
        assert r.json()["mystery"]["envelopes_total"] == 4
        r = client.delete(f"/tournaments/{TOUR}/mystery/start")
        assert r.status_code == 200 and r.json()["mystery"]["envelopes_total"] == 0

    def test_envelopes_errados_viram_400_com_codigo(self, client, mystery):
        r = client.post(f"/tournaments/{TOUR}/mystery/start", json={"envelopes": [{"value": 10, "quantity": 1}]})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "envelopes_soma_errada"
