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


class TestPremioManual:
    """Envelope aberto na mesa sem passar pelo sistema (o que aconteceu no
    MISTERY do NSOP em 2026-10-14): o clube registra quem recebeu e quanto,
    e o caixa paga pelo caminho de sempre."""

    def test_registra_pendente_para_quem_recebeu(self, mystery):
        ko = K.registrar_manual(TOUR, "tp2", 100, eliminado_tp_id="tp1", user_id="u1")
        assert ko["kind"] == "manual" and ko["format"] == "mystery"
        assert ko["eliminated_tp_id"] == "tp1"
        [p] = ko["payouts"]
        assert p["eliminator_tp_id"] == "tp2"
        assert p["cash_amount"] == D("100.00") and p["paid"] is False
        r = K.resumo(TOUR)
        assert r["pending"] == D("100.00") and r["manual_total"] == D("100.00")

    def test_paga_pelo_caixa_geral_como_qualquer_ko(self, mystery):
        ko = K.registrar_manual(TOUR, "tp2", 100)
        K.pagar(TOUR, ko["payouts"][0]["id"], "u1")
        assert len(_pagos(mystery)) == 1
        [premio] = [t for t in mystery.store["transactions"] if t.get("type") == "prize"]
        assert premio["prize_kind"] == "knockout" and float(premio["amount"]) == 100

    def test_nao_passa_do_pool(self, mystery):
        K.registrar_manual(TOUR, "tp2", 200)
        with pytest.raises(ErroDeNegocio) as e:
            K.registrar_manual(TOUR, "tp3", 50)   # sobram 40 de 240
        assert e.value.code == "premio_acima_do_pool"
        assert e.value.dados == {"disponivel": 40.0, "solicitado": 50.0}

    def test_valor_e_jogador_validos(self, mystery):
        with pytest.raises(ErroDeNegocio) as e:
            K.registrar_manual(TOUR, "tp2", 0)
        assert e.value.code == "premio_valor_invalido"
        with pytest.raises(ErroDeNegocio) as e:
            K.registrar_manual(TOUR, "fora", 10)
        assert e.value.code == "premio_jogador_invalido"
        with pytest.raises(ErroDeNegocio) as e:
            K.registrar_manual(TOUR, "tp2", 10, eliminado_tp_id="tp2")
        assert e.value.code == "eliminador_e_a_vitima"

    def test_so_antes_da_fase_no_sistema(self, mystery):
        _iniciar(mystery)
        with pytest.raises(ErroDeNegocio) as e:
            K.registrar_manual(TOUR, "tp2", 10)
        assert e.value.code == "premio_manual_fase_iniciada"

    def test_so_no_mystery(self, cenario):
        cenario()   # torneio PKO
        with pytest.raises(ErroDeNegocio) as e:
            K.registrar_manual(TOUR, "tp2", 10)
        assert e.value.code == "premio_manual_so_mystery"

    def test_desfazer_enquanto_ninguem_pagou(self, mystery):
        ko = K.registrar_manual(TOUR, "tp2", 100)
        r = K.desfazer_manual(TOUR, ko["id"], "u1")
        assert r["pending"] == D("0.00") and r["manual_total"] == D("0.00")
        # Desfeito, o valor volta a caber no pool.
        K.registrar_manual(TOUR, "tp3", 240)

    def test_pago_nao_desfaz(self, mystery):
        ko = K.registrar_manual(TOUR, "tp2", 100)
        K.pagar(TOUR, ko["payouts"][0]["id"], "u1")
        with pytest.raises(ErroDeNegocio) as e:
            K.desfazer_manual(TOUR, ko["id"])
        assert e.value.code == "premio_manual_ja_pago"

    def test_iniciar_a_fase_depois_desconta_o_que_saiu_a_mao(self, mystery):
        K.registrar_manual(TOUR, "tp2", 40)
        with pytest.raises(ErroDeNegocio) as e:
            K.iniciar_mystery(TOUR, ENVELOPES)          # somam 240; sobram 200
        assert e.value.code == "envelopes_soma_errada"
        r = K.iniciar_mystery(TOUR, [{"value": 100, "quantity": 2}])
        assert r["mystery"]["envelopes_total"] == 2

    def test_pelas_rotas(self, client, mystery):
        r = client.post(f"/tournaments/{TOUR}/knockouts/manual",
                        json={"recipient_tp_id": "tp2", "value": 100, "eliminated_tp_id": "tp1"})
        assert r.status_code == 200, r.text
        kid = r.json()["id"]
        r = client.post(f"/tournaments/{TOUR}/knockouts/manual", json={"recipient_tp_id": "tp3", "value": 500})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "premio_acima_do_pool"
        r = client.delete(f"/tournaments/{TOUR}/knockouts/manual/{kid}")
        assert r.status_code == 200, r.text
        assert float(r.json()["manual_total"]) == 0


