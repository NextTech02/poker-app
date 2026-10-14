"""Regras de dinheiro da premiação por eliminação (funções puras).

O que importa aqui é que NENHUM centavo some nem sobra: a parte KO de cada
venda, a divisão do bounty (PKO 50/50, KO fixo 100%, pote dividido) e o
bounty de cada jogador, derivado do livro, fecham sempre com o pozo KO.
"""
from decimal import Decimal

import pytest

from app.services import ko_regras as R
from app.utils.erros import ErroDeNegocio

D = Decimal


def _torneio(formato="pko", pct=40, share=50, **extra):
    return {"ko_format": formato, "ko_percentage": pct, "ko_cash_share": share, **extra}


class TestParteKoDaVenda:
    def test_exemplo_do_clube(self):
        # A porcentagem vale sobre o VALOR da entrada: 40% de 200 = 80 (os 36
        # de rake saem do resto; ficam 84 para as posições).
        assert R.parte_ko_da_venda(_torneio(), 200, 36) == D("80.00")

    def test_mystery_do_nsop_40_por_cento_do_buy_in(self):
        # Buy-in de S/ 600 com rake de 18% (108): 40% do buy-in = S/ 240.
        assert R.parte_ko_da_venda(_torneio("mystery"), 600, 108) == D("240.00")

    def test_nunca_passa_do_liquido(self):
        # 90% de 200 = 180, mas só 164 entraram no pozo (200 − 36 de rake).
        assert R.parte_ko_da_venda(_torneio(pct=90), 200, 36) == D("164.00")

    def test_torneio_sem_ko_nao_separa_nada(self):
        assert R.parte_ko_da_venda({"ko_format": "none", "ko_percentage": 40}, 200, 36) == D("0")
        assert R.parte_ko_da_venda({}, 200, 36) == D("0")

    def test_bonus_dealer_com_rake_100_nao_tem_parte_ko(self):
        assert R.parte_ko_da_venda(_torneio(), 20, 20) == D("0")

    def test_entrada_por_ticket_vale_zero(self):
        assert R.parte_ko_da_venda(_torneio(), 0, 0) == D("0")

    def test_fase_mystery_iniciada_congela_o_pozo(self):
        t = _torneio("mystery", mystery_started_at="2026-10-14T00:00:00Z")
        assert R.parte_ko_da_venda(t, 200, 36) == D("0")

    def test_bounties_encerrados_nao_recebem_mais(self):
        assert R.parte_ko_da_venda(_torneio(ko_closed_at="2026-10-14T00:00:00Z"), 200, 36) == D("0")

    def test_arredonda_meio_para_cima(self):
        # 33,33 × 50% = 16,665 → 16,67
        assert R.parte_ko_da_venda(_torneio(pct=50), D("33.33"), 0) == D("16.67")


class TestDividirBounty:
    def test_pko_metade_em_dinheiro_metade_no_bounty(self):
        [p] = R.dividir_bounty(D("65.60"), 50, ["b"])
        assert (p["cash_amount"], p["added_to_bounty"]) == (D("32.80"), D("32.80"))

    def test_ko_fixo_tudo_em_dinheiro(self):
        [p] = R.dividir_bounty(D("65.60"), 100, ["b"])
        assert (p["cash_amount"], p["added_to_bounty"]) == (D("65.60"), D("0.00"))

    def test_centavo_impar_vai_para_o_dinheiro(self):
        [p] = R.dividir_bounty(D("0.03"), 50, ["b"])
        assert p["cash_amount"] + p["added_to_bounty"] == D("0.03")
        assert p["cash_amount"] == D("0.02")

    def test_pote_dividido_reparte_ao_centavo_sem_perder_nada(self):
        partes = R.dividir_bounty(D("100.00"), 50, ["c", "a", "b"])
        assert [p["eliminator_tp_id"] for p in partes] == ["a", "b", "c"]  # ordem determinística
        assert sum(p["cash_amount"] for p in partes) == D("50.00")
        assert sum(p["added_to_bounty"] for p in partes) == D("50.00")
        # 50,00 / 3 = 16,66 e sobram 2 centavos: vão aos dois primeiros ids.
        assert [p["cash_amount"] for p in partes] == [D("16.67"), D("16.67"), D("16.66")]

    def test_sem_eliminador_nao_divide(self):
        assert R.dividir_bounty(D("50"), 50, []) == []

    def test_eliminador_repetido_conta_uma_vez(self):
        assert len(R.dividir_bounty(D("50"), 50, ["a", "a"])) == 1


