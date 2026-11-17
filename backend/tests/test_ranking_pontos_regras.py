"""Ranking de pontos: a fórmula e a classificação do Manual de Ranking NSOP.

Os números esperados são os das tabelas do próprio manual (seção 03,
"Ejemplos con torneos NSOP"): se a conta mudar, o ranking do clube deixa de
bater com o regulamento que ele publicou.
"""
import pytest

from app.services.ranking_pontos_regras import (
    RegrasDoRanking, arredondar, classificar, fator_buy_in, fator_jogadores,
    pontos, tabela_de_pontos, torneio_pontua,
)

REGRAS = RegrasDoRanking()


class TestFormulaDoManual:
    def test_tabela_base_por_posicao(self):
        # 50 jogadores únicos e buy-in S/350: os dois fatores valem 1.
        base = {1: 100, 2: 71, 3: 58, 4: 50, 5: 45, 6: 41, 7: 38, 8: 35, 9: 33, 10: 32,
                15: 26, 20: 22, 30: 18}
        for posicao, esperado in base.items():
            assert pontos(posicao, 50, 350, 30, REGRAS) == esperado, posicao

    @pytest.mark.parametrize("nome, jogadores, buy_in, premiados, fator, esperados", [
        ("Deepstack", 50, 350, 8, 1.000, {1: 100, 2: 71, 3: 58, 6: 41, 9: 0}),
        ("Main Event", 180, 700, 27, 1.389, {1: 139, 2: 98, 3: 80, 6: 57, 9: 46}),
        ("Turbo", 40, 120, 6, 0.811, {1: 81, 2: 57, 3: 47, 6: 33, 9: 0}),
    ])
    def test_exemplos_do_manual(self, nome, jogadores, buy_in, premiados, fator, esperados):
        combinado = fator_jogadores(jogadores, REGRAS) * fator_buy_in(buy_in, REGRAS)
        assert combinado == pytest.approx(fator, abs=0.0005), nome
        for posicao, esperado in esperados.items():
            assert pontos(posicao, jogadores, buy_in, premiados, REGRAS) == esperado, (nome, posicao)

    def test_fora_do_itm_vale_zero(self):
        # O 9º de um torneio que premia 8 tem valor "matemático", mas não pontua.
        assert pontos(9, 50, 350, 8, REGRAS) == 0
        assert pontos(8, 50, 350, 8, REGRAS) == 35

    def test_abaixo_de_12_jogadores_unicos_ninguem_pontua(self):
        assert not torneio_pontua(11, REGRAS)
        assert pontos(1, 11, 350, 3, REGRAS) == 0
        assert torneio_pontua(12, REGRAS)
        assert pontos(1, 12, 350, 3, REGRAS) > 0

    def test_fatores_tem_teto_e_piso(self):
        assert fator_jogadores(100000, REGRAS) == 1.50
        assert fator_jogadores(1, REGRAS) == 0.75
        assert fator_buy_in(1000000, REGRAS) == 1.40
        assert fator_buy_in(1, REGRAS) == 0.75

    def test_posicao_invalida_vale_zero(self):
        assert pontos(0, 50, 350, 8, REGRAS) == 0
        assert pontos(-1, 50, 350, 8, REGRAS) == 0

    def test_arredonda_so_no_fim_e_como_o_excel(self):
        # Meio vai para cima (o round do Python daria 2).
        assert arredondar(2.5) == 3
        assert arredondar(70.71) == 71
        assert arredondar(0.49) == 0

    def test_tabela_de_pontos_cobre_as_posicoes_premiadas(self):
        tabela = tabela_de_pontos(180, 700, 3, REGRAS)
        assert tabela == [{"position": 1, "points": 139}, {"position": 2, "points": 98},
                          {"position": 3, "points": 80}]
        assert tabela_de_pontos(50, 350, 0, REGRAS) == []