def _iniciar_fisico(fake, envelopes=ENVELOPES):
    resumo = K.iniciar_mystery(TOUR, envelopes, None, "physical")
    for tp in fake.store["tournament_players"]:
        tp["tournaments"].update({k: fake.store["tournaments"][0][k]
                                  for k in ("mystery_started_at", "mystery_pool")})
    return resumo


class TestSorteioFisico:
    """Guia do NSOP: o jogador troca um comprovante por um envelope de
    verdade no ponto de troca; o staff registra o valor que saiu."""

    def test_a_fase_guarda_o_modo(self, mystery):
        r = _iniciar_fisico(mystery)
        assert mystery.store["tournaments"][0]["mystery_draw_mode"] == "physical"
        assert r["mystery"]["draw_mode"] == "physical"

    def test_eliminacao_gera_comprovante_sem_valor_e_sem_sortear(self, mystery):
        _iniciar_fisico(mystery)
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp4"])
        assert ko["envelope_pending"] is True and ko["bounty_value"] == D("0.00")
        assert [p["cash_amount"] for p in ko["payouts"]] == [D("0.00")]
        assert not [e for e in mystery.store["tournament_mystery_envelopes"] if e.get("drawn_at")]
        assert K.resumo(TOUR)["mystery"]["pending_draws"] == 1

    def test_comprovante_nao_se_paga_antes_da_troca(self, mystery):
        _iniciar_fisico(mystery)
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp4"])
        with pytest.raises(ErroDeNegocio) as e:
            K.pagar(TOUR, ko["payouts"][0]["id"], "u1")
        assert e.value.code == "mystery_envelope_nao_trocado"

    def test_troca_registra_o_envelope_que_saiu_e_libera_o_pagamento(self, mystery):
        _iniciar_fisico(mystery)
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp4"])
        trocado = K.trocar_envelope(TOUR, ko["id"], 100, "u1")
        assert trocado["envelope_pending"] is False and trocado["bounty_value"] == D("100.00")
        assert trocado["payouts"][0]["cash_amount"] == D("100.00")
        sorteados = [e for e in mystery.store["tournament_mystery_envelopes"] if e.get("drawn_at")]
        assert len(sorteados) == 1 and sorteados[0]["drawn_knockout_id"] == ko["id"]
        K.pagar(TOUR, ko["payouts"][0]["id"], "u1")
        assert len(_pagos(mystery)) == 1
        assert K.resumo(TOUR)["mystery"]["envelopes_remaining"] == 3

    def test_valor_que_nao_esta_no_estoque_e_recusado(self, mystery):
        _iniciar_fisico(mystery)
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp4"])
        with pytest.raises(ErroDeNegocio) as e:
            K.trocar_envelope(TOUR, ko["id"], 55)
        assert e.value.code == "mystery_envelope_inexistente"

    def test_nao_troca_duas_vezes(self, mystery):
        _iniciar_fisico(mystery)
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp4"])
        K.trocar_envelope(TOUR, ko["id"], 30)
        with pytest.raises(ErroDeNegocio) as e:
            K.trocar_envelope(TOUR, ko["id"], 10)
        assert e.value.code == "mystery_envelope_ja_trocado"

    def test_pote_dividido_reparte_o_envelope_na_troca(self, mystery):
        _iniciar_fisico(mystery, [{"value": 60, "quantity": 4}])
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp2", "tp3"])
        trocado = K.trocar_envelope(TOUR, ko["id"], 60)
        assert [p["cash_amount"] for p in trocado["payouts"]] == [D("30.00"), D("30.00")]

    def test_nao_promete_mais_comprovantes_que_envelopes(self, mystery):
        _iniciar_fisico(mystery, [{"value": 120, "quantity": 2}])
        _, k1 = TPS.eliminar("tp1", "u1", eliminated_by=["tp4"])
        _, k2 = TPS.eliminar("tp2", "u1", eliminated_by=["tp4"])
        _, k3 = TPS.eliminar("tp3", "u1", eliminated_by=["tp4"])
        assert (k1["envelope_pending"], k2["envelope_pending"], k3["envelope_pending"]) == (True, True, False)

    def test_encerrar_com_comprovante_pendente_e_recusado(self, mystery):
        _iniciar_fisico(mystery)
        TPS.eliminar("tp1", "u1", eliminated_by=["tp4"])
        with pytest.raises(ErroDeNegocio) as e:
            K.encerrar(TOUR, "tp4", "u1")
        assert e.value.code == "mystery_comprovantes_pendentes"

    def test_desfazer_eliminacao_cancela_o_comprovante(self, mystery):
        _iniciar_fisico(mystery)
        TPS.eliminar("tp1", "u1", eliminated_by=["tp4"])
        TPS.uneliminate_player("tp1")
        assert K.resumo(TOUR)["mystery"]["pending_draws"] == 0

    def test_pela_rota(self, client, mystery):
        _iniciar_fisico(mystery)
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp4"])
        r = client.post(f"/tournaments/{TOUR}/knockouts/{ko['id']}/envelope", json={"value": 100})
        assert r.status_code == 200, r.text
        assert r.json()["envelope_pending"] is False
        r = client.post(f"/tournaments/{TOUR}/knockouts/{ko['id']}/envelope", json={"value": 100})
        assert r.status_code == 409 and r.json()["detail"]["code"] == "mystery_envelope_ja_trocado"


