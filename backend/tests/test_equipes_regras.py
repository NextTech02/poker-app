"""Regras do torneio por equipes (funções puras).

Pontos pela posição na mesa (5 por posição, vencedor 5·N), empates que dividem
a média, ranking com o capitão e o 2º critério, sorteio que separa os
integrantes e reparte as mesas grandes com justiça, e o revezamento da final.
"""
import random
from collections import Counter
from decimal import Decimal

import pytest

from app.services import equipes_regras as R
from app.utils.erros import ErroDeNegocio

D = Decimal


def _eliminados(*ids, empates=()):
    return [{"id": i, "tie_with_previous": i in empates} for i in ids]


class TestResultadoDaMesa:
    def test_mesa_de_8_vai_de_5_a_40(self):
        r = R.resultado_da_mesa(_eliminados("a", "b", "c", "d", "e", "f", "g"), ["h"])
        assert r["tamanho"] == 8 and r["terminada"]
        pontos = {k: v["pontos"] for k, v in r["jogadores"].items()}
        assert pontos == {"a": D(5), "b": D(10), "c": D(15), "d": D(20), "e": D(25),
                          "f": D(30), "g": D(35), "h": D(40)}
        assert r["jogadores"]["a"]["posicao"] == 8 and r["jogadores"]["h"]["posicao"] == 1

    def test_mesa_incompleta_usa_a_escala_desde_o_ultimo(self):
        # Mesa de 6: do 6º (5 pontos) ao 1º (30 pontos), como nas bases.
        r = R.resultado_da_mesa(_eliminados("a", "b", "c", "d", "e"), ["f"])
        assert r["jogadores"]["a"]["pontos"] == D(5)
        assert r["jogadores"]["f"]["pontos"] == D(30)

    def test_mesa_em_jogo_nao_pontua_os_vivos(self):
        r = R.resultado_da_mesa(_eliminados("a", "b"), ["c", "d", "e"])
        assert not r["terminada"] and r["tamanho"] == 5
        assert set(r["jogadores"]) == {"a", "b"}
        assert r["jogadores"]["b"]["posicao"] == 4

    def test_empate_de_dois_divide_os_pontos(self):
        # Mesa de 8: as posições 8 e 7 valem 5 + 10 → 7,5 para cada um.
        r = R.resultado_da_mesa(_eliminados("a", "b", "c", "d", "e", "f", "g", empates={"b"}), ["h"])
        assert r["jogadores"]["a"]["pontos"] == D("7.50") == r["jogadores"]["b"]["pontos"]
        assert r["jogadores"]["a"]["empate"] and r["jogadores"]["b"]["empate"]
        assert r["jogadores"]["a"]["posicao"] == 7  # dividem a melhor das duas
        assert r["jogadores"]["c"]["pontos"] == D(15)

    def test_empate_de_tres_divide_a_media(self):
        r = R.resultado_da_mesa(_eliminados("a", "b", "c", "d", empates={"c", "d"}), ["e"])
        # ordens 2, 3 e 4 → (10 + 15 + 20) / 3 = 15
        assert [r["jogadores"][k]["pontos"] for k in "bcd"] == [D(15)] * 3
        assert r["jogadores"]["a"]["pontos"] == D(5)
        assert r["jogadores"]["e"]["pontos"] == D(25)

    def test_ultimo_em_pe_eliminado_por_engano_ainda_faz_o_maximo(self):
        r = R.resultado_da_mesa(_eliminados("a", "b", "c"), [])
        assert r["terminada"]
        assert r["jogadores"]["c"] == {"ordem": 3, "posicao": 1, "pontos": D(15), "empate": False}

    def test_quem_sentou_atrasado_conta_no_tamanho(self):
        # 5 na mesa, um sentou depois de 2 eliminações: N = 6 de qualquer jeito.
        r = R.resultado_da_mesa(_eliminados("a", "b", "c", "d", "e"), ["atrasado"])
        assert r["jogadores"]["atrasado"]["pontos"] == D(30)


class TestResultadoManual:
    def test_posicoes_digitadas(self):
        r = R.resultado_manual({"a": 3, "b": 1, "c": 2})
        assert {k: v["pontos"] for k, v in r["jogadores"].items()} == {"a": D(5), "b": D(15), "c": D(10)}

    def test_posicoes_iguais_sao_empate(self):
        r = R.resultado_manual({"a": 3, "b": 3, "c": 1, "d": 2})
        # mesa de 4: posições 3 e 4 valem 10 e 5 → 7,5 cada
        assert r["jogadores"]["a"]["pontos"] == D("7.50") == r["jogadores"]["b"]["pontos"]
        assert r["jogadores"]["a"]["empate"]

    @pytest.mark.parametrize("posicoes", [{"a": 0, "b": 1}, {"a": 3, "b": 1}, {"a": 2, "b": 2}])
    def test_posicao_fora_da_mesa_e_recusada(self, posicoes):
        with pytest.raises(ErroDeNegocio) as e:
            R.resultado_manual(posicoes)
        assert e.value.code == "posicao_fora_da_mesa"