class TestRegrasDoClube:
    def test_linha_vazia_usa_o_padrao_do_manual(self):
        assert RegrasDoRanking.da_linha(None) == RegrasDoRanking()
        assert RegrasDoRanking.da_linha({}) == RegrasDoRanking()

    def test_parametros_gravados_mudam_a_conta(self):
        # Um clube em pesos colombianos usa outra referência de buy-in.
        regras = RegrasDoRanking.da_linha({"buy_in_reference": "200000", "min_unique_players": 20})
        assert regras.buy_in_referencia == 200000.0
        assert regras.minimo_de_jogadores == 20
        assert isinstance(regras.minimo_de_jogadores, int)
        assert fator_buy_in(200000, regras) == 1.0

    def test_ida_e_volta_pelas_colunas_do_banco(self):
        regras = RegrasDoRanking(jogadores_referencia=80, minimo_de_jogadores=16)
        linha = regras.como_linha()
        assert linha["players_reference"] == 80 and linha["min_unique_players"] == 16
        assert RegrasDoRanking.da_linha(linha) == regras


def _r(jogador, torneio, posicao, pontos_, data="2026-10-01"):
    return {"player_id": jogador, "player_name": jogador.capitalize(), "tournament_id": torneio,
            "position": posicao, "points": pontos_, "tournament_date": data}


class TestClassificacao:
    def test_exemplo_de_etapa_do_manual(self):
        # Carla lidera sem ter vencido: os resultados somados é que contam.
        resultados = [
            _r("carla", "deep", 6, 41), _r("carla", "main", 2, 98), _r("carla", "turbo", 1, 81),
            _r("bruno", "deep", 2, 71), _r("bruno", "main", 3, 80), _r("bruno", "turbo", 2, 57),
            _r("alba", "deep", 1, 100), _r("alba", "main", 8, 49),
        ]
        linhas = classificar(resultados)
        assert [(l.player_id, l.total, l.posicao) for l in linhas] == [
            ("carla", 220, 1), ("bruno", 208, 2), ("alba", 149, 3),
        ]
        assert linhas[0].por_torneio == {"deep": 41, "main": 98, "turbo": 81}

    def test_temporada_soma_so_os_n_melhores(self):
        resultados = [_r("ana", f"t{i}", 5, p) for i, p in enumerate([10, 50, 30, 20])]
        [ana] = classificar(resultados, melhores=2)
        assert ana.total == 80
        assert ana.eventos == 4 and ana.contados == 2
        assert sorted(ana.descartados) == ["t0", "t3"]

    def test_desempate_por_mais_vitorias(self):
        resultados = [
            _r("ana", "t1", 1, 50), _r("ana", "t2", 9, 0),
            _r("bia", "t1", 2, 30), _r("bia", "t2", 2, 20),
        ]
        linhas = classificar(resultados)
        assert [l.player_id for l in linhas] == ["ana", "bia"]
        assert linhas[0].total == linhas[1].total == 50
        assert not linhas[0].empatado

    def test_desempate_por_segundos_terceiros_e_mesas_finais(self):
        segundos = classificar([_r("ana", "t1", 2, 40), _r("bia", "t1", 3, 30), _r("bia", "t2", 4, 10)])
        assert segundos[0].player_id == "ana"
        mesas = classificar([
            _r("ana", "t1", 5, 20), _r("ana", "t2", 8, 20),
            _r("bia", "t1", 5, 20), _r("bia", "t2", 12, 20),
        ])
        assert mesas[0].player_id == "ana"
        assert mesas[0].mesas_finais == 2 and mesas[1].mesas_finais == 1

    def test_desempate_pelo_melhor_resultado_isolado(self):
        linhas = classificar([
            _r("ana", "t1", 12, 60), _r("ana", "t2", 15, 20),
            _r("bia", "t1", 11, 40), _r("bia", "t2", 13, 40),
        ])
        assert [l.player_id for l in linhas] == ["ana", "bia"]

    def test_empate_total_compartilha_a_posicao(self):
        linhas = classificar([_r("ana", "t1", 4, 30), _r("bia", "t2", 4, 30), _r("caio", "t1", 5, 10)])
        assert [l.posicao for l in linhas] == [1, 1, 3]
        assert linhas[0].empatado and linhas[1].empatado and not linhas[2].empatado

    def test_desempate_olha_todos_os_torneios_mesmo_os_descartados(self):
        # A vitória que ficou fora dos N melhores ainda desempata.
        linhas = classificar([
            _r("ana", "t1", 3, 40), _r("ana", "t2", 1, 10),
            _r("bia", "t1", 2, 40), _r("bia", "t2", 20, 5),
        ], melhores=1)
        assert linhas[0].total == linhas[1].total == 40
        assert linhas[0].player_id == "ana"
