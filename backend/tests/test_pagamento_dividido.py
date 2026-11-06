"""PAGAMENTO DIVIDIDO ("pago mixto") — o que o Python garante.

Pedido do cliente: entrada de 500 paga com 300 em dinheiro + 200 em
transferência. A venda continua sendo UMA linha por item (relatórios, bolsa,
fichas e estorno contam linhas); as partes moram na linha, em `payment_split`,
com `payment_method = 'split'`.

O CHECK que confere as partes no banco e a soma por meio da RPC são testados
num Postgres de verdade (db/tests/pagamento_dividido). Aqui ficam travados:
1. **As partes fecham o valor calculado no servidor**, fundidas por meio; uma
   parte só vira venda simples.
2. **Crédito, ticket e fiado nunca dividem**, nem prêmio.
3. **Recusa ANTES de qualquer escrita**: nem inscrição, nem contador, nem
   cadeira ficam pela metade.
4. **Venda simples não cita a coluna nova** (deploy antes da migração), e a
   venda dividida sem a coluna é recusada com nome.
5. **Todo agregado por meio soma as partes** (conferência da etapa, dia do cash).
"""
from decimal import Decimal

import pytest

from app.models.cash_game import CashRebuy
from app.models.pagamento import PaymentLeg
from app.services import pagamento_dividido as pd
from app.services.cash_day_service import CashDayService
from app.services.cash_register_service import CashRegisterService
from app.services.cash_transaction_service import CashTransactionService as CTS
from app.services.sync_service import SyncService
from app.services.tournament_player_service import TournamentPlayerService as TPS
from app.services.transaction_service import TransactionService
from app.utils.erros import ErroDeNegocio

from tests import test_fiado as cash
from tests import test_tournament_players as torneio
from tests.test_cash_register import STAGE, _fake as _fake_etapa, _mundo
from tests.test_transactions import _cenario as _cenario_venda, _venda


def recusa(exc):
    return exc.value.como_http().detail


def P(metodo, valor):
    return PaymentLeg(payment_method=metodo, amount=valor)


TRANSFER_300_200 = [P("cash", 300), P("transfer", 200)]


# ══════════════════════════════════════════════════════════════════════
# A regra
# ══════════════════════════════════════════════════════════════════════