def _equipe(i, membros, capitao=None, rank=None):
    return {"id": i, "members": membros, "captain_player_id": capitao or membros[0], "tiebreak_rank": rank}


class TestRanking:
    def test_soma_dos_quatro_em_ordem_decrescente(self):
        pontos = {"a1": D(40), "a2": D(5), "b1": D(20), "b2": D(30)}
        r = R.ranking([_equipe("A", ["a1", "a2"]), _equipe("B", ["b1", "b2"])], pontos)
        assert [(l["team_id"], l["pontos"], l["rank"]) for l in r] == [("B", D(50), 1), ("A", D(45), 2)]
        assert not any(l["empatada"] for l in r)

    def test_desempate_pelo_capitao(self):
        pontos = {"a1": D(10), "a2": D(30), "b1": D(20), "b2": D(20)}
        r = R.ranking([_equipe("A", ["a1", "a2"]), _equipe("B", ["b1", "b2"])], pontos)
        assert [l["team_id"] for l in r] == ["B", "A"]  # capitão B 20 > capitão A 10

    def test_segundo_criterio_melhores_individuais(self):
        pontos = {"a1": D(10), "a2": D(40), "a3": D(0), "b1": D(10), "b2": D(25), "b3": D(15)}
        r = R.ranking([_equipe("B", ["b1", "b2", "b3"]), _equipe("A", ["a1", "a2", "a3"])], pontos)
        assert [l["team_id"] for l in r] == ["A", "B"]  # 40 > 25

    def test_segundo_criterio_manual(self):
        pontos = {"a1": D(10), "a2": D(40), "b1": D(10), "b2": D(40)}
        equipes = [_equipe("A", ["a1", "a2"], rank=2), _equipe("B", ["b1", "b2"], rank=1)]
        assert [l["team_id"] for l in R.ranking(equipes, pontos, "manual")] == ["B", "A"]

    def test_empate_nao_resolvido_divide_a_posicao(self):
        pontos = {"a1": D(10), "a2": D(40), "b1": D(10), "b2": D(40), "c1": D(1)}
        equipes = [_equipe("A", ["a1", "a2"]), _equipe("B", ["b1", "b2"]), _equipe("C", ["c1"])]
        r = R.ranking(equipes, pontos, "manual")
        assert [(l["rank"], l["empatada"]) for l in r] == [(1, True), (1, True), (3, False)]
        assert R.empate_na_linha_de_corte(r, 1)
        assert not R.empate_na_linha_de_corte(r, 2)

    def test_quem_nao_jogou_soma_zero(self):
        r = R.ranking([_equipe("A", ["a1", "a2"])], {})
        assert r[0]["pontos"] == D(0)


def _mesas(n, ocupados=None, capacidade=8, bloqueadas=None):
    ocupados = ocupados or {}
    return [{"id": f"m{i}", "table_number": i, "ocupados": ocupados.get(i, 0),
             "capacidade": capacidade - ocupados.get(i, 0) - (bloqueadas or {}).get(i, 0)}
            for i in range(1, n + 1)]


def _times(n, prefixo="e"):
    return [{"id": f"{prefixo}{j}", "a_sentar": [f"{prefixo}{j}-{k}" for k in range(4)], "proibidas": set()}
            for j in range(n)]


def _conferir(mesa_de, equipes, mesas, avulsos=()):
    assert len(mesa_de) == sum(len(e["a_sentar"]) for e in equipes) + len(avulsos)
    for e in equipes:
        usadas = [mesa_de[p] for p in e["a_sentar"]]
        assert len(set(usadas)) == len(usadas), "integrantes na mesma mesa"
        assert not set(usadas) & set(e["proibidas"]), "mesa com colega"
    tamanhos = Counter(mesa_de.values())
    base = {m["id"]: m["ocupados"] for m in mesas}
    finais = {t: base[t] + c for t, c in tamanhos.items()}
    assert max(finais.values()) <= 8
    assert max(finais.values()) - min(finais.values()) <= 1
    return finais