class TestBountiesDerivados:
    def _venda(self, tp, valor, status="active", tipo="buy_in"):
        return {"tournament_player_id": tp, "bounty_amount": valor, "status": status, "type": tipo}

    def test_vendas_somam_e_cancelada_nao(self):
        saldos = R.bounties_derivados(
            [self._venda("a", 50), self._venda("a", 20, tipo="addon"), self._venda("a", 99, status="cancelled")],
            [], [],
        )
        assert saldos["a"] == D("70.00")

    def test_quem_cai_perde_e_quem_elimina_soma_a_metade(self):
        vendas = [self._venda("a", 50), self._venda("b", 50)]
        kos = [{"id": "k1", "eliminated_tp_id": "a", "bounty_value": 50, "status": "active", "kind": "elimination"}]
        pagos = [{"knockout_id": "k1", "eliminator_tp_id": "b", "cash_amount": 25, "added_to_bounty": 25}]
        saldos = R.bounties_derivados(vendas, kos, pagos)
        assert saldos == {"a": D("0.00"), "b": D("75.00")}

    def test_ko_desfeito_devolve_tudo(self):
        vendas = [self._venda("a", 50), self._venda("b", 50)]
        kos = [{"id": "k1", "eliminated_tp_id": "a", "bounty_value": 50, "status": "undone", "kind": "elimination"}]
        pagos = [{"knockout_id": "k1", "eliminator_tp_id": "b", "cash_amount": 25, "added_to_bounty": 25}]
        assert R.bounties_derivados(vendas, kos, pagos) == {"a": D("50.00"), "b": D("50.00")}

    def test_reentrada_traz_bounty_novo(self):
        vendas = [self._venda("a", 50), self._venda("a", 50, tipo="rebuy"), self._venda("b", 50)]
        kos = [{"id": "k1", "eliminated_tp_id": "a", "bounty_value": 50, "status": "active", "kind": "elimination"}]
        pagos = [{"knockout_id": "k1", "eliminator_tp_id": "b", "cash_amount": 25, "added_to_bounty": 25}]
        assert R.bounties_derivados(vendas, kos, pagos)["a"] == D("50.00")

    def test_sem_autor_vai_para_o_bolo_do_campeao(self):
        kos = [
            {"id": "k1", "kind": "elimination", "format": "pko", "status": "active", "bounty_value": 40},
            {"id": "k2", "kind": "elimination", "format": "pko", "status": "active", "bounty_value": 10},
        ]
        pagos = [{"knockout_id": "k2", "eliminator_tp_id": "b", "added_to_bounty": 5}]
        assert R.sem_autor(kos, pagos) == D("40.00")


class TestEnvelopes:
    def test_um_por_jogador_somando_o_pozo(self):
        valores = R.validar_envelopes(
            [{"value": 500, "quantity": 2}, {"value": 100, "quantity": 3}], jogadores=5, pozo=1300,
        )
        assert sorted(valores) == [D("100.00")] * 3 + [D("500.00")] * 2

    def test_quantidade_diferente_dos_vivos_e_recusada(self):
        with pytest.raises(ErroDeNegocio) as e:
            R.validar_envelopes([{"value": 100, "quantity": 3}], jogadores=5, pozo=300)
        assert e.value.code == "envelopes_quantidade_errada"
        assert e.value.dados == {"esperado": 5, "informado": 3}

    def test_soma_diferente_do_pozo_e_recusada(self):
        with pytest.raises(ErroDeNegocio) as e:
            R.validar_envelopes([{"value": 100, "quantity": 5}], jogadores=5, pozo=600)
        assert e.value.code == "envelopes_soma_errada"

    @pytest.mark.parametrize("linha", [{"value": 0, "quantity": 1}, {"value": 10, "quantity": 0}])
    def test_valor_ou_quantidade_invalidos(self, linha):
        with pytest.raises(ErroDeNegocio) as e:
            R.validar_envelopes([linha], jogadores=1, pozo=10)
        assert e.value.code == "envelope_invalido"
