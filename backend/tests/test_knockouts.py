"""Premiação por eliminação (KO fixo e PKO) de ponta a ponta no serviço.

Cada venda congela a sua parte KO; a eliminação registra QUEM eliminou e o
prêmio; o caixa paga do caixa geral; o encerramento entrega o resto. A conta
que fecha tudo: depois do encerramento, o pago em KO é exatamente o pozo KO.
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.services import knockout_service, prize_allocation_service, sales_block_service, tournament_player_service
from app.services.cash_register_service import CashRegisterService
from app.services.cashbox_service import CashboxService
from app.services.knockout_service import KnockoutService as K
from app.services.prize_allocation_service import PrizeAllocationService as P
from app.services.tournament_player_service import TournamentPlayerService as TPS
from app.models.tournament_player import TournamentPlayerCreate
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase

D = Decimal
ORG = "33333333-3333-3333-3333-333333333333"
TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
JOGADORES = {f"tp{i}": f"p{i}" for i in range(1, 6)}


def _torneio(formato="pko", pct=40, share=50, **extra):
    return {
        "id": TOUR, "name": "Torneio KO", "organization_id": ORG, "stage_id": "st1",
        "elimination_mode": "table", "has_qualifying": False,
        "ko_format": formato, "ko_percentage": pct, "ko_cash_share": share,
        "ko_closed_at": None, "mystery_started_at": None, "mystery_pool": None,
        "guaranteed_prize": 0, "reserved_prize_percentage": 0, **extra,
    }


def _dia():
    return {
        "id": DIA, "tournament_id": TOUR, "buy_in": 200, "rake_percentage": 18,
        "starting_chips": 25000, "rebuy_amount": 200, "rebuy_chips": 25000,
        "addon_amount": 200, "addon_chips": 40000, "max_players": None,
        "registered_players": 0, "eliminations_count": 0, "day_type": "regular",
        "created_at": "2026-10-14T00:00:00Z",
    }


def _tp(tp_id, status="active", torneio=None):
    return {
        "id": tp_id, "tournament_id": TOUR, "tournament_day_id": DIA,
        "player_id": JOGADORES.get(tp_id, tp_id), "status": status,
        "rebuy_count": 0, "addon_count": 0, "buy_in_count": 1, "total_chips": 25000,
        "total_spent": 200, "total_buy_in_amount": 200, "total_rebuy_amount": 0,
        "total_addon_amount": 0, "created_at": "2026-10-14T00:00:00Z",
        "registered_at": "2026-10-14T00:00:00Z",
        # Embeds que o PostgREST devolve na leitura da venda.
        "tournament_days": _dia(),
        "tournaments": {**(torneio or _torneio()), "stages": {"sales_blocked": False}},
    }


def _venda(tp_id, bounty, tipo="buy_in", quando="2026-01-01T01:00:00Z", vid=None, status="active"):
    return {
        "id": vid or f"v-{tp_id}-{tipo}-{bounty}", "tournament_id": TOUR, "tournament_player_id": tp_id,
        "player_id": JOGADORES.get(tp_id, tp_id), "type": tipo, "amount": 200, "rake_amount": 36,
        "bounty_amount": bounty, "status": status, "created_at": quando,
    }


@pytest.fixture
def cenario(monkeypatch):
    """Monta o torneio; devolve (fake, saldo do caixa geral)."""
    def montar(torneio=None, inscritos=None, vendas=None, saldo=10000, tabelas=None):
        t = torneio or _torneio()
        base = {
            "tournaments": [t],
            "tournament_days": [_dia()],
            "tournament_players": inscritos if inscritos is not None else [_tp(f"tp{i}", torneio=t) for i in range(1, 5)],
            "players": [{"id": p, "name": f"Jogador {p[-1]}"} for p in JOGADORES.values()],
            "transactions": vendas if vendas is not None else [_venda(f"tp{i}", 50) for i in range(1, 5)],
            "seat_allocations": [], "buy_types": [], "prize_allocations": [],
            "tournament_knockouts": [], "tournament_knockout_payouts": [], "tournament_mystery_envelopes": [],
            "general_cash_register": [{"id": "gc1", "current_balance": saldo}],
        }
        base.update(tabelas or {})
        fake = FakeSupabase(base)
        fake.rpcs.update({
            "consumir_eliminacao": True, "desfazer_eliminacoes": 0, "recontar_eliminacoes": 0,
            "registrar_eliminacao": 0,
        })
        caixa = {"saldo": D(str(saldo))}

        def debitar(params):
            valor = D(str(params["p_amount"]))
            if caixa["saldo"] < valor:
                return None
            caixa["saldo"] -= valor
            return float(caixa["saldo"])

        def creditar(params):
            caixa["saldo"] += D(str(params["p_amount"]))
            return float(caixa["saldo"])

        fake.rpcs["debit_general_cash_register"] = debitar
        fake.rpcs["credit_general_cash_register"] = creditar
        for mod in (tournament_player_service, knockout_service, sales_block_service, prize_allocation_service):
            monkeypatch.setattr(mod, "supabase", fake)
        monkeypatch.setattr(tournament_player_service, "_recalcular_ranking", lambda *a, **k: None)
        monkeypatch.setattr(CashboxService, "require_open_cashbox_for_tournament", staticmethod(lambda *a, **k: None))
        monkeypatch.setattr(CashRegisterService, "get_general_cash",
                            staticmethod(lambda: SimpleNamespace(id="gc1", current_balance=caixa["saldo"])))
        fake.caixa = caixa
        return fake
    return montar


def _tp_de(fake, tp_id):
    return next(t for t in fake.store["tournament_players"] if t["id"] == tp_id)


def _pagos(fake):
    return [p for p in fake.store["tournament_knockout_payouts"] if p.get("paid")]


# ─────────────────────────────────────────────────────────────────────────────
# Vendas congelam a parte KO
# ─────────────────────────────────────────────────────────────────────────────

class TestVendasCongelamParteKo:
    def test_inscricao_grava_a_parte_ko(self, cenario):
        fake = cenario(inscritos=[], vendas=[])
        TPS.register_player(TournamentPlayerCreate(tournament_id=TOUR, tournament_day_id=DIA, player_id="p1"), "u1")
        [venda] = fake.store["transactions"]
        # 40% do valor da entrada (200) = 80 de bounty; o rake (36) sai do resto.
        assert venda["rake_amount"] == 36
        assert venda["bounty_amount"] == pytest.approx(80.00)

    def test_reentrada_traz_bounty_novo(self, cenario):
        fake = cenario(inscritos=[_tp("tp1", status="eliminated")], vendas=[])
        TPS.add_rebuy("tp1", "u1", skip_level_gate=True)
        [venda] = fake.store["transactions"]
        assert venda["type"] == "rebuy" and venda["bounty_amount"] == pytest.approx(80.00)

    def test_add_on_soma_no_bounty_de_quem_comprou(self, cenario):
        fake = cenario(inscritos=[_tp("tp1")], vendas=[])
        TPS.add_addon("tp1", "u1")
        assert fake.store["transactions"][0]["bounty_amount"] == pytest.approx(80.00)

    def test_torneio_comum_nao_separa_nada(self, cenario):
        comum = _torneio(formato="none", pct=0)
        fake = cenario(torneio=comum, inscritos=[_tp("tp1", torneio=comum)], vendas=[])
        TPS.add_addon("tp1", "u1")
        assert fake.store["transactions"][0]["bounty_amount"] == 0


# ─────────────────────────────────────────────────────────────────────────────
# Eliminação registra quem eliminou
# ─────────────────────────────────────────────────────────────────────────────

class TestEliminacaoComKo:
    def test_eliminador_e_obrigatorio(self, cenario):
        fake = cenario()
        with pytest.raises(ErroDeNegocio) as e:
            TPS.eliminate_player("tp1", "u1")
        assert e.value.code == "eliminador_obrigatorio"
        assert _tp_de(fake, "tp1")["status"] == "active"

    def test_pko_metade_em_dinheiro_metade_no_bounty(self, cenario):
        fake = cenario()
        tp, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        assert tp.status == "eliminated"
        assert ko["bounty_value"] == D("50.00")
        [p] = ko["payouts"]
        assert (p["cash_amount"], p["added_to_bounty"], p["eliminator_name"]) == (D("25.00"), D("25.00"), "Jogador 2")
        assert K.bounties(TOUR)["tp2"] == D("75.00")
        assert K.bounties(TOUR)["tp1"] == D("0.00")

    def test_ko_fixo_paga_o_bounty_inteiro(self, cenario):
        t = _torneio(formato="ko", share=100)
        cenario(torneio=t, inscritos=[_tp(f"tp{i}", torneio=t) for i in range(1, 5)])
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        assert (ko["payouts"][0]["cash_amount"], ko["payouts"][0]["added_to_bounty"]) == (D("50.00"), D("0.00"))

    def test_bounty_progressivo_passa_adiante(self, cenario):
        cenario()
        TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])          # tp2: 75
        _, ko = TPS.eliminar("tp2", "u1", eliminated_by=["tp3"])  # tp3 leva 37,50 + soma 37,50
        assert ko["bounty_value"] == D("75.00")
        assert K.bounties(TOUR)["tp3"] == D("87.50")

    def test_pote_dividido(self, cenario):
        cenario()
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp3", "tp2"])
        assert [p["cash_amount"] for p in ko["payouts"]] == [D("12.50"), D("12.50")]

    def test_sem_eliminador_o_bounty_fica_para_o_campeao(self, cenario):
        fake = cenario()
        _, ko = TPS.eliminar("tp1", "u1", no_eliminator=True)
        assert ko["payouts"] == []
        assert K.resumo(TOUR)["unclaimed"] == D("50.00")
        assert _tp_de(fake, "tp1")["status"] == "eliminated"

    @pytest.mark.parametrize("eliminador,codigo", [("tp1", "eliminador_e_a_vitima"), ("tpX", "eliminador_nao_encontrado")])
    def test_eliminador_invalido_e_recusado_sem_eliminar(self, cenario, eliminador, codigo):
        fake = cenario()
        with pytest.raises(ErroDeNegocio) as e:
            TPS.eliminar("tp1", "u1", eliminated_by=[eliminador])
        assert e.value.code == codigo
        assert _tp_de(fake, "tp1")["status"] == "active"

    def test_eliminador_ja_eliminado_e_recusado_ao_vivo(self, cenario):
        t = _torneio()
        cenario(inscritos=[_tp("tp1", torneio=t), _tp("tp2", status="eliminated", torneio=t)])
        with pytest.raises(ErroDeNegocio) as e:
            TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        assert e.value.code == "eliminador_nao_esta_ativo"

    def test_replay_offline_sem_eliminador_vale_como_sem_autor(self, cenario):
        fake = cenario()
        TPS.eliminate_player("tp1", "u1", idempotent=True)
        assert _tp_de(fake, "tp1")["status"] == "eliminated"
        [ko] = fake.store["tournament_knockouts"]
        assert ko["bounty_value"] == 50 and fake.store["tournament_knockout_payouts"] == []

    def test_mesmo_cmid_nao_registra_duas_vezes(self, cenario):
        fake = cenario()
        TPS.eliminate_player("tp1", "u1", eliminated_by=["tp2"], client_mutation_id="cm-1")
        TPS.eliminate_player("tp1", "u1", idempotent=True, eliminated_by=["tp2"], client_mutation_id="cm-1")
        assert len(fake.store["tournament_knockouts"]) == 1

    def test_reparo_status_gravou_e_o_ko_nao(self, cenario):
        """Queda entre os dois passos: o replay com o MESMO cmid completa o KO."""
        t = _torneio()
        vitima = {**_tp("tp1", status="eliminated", torneio=t), "eliminated_cmid": "cm-9"}
        fake = cenario(inscritos=[vitima, _tp("tp2", torneio=t)],
                       vendas=[_venda("tp1", 50), _venda("tp2", 50)])
        TPS.eliminate_player("tp1", "u1", idempotent=True, eliminated_by=["tp2"], client_mutation_id="cm-9")
        assert len(fake.store["tournament_knockouts"]) == 1

    def test_falha_no_ko_desfaz_a_eliminacao(self, cenario, monkeypatch):
        fake = cenario()

        def quebra(*a, **k):
            raise RuntimeError("banco caiu")

        monkeypatch.setattr(K, "_gravar_payouts", staticmethod(quebra))
        with pytest.raises(RuntimeError):
            TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        assert _tp_de(fake, "tp1")["status"] == "active"
        assert fake.store["tournament_knockouts"] == []

    def test_torneio_comum_elimina_sem_perguntar_quem(self, cenario):
        comum = _torneio(formato="none", pct=0)
        fake = cenario(torneio=comum, inscritos=[_tp("tp1", torneio=comum)])
        _, ko = TPS.eliminar("tp1", "u1")
        assert ko is None and fake.store["tournament_knockouts"] == []


# ─────────────────────────────────────────────────────────────────────────────
# Desfazer e corrigir
# ─────────────────────────────────────────────────────────────────────────────

class TestDesfazerECorrigir:
    def test_desfazer_eliminacao_devolve_o_bounty(self, cenario):
        fake = cenario()
        TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        TPS.uneliminate_player("tp1")
        assert _tp_de(fake, "tp1")["status"] == "active"
        assert fake.store["tournament_knockouts"][0]["status"] == "undone"
        assert K.bounties(TOUR)["tp1"] == D("50.00") and K.bounties(TOUR)["tp2"] == D("50.00")

    def test_ko_pago_nao_deixa_desfazer(self, cenario):
        fake = cenario()
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        K.pagar(TOUR, ko["payouts"][0]["id"], "u1")
        with pytest.raises(ErroDeNegocio) as e:
            TPS.uneliminate_player("tp1")
        assert e.value.code == "ko_ja_pago"
        assert _tp_de(fake, "tp1")["status"] == "eliminated"

    def test_cadeia_precisa_desfazer_o_mais_recente_antes(self, cenario):
        cenario()
        TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        TPS.eliminar("tp2", "u1", eliminated_by=["tp3"])
        with pytest.raises(ErroDeNegocio) as e:
            TPS.uneliminate_player("tp1")
        assert e.value.code == "ko_desfazer_bloqueado_cadeia"

    def test_corrigir_eliminador(self, cenario):
        cenario()
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        novo = K.corrigir_eliminadores(TOUR, ko["id"], ["tp3"])
        assert [p["eliminator_tp_id"] for p in novo["payouts"]] == ["tp3"]
        assert K.bounties(TOUR)["tp3"] == D("75.00") and K.bounties(TOUR)["tp2"] == D("50.00")


# ─────────────────────────────────────────────────────────────────────────────
# Pagamento do caixa geral
# ─────────────────────────────────────────────────────────────────────────────

class TestPagamento:
    def test_paga_do_caixa_geral_como_premio_de_ko(self, cenario):
        fake = cenario(saldo=1000)
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        K.pagar(TOUR, ko["payouts"][0]["id"], "u1", paid_by="Caixa 1")
        [pago] = _pagos(fake)
        [tx] = [t for t in fake.store["transactions"] if t["type"] == "prize"]
        assert (tx["prize_kind"], tx["amount"], tx["player_id"]) == ("knockout", 25.0, "p2")
        assert "tournament_player_id" not in tx
        assert pago["transaction_id"] == tx["id"] and pago["paid_by"] == "Caixa 1"
        assert fake.caixa["saldo"] == D("975")

    def test_saldo_insuficiente_nao_paga(self, cenario):
        fake = cenario(saldo=10)
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        with pytest.raises(ErroDeNegocio) as e:
            K.pagar(TOUR, ko["payouts"][0]["id"], "u1")
        assert e.value.code == "saldo_insuficiente_no_caixa_geral"
        assert _pagos(fake) == []

    def test_corrida_no_debito_desfaz_a_reserva(self, cenario):
        """O saldo bastava na leitura, mas outro caixa pagou antes do débito."""
        fake = cenario(saldo=1000)
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        fake.rpcs["debit_general_cash_register"] = None
        with pytest.raises(ErroDeNegocio):
            K.pagar(TOUR, ko["payouts"][0]["id"], "u1")
        assert _pagos(fake) == []
        assert not [t for t in fake.store["transactions"] if t["type"] == "prize"]

    def test_nao_paga_duas_vezes(self, cenario):
        cenario()
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        K.pagar(TOUR, ko["payouts"][0]["id"], "u1")
        with pytest.raises(ErroDeNegocio) as e:
            K.pagar(TOUR, ko["payouts"][0]["id"], "u1")
        assert e.value.code == "premio_ja_pago"

    def test_caixa_do_operador_fechado_recusa(self, cenario, monkeypatch):
        fake = cenario()
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])

        def fechado(*a, **k):
            raise ErroDeNegocio("caixa_fechado", "Abra o seu caixa antes de vender.")

        monkeypatch.setattr(CashboxService, "require_open_cashbox_for_tournament", staticmethod(fechado))
        with pytest.raises(ErroDeNegocio):
            K.pagar(TOUR, ko["payouts"][0]["id"], "u1")
        assert _pagos(fake) == []

    def test_ko_desfeito_nao_e_pago(self, cenario):
        cenario()
        _, ko = TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        TPS.uneliminate_player("tp1")
        with pytest.raises(ErroDeNegocio) as e:
            K.pagar(TOUR, ko["payouts"][0]["id"], "u1")
        assert e.value.code == "ko_desfeito"

    def test_pagar_em_lote(self, cenario):
        fake = cenario()
        _, k1 = TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        _, k2 = TPS.eliminar("tp3", "u1", eliminated_by=["tp4"])
        K.pagar_lote(TOUR, [k1["payouts"][0]["id"], k2["payouts"][0]["id"]], "u1")
        assert len(_pagos(fake)) == 2


# ─────────────────────────────────────────────────────────────────────────────
# Encerramento: o pago em KO fecha com o pozo KO
# ─────────────────────────────────────────────────────────────────────────────

class TestEncerramento:
    def test_invariante_pago_igual_ao_pozo(self, cenario):
        vendas = [_venda(f"tp{i}", 50) for i in range(1, 5)]
        fake = cenario(vendas=vendas)
        TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])          # tp2: 75
        TPS.eliminar("tp3", "u1", eliminated_by=["tp2"])          # tp2: 100
        TPS.eliminar("tp4", "u1", no_eliminator=True)             # 50 sem autor
        # Add-on vendido a um eliminado: o bounty fica na cabeça dele.
        fake.store["transactions"].append(_venda("tp1", 10, tipo="addon", quando="2026-01-01T05:00:00Z"))
        resumo = K.encerrar(TOUR, "tp2", "u1")
        for p in list(fake.store["tournament_knockout_payouts"]):
            if not p.get("paid"):
                K.pagar(TOUR, p["id"], "u1")
        pago = sum(D(str(p["cash_amount"])) for p in _pagos(fake))
        assert pago == D("210.00") == resumo["ko_pool"]
        assert resumo["closed_at"]
        assert all(b == 0 for b in K.bounties(TOUR).values())

    def test_campeao_precisa_estar_vivo(self, cenario):
        cenario()
        TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        with pytest.raises(ErroDeNegocio) as e:
            K.encerrar(TOUR, "tp1", "u1")
        assert e.value.code == "campeao_invalido"

    def test_nao_encerra_duas_vezes_e_da_para_desfazer(self, cenario):
        fake = cenario()
        K.encerrar(TOUR, "tp2", "u1")
        with pytest.raises(ErroDeNegocio) as e:
            K.encerrar(TOUR, "tp2", "u1")
        assert e.value.code == "ko_ja_encerrado"
        K.desfazer_encerramento(TOUR, "u1")
        assert fake.store["tournaments"][0]["ko_closed_at"] is None
        assert all(k["status"] == "undone" for k in fake.store["tournament_knockouts"])

    def test_encerramento_pago_nao_desfaz(self, cenario):
        fake = cenario()
        K.encerrar(TOUR, "tp2", "u1")
        K.pagar(TOUR, fake.store["tournament_knockout_payouts"][0]["id"], "u1")
        with pytest.raises(ErroDeNegocio) as e:
            K.desfazer_encerramento(TOUR, "u1")
        assert e.value.code == "ko_encerramento_com_pagamento"

    def test_depois_de_encerrar_eliminacao_e_recusada(self, cenario):
        cenario()
        K.encerrar(TOUR, "tp2", "u1")
        with pytest.raises(ErroDeNegocio) as e:
            TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        assert e.value.code == "ko_encerrado"


# ─────────────────────────────────────────────────────────────────────────────
# Guardas: estorno de venda e configuração do torneio
# ─────────────────────────────────────────────────────────────────────────────

class TestGuardas:
    def test_venda_cujo_bounty_ja_foi_entregue_nao_estorna(self, cenario):
        cenario()
        TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        with pytest.raises(ErroDeNegocio) as e:
            K.exigir_venda_sem_ko(_venda("tp1", 50))
        assert e.value.code == "venda_com_ko_registrado"

    def test_reentrada_depois_do_ko_estorna_normalmente(self, cenario):
        cenario()
        TPS.eliminar("tp1", "u1", eliminated_by=["tp2"])
        K.exigir_venda_sem_ko(_venda("tp1", 50, tipo="rebuy", quando="2099-01-01T00:00:00Z"))

    def test_torneio_comum_nao_tem_guarda(self, cenario):
        comum = _torneio(formato="none", pct=0)
        cenario(torneio=comum)
        K.exigir_venda_sem_ko(_venda("tp1", 0))

    def test_fase_mystery_trava_estornos(self, cenario):
        cenario(torneio=_torneio(formato="mystery", mystery_started_at="2026-10-14T03:00:00Z", mystery_pool=200))
        with pytest.raises(ErroDeNegocio) as e:
            K.exigir_venda_sem_ko(_venda("tp1", 50))
        assert e.value.code == "venda_na_fase_mystery"


class TestConfiguracaoDoTorneio:
    @pytest.fixture
    def torneio_service(self, monkeypatch):
        from app.services import tournament_service

        def montar(torneio=None, vendas=None):
            fake = FakeSupabase({"tournaments": [torneio or _torneio(formato="none", pct=0)],
                                 "transactions": vendas or [], "tournament_days": []})
            monkeypatch.setattr(tournament_service, "supabase", fake)
            return tournament_service.TournamentService, fake
        return montar

    def test_ko_exige_eliminacao_por_mesa(self, torneio_service):
        S, _ = torneio_service()
        with pytest.raises(ErroDeNegocio) as e:
            S._validar_ko(None, {"ko_format": "pko", "ko_percentage": 40, "elimination_mode": "bulk"})
        assert e.value.code == "ko_exige_modo_mesa"

    def test_ko_sem_classificatorio(self, torneio_service):
        S, _ = torneio_service()
        with pytest.raises(ErroDeNegocio) as e:
            S._validar_ko(None, {"ko_format": "pko", "ko_percentage": 40, "elimination_mode": "table",
                                 "has_qualifying": True})
        assert e.value.code == "ko_sem_classificatorio"

    def test_percentual_obrigatorio(self, torneio_service):
        S, _ = torneio_service()
        with pytest.raises(ErroDeNegocio) as e:
            S._validar_ko(None, {"ko_format": "ko", "ko_percentage": 0, "elimination_mode": "table"})
        assert e.value.code == "ko_percentual_obrigatorio"

    def test_ko_fixo_forca_100_em_dinheiro(self, torneio_service):
        S, _ = torneio_service()
        dados = {"ko_format": "ko", "ko_percentage": 30, "ko_cash_share": 50, "elimination_mode": "table"}
        S._validar_ko(None, dados)
        assert dados["ko_cash_share"] == 100

    def test_nao_muda_depois_da_primeira_venda(self, torneio_service):
        S, _ = torneio_service(torneio=_torneio(), vendas=[_venda("tp1", 50)])
        with pytest.raises(ErroDeNegocio) as e:
            S._validar_ko(TOUR, {"ko_percentage": 30})
        assert e.value.code == "ko_config_bloqueada_com_vendas"

    def test_reenviar_os_mesmos_valores_com_vendas_passa(self, torneio_service):
        S, _ = torneio_service(torneio=_torneio(), vendas=[_venda("tp1", 50)])
        S._validar_ko(TOUR, {"ko_format": "pko", "ko_percentage": 40, "ko_cash_share": 50})

    def test_voltar_para_em_massa_e_recusado(self, torneio_service):
        S, _ = torneio_service(torneio=_torneio())
        with pytest.raises(ErroDeNegocio) as e:
            S._validar_ko(TOUR, {"elimination_mode": "bulk", "ko_format": "pko"})
        assert e.value.code == "ko_exige_modo_mesa"


# ─────────────────────────────────────────────────────────────────────────────
# Pozo: KO sai do líquido; garantido e reservado só nas posições
# ─────────────────────────────────────────────────────────────────────────────

class TestPozos:
    def _monta(self, cenario, torneio, totais):
        fake = cenario(torneio=torneio)
        fake.rpcs["get_tournament_entry_totals"] = [totais]
        return fake

    def test_divisao_do_exemplo_do_clube(self, cenario):
        # Entradas 12.195,12 com 18% de rake = pozo 10.000; KO 40% = 4.000.
        self._monta(cenario, _torneio(), {"total": 12195.12, "total_rake": 2195.12, "total_bounty": 4000})
        r = P.get_prize_summary(TOUR)
        assert r.net_pool == D("10000.00")
        assert r.ko_pool == D("4000")
        assert r.player_pool == D("6000.00")
        assert r.total_prize_pool == D("10000.00")
        assert r.ko_format == "pko"

    def test_garantido_e_reservado_valem_so_para_posicoes(self, cenario):
        t = _torneio(guaranteed_prize=1000, reserved_prize_percentage=10)
        self._monta(cenario, t, {"total": 1000, "total_rake": 200, "total_bounty": 320})
        r = P.get_prize_summary(TOUR)
        assert r.player_pool == D("480")
        assert r.available_prize_pool == D("1480")
        assert r.payable_pool == D("1380")  # reservado: 10% do bruto (100)
        assert r.total_prize_pool == D("1800")

    def test_rpc_antiga_sem_total_bounty(self, cenario):
        self._monta(cenario, _torneio(), {"total": 1000, "total_rake": 200})
        r = P.get_prize_summary(TOUR)
        assert r.ko_pool == 0 and r.player_pool == D("800")

    def test_mystery_iniciado_usa_o_pozo_congelado(self, cenario):
        t = _torneio(formato="mystery", mystery_started_at="2026-10-14T03:00:00Z", mystery_pool=300)
        self._monta(cenario, t, {"total": 1000, "total_rake": 200, "total_bounty": 320})
        assert P.get_prize_summary(TOUR).ko_pool == D("300")

    def test_pagamento_de_posicao_respeita_o_pozo_das_posicoes(self, cenario):
        self._monta(cenario, _torneio(), {"total": 1000, "total_rake": 200, "total_bounty": 320})
        assert P.get_tournament_prize_pool(TOUR)["available"] == pytest.approx(480)


# ─────────────────────────────────────────────────────────────────────────────
# Rotas
# ─────────────────────────────────────────────────────────────────────────────

class TestRotas:
    def test_eliminar_com_eliminador_devolve_o_ko(self, client, cenario):
        cenario()
        r = client.post("/tournament-players/tp1/eliminate", json={"eliminated_by": ["tp2"]})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "eliminated"
        assert r.json()["knockout"]["payouts"][0]["cash_amount"] in ("25.00", 25.0, "25")

    def test_eliminar_sem_eliminador_em_torneio_ko_e_400_com_codigo(self, client, cenario):
        cenario()
        r = client.post("/tournament-players/tp1/eliminate", json={"tournament_player_id": "tp1"})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "eliminador_obrigatorio"

    def test_resumo_pagar_e_encerrar(self, client, cenario):
        fake = cenario()
        client.post("/tournament-players/tp1/eliminate", json={"eliminated_by": ["tp2"]})
        resumo = client.get(f"/tournaments/{TOUR}/knockouts/summary").json()
        assert resumo["ko_format"] == "pko"
        payout_id = resumo["knockouts"][0]["payouts"][0]["id"]
        assert client.post(f"/tournaments/{TOUR}/knockouts/payouts/{payout_id}/pay", json={}).status_code == 200
        assert len(_pagos(fake)) == 1
        r = client.post(f"/tournaments/{TOUR}/knockouts/close", json={"champion_tp_id": "tp2"})
        assert r.status_code == 200 and r.json()["closed_at"]

    def test_pagar_sem_saldo_e_400_com_codigo(self, client, cenario):
        cenario(saldo=0)
        client.post("/tournament-players/tp1/eliminate", json={"eliminated_by": ["tp2"]})
        pid = client.get(f"/tournaments/{TOUR}/knockouts/summary").json()["knockouts"][0]["payouts"][0]["id"]
        r = client.post(f"/tournaments/{TOUR}/knockouts/payouts/{pid}/pay", json={})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "saldo_insuficiente_no_caixa_geral"


class TestSync:
    def test_replay_leva_quem_eliminou(self, monkeypatch):
        from app.services import sync_service
        from app.services.sync_service import SyncService

        monkeypatch.setattr(sync_service, "supabase", FakeSupabase({"sync_mutations": []}))
        recebido = {}

        def eliminar(tpid, uid, **kw):
            recebido.update(kw, tpid=tpid)

        monkeypatch.setattr(TPS, "eliminate_player", staticmethod(eliminar))
        op = {"kind": "eliminate", "clientMutationId": "cm-1",
              "body": {"tournament_player_id": "tp1", "eliminated_by": ["tp2"], "no_eliminator": False}}
        assert SyncService.apply_op(op, "u1", ORG)["status"] == "applied"
        assert recebido == {"tpid": "tp1", "idempotent": True, "eliminated_by": ["tp2"],
                            "no_eliminator": False, "client_mutation_id": "cm-1"}


class TestGarantidoENivelDoMystery:
    def _servico(self, monkeypatch, **torneio):
        from app.services import tournament_service
        fake = FakeSupabase({"tournaments": [_torneio(formato="mystery", **torneio)],
                             "transactions": [], "tournament_days": []})
        monkeypatch.setattr(tournament_service, "supabase", fake)
        return tournament_service.TournamentService

    def test_livres_antes_da_fase(self, monkeypatch):
        S = self._servico(monkeypatch)
        S._validar_ko(TOUR, {"mystery_guarantee": 1000, "mystery_start_level": 13})

    def test_travados_depois_da_fase(self, monkeypatch):
        S = self._servico(monkeypatch, mystery_started_at="2026-10-14T22:00:00Z", mystery_guarantee=1000)
        S._validar_ko(TOUR, {"mystery_guarantee": 1000})   # mesmo valor passa
        with pytest.raises(ErroDeNegocio) as e:
            S._validar_ko(TOUR, {"mystery_guarantee": 2000})
        assert e.value.code == "mystery_config_bloqueada"
