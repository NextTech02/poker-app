"""Testes de fidelidade, relatórios e modelos de estrutura de blind.

**Fidelidade.** Toda operação que mexe em ponto ou saldo é uma RPC atômica
no banco — resgatar recompensa, converter cashback, usar cupom, reivindicar
meta, presentear crédito. Fazer isso em Python daria a janela clássica:
ler o saldo, o jogador resgatar de novo em outro caixa, e os dois passarem.
O que sobra para o serviço é o escopo por organização e a tradução do erro:
o banco levanta `FIDELIDADE: <texto>` e o operador precisa ler o texto, não
o stack do Postgres.

**Relatórios.** O relatório por torneio é o que o clube usa para fechar a
etapa. Ele agrega por dia numa consulta só (era uma por dia) e conta cada
coisa numa unidade diferente — jogadores DISTINTOS, entradas somadas,
prêmio pago só quando é dinheiro e já foi pago.

**Modelos de blind.** O gerador precisa produzir níveis contínuos mesmo
inserindo intervalos no meio: um `level` repetido deixaria o relógio sem
saber qual estrutura aplicar.
"""
import pytest

from app.models.blind_template import BlindTemplateCreate, BlindTemplateUpdate
from app.services import loyalty_service as loymod
from app.services import report_service as repmod
from app.services import blind_template_service as btmod
from app.services.loyalty_service import LoyaltyService as L
from app.services.report_service import ReportService as R
from app.services.blind_template_service import BlindTemplateService as B

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
JOGADOR = "44444444-4444-4444-4444-444444444444"
TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
ETAPA = "11111111-1111-1111-1111-111111111111"
MODELO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"
MODELO2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2"
AUTOR = "88888888-8888-8888-8888-888888888888"


# ---------------------------------------------------------------------------
# Fidelidade
# ---------------------------------------------------------------------------