class TestGarantidoMystery:
    """O fundo é o MAIOR entre as entradas e o garantido; a diferença é da
    casa, e o pool das posições continua descontando só as entradas."""

    def test_fundo_usa_o_garantido_quando_e_maior(self, mystery):
        mystery.store["tournaments"][0]["mystery_guarantee"] = 500
        r = K.resumo(TOUR)
        assert r["ko_pool"] == D("500.00") and r["entries_pool"] == D("240.00")
        assert r["mystery_guarantee"] == D("500.00")

    def test_entradas_acima_do_garantido_valem_as_entradas(self, mystery):
        mystery.store["tournaments"][0]["mystery_guarantee"] = 100
        assert K.resumo(TOUR)["ko_pool"] == D("240.00")

    def test_envelopes_somam_o_garantido(self, mystery):
        mystery.store["tournaments"][0]["mystery_guarantee"] = 500
        with pytest.raises(ErroDeNegocio) as e:
            K.iniciar_mystery(TOUR, ENVELOPES)                 # somam 240
        assert e.value.code == "envelopes_soma_errada"
        r = K.iniciar_mystery(TOUR, [{"value": 250, "quantity": 2}])
        # O congelado é o das ENTRADAS (o que sai das posições).
        assert mystery.store["tournaments"][0]["mystery_pool"] == 240
        assert r["ko_pool"] == D("500.00")

    def test_premio_manual_cabe_no_garantido(self, mystery):
        mystery.store["tournaments"][0]["mystery_guarantee"] = 500
        K.registrar_manual(TOUR, "tp2", 450)

    def test_prize_summary_desconta_das_posicoes_so_as_entradas(self, mystery):
        from app.services.prize_allocation_service import PrizeAllocationService as P
        mystery.store["tournaments"][0]["mystery_guarantee"] = 5000
        s = P.get_prize_summary(TOUR)
        assert s.ko_fund == D("5000")
        assert s.player_pool == s.net_pool - s.ko_pool
        assert s.total_prize_pool == s.available_prize_pool + s.ko_fund