class TestResolver:
    def test_sem_partes_nada_muda(self):
        assert pd.resolver("pix", None, 500) == ("pix", None)
        assert pd.resolver(None, [], 500) == (None, None)

    def test_300_dinheiro_mais_200_transferencia(self):
        metodo, partes = pd.resolver("cash", TRANSFER_300_200, 500, "cash")
        assert metodo == "split"
        assert partes == [
            {"payment_method": "cash", "amount": 300.0},
            {"payment_method": "transfer", "amount": 200.0},
        ]

    def test_partes_do_mesmo_meio_sao_somadas(self):
        _, partes = pd.resolver("cash", [P("cash", 200), P("pix", 200), P("cash", 100)], 500)
        assert partes == [
            {"payment_method": "cash", "amount": 300.0},
            {"payment_method": "pix", "amount": 200.0},
        ]

    def test_uma_parte_so_vira_venda_simples(self):
        assert pd.resolver("pix", [P("yape", 250), P("yape", 250)], 500) == ("yape", None)

    def test_centavos_fecham_sem_erro_de_arredondamento(self):
        _, partes = pd.resolver("cash", [P("cash", 0.1), P("pix", 0.2)], 0.3)
        assert [p["amount"] for p in partes] == [0.1, 0.2]

    def test_aceita_partes_como_dict(self):
        metodo, _ = pd.resolver(
            "cash", [{"payment_method": "cash", "amount": 300}, {"payment_method": "pix", "amount": 200}], 500
        )
        assert metodo == "split"

    def test_soma_diferente_do_valor_recusa_com_os_numeros(self):
        with pytest.raises(ErroDeNegocio) as e:
            pd.resolver("cash", [P("cash", 300), P("pix", 150)], 500)
        assert e.value.status == 409
        assert recusa(e) == {
            "code": "pagamento_dividido_nao_fecha",
            "message": "As partes do pagamento não somam o valor da venda.",
            "valor": 500.0, "soma": 450.0,
        }

    def test_split_sem_partes_recusa(self):
        with pytest.raises(ErroDeNegocio) as e:
            pd.resolver("split", None, 500)
        assert e.value.code == "pagamento_dividido_sem_partes"

    @pytest.mark.parametrize("fonte,codigo", [
        ("credit", "pagamento_dividido_com_credito"),
        ("mixed", "pagamento_dividido_com_credito"),
        ("ticket", "pagamento_dividido_com_credito"),
        ("house_credit", "pagamento_dividido_com_fiado"),
    ])
    def test_credito_ticket_e_fiado_nao_dividem(self, fonte, codigo):
        with pytest.raises(ErroDeNegocio) as e:
            pd.resolver("cash", TRANSFER_300_200, 500, fonte)
        assert e.value.code == codigo

    @pytest.mark.parametrize("meio", ["split", "credit", "house_credit", "ticket", "  "])
    def test_meio_que_nao_e_dinheiro_recusa(self, meio):
        with pytest.raises(ErroDeNegocio) as e:
            pd.resolver("cash", [{"payment_method": meio, "amount": 300}, P("pix", 200)], 500)
        assert e.value.code == "pagamento_dividido_meio_invalido"

    def test_mais_de_duas_casas_recusa_em_vez_de_arredondar(self):
        with pytest.raises(ErroDeNegocio) as e:
            pd.resolver("cash", [P("cash", 300.005), P("pix", 199.995)], 500)
        assert e.value.code == "pagamento_dividido_invalido"


class TestLeituraDasPartes:
    def test_linha_simples_e_uma_parte(self):
        assert pd.pernas_da_linha({"payment_method": "pix", "amount": 100}) == [("pix", Decimal("100"))]

    def test_linha_dividida_devolve_as_partes(self):
        linha = {"payment_method": "split", "amount": 500, "payment_split": [
            {"payment_method": "cash", "amount": 300}, {"payment_method": "transfer", "amount": 200}]}
        assert pd.pernas_da_linha(linha) == [("cash", Decimal("300")), ("transfer", Decimal("200"))]

    def test_partes_em_texto_json_tambem(self):
        linha = {"payment_method": "split", "amount": 500,
                 "payment_split": '[{"payment_method":"cash","amount":300},{"payment_method":"pix","amount":200}]'}
        assert [m for m, _ in pd.pernas_da_linha(linha)] == ["cash", "pix"]

    def test_somar_por_meio_soma_partes_e_poe_o_maior_primeiro(self):
        linhas = [
            {"payment_method": "cash", "amount": 100},
            {"payment_method": "split", "amount": 500, "payment_split": [
                {"payment_method": "cash", "amount": 300}, {"payment_method": "transfer", "amount": 200}]},
            {"payment_method": None, "amount": 20},
        ]
        assert pd.somar_por_meio(linhas) == [
            ("cash", Decimal("400"), 2), ("transfer", Decimal("200"), 1), (None, Decimal("20"), 1),
        ]