def _monta_fidelidade(monkeypatch, **tabelas):
    base = {
        "organizations": [{"id": ORG, "plan_code": "pro"}],
        "loyalty_settings": [{"organization_id": ORG, "points_per_currency": 1,
                              "system_sponsor_id": "sp-sistema"}],
        "loyalty_tiers": [], "loyalty_accounts": [], "loyalty_ledger": [],
        "loyalty_rewards": [], "loyalty_coupons": [], "loyalty_goals": [],
        "loyalty_goal_claims": [], "player_credits": [],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    monkeypatch.setattr(loymod, "supabase", fake)
    return fake


class TestPlanoEConfiguracao:
    def test_plano_vem_da_rpc(self, monkeypatch):
        """RPC SECURITY DEFINER: o backend local roda com service_role e uma
        consulta direta pegaria a organização errada."""
        fake = _monta_fidelidade(monkeypatch)
        fake.rpcs = {"org_plan_code": "premium", "org_has_loyalty": True}
        assert L.get_config(ORG)["plan_code"] == "premium"

    def test_sem_a_rpc_cai_na_tabela(self, monkeypatch):
        fake = _monta_fidelidade(monkeypatch)
        fake.rpcs = {"org_has_loyalty": True}      # org_plan_code ausente
        assert L.get_config(ORG)["plan_code"] == "pro"

    @pytest.mark.parametrize("plano,disponivel", [
        ("free", False), ("standard", False), ("pro", True), ("premium", True),
    ])
    def test_disponibilidade_segue_o_plano(self, monkeypatch, plano, disponivel):
        """`available` é o direito do plano; independe de o clube ter ligado
        o programa. É o que a tela usa para oferecer o upgrade."""
        fake = _monta_fidelidade(monkeypatch)
        fake.rpcs = {"org_plan_code": plano, "org_has_loyalty": False}
        assert L.get_config(ORG)["available"] is disponivel

    def test_programa_desligado_com_plano_que_permite(self, monkeypatch):
        fake = _monta_fidelidade(monkeypatch)
        fake.rpcs = {"org_plan_code": "pro", "org_has_loyalty": False}
        r = L.get_config(ORG)
        assert r["available"] is True
        assert r["enabled"] is False

    def test_rpc_de_habilitacao_ausente_conta_como_desligado(self, monkeypatch):
        """Fail-closed: sem conseguir confirmar, não libera."""
        fake = _monta_fidelidade(monkeypatch)
        fake.rpcs = {"org_plan_code": "pro"}
        assert L.get_config(ORG)["enabled"] is False

    def test_sem_organizacao_devolve_tudo_desligado(self, monkeypatch):
        _monta_fidelidade(monkeypatch)
        r = L.get_config(None)
        assert r == {"enabled": False, "plan_code": None, "available": False,
                     "settings": None, "tiers": []}

    def test_atualiza_a_configuracao(self, monkeypatch):
        fake = _monta_fidelidade(monkeypatch)
        r = L.update_settings(ORG, {"points_per_currency": 3, "cashback_pct": None})
        assert r["points_per_currency"] == 3
        # None é descartado: PATCH parcial não pode apagar o que não veio
        assert "cashback_pct" not in fake.store["loyalty_settings"][0]

    def test_atualizacao_vazia_nao_toca_no_banco(self, monkeypatch):
        _monta_fidelidade(monkeypatch)
        assert L.update_settings(ORG, {"x": None}) is None

    def test_sem_organizacao_nao_atualiza(self, monkeypatch):
        _monta_fidelidade(monkeypatch)
        assert L.update_settings(None, {"points_per_currency": 2}) is None


class TestExtratoDoJogador:
    def test_monta_conta_extrato_e_proximo_nivel(self, monkeypatch):
        """O "próximo nível" é o primeiro cuja exigência ainda não foi
        atingida — é o que a tela mostra como meta."""
        fake = _monta_fidelidade(
            monkeypatch,
            loyalty_accounts=[{"id": "ac1", "organization_id": ORG,
                               "player_id": JOGADOR, "points_balance": 120,
                               "lifetime_points": 350, "cashback_balance": 42.5,
                               "loyalty_tiers": {"id": "t1", "name": "Prata",
                                                 "color": "#ccc", "min_points": 100,
                                                 "points_multiplier": 1.2}}],
            loyalty_tiers=[
                {"id": "t1", "organization_id": ORG, "name": "Prata", "min_points": 100},
                {"id": "t2", "organization_id": ORG, "name": "Ouro", "min_points": 1000},
            ],
            loyalty_ledger=[{"id": "l1", "organization_id": ORG, "player_id": JOGADOR,
                             "delta": 50, "balance_after": 120, "reason": "buy_in",
                             "description": None, "created_at": "2026-06-08T10:00:00Z",
                             "transaction_id": None}],
        )
        fake.rpcs = {"org_plan_code": "pro", "org_has_loyalty": True}
        r = L.get_player_loyalty(ORG, JOGADOR)
        assert r["lifetime_points"] == 350
        assert r["cashback_balance"] == 42.5
        assert r["tier"]["name"] == "Prata"
        assert r["next_tier"]["name"] == "Ouro"
        assert len(r["ledger"]) == 1

    def test_jogador_sem_conta_nao_quebra(self, monkeypatch):
        """Quem nunca pontuou ainda não tem linha; a tela precisa abrir."""
        _monta_fidelidade(monkeypatch)
        r = L.get_player_loyalty(ORG, JOGADOR)
        assert r["account"] is None
        assert r["lifetime_points"] == 0
        assert r["cashback_balance"] == 0

    def test_no_topo_nao_ha_proximo_nivel(self, monkeypatch):
        _monta_fidelidade(monkeypatch,
                          loyalty_accounts=[{"id": "ac1", "organization_id": ORG,
                                             "player_id": JOGADOR,
                                             "lifetime_points": 5000,
                                             "cashback_balance": 0}],
                          loyalty_tiers=[{"id": "t1", "organization_id": ORG,
                                          "name": "Ouro", "min_points": 1000}])
        assert L.get_player_loyalty(ORG, JOGADOR)["next_tier"] is None

    def test_so_traz_recompensas_ativas(self, monkeypatch):
        _monta_fidelidade(monkeypatch, loyalty_rewards=[
            {"id": "r1", "organization_id": ORG, "name": "Buy-in", "active": True,
             "cost_points": 500, "sort_order": 1},
            {"id": "r2", "organization_id": ORG, "name": "Antigo", "active": False,
             "cost_points": 100, "sort_order": 2},
        ])
        assert len(L.get_player_loyalty(ORG, JOGADOR)["rewards"]) == 1


class TestCatalogoDeRecompensas:
    def test_lista(self, monkeypatch):
        _monta_fidelidade(monkeypatch, loyalty_rewards=[
            {"id": "r1", "organization_id": ORG, "active": True, "cost_points": 1,
             "sort_order": 1}])
        assert len(L.get_rewards(ORG)) == 1

    def test_filtra_so_ativas(self, monkeypatch):
        _monta_fidelidade(monkeypatch, loyalty_rewards=[
            {"id": "r1", "organization_id": ORG, "active": True, "cost_points": 1,
             "sort_order": 1},
            {"id": "r2", "organization_id": ORG, "active": False, "cost_points": 1,
             "sort_order": 2}])
        assert len(L.get_rewards(ORG, active_only=True)) == 1

    def test_sem_organizacao_devolve_vazio(self, monkeypatch):
        _monta_fidelidade(monkeypatch)
        assert L.get_rewards(None) == []

    def test_cria_ja_carimbando_a_organizacao(self, monkeypatch):
        """Sem o carimbo, a recompensa aparece no catálogo de todos os clubes."""
        fake = _monta_fidelidade(monkeypatch)
        L.create_reward(ORG, {"name": "Buy-in grátis", "cost_points": 500})
        assert fake.store["loyalty_rewards"][0]["organization_id"] == ORG

    def test_atualiza(self, monkeypatch):
        _monta_fidelidade(monkeypatch, loyalty_rewards=[
            {"id": "r1", "organization_id": ORG, "cost_points": 500}])
        assert L.update_reward(ORG, "r1", {"cost_points": 300})["cost_points"] == 300

    def test_atualizacao_vazia(self, monkeypatch):
        _monta_fidelidade(monkeypatch)
        assert L.update_reward(ORG, "r1", {"x": None}) is None

    def test_recompensa_de_outra_organizacao_nao_e_alterada(self, monkeypatch):
        _monta_fidelidade(monkeypatch, loyalty_rewards=[
            {"id": "r1", "organization_id": "outra-org", "cost_points": 500}])
        assert L.update_reward(ORG, "r1", {"cost_points": 1}) is None

    def test_apaga(self, monkeypatch):
        fake = _monta_fidelidade(monkeypatch, loyalty_rewards=[
            {"id": "r1", "organization_id": ORG}])
        assert L.delete_reward(ORG, "r1") is True
        assert fake.store["loyalty_rewards"] == []

    def test_nao_apaga_de_outra_organizacao(self, monkeypatch):
        fake = _monta_fidelidade(monkeypatch, loyalty_rewards=[
            {"id": "r1", "organization_id": "outra-org"}])
        assert L.delete_reward(ORG, "r1") is False
        assert len(fake.store["loyalty_rewards"]) == 1


class TestOperacoesAtomicas:
    """Ponto e saldo só mudam por RPC. Ler o saldo em Python e gravar depois
    deixaria a janela para o jogador resgatar duas vezes em caixas
    diferentes."""

    @pytest.mark.parametrize("metodo,rpc,args", [
        ("redeem_reward", "loyalty_redeem_reward", (ORG, JOGADOR, "r1")),
        ("convert_cashback", "loyalty_convert_cashback", (ORG, JOGADOR)),
        ("redeem_coupon", "loyalty_redeem_coupon", (ORG, JOGADOR, "BEMVINDO")),
        ("claim_goal", "loyalty_claim_goal", (ORG, JOGADOR, "m1")),
        ("gift_credit", "loyalty_gift_credit", (ORG, "cr1", "p2")),
    ])
    def test_delegam_para_a_rpc(self, monkeypatch, metodo, rpc, args):
        fake = _monta_fidelidade(monkeypatch)
        fake.rpcs = {rpc: {"ok": True}}
        assert getattr(L, metodo)(*args) == {"ok": True}
        assert fake.rpc_calls[0][0] == rpc

    @pytest.mark.parametrize("metodo,rpc,args", [
        ("redeem_reward", "loyalty_redeem_reward", (ORG, JOGADOR, "r1")),
        ("convert_cashback", "loyalty_convert_cashback", (ORG, JOGADOR)),
        ("redeem_coupon", "loyalty_redeem_coupon", (ORG, JOGADOR, "X")),
        ("claim_goal", "loyalty_claim_goal", (ORG, JOGADOR, "m1")),
        ("gift_credit", "loyalty_gift_credit", (ORG, "cr1", "p2")),
    ])
    def test_erro_do_banco_vira_texto_legivel(self, monkeypatch, metodo, rpc, args):
        """O banco levanta `FIDELIDADE: <texto>`; o operador lê o texto para o
        jogador, não o stack do Postgres."""
        fake = _monta_fidelidade(monkeypatch)

        def _estoura(_):
            raise Exception("FIDELIDADE: Pontos insuficientes\nCONTEXT: PL/pgSQL ...")

        fake.rpcs = {rpc: _estoura}
        with pytest.raises(ValueError, match="Pontos insuficientes"):
            getattr(L, metodo)(*args)

    def test_rpc_sem_retorno_devolve_dicionario_vazio(self, monkeypatch):
        fake = _monta_fidelidade(monkeypatch)
        fake.rpcs = {"loyalty_convert_cashback": None}
        assert L.convert_cashback(ORG, JOGADOR) == {}

    def test_erro_sem_o_prefixo_vira_mensagem_generica(self, monkeypatch):
        """Falha de infraestrutura não deve vazar detalhe do banco para a
        tela do balcão."""
        fake = _monta_fidelidade(monkeypatch)

        def _estoura(_):
            raise Exception("connection reset by peer")

        fake.rpcs = {"loyalty_redeem_reward": _estoura}
        with pytest.raises(ValueError, match="Falha ao processar"):
            L.redeem_reward(ORG, JOGADOR, "r1")


class TestCupons:
    def test_codigo_e_normalizado_para_maiusculo(self, monkeypatch):
        """O jogador digita como quiser; o código é comparado exato."""
        fake = _monta_fidelidade(monkeypatch)
        L.create_coupon(ORG, {"code": "  bemvindo ", "points": 100})
        assert fake.store["loyalty_coupons"][0]["code"] == "BEMVINDO"

    def test_lista(self, monkeypatch):
        _monta_fidelidade(monkeypatch, loyalty_coupons=[
            {"id": "cp1", "organization_id": ORG, "code": "X",
             "created_at": "2026-06-08T00:00:00Z"}])
        assert len(L.get_coupons(ORG)) == 1

    def test_sem_organizacao(self, monkeypatch):
        _monta_fidelidade(monkeypatch)
        assert L.get_coupons(None) == []

    def test_apaga(self, monkeypatch):
        _monta_fidelidade(monkeypatch, loyalty_coupons=[
            {"id": "cp1", "organization_id": ORG}])
        assert L.delete_coupon(ORG, "cp1") is True

    def test_de_outra_organizacao_nao_e_apagado(self, monkeypatch):
        _monta_fidelidade(monkeypatch, loyalty_coupons=[
            {"id": "cp1", "organization_id": "outra"}])
        assert L.delete_coupon(ORG, "cp1") is False


class TestMetas:
    def _meta(self, id_="m1", periodo="monthly", alvo=5):
        return {"id": id_, "organization_id": ORG, "name": "5 torneios",
                "metric": "tournaments", "target": alvo, "period": periodo,
                "active": True, "sort_order": 1}

    def test_progresso_vem_da_rpc_e_marca_a_conclusao(self, monkeypatch):
        fake = _monta_fidelidade(monkeypatch, loyalty_goals=[self._meta()])
        fake.rpcs = {"loyalty_goal_current": 5}
        r = L.get_goals(ORG, JOGADOR)[0]
        assert r["progress"] == 5
        assert r["completed"] is True

    def test_meta_incompleta(self, monkeypatch):
        fake = _monta_fidelidade(monkeypatch, loyalty_goals=[self._meta()])
        fake.rpcs = {"loyalty_goal_current": 2}
        assert L.get_goals(ORG, JOGADOR)[0]["completed"] is False

    def test_falha_na_rpc_de_progresso_nao_derruba_a_tela(self, monkeypatch):
        fake = _monta_fidelidade(monkeypatch, loyalty_goals=[self._meta()])

        def _estoura(_):
            raise Exception("timeout")

        fake.rpcs = {"loyalty_goal_current": _estoura}
        assert L.get_goals(ORG, JOGADOR)[0]["progress"] == 0.0

    def test_meta_mensal_ja_reivindicada_no_mes_corrente(self, monkeypatch):
        """A chave do período é o ano-mês: reivindicar em junho não bloqueia
        julho."""
        from datetime import datetime, timezone
        mes = datetime.now(timezone.utc).strftime("%Y-%m")
        fake = _monta_fidelidade(
            monkeypatch, loyalty_goals=[self._meta()],
            loyalty_goal_claims=[{"organization_id": ORG, "player_id": JOGADOR,
                                  "goal_id": "m1", "period_key": mes}])
        fake.rpcs = {"loyalty_goal_current": 5}
        assert L.get_goals(ORG, JOGADOR)[0]["claimed"] is True

    def test_reivindicacao_de_mes_anterior_nao_bloqueia_o_atual(self, monkeypatch):
        fake = _monta_fidelidade(
            monkeypatch, loyalty_goals=[self._meta()],
            loyalty_goal_claims=[{"organization_id": ORG, "player_id": JOGADOR,
                                  "goal_id": "m1", "period_key": "2020-01"}])
        fake.rpcs = {"loyalty_goal_current": 5}
        assert L.get_goals(ORG, JOGADOR)[0]["claimed"] is False

    def test_meta_permanente_usa_chave_unica(self, monkeypatch):
        fake = _monta_fidelidade(
            monkeypatch, loyalty_goals=[self._meta(periodo="all")],
            loyalty_goal_claims=[{"organization_id": ORG, "player_id": JOGADOR,
                                  "goal_id": "m1", "period_key": "all"}])
        fake.rpcs = {"loyalty_goal_current": 9}
        assert L.get_goals(ORG, JOGADOR)[0]["claimed"] is True

    def test_catalogo_sem_jogador_nao_consulta_progresso(self, monkeypatch):
        fake = _monta_fidelidade(monkeypatch, loyalty_goals=[self._meta()])
        r = L.get_goals(ORG, None)[0]
        assert r["progress"] == 0.0
        assert fake.rpc_calls == []

    def test_meta_inativa_fica_de_fora(self, monkeypatch):
        meta = self._meta()
        meta["active"] = False
        _monta_fidelidade(monkeypatch, loyalty_goals=[meta])
        assert L.get_goals(ORG, None) == []

    def test_sem_organizacao(self, monkeypatch):
        _monta_fidelidade(monkeypatch)
        assert L.get_goals(None, JOGADOR) == []

    def test_cria_e_apaga(self, monkeypatch):
        fake = _monta_fidelidade(monkeypatch)
        L.create_goal(ORG, {"name": "X", "metric": "entries", "target": 3})
        assert fake.store["loyalty_goals"][0]["organization_id"] == ORG
        assert L.delete_goal(ORG, fake.store["loyalty_goals"][0]["id"]) is True


class TestCreditosPresenteaveis:
    def _credito(self, id_="cr1", sponsor="sp-sistema", usado=0, status="active"):
        return {"id": id_, "organization_id": ORG, "player_id": JOGADOR,
                "sponsor_id": sponsor, "original_amount": 100,
                "remaining_amount": 100, "used_amount": usado, "status": status,
                "notes": None}

    def test_so_creditos_do_proprio_programa(self, monkeypatch):
        """Crédito de um patrocinador real não é do jogador para dar — o
        patrocinador pagou por AQUELE jogador."""
        _monta_fidelidade(monkeypatch, player_credits=[
            self._credito("cr1"), self._credito("cr2", sponsor="patrocinador-real")])
        assert [c["id"] for c in L.giftable_credits(ORG, JOGADOR)] == ["cr1"]

    def test_credito_ja_tocado_nao_e_presenteavel(self, monkeypatch):
        _monta_fidelidade(monkeypatch, player_credits=[self._credito(usado=30)])
        assert L.giftable_credits(ORG, JOGADOR) == []

    def test_credito_cancelado_nao_e_presenteavel(self, monkeypatch):
        _monta_fidelidade(monkeypatch,
                          player_credits=[self._credito(status="cancelled")])
        assert L.giftable_credits(ORG, JOGADOR) == []

    def test_sem_patrocinador_de_sistema_configurado_aceita_todos(self, monkeypatch):
        _monta_fidelidade(monkeypatch,
                          loyalty_settings=[{"organization_id": ORG,
                                             "system_sponsor_id": None}],
                          player_credits=[self._credito(sponsor="qualquer")])
        assert len(L.giftable_credits(ORG, JOGADOR)) == 1

    def test_sem_organizacao(self, monkeypatch):
        _monta_fidelidade(monkeypatch)
        assert L.giftable_credits(None, JOGADOR) == []


# ---------------------------------------------------------------------------
# Relatórios
# ---------------------------------------------------------------------------

def _monta_relatorio(monkeypatch, **tabelas):
    base = {
        "tournaments": [{"id": TOUR, "name": "Torneio", "status": "completed",
                         "has_qualifying": False, "is_satellite": False,
                         "sponsors": {"name": "Casa de Apostas"},
                         "created_at": "2026-06-08T00:00:00Z"}],
        "tournament_days": [], "tournament_players": [], "transactions": [],
        "prize_allocations": [], "players": [],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    monkeypatch.setattr(repmod, "supabase", fake)
    return fake


class _ResumoDePremio:
    """Stub do PrizeAllocationService: a matemática do prêmio já tem teste
    próprio; aqui só interessa que os números cheguem inteiros ao relatório."""
    rake_percentage = 20.0
    total_entries = 10000.0
    player_pool = 8000.0
    guaranteed_prize = 5000.0
    available_prize_pool = 8000.0
    reserved_prize_percentage = 3.0
    reserved_purpose = "Etapa final"
    reserved_amount = 300.0
    payable_pool = 7700.0
    total_allocated = 7700.0


@pytest.fixture
def resumo_de_premio(monkeypatch):
    from app.services import prize_allocation_service as pas
    monkeypatch.setattr(pas.PrizeAllocationService, "get_prize_summary",
                        staticmethod(lambda tid: _ResumoDePremio()))


class TestRelatorioDoTorneio:
    def _dia(self, id_=DIA, nome="Dia 1", tipo="regular"):
        return {"id": id_, "tournament_id": TOUR, "day_name": nome,
                "day_type": tipo, "status": "completed", "buy_in": 300,
                "created_at": "2026-06-08T00:00:00Z"}

    def _inscrito(self, dia, player, buy=1, rebuy=0, addon=0):
        return {"tournament_day_id": dia, "player_id": player,
                "buy_in_count": buy, "rebuy_count": rebuy, "addon_count": addon,
                "total_buy_in_amount": 300.0 * buy,
                "total_rebuy_amount": 300.0 * rebuy,
                "total_addon_amount": 150.0 * addon}

    def test_jogador_que_joga_dois_dias_conta_uma_vez_no_total(self, monkeypatch, resumo_de_premio):
        """"Total de jogadores" é gente distinta; somar por dia contaria o
        mesmo jogador duas vezes e inflaria o relatório do clube."""
        _monta_relatorio(monkeypatch,
                         tournament_days=[self._dia(DIA), self._dia("d2", "Dia 2")],
                         tournament_players=[self._inscrito(DIA, JOGADOR),
                                             self._inscrito("d2", JOGADOR)])
        r = R.get_tournament_report(TOUR)
        assert r.total_players == 1
        assert r.total_entries == 2

    def test_soma_entradas_e_receita_por_dia(self, monkeypatch, resumo_de_premio):
        _monta_relatorio(monkeypatch,
                         tournament_days=[self._dia()],
                         tournament_players=[self._inscrito(DIA, "p1", buy=1, rebuy=2, addon=1),
                                             self._inscrito(DIA, "p2", buy=1)])
        r = R.get_tournament_report(TOUR)
        assert (r.total_buy_ins, r.total_rebuys, r.total_addons) == (2, 2, 1)
        assert r.days[0].players == 2
        assert r.days[0].revenue == 300 + 600 + 150 + 300

    def test_receita_vem_das_transacoes_e_ignora_premio(self, monkeypatch, resumo_de_premio):
        """Prêmio é saída; entrar na receita dobraria o faturamento da etapa."""
        _monta_relatorio(monkeypatch, transactions=[
            {"tournament_id": TOUR, "type": "buy_in", "amount": 300},
            {"tournament_id": TOUR, "type": "rebuy", "amount": 300},
            {"tournament_id": TOUR, "type": "prize", "amount": 5000},
        ])
        assert R.get_tournament_report(TOUR).total_revenue == 600.0

    def test_rake_e_a_diferenca_real_e_nao_o_percentual(self, monkeypatch, resumo_de_premio):
        """Com tipos de compra diferentes, cada transação tem o seu rake; o
        percentual do dia é só o padrão."""
        _monta_relatorio(monkeypatch)
        assert R.get_tournament_report(TOUR).rake_amount == 2000.0

    def test_premio_distribuido_conta_so_dinheiro_ja_pago(self, monkeypatch, resumo_de_premio):
        """Vaga não é dinheiro e prêmio não pago ainda está no caixa."""
        _monta_relatorio(monkeypatch, prize_allocations=[
            {"id": "a1", "tournament_id": TOUR, "position": 1, "prize_type": "cash",
             "prize_amount": 3000, "paid": True, "released": True, "visible": True,
             "players": {"name": "Campeão"}},
            {"id": "a2", "tournament_id": TOUR, "position": 2, "prize_type": "cash",
             "prize_amount": 2000, "paid": False, "released": True, "visible": True,
             "players": None},
            {"id": "a3", "tournament_id": TOUR, "position": 3, "prize_type": "vaga",
             "prize_amount": 1000, "paid": True, "released": True, "visible": True,
             "players": None},
        ])
        r = R.get_tournament_report(TOUR)
        assert r.total_distributed == 3000.0
        assert r.vagas_count == 1
        assert r.vagas_generated == 0
        assert len(r.prizes) == 3

    def test_conta_as_vagas_ja_convertidas_em_ticket(self, monkeypatch, resumo_de_premio):
        _monta_relatorio(monkeypatch, prize_allocations=[
            {"id": "a1", "tournament_id": TOUR, "position": 1, "prize_type": "vaga",
             "prize_amount": 0, "paid": False, "released": True, "visible": True,
             "generated_ticket_id": "t1", "players": None}])
        assert R.get_tournament_report(TOUR).vagas_generated == 1

    def test_conta_premios_ainda_nao_liberados(self, monkeypatch, resumo_de_premio):
        """Prêmio não liberado é o que o clube ainda precisa conferir antes de
        pagar."""
        _monta_relatorio(monkeypatch, prize_allocations=[
            {"id": "a1", "tournament_id": TOUR, "position": 1, "prize_type": "cash",
             "prize_amount": 100, "paid": False, "released": False, "visible": True,
             "players": None},
            {"id": "a2", "tournament_id": TOUR, "position": 2, "prize_type": "cash",
             "prize_amount": 50, "paid": True, "released": True, "visible": True,
             "players": None}])
        assert R.get_tournament_report(TOUR).pending_release == 1

    def test_traz_o_patrocinador(self, monkeypatch, resumo_de_premio):
        _monta_relatorio(monkeypatch)
        assert R.get_tournament_report(TOUR).sponsor_name == "Casa de Apostas"

    def test_torneio_inexistente_da_404(self, monkeypatch, resumo_de_premio):
        from fastapi import HTTPException
        _monta_relatorio(monkeypatch, tournaments=[])
        with pytest.raises(HTTPException) as e:
            R.get_tournament_report(TOUR)
        assert e.value.status_code == 404

    def test_torneio_sem_dias_nem_premios(self, monkeypatch, resumo_de_premio):
        _monta_relatorio(monkeypatch)
        r = R.get_tournament_report(TOUR)
        assert r.days == []
        assert r.prizes == []
        assert r.total_players == 0


class TestRelatorioPorPeriodo:
    def test_usa_a_rpc_de_totais(self, monkeypatch):
        fake = _monta_relatorio(monkeypatch)
        fake.rpcs["get_reports_totals"] = [{
            "total_revenue": 12000, "total_buy_ins": 30, "total_rebuys": 8,
            "total_addons": 5, "avg_buy_in": 300}]
        r = R.get_reports("2026-06-01", "2026-06-30")
        assert r.totalRevenue == 12000
        assert r.totalPlayers == 43        # entradas somadas

    def test_sem_a_rpc_soma_em_python(self, monkeypatch):
        """Cliente sem a migração continua tendo relatório, só com mais
        trabalho no servidor."""
        _monta_relatorio(monkeypatch, transactions=[
            {"id": "t1", "type": "buy_in", "amount": 300,
             "created_at": "2026-06-10T00:00:00Z"},
            {"id": "t2", "type": "rebuy", "amount": 300,
             "created_at": "2026-06-11T00:00:00Z"},
            {"id": "t3", "type": "prize", "amount": 5000,
             "created_at": "2026-06-12T00:00:00Z"},
        ])
        r = R.get_reports("2026-06-01", "2026-06-30")
        assert r.totalRevenue == 600.0
        assert (r.totalBuyIns, r.totalRebuys, r.totalAddons) == (1, 1, 0)
        assert r.avgBuyIn == 300.0

    def test_o_fim_do_periodo_inclui_o_dia_inteiro(self, monkeypatch):
        """Com corte à meia-noite, tudo que aconteceu no último dia ficaria de
        fora — e o clube fecharia a etapa com o caixa errado."""
        _monta_relatorio(monkeypatch, transactions=[
            {"id": "t1", "type": "buy_in", "amount": 300,
             "created_at": "2026-06-30T22:30:00"}])
        assert R.get_reports("2026-06-01", "2026-06-30").totalRevenue == 300.0

    def test_sem_buy_in_a_media_e_zero(self, monkeypatch):
        """Divisão por zero derrubaria o relatório de um período vazio."""
        _monta_relatorio(monkeypatch, transactions=[])
        assert R.get_reports("2026-06-01", "2026-06-30").avgBuyIn == 0

    def test_agrupa_o_gasto_por_jogador(self, monkeypatch):
        _monta_relatorio(monkeypatch, tournament_players=[
            {"tournament_id": TOUR, "buy_in_count": 1, "rebuy_count": 1,
             "addon_count": 0, "total_spent": 600, "players": {"name": "Fulano"}},
            {"tournament_id": TOUR, "buy_in_count": 1, "rebuy_count": 0,
             "addon_count": 1, "total_spent": 450, "players": {"name": "Fulano"}},
            {"tournament_id": TOUR, "buy_in_count": 1, "rebuy_count": 0,
             "addon_count": 0, "total_spent": 300, "players": {"name": "Beltrano"}},
        ])
        r = R.get_reports()
        por_nome = {p.player_name: p for p in r.playerReports}
        assert por_nome["Fulano"].total_spent == 1050.0
        assert por_nome["Fulano"].total_entries == 4
        assert por_nome["Beltrano"].total_entries == 1

    def test_periodo_sem_torneio_nao_traz_jogador(self, monkeypatch):
        _monta_relatorio(monkeypatch, tournaments=[], tournament_players=[
            {"tournament_id": TOUR, "buy_in_count": 1, "rebuy_count": 0,
             "addon_count": 0, "total_spent": 300, "players": {"name": "Fulano"}}])
        assert R.get_reports("2026-01-01", "2026-01-31").playerReports == []

    def test_sem_periodo_traz_tudo(self, monkeypatch):
        _monta_relatorio(monkeypatch, tournament_players=[
            {"tournament_id": TOUR, "buy_in_count": 1, "rebuy_count": 0,
             "addon_count": 0, "total_spent": 300, "players": {"name": "Fulano"}}])
        assert len(R.get_reports().playerReports) == 1

    def test_jogador_sem_nome_nao_quebra(self, monkeypatch):
        _monta_relatorio(monkeypatch, tournament_players=[
            {"tournament_id": TOUR, "buy_in_count": 1, "rebuy_count": 0,
             "addon_count": 0, "total_spent": 300, "players": {}}])
        assert R.get_reports().playerReports[0].player_name == "Unknown"


# ---------------------------------------------------------------------------
# Modelos de estrutura de blind
# ---------------------------------------------------------------------------

def _monta_modelo(monkeypatch, **tabelas):
    base = {
        "blind_templates": [], "blinds": [],
        "tournament_days": [{"id": DIA, "tournament_id": TOUR}],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    monkeypatch.setattr(btmod, "supabase", fake)
    return fake


def _modelo(id_=MODELO, **kw):
    base = {"id": id_, "name": "Turbo", "description": None, "stage_id": None,
            "blind_duration": 15, "initial_small_blind": 25,
            "initial_big_blind": 50, "blind_increase_type": "double",
            "bb_ante_start_level": 3, "break_interval": 60, "break_duration": 10,
            "custom_levels": None, "created_at": "2026-06-08T00:00:00Z",
            "updated_at": "2026-06-08T00:00:00Z"}
    base.update(kw)
    return base


class TestCrudDeModelos:
    def test_cria(self, monkeypatch):
        fake = _monta_modelo(monkeypatch)
        r = B.create_template(BlindTemplateCreate(name="Turbo"), user_id=AUTOR)
        assert r.name == "Turbo"
        assert fake.store["blind_templates"][0]["created_by"] == AUTOR

    def test_cria_sem_autor(self, monkeypatch):
        fake = _monta_modelo(monkeypatch)
        B.create_template(BlindTemplateCreate(name="Turbo"))
        assert "created_by" not in fake.store["blind_templates"][0]

    def test_busca_um(self, monkeypatch):
        _monta_modelo(monkeypatch, blind_templates=[_modelo()])
        assert B.get_template(MODELO).name == "Turbo"

    def test_inexistente(self, monkeypatch):
        _monta_modelo(monkeypatch)
        assert B.get_template(MODELO) is None

    def test_lista_em_ordem_alfabetica(self, monkeypatch):
        _monta_modelo(monkeypatch, blind_templates=[
            _modelo(MODELO, name="Turbo"), _modelo(MODELO2, name="Deep")])
        assert [t.name for t in B.get_templates()] == ["Deep", "Turbo"]

    def test_atualiza_e_carimba_o_horario(self, monkeypatch):
        _monta_modelo(monkeypatch, blind_templates=[_modelo()])
        r = B.update_template(MODELO, BlindTemplateUpdate(name="Lento"))
        assert r.name == "Lento"

    def test_atualizar_inexistente(self, monkeypatch):
        _monta_modelo(monkeypatch)
        assert B.update_template(MODELO, BlindTemplateUpdate(name="X")) is None

    def test_apaga(self, monkeypatch):
        fake = _monta_modelo(monkeypatch, blind_templates=[_modelo()])
        assert B.delete_template(MODELO) is True
        assert fake.store["blind_templates"] == []

    def test_apagar_inexistente(self, monkeypatch):
        _monta_modelo(monkeypatch)
        assert B.delete_template(MODELO) is False


class TestGeracaoDeNiveis:
    def test_niveis_sao_continuos_mesmo_com_intervalo_no_meio(self, monkeypatch):
        """O intervalo ocupa um `level` próprio. Repetir número deixaria o
        relógio sem saber qual estrutura aplicar naquele momento."""
        blinds = B._generate_blinds(_modelo(), DIA, TOUR, num_levels=8)
        niveis = [b["level"] for b in blinds]
        assert niveis == list(range(1, len(blinds) + 1))

    def test_intervalo_entra_no_ritmo_configurado(self, monkeypatch):
        """60min de intervalo com níveis de 15min = pausa depois de 4 níveis."""
        blinds = B._generate_blinds(_modelo(), DIA, TOUR, num_levels=8)
        pausas = [i for i, b in enumerate(blinds) if b["is_break"]]
        assert pausas
        assert blinds[pausas[0] - 1]["is_break"] is False
        assert blinds[pausas[0]]["duration"] == 10

    def test_sem_intervalo_configurado_nao_gera_pausa(self, monkeypatch):
        blinds = B._generate_blinds(_modelo(break_interval=0), DIA, TOUR, num_levels=6)
        assert not any(b["is_break"] for b in blinds)

    def test_dobrar_dobra_os_valores(self, monkeypatch):
        blinds = [b for b in B._generate_blinds(_modelo(), DIA, TOUR, num_levels=3)
                  if not b["is_break"]]
        assert [b["small_blind"] for b in blinds] == [25, 50, 100]

    def test_gradual_arredonda_para_valores_de_mesa(self, monkeypatch):
        """Blind de 37 não existe em mesa; a ficha mínima não permite."""
        blinds = [b for b in B._generate_blinds(
            _modelo(blind_increase_type="gradual"), DIA, TOUR, num_levels=4)
            if not b["is_break"]]
        assert all(b["small_blind"] % 5 == 0 for b in blinds)

    def test_ante_comeca_no_nivel_configurado(self, monkeypatch):
        blinds = [b for b in B._generate_blinds(_modelo(bb_ante_start_level=3),
                                                DIA, TOUR, num_levels=4)
                  if not b["is_break"]]
        assert blinds[0]["ante"] == 0
        assert blinds[1]["ante"] == 0
        assert blinds[2]["ante"] == blinds[2]["big_blind"]

    @pytest.mark.parametrize("valor,esperado", [
        (37, 35), (38, 40),            # < 100 → múltiplo de 5
        (137, 125), (140, 150),        # < 1000 → múltiplo de 25
        (1370, 1400),                  # < 10000 → múltiplo de 100
        (13700, 13500),                # ≥ 10000 → múltiplo de 500
    ])
    def test_arredondamento_por_faixa(self, valor, esperado):
        assert B._round_to_nice_number(valor) == esperado


class TestAplicacaoDoModelo:
    def test_aplica_os_niveis_customizados(self, monkeypatch):
        """Estrutura desenhada à mão vale como está — não é regerada."""
        fake = _monta_modelo(monkeypatch, blind_templates=[_modelo(custom_levels=[
            {"level": 1, "small_blind": 100, "big_blind": 200, "ante": 0,
             "duration": 20, "is_break": False},
            {"level": 2, "small_blind": 0, "big_blind": 0, "duration": 10,
             "is_break": True},
        ])])
        r = B.apply_template_to_day(MODELO, DIA)
        assert len(r) == 2
        assert fake.store["blinds"][0]["small_blind"] == 100
        assert fake.store["blinds"][1]["is_break"] is True

    def test_sem_niveis_customizados_gera_a_estrutura(self, monkeypatch):
        fake = _monta_modelo(monkeypatch, blind_templates=[_modelo()])
        B.apply_template_to_day(MODELO, DIA)
        assert len(fake.store["blinds"]) > 10

    def test_limpa_a_estrutura_anterior_por_padrao(self, monkeypatch):
        """Sem limpar, os níveis do modelo antigo e do novo conviveriam e o
        relógio veria duas estruturas."""
        fake = _monta_modelo(monkeypatch, blind_templates=[_modelo(custom_levels=[
            {"level": 1, "small_blind": 100, "big_blind": 200, "duration": 20}])],
            blinds=[{"id": "antigo", "tournament_day_id": DIA, "level": 1,
                     "small_blind": 999, "big_blind": 1998}])
        B.apply_template_to_day(MODELO, DIA)
        assert [b["small_blind"] for b in fake.store["blinds"]] == [100]

    def test_pode_manter_a_estrutura_anterior(self, monkeypatch):
        fake = _monta_modelo(monkeypatch, blind_templates=[_modelo(custom_levels=[
            {"level": 2, "small_blind": 100, "big_blind": 200, "duration": 20}])],
            blinds=[{"id": "antigo", "tournament_day_id": DIA, "level": 1,
                     "small_blind": 999, "big_blind": 1998}])
        B.apply_template_to_day(MODELO, DIA, clear_existing=False)
        assert len(fake.store["blinds"]) == 2

    def test_o_torneio_e_gravado_junto_com_o_dia(self, monkeypatch):
        fake = _monta_modelo(monkeypatch, blind_templates=[_modelo(custom_levels=[
            {"level": 1, "small_blind": 100, "big_blind": 200, "duration": 20}])])
        B.apply_template_to_day(MODELO, DIA)
        assert fake.store["blinds"][0]["tournament_id"] == TOUR

    def test_modelo_inexistente(self, monkeypatch):
        _monta_modelo(monkeypatch)
        with pytest.raises(ValueError, match="Template not found"):
            B.apply_template_to_day(MODELO, DIA)

    def test_dia_inexistente(self, monkeypatch):
        _monta_modelo(monkeypatch, blind_templates=[_modelo()], tournament_days=[])
        with pytest.raises(ValueError, match="Tournament day not found"):
            B.apply_template_to_day(MODELO, DIA)


class TestSalvarEstruturaComoModelo:
    def _blind(self, nivel, sb=100, bb=200, pausa=False, duracao=15):
        return {"id": f"b{nivel}", "tournament_day_id": DIA, "level": nivel,
                "small_blind": sb, "big_blind": bb, "ante": 0,
                "duration": duracao, "is_break": pausa}

    def test_copia_a_estrutura_do_dia(self, monkeypatch):
        """Caminho inverso: o clube monta no dia, gosta, e guarda para
        reusar sem redigitar nível por nível."""
        fake = _monta_modelo(monkeypatch, blinds=[
            self._blind(1), self._blind(2, 200, 400)])
        r = B.save_blinds_as_template(DIA, "Minha Estrutura", user_id=AUTOR)
        assert r.name == "Minha Estrutura"
        guardado = fake.store["blind_templates"][0]
        assert len(guardado["custom_levels"]) == 2
        assert guardado["blind_increase_type"] == "custom"
        assert guardado["created_by"] == AUTOR

    def test_os_valores_iniciais_saem_do_primeiro_nivel_jogavel(self, monkeypatch):
        """Se a estrutura começar com um intervalo, pegar o primeiro nível
        daria blind zero como valor inicial do modelo."""
        fake = _monta_modelo(monkeypatch, blinds=[
            self._blind(1, 0, 0, pausa=True, duracao=10),
            self._blind(2, 300, 600, duracao=20)])
        B.save_blinds_as_template(DIA, "X")
        guardado = fake.store["blind_templates"][0]
        assert guardado["initial_small_blind"] == 300
        assert guardado["blind_duration"] == 20

    def test_associa_a_etapa_quando_informada(self, monkeypatch):
        fake = _monta_modelo(monkeypatch, blinds=[self._blind(1)])
        B.save_blinds_as_template(DIA, "X", stage_id=ETAPA)
        assert fake.store["blind_templates"][0]["stage_id"] == ETAPA

    def test_dia_sem_estrutura(self, monkeypatch):
        _monta_modelo(monkeypatch)
        with pytest.raises(ValueError, match="No blinds found"):
            B.save_blinds_as_template(DIA, "X")