class TestSorteio:
    @pytest.mark.parametrize("semente", range(15))
    def test_9_equipes_em_8_mesas_dividem_as_mesas_grandes(self, semente):
        # 36 jogadores em 8 mesas daria mesas de 4 e 5 — mas o mínimo é 5 mesas
        # (até 8 por mesa): 8, 7, 7, 7, 7.
        equipes, mesas = _times(9), _mesas(8)
        mesa_de = R.distribuir_por_mesas(equipes, [], mesas, random.Random(semente))
        finais = _conferir(mesa_de, equipes, mesas)
        assert sorted(finais.values()) == [7, 7, 7, 7, 8]
        grandes = {t for t, n in finais.items() if n == 8}
        por_equipe = [sum(1 for p in e["a_sentar"] if mesa_de[p] in grandes) for e in equipes]
        assert max(por_equipe) - min(por_equipe) <= 1

    @pytest.mark.parametrize("equipes_n,mesas_n", [(6, 5), (10, 5), (4, 4), (5, 4), (8, 4)])
    def test_varios_tamanhos(self, equipes_n, mesas_n):
        for semente in range(8):
            equipes, mesas = _times(equipes_n), _mesas(mesas_n)
            mesa_de = R.distribuir_por_mesas(equipes, [], mesas, random.Random(semente))
            finais = _conferir(mesa_de, equipes, mesas)
            vagas = {t: n for t, n in finais.items()}
            if max(vagas.values()) != min(vagas.values()):
                grandes = {t for t, n in vagas.items() if n == max(vagas.values())}
                por_equipe = [sum(1 for p in e["a_sentar"] if mesa_de[p] in grandes) for e in equipes]
                assert max(por_equipe) - min(por_equipe) <= 1

    def test_usa_o_minimo_de_mesas(self):
        # 20 jogadores com 8 mesas criadas: 4 mesas de 5, não 8 mesas de 2 ou 3.
        equipes, mesas = _times(5), _mesas(8)
        finais = _conferir(R.distribuir_por_mesas(equipes, [], mesas, random.Random(1)), equipes, mesas)
        assert sorted(finais.values()) == [5, 5, 5, 5]

    def test_avulsos_completam_sem_restricao(self):
        equipes, mesas = _times(3), _mesas(4)
        avulsos = ["x1", "x2", "x3"]
        mesa_de = R.distribuir_por_mesas(equipes, avulsos, mesas, random.Random(3))
        finais = _conferir(mesa_de, equipes, mesas, avulsos)
        assert sum(finais.values()) == 15

    def test_respeita_lugares_bloqueados_e_ja_sentados(self):
        mesas = _mesas(4, ocupados={1: 2}, bloqueadas={2: 3})
        equipes = _times(4)
        equipes[0]["proibidas"] = {"m1"}  # um colega já está na mesa 1
        equipes[0]["a_sentar"] = equipes[0]["a_sentar"][:3]
        mesa_de = R.distribuir_por_mesas(equipes, [], mesas, random.Random(5))
        assert all(mesa_de[p] != "m1" for p in equipes[0]["a_sentar"])
        assert Counter(mesa_de.values())["m2"] <= 5  # 8 − 3 bloqueados

    def test_menos_de_4_mesas_e_recusado(self):
        with pytest.raises(ErroDeNegocio) as e:
            R.distribuir_por_mesas(_times(2), [], _mesas(3), random.Random(1))
        assert e.value.code == "mesas_insuficientes_para_equipes"
        assert e.value.dados["minimo"] == 4

    def test_sem_lugar_suficiente_e_recusado(self):
        with pytest.raises(ErroDeNegocio) as e:
            R.distribuir_por_mesas(_times(9), [], _mesas(4), random.Random(1))
        assert e.value.code == "mesas_sem_lugar_para_equipes"
        assert e.value.dados["faltam"] == 4

    def test_ninguem_para_sentar(self):
        assert R.distribuir_por_mesas([], [], _mesas(4), random.Random(1)) == {}


class TestTamanhosAlvo:
    def test_equilibra_com_quem_ja_esta_sentado(self):
        cota = R.tamanhos_alvo(_mesas(3, ocupados={1: 4}), 8)
        assert cota == {"m1": 0, "m2": 4, "m3": 4}

    def test_mesas_minimas(self):
        assert R.mesas_minimas(36) == 5
        assert R.mesas_minimas(12) == 4
        assert R.mesas_minimas(0) == 0


class TestRevezamento:
    def test_a_cada_nivel_entra_o_proximo(self):
        assert [R.membro_da_vez(4, n) for n in range(1, 10)] == [0, 1, 2, 3, 0, 1, 2, 3, 0]

    def test_antes_do_inicio_joga_o_primeiro(self):
        assert R.membro_da_vez(4, None) == 0
        assert R.membro_da_vez(4, 0) == 0

    def test_nivel_inicial_diferente(self):
        assert R.membro_da_vez(4, 5, nivel_inicial=5) == 0
        assert R.membro_da_vez(4, 7, nivel_inicial=5) == 2

    def test_equipe_desfalcada(self):
        assert [R.membro_da_vez(3, n) for n in range(1, 5)] == [0, 1, 2, 0]