class _BancoSemAColuna:
    """PostgREST de um banco que ainda não recebeu a migração."""

    def table(self, _nome):
        return self

    def select(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        raise Exception("{'code': 'PGRST204', 'message': \"Could not find the 'payment_split' column\"}")


# ══════════════════════════════════════════════════════════════════════
# Torneio
# ══════════════════════════════════════════════════════════════════════

class TestInscricaoDividida:
    def test_grava_split_com_as_partes_na_linha_da_entrada(self, monkeypatch):
        fake = torneio._monta(monkeypatch, dia=torneio._dia(buy_in=500))
        TPS.register_player(torneio._inscricao(payment_method="cash", payment_split=TRANSFER_300_200), "u1")
        [venda] = fake.store["transactions"]
        assert venda["payment_method"] == "split"
        assert venda["payment_split"] == [
            {"payment_method": "cash", "amount": 300.0}, {"payment_method": "transfer", "amount": 200.0}]
        assert float(venda["amount"]) == 500.0
        assert len(fake.store["tournament_players"]) == 1

    def test_partes_que_nao_fecham_nao_deixam_inscrito(self, monkeypatch):
        fake = torneio._monta(monkeypatch, dia=torneio._dia(buy_in=500))
        with pytest.raises(ErroDeNegocio) as e:
            TPS.register_player(torneio._inscricao(payment_split=[P("cash", 300), P("pix", 100)]), "u1")
        assert e.value.code == "pagamento_dividido_nao_fecha"
        assert fake.store["tournament_players"] == []
        assert fake.store["transactions"] == []

    def test_credito_dividido_recusa_antes_de_inscrever(self, monkeypatch):
        fake = torneio._monta(monkeypatch, dia=torneio._dia(buy_in=500))
        with pytest.raises(ErroDeNegocio):
            TPS.register_player(
                torneio._inscricao(payment_source="credit", payment_split=TRANSFER_300_200), "u1")
        assert fake.store["tournament_players"] == []

    def test_venda_simples_nao_cita_a_coluna_nova(self, monkeypatch):
        fake = torneio._monta(monkeypatch)
        TPS.register_player(torneio._inscricao(payment_method="pix"), "u1")
        [venda] = fake.store["transactions"]
        assert venda["payment_method"] == "pix"
        assert "payment_split" not in venda

    def test_sem_a_migracao_a_dividida_e_recusada_antes_de_inscrever(self, monkeypatch):
        fake = torneio._monta(monkeypatch, dia=torneio._dia(buy_in=500))
        monkeypatch.setattr(pd, "supabase", _BancoSemAColuna())
        with pytest.raises(ErroDeNegocio) as e:
            TPS.register_player(torneio._inscricao(payment_split=TRANSFER_300_200), "u1")
        assert e.value.code == "pagamento_dividido_indisponivel"
        assert fake.store["tournament_players"] == []

    def test_sem_a_migracao_a_simples_segue(self, monkeypatch):
        fake = torneio._monta(monkeypatch)
        monkeypatch.setattr(pd, "supabase", _BancoSemAColuna())
        TPS.register_player(torneio._inscricao(payment_method="cash"), "u1")
        assert len(fake.store["transactions"]) == 1


def _meio(id_, categoria):
    return {"id": id_, "tournament_id": torneio.TOUR, "name": id_, "category": categoria,
            "amount": 100, "rake_percentage": 20, "chips": 10000, "active": True}


class TestReentradaEAddonDivididos:
    def _jogador(self, monkeypatch):
        fake = torneio.TestRebuyEAddon._com_jogador(self, monkeypatch)
        # O meio de entrada manda no preço: 100 na reentrada e no add-on.
        fake.store["buy_types"] += [_meio("bt-rebuy", "rebuy"), _meio("bt-addon", "addon")]
        return fake

    def test_reentrada_dividida(self, monkeypatch):
        fake = self._jogador(monkeypatch)
        TPS.add_rebuy(torneio.TP, "u1", skip_level_gate=True, buy_type_id="bt-rebuy",
                      payment_split=[P("cash", 60), P("yape", 40)])
        [venda] = [t for t in fake.store["transactions"] if t["type"] == "rebuy"]
        assert venda["payment_method"] == "split"
        assert [p["amount"] for p in venda["payment_split"]] == [60.0, 40.0]

    def test_reentrada_que_nao_fecha_nao_mexe_no_jogador(self, monkeypatch):
        fake = self._jogador(monkeypatch)
        with pytest.raises(ErroDeNegocio):
            TPS.add_rebuy(torneio.TP, "u1", skip_level_gate=True, buy_type_id="bt-rebuy",
                          payment_split=[P("cash", 60), P("yape", 30)])
        assert fake.store["tournament_players"][0]["rebuy_count"] == 0
        assert fake.store["transactions"] == []

    def test_lote_antigo_nao_divide(self, monkeypatch):
        fake = self._jogador(monkeypatch)
        with pytest.raises(ErroDeNegocio) as e:
            TPS.add_rebuy(torneio.TP, "u1", skip_level_gate=True, quantity=2, buy_type_id="bt-rebuy",
                          payment_split=[P("cash", 100), P("yape", 100)])
        assert e.value.code == "pagamento_dividido_com_quantidade"
        assert fake.store["tournament_players"][0]["rebuy_count"] == 0

    def test_addon_dividido(self, monkeypatch):
        fake = self._jogador(monkeypatch)
        TPS.add_addon(torneio.TP, "u1", buy_type_id="bt-addon",
                      payment_split=[P("transfer", 70), P("cash", 30)])
        [venda] = fake.store["transactions"]
        assert venda["payment_method"] == "split"
        assert venda["payment_split"][0] == {"payment_method": "transfer", "amount": 70.0}

    def test_addon_que_nao_fecha_nao_soma_no_jogador(self, monkeypatch):
        fake = self._jogador(monkeypatch)
        with pytest.raises(ErroDeNegocio):
            TPS.add_addon(torneio.TP, "u1", buy_type_id="bt-addon",
                          payment_split=[P("transfer", 70), P("cash", 20)])
        assert fake.store["tournament_players"][0]["addon_count"] == 0


class TestRotas:
    @pytest.mark.parametrize("acao,metodo", [("rebuy", "add_rebuy"), ("addon", "add_addon")])
    def test_as_partes_do_corpo_chegam_ao_servico(self, client, stub, acao, metodo):
        from tests.test_router_core import TP, _inscricao
        recebidos = {}

        def _acao(tpid, uid, **kwargs):
            recebidos["partes"] = kwargs.get("payment_split")
            return _inscricao()

        stub(TPS, **{metodo: _acao})
        r = client.post(
            f"/tournament-players/{TP}/{acao}?payment_method=cash",
            json={"tournament_player_id": TP, "payment_method": "cash",
                  "payment_split": [{"payment_method": "cash", "amount": 300},
                                    {"payment_method": "transfer", "amount": 200}]},
        )
        assert r.status_code == 200
        assert [p.payment_method for p in recebidos["partes"]] == ["cash", "transfer"]

    @pytest.mark.parametrize("acao,metodo", [("rebuy", "add_rebuy"), ("addon", "add_addon")])
    def test_o_corpo_antigo_do_caixa_continua_aceito(self, client, stub, acao, metodo):
        """O Caixa de hoje manda um corpo com os mesmos campos dos parâmetros."""
        from tests.test_router_core import TP, _inscricao
        recebidos = {}

        def _acao(tpid, uid, **kwargs):
            recebidos["partes"] = kwargs.get("payment_split")
            return _inscricao()

        stub(TPS, **{metodo: _acao})
        r = client.post(f"/tournament-players/{TP}/{acao}",
                        json={"tournament_player_id": TP, "payment_method": "pix",
                              "client_mutation_id": "cm-1"})
        assert r.status_code == 200
        assert recebidos["partes"] is None


class TestTrocarPagamento:
    def test_divide_uma_venda_ja_registrada(self, monkeypatch):
        fake = _cenario_venda(monkeypatch)  # venda de 100 em dinheiro
        r = TransactionService.update_payment_method("tx-1", "cash", payment_split=[P("cash", 60), P("pix", 40)])
        linha = fake.store["transactions"][0]
        assert linha["payment_method"] == "split"
        assert linha["payment_split"][1] == {"payment_method": "pix", "amount": 40.0}
        assert float(linha["amount"]) == 100.0
        assert r.payment_split[0].payment_method == "cash"

    def test_voltar_para_um_meio_limpa_as_partes(self, monkeypatch):
        fake = _cenario_venda(monkeypatch, venda=_venda(
            payment_method="split",
            payment_split=[{"payment_method": "cash", "amount": 60}, {"payment_method": "pix", "amount": 40}]))
        TransactionService.update_payment_method("tx-1", "pix")
        linha = fake.store["transactions"][0]
        assert linha["payment_method"] == "pix"
        assert linha["payment_split"] is None

    def test_banco_sem_a_coluna_troca_simples_sem_cita_la(self, monkeypatch):
        fake = _cenario_venda(monkeypatch)
        TransactionService.update_payment_method("tx-1", "pix")
        assert "payment_split" not in fake.store["transactions"][0]

    def test_partes_conferidas_contra_o_valor_da_linha(self, monkeypatch):
        fake = _cenario_venda(monkeypatch)
        with pytest.raises(ErroDeNegocio) as e:
            TransactionService.update_payment_method("tx-1", "cash", payment_split=[P("cash", 60), P("pix", 60)])
        assert e.value.code == "pagamento_dividido_nao_fecha"
        assert fake.store["transactions"][0]["payment_method"] == "cash"

    def test_premio_nao_divide(self, monkeypatch):
        _cenario_venda(monkeypatch, venda=_venda(tipo="prize"))
        with pytest.raises(ErroDeNegocio) as e:
            TransactionService.update_payment_method("tx-1", "cash", payment_split=[P("cash", 60), P("pix", 40)])
        assert e.value.code == "pagamento_dividido_so_em_venda"


class TestConferenciaDaEtapa:
    def test_o_caminho_reserva_soma_as_partes(self, monkeypatch):
        _fake_etapa(monkeypatch, _mundo(transacoes=[
            {"id": "x1", "tournament_id": "t1", "type": "buy_in", "amount": "100.00", "payment_method": "cash"},
            {"id": "x2", "tournament_id": "t1", "type": "buy_in", "amount": "500.00", "payment_method": "split",
             "payment_split": [{"payment_method": "cash", "amount": 300},
                               {"payment_method": "transfer", "amount": 200}]},
        ]))
        r = CashRegisterService.get_stage_totals_by_payment_method(STAGE)
        por_meio = {m.code: m for m in r.methods}
        assert por_meio["cash"].total == Decimal("400")
        assert por_meio["transfer"].total == Decimal("200")
        assert "split" not in por_meio
        assert r.total == Decimal("600")


class TestSincronismo:
    @pytest.mark.parametrize("kind,metodo", [("rebuy", "add_rebuy"), ("addon", "add_addon")])
    def test_a_fila_offline_repassa_as_partes(self, monkeypatch, kind, metodo):
        from tests.test_sync import ORG, TP, _monta, _op
        _monta(monkeypatch)
        recebidos = {}
        monkeypatch.setattr(TPS, metodo, staticmethod(lambda *a, **k: recebidos.update(k)))
        partes = [{"payment_method": "cash", "amount": 60}, {"payment_method": "pix", "amount": 40}]
        SyncService.apply_op(_op(kind, "cm-9", {"tournament_player_id": TP, "payment_split": partes}), "u1", ORG)
        assert recebidos["payment_split"] == partes

    def test_fila_antiga_sem_partes(self, monkeypatch):
        from tests.test_sync import ORG, TP, _monta, _op
        _monta(monkeypatch)
        recebidos = {}
        monkeypatch.setattr(TPS, "add_addon", staticmethod(lambda *a, **k: recebidos.update(k)))
        SyncService.apply_op(_op("addon", "cm-8", {"tournament_player_id": TP}), "u1", ORG)
        assert recebidos["payment_split"] is None


# ══════════════════════════════════════════════════════════════════════
# Cash game
# ══════════════════════════════════════════════════════════════════════

class TestCashDividido:
    def test_sentar_com_pagamento_dividido(self, monkeypatch):
        fake = cash._banco(monkeypatch)
        CTS.sit(cash.MESA, 3, cash._sit(1000, fonte=None, payment_split=[P("cash", 600), P("transfer", 400)]),
                cash.AUTH, cash.ORG)
        [venda] = fake.store["cash_transactions"]
        assert venda["payment_method"] == "split"
        assert venda["payment_split"] == [
            {"payment_method": "cash", "amount": 600.0}, {"payment_method": "transfer", "amount": 400.0}]
        # A gaveta recebe o valor cheio, como hoje.
        assert venda["cashbox_id"] == cash.CAIXA

    def test_partes_que_nao_fecham_nao_tomam_a_cadeira(self, monkeypatch):
        fake = cash._banco(monkeypatch)
        with pytest.raises(ErroDeNegocio) as e:
            CTS.sit(cash.MESA, 3, cash._sit(1000, fonte=None, payment_split=[P("cash", 600), P("pix", 300)]),
                    cash.AUTH, cash.ORG)
        assert e.value.code == "pagamento_dividido_nao_fecha"
        assert fake.store["cash_player_sessions"] == []
        assert next(a for a in fake.store["cash_seats"] if a["seat_number"] == 3)["status"] == "free"

    def test_fiado_nao_divide(self, monkeypatch):
        fake = cash._banco(monkeypatch, house_credit_accounts=[cash._conta()])
        with pytest.raises(ErroDeNegocio) as e:
            CTS.sit(cash.MESA, 3, cash._sit(300, payment_split=[P("cash", 100), P("pix", 200)]),
                    cash.AUTH, cash.ORG)
        assert e.value.code == "pagamento_dividido_com_fiado"
        assert fake.store["cash_player_sessions"] == []

    def test_recompra_dividida(self, monkeypatch):
        fake = cash._banco(monkeypatch, cash_player_sessions=[cash._sessao()])
        CTS.rebuy("s1", CashRebuy(amount=500, payment_method="cash",
                                  payment_split=[P("cash", 200), P("yape", 300)]), cash.AUTH, cash.ORG)
        [venda] = fake.store["cash_transactions"]
        assert venda["payment_method"] == "split"
        assert venda["type"] == "rebuy"

    def test_venda_simples_do_cash_nao_cita_a_coluna(self, monkeypatch):
        fake = cash._banco(monkeypatch)
        CTS.sit(cash.MESA, 3, cash._sit(300, fonte=None), cash.AUTH, cash.ORG)
        assert "payment_split" not in fake.store["cash_transactions"][0]

    def test_resumo_do_dia_por_meio_soma_as_partes_e_deixa_o_fiado_fora(self, monkeypatch):
        linhas = [
            {"id": "c1", "cash_day_id": cash.DIA, "type": "buy_in", "amount": 1000, "status": "active",
             "payment_method": "split", "payment_source": "cash",
             "payment_split": [{"payment_method": "cash", "amount": 600},
                               {"payment_method": "transfer", "amount": 400}]},
            {"id": "c2", "cash_day_id": cash.DIA, "type": "rebuy", "amount": 200, "status": "active",
             "payment_method": "cash", "payment_source": None},
            {"id": "c3", "cash_day_id": cash.DIA, "type": "buy_in", "amount": 300, "status": "active",
             "payment_method": None, "payment_source": "house_credit"},
            {"id": "c4", "cash_day_id": cash.DIA, "type": "buy_in", "amount": 999, "status": "cancelled",
             "payment_method": "cash", "payment_source": None},
            {"id": "c5", "cash_day_id": cash.DIA, "type": "cash_out", "amount": 500, "status": "active",
             "payment_method": "cash", "payment_source": None},
        ]
        cash._banco(monkeypatch, cash_transactions=linhas)
        r = CashDayService.summary(cash.DIA)
        assert r.buy_ins_by_method == [
            {"code": "cash", "total": 800.0, "count": 2},
            {"code": "transfer", "total": 400.0, "count": 1},
        ]
        assert r.total_buy_ins == 1500.0  # o fiado continua contando como fichas
