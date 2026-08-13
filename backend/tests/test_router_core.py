"""Testes da camada HTTP do núcleo: torneios, inscrições, transações e caixa.

Três decisões de projeto aparecem aqui e são o que os testes fixam:

1. **Torneio sem etapa não existe.** A etapa vem do header (preferido) ou
   do corpo; sem nenhum dos dois, 400. Um torneio órfão de etapa não
   aparece em tela nenhuma e não entra em DRE nenhum.
2. **`GET /tournaments/{id}` é público de propósito** — é o que a tela de
   transmissão lê. Já a LISTA exige autenticação, porque atravessa etapas.
3. **Inscrição usa 404 para erro de regra**, e não 400: o texto do
   ValueError do service ("jogador já inscrito", "dia lotado") é o que o
   operador lê. Os testes travam esse contrato para que uma refatoração
   não troque o código e quebre a mensagem no balcão.
"""
import pytest

from app.models.tournament import Tournament, TournamentSummary
from app.models.tournament_player import TournamentPlayer, TournamentPlayerDetail
from app.models.transaction import TransactionDetail
from app.models.cash_register import (
    StageCashRegister, GeneralCashRegister, RakeRegister,
    SangriaTransaction, CashDashboard, StageCashSummary, SangriaResponse,
    StageCashScopedSummary, StagePaymentBreakdown, PaymentMethodTotal,
)
from app.services.tournament_service import TournamentService as TS
from app.services.tournament_player_service import TournamentPlayerService as TPS
from app.services.transaction_service import TransactionService as TrS
from app.services.cash_register_service import CashRegisterService as CRS

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
ETAPA = "11111111-1111-1111-1111-111111111111"
OUTRA_ETAPA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
DIA = "77777777-7777-7777-7777-777777777777"
JOGADOR = "44444444-4444-4444-4444-444444444444"
TP = "55555555-5555-5555-5555-555555555555"
AUTOR = "88888888-8888-8888-8888-888888888888"


def _torneio(stage_id=ETAPA):
    return Tournament(id=TOUR, name="Torneio", stage_id=stage_id,
                      created_by=AUTOR, created_at="2026-06-08T00:00:00Z")


def _inscricao(status="active", gasto=100.0):
    return TournamentPlayer(id=TP, tournament_id=TOUR, player_id=JOGADOR,
                            total_spent=gasto, status=status,
                            registered_at="2026-06-08T00:00:00Z")


def _inscricao_detalhe():
    return TournamentPlayerDetail(
        id=TP, tournament_id=TOUR, player_id=JOGADOR, total_spent=100.0,
        status="active", registered_at="2026-06-08T00:00:00Z",
        player_name="Fulano", tournament_name="Torneio")


def _transacao(tipo="buy_in", valor=100.0):
    return TransactionDetail(id="tx1", tournament_id=TOUR, player_id=JOGADOR,
                             type=tipo, amount=valor,
                             created_at="2026-06-08T00:00:00Z",
                             player_name="Fulano", tournament_name="Torneio")


@pytest.fixture
def etapa_no_banco(monkeypatch):
    """A criação de torneio valida a etapa direto no banco."""
    fake = FakeSupabase({"stages": [{"id": ETAPA, "name": "Etapa 1"}]})
    monkeypatch.setattr("app.database.supabase_client.supabase", fake)
    return fake


class TestCriacaoDeTorneio:
    def test_a_etapa_do_header_manda(self, client, stub, etapa_no_banco):
        """O header é o que a interface realmente usa; o corpo é fallback para
        chamadas diretas à API."""
        recebidos = {}

        def _cria(dados, uid):
            recebidos["stage"] = dados.stage_id
            return _torneio()

        stub(TS, create_tournament=_cria)
        r = client.post("/tournaments", json={"name": "Torneio", "stage_id": OUTRA_ETAPA},
                        headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 201
        assert recebidos["stage"] == ETAPA

    def test_sem_header_usa_a_etapa_do_corpo(self, client, stub, etapa_no_banco):
        recebidos = {}

        def _cria(dados, uid):
            recebidos["stage"] = dados.stage_id
            return _torneio()

        stub(TS, create_tournament=_cria)
        client.post("/tournaments", json={"name": "Torneio", "stage_id": ETAPA})
        assert recebidos["stage"] == ETAPA

    def test_sem_etapa_nenhuma_da_400(self, client, etapa_no_banco):
        """Um torneio órfão de etapa não aparece em tela nenhuma."""
        r = client.post("/tournaments", json={"name": "Torneio"})
        assert r.status_code == 400
        assert "etapa" in r.json()["detail"]

    def test_etapa_inexistente_da_404(self, client, etapa_no_banco):
        r = client.post("/tournaments", json={"name": "T"},
                        headers={"X-Stage-ID": "etapa-fantasma"})
        assert r.status_code == 404


class TestLeituraDeTorneio:
    def test_lista_com_o_header_vencendo_a_query(self, client, stub):
        recebidos = {}

        def _resumo(stage_id=None):
            recebidos["stage"] = stage_id
            return []

        stub(TS, get_tournament_summary=_resumo)
        client.get(f"/tournaments?stage_id={OUTRA_ETAPA}", headers={"X-Stage-ID": ETAPA})
        assert recebidos["stage"] == ETAPA

    def test_lista_cai_na_query_sem_o_header(self, client, stub):
        recebidos = {}

        def _resumo(stage_id=None):
            recebidos["stage"] = stage_id
            return []

        stub(TS, get_tournament_summary=_resumo)
        client.get(f"/tournaments?stage_id={ETAPA}")
        assert recebidos["stage"] == ETAPA

    def test_busca_um(self, client, stub):
        stub(TS, get_tournament=lambda tid: _torneio())
        assert client.get(f"/tournaments/{TOUR}").json()["id"] == TOUR

    def test_inexistente_da_404(self, client, stub):
        stub(TS, get_tournament=lambda tid: None)
        assert client.get(f"/tournaments/{TOUR}").status_code == 404


class TestEdicaoDeTorneio:
    def test_atualiza(self, client, stub):
        stub(TS, update_tournament=lambda tid, d: _torneio())
        assert client.patch(f"/tournaments/{TOUR}", json={"name": "Novo"}).status_code == 200

    def test_torneio_de_outra_etapa_da_403(self, client, stub):
        stub(TS, get_tournament=lambda tid: _torneio(stage_id=OUTRA_ETAPA))
        r = client.patch(f"/tournaments/{TOUR}", json={"name": "X"},
                         headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 403

    def test_atualizar_inexistente_com_etapa_da_404(self, client, stub):
        stub(TS, get_tournament=lambda tid: None)
        r = client.patch(f"/tournaments/{TOUR}", json={"name": "X"},
                         headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 404

    def test_atualizar_inexistente_sem_etapa_da_404(self, client, stub):
        stub(TS, update_tournament=lambda tid, d: None)
        assert client.patch(f"/tournaments/{TOUR}", json={"name": "X"}).status_code == 404

    def test_apaga(self, client, stub):
        stub(TS, delete_tournament=lambda tid: True)
        assert client.delete(f"/tournaments/{TOUR}").status_code == 204

    def test_apagar_de_outra_etapa_da_403(self, client, stub):
        stub(TS, get_tournament=lambda tid: _torneio(stage_id=OUTRA_ETAPA))
        r = client.delete(f"/tournaments/{TOUR}", headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 403

    def test_apagar_inexistente_com_etapa_da_404(self, client, stub):
        stub(TS, get_tournament=lambda tid: None)
        r = client.delete(f"/tournaments/{TOUR}", headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 404

    def test_apagar_inexistente_sem_etapa_da_404(self, client, stub):
        stub(TS, delete_tournament=lambda tid: False)
        assert client.delete(f"/tournaments/{TOUR}").status_code == 404


class TestInscricoes:
    def test_inscreve(self, client, stub):
        recebidos = {}

        def _registra(dados, uid):
            recebidos["autor"] = uid
            return _inscricao_detalhe()

        stub(TPS, register_player=_registra)
        r = client.post("/tournament-players",
                        json={"tournament_id": TOUR, "player_id": JOGADOR})
        assert r.status_code == 201
        assert recebidos["autor"] == AUTOR

    def test_jogador_ja_inscrito_devolve_o_texto_do_service(self, client, stub):
        """A mensagem é lida em voz alta para o jogador no balcão; o teste
        garante que ela chega inteira, e não trocada por um genérico."""
        def _estoura(dados, uid):
            raise ValueError("Jogador já inscrito neste dia")
        stub(TPS, register_player=_estoura)
        r = client.post("/tournament-players",
                        json={"tournament_id": TOUR, "player_id": JOGADOR})
        assert r.status_code == 404
        assert r.json()["detail"] == "Jogador já inscrito neste dia"

    @pytest.mark.parametrize("acao,metodo", [("rebuy", "add_rebuy"), ("addon", "add_addon")])
    def test_rebuy_e_addon(self, client, stub, acao, metodo):
        stub(TPS, **{metodo: lambda tpid, uid, payment_source="cash",
                     payment_method="cash", buy_type_id=None: _inscricao(gasto=200.0)})
        r = client.post(f"/tournament-players/{TP}/{acao}")
        assert r.status_code == 200
        assert r.json()["total_spent"] == 200.0

    @pytest.mark.parametrize("acao,metodo", [("rebuy", "add_rebuy"), ("addon", "add_addon")])
    def test_forma_de_pagamento_e_tipo_de_compra_chegam_ao_service(self, client, stub, acao, metodo):
        """`buy_type_id` define o rake real da transação; se ele se perder no
        caminho, o rake volta a ser o percentual genérico do dia."""
        recebidos = {}

        def _acao(tpid, uid, payment_source="cash", payment_method="cash", buy_type_id=None):
            recebidos.update(fonte=payment_source, forma=payment_method, tipo=buy_type_id)
            return _inscricao()

        stub(TPS, **{metodo: _acao})
        client.post(f"/tournament-players/{TP}/{acao}"
                    "?payment_source=credit&payment_method=pix&buy_type_id=bt1")
        assert recebidos == {"fonte": "credit", "forma": "pix", "tipo": "bt1"}

    @pytest.mark.parametrize("acao,metodo", [("rebuy", "add_rebuy"), ("addon", "add_addon")])
    def test_fora_do_nivel_permitido_da_404_com_motivo(self, client, stub, acao, metodo):
        def _estoura(tpid, uid, payment_source="cash", payment_method="cash", buy_type_id=None):
            raise ValueError("Rebuy não permitido após o nível 6")
        stub(TPS, **{metodo: _estoura})
        r = client.post(f"/tournament-players/{TP}/{acao}")
        assert r.status_code == 404
        assert "nível 6" in r.json()["detail"]

    def test_lista_por_torneio(self, client, stub):
        stub(TPS, get_tournament_players=lambda tid: [_inscricao_detalhe()])
        assert len(client.get(f"/tournament-players/tournament/{TOUR}").json()) == 1

    def test_lista_por_dia(self, client, stub):
        stub(TPS, get_tournament_day_players=lambda did: [_inscricao_detalhe()])
        assert len(client.get(f"/tournament-players/day/{DIA}").json()) == 1

    def test_atualiza(self, client, stub):
        stub(TPS, update_tournament_player=lambda tpid, d: _inscricao(status="eliminated"))
        r = client.patch(f"/tournament-players/{TP}", json={"status": "eliminated"})
        assert r.json()["status"] == "eliminated"

    def test_atualizar_inexistente_da_404(self, client, stub):
        stub(TPS, update_tournament_player=lambda tpid, d: None)
        assert client.patch(f"/tournament-players/{TP}", json={}).status_code == 404

    def test_elimina(self, client, stub):
        stub(TPS, eliminate_player=lambda tpid, uid: _inscricao(status="eliminated"))
        assert client.post(f"/tournament-players/{TP}/eliminate").json()["status"] == "eliminated"

    def test_eliminar_inexistente_da_404(self, client, stub):
        def _estoura(tpid, uid):
            raise ValueError("Inscrição não encontrada")
        stub(TPS, eliminate_player=_estoura)
        assert client.post(f"/tournament-players/{TP}/eliminate").status_code == 404


class TestTransacoes:
    def _corpo(self):
        return {"tournament_id": TOUR, "player_id": JOGADOR,
                "type": "buy_in", "amount": 100}

    def test_cria(self, client, stub):
        stub(TrS, create_transaction=lambda t, uid: _transacao())
        assert client.post("/transactions", json=self._corpo()).status_code == 201

    def test_erro_de_regra_da_400(self, client, stub):
        def _estoura(t, uid):
            raise ValueError("valor não confere com o buy-in do dia")
        stub(TrS, create_transaction=_estoura)
        assert client.post("/transactions", json=self._corpo()).status_code == 400

    def test_torneio_de_outra_etapa_da_403(self, client, stub):
        """Sem isso, dinheiro de um clube entraria no caixa de outra etapa."""
        stub(TS, get_tournament=lambda tid: _torneio(stage_id=OUTRA_ETAPA))
        r = client.post("/transactions", json=self._corpo(),
                        headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 403

    def test_torneio_inexistente_da_404(self, client, stub):
        stub(TS, get_tournament=lambda tid: None)
        r = client.post("/transactions", json=self._corpo(),
                        headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 404

    def test_lista_filtrada_pela_etapa_do_header(self, client, stub):
        recebidos = {}

        def _lista(stage_id=None):
            recebidos["stage"] = stage_id
            return []

        stub(TrS, get_transactions=_lista)
        client.get("/transactions", headers={"X-Stage-ID": ETAPA})
        assert recebidos["stage"] == ETAPA

    def test_lista_por_torneio(self, client, stub):
        stub(TrS, get_transactions_by_tournament=lambda tid: [_transacao()])
        assert len(client.get(f"/transactions/tournament/{TOUR}").json()) == 1

    def test_lista_por_torneio_de_outra_etapa_da_403(self, client, stub):
        stub(TS, get_tournament=lambda tid: _torneio(stage_id=OUTRA_ETAPA))
        r = client.get(f"/transactions/tournament/{TOUR}", headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 403

    def test_lista_por_torneio_inexistente_da_404(self, client, stub):
        stub(TS, get_tournament=lambda tid: None)
        r = client.get(f"/transactions/tournament/{TOUR}", headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 404

    def test_lista_por_jogador(self, client, stub):
        stub(TrS, get_transactions_by_player=lambda pid: [_transacao()])
        assert len(client.get(f"/transactions/player/{JOGADOR}").json()) == 1


class TestCaixa:
    def _caixa_etapa(self, saldo=1000.0):
        return StageCashRegister(id="sc1", stage_id=ETAPA, current_balance=saldo,
                                 created_at="2026-06-08T00:00:00Z")

    def test_caixa_da_etapa(self, client, stub):
        stub(CRS, get_stage_cash=lambda sid: self._caixa_etapa())
        assert float(client.get(f"/cash/stage/{ETAPA}").json()["current_balance"]) == 1000.0

    def test_etapa_sem_caixa_da_404(self, client, stub):
        stub(CRS, get_stage_cash=lambda sid: None)
        assert client.get(f"/cash/stage/{ETAPA}").status_code == 404

    def test_rake_pendente_para_previa_da_sangria(self, client, stub):
        """A tela mostra quanto de rake sairá ANTES de confirmar — sem isso a
        sangria é feita às cegas."""
        stub(CRS, get_stage_cash=lambda sid: self._caixa_etapa(2000.0),
             get_stage_pending_rake=lambda sid: 400.0)
        r = client.get(f"/cash/stage/{ETAPA}/pending-rake").json()
        assert r["pending_rake"] == 400.0
        assert r["stage_balance"] == 2000.0

    def test_rake_pendente_sem_caixa_mostra_saldo_zero(self, client, stub):
        stub(CRS, get_stage_cash=lambda sid: None,
             get_stage_pending_rake=lambda sid: 0)
        assert client.get(f"/cash/stage/{ETAPA}/pending-rake").json()["stage_balance"] == 0.0

    def test_resumo_da_etapa(self, client, stub):
        """A tela precisa separar o que e DESTA etapa do total do clube; sem
        essa rota o operador le o caixa geral inteiro como se fosse da noite."""
        stub(CRS, get_stage_cash_summary=lambda sid: StageCashScopedSummary(
            stage_id=sid, current_balance=1000, total_sangrias=400, sangria_count=2,
            rake_generated=140, rake_extracted=80, pending_rake=60, net_to_general=320))
        r = client.get(f"/cash/stage/{ETAPA}/summary")
        assert r.status_code == 200
        assert float(r.json()["net_to_general"]) == 320.0
        assert r.json()["sangria_count"] == 2

    def test_entradas_por_metodo_de_pagamento(self, client, stub):
        stub(CRS, get_stage_totals_by_payment_method=lambda sid: StagePaymentBreakdown(
            stage_id=sid, total=450,
            methods=[PaymentMethodTotal(code="pix", total=300, count=1),
                     PaymentMethodTotal(code=None, total=150, count=2)]))
        r = client.get(f"/cash/stage/{ETAPA}/payment-methods")
        assert r.status_code == 200
        assert float(r.json()["total"]) == 450.0
        # metodo nao informado viaja como null, nao como "cash"
        assert r.json()["methods"][1]["code"] is None

    def test_lista_todos_os_caixas_de_etapa(self, client, stub):
        stub(CRS, get_all_stage_cash=lambda: [StageCashSummary(
            stage_id=ETAPA, stage_name="Etapa 1", stage_location="Rio",
            stage_status="active", cash_register=self._caixa_etapa())])
        assert len(client.get("/cash/stage").json()) == 1

    def test_caixa_geral(self, client, stub):
        stub(CRS, get_general_cash=lambda: GeneralCashRegister(
            id="gc1", created_at="2026-06-08T00:00:00Z"))
        assert client.get("/cash/general").status_code == 200

    def test_falha_no_caixa_geral_da_500(self, client, stub):
        def _estoura():
            raise RuntimeError("banco fora do ar")
        stub(CRS, get_general_cash=_estoura)
        assert client.get("/cash/general").status_code == 500

    def test_rake_acumulado(self, client, stub):
        stub(CRS, get_rake_register=lambda: RakeRegister(
            id="rk1", created_at="2026-06-08T00:00:00Z"))
        assert client.get("/cash/rake").status_code == 200

    def test_falha_no_rake_da_500(self, client, stub):
        def _estoura():
            raise RuntimeError("boom")
        stub(CRS, get_rake_register=_estoura)
        assert client.get("/cash/rake").status_code == 500

    def _sangria(self):
        return SangriaTransaction(id="sg1", stage_id=ETAPA, stage_name="Etapa 1",
                                  amount=500.0, rake_amount=100.0, net_amount=400.0,
                                  created_at="2026-06-08T00:00:00Z")

    def test_sangria(self, client, stub):
        stub(CRS, perform_sangria=lambda sangria_data, user_id: SangriaResponse(
            success=True, message="ok", sangria_transaction=self._sangria(),
            updated_stage_cash=self._caixa_etapa(500.0),
            updated_general_cash=GeneralCashRegister(id="gc1", created_at="2026-06-08T00:00:00Z"),
            updated_rake=RakeRegister(id="rk1", created_at="2026-06-08T00:00:00Z")))
        r = client.post("/cash/sangria", json={"stage_id": ETAPA,
                                               "stage_name": "Etapa 1", "amount": 500})
        assert r.status_code == 201
        assert float(r.json()["sangria_transaction"]["net_amount"]) == 400.0

    def test_sangria_maior_que_o_caixa_da_400(self, client, stub):
        """Deixaria o caixa da etapa negativo — sinal de erro de digitação."""
        def _estoura(sangria_data, user_id):
            raise ValueError("Saldo insuficiente no caixa da etapa")
        stub(CRS, perform_sangria=_estoura)
        r = client.post("/cash/sangria", json={"stage_id": ETAPA,
                                               "stage_name": "E", "amount": 99999})
        assert r.status_code == 400

    def test_falha_inesperada_na_sangria_da_500(self, client, stub):
        def _estoura(sangria_data, user_id):
            raise RuntimeError("boom")
        stub(CRS, perform_sangria=_estoura)
        r = client.post("/cash/sangria", json={"stage_id": ETAPA,
                                               "stage_name": "E", "amount": 1})
        assert r.status_code == 500

    def test_historico(self, client, stub):
        stub(CRS, get_sangria_history=lambda stage_id=None, limit=50: [self._sangria()])
        assert len(client.get("/cash/sangria/history").json()) == 1

    def test_historico_respeita_o_teto_de_registros(self, client):
        """Limite acima de 200 seria uma consulta capaz de derrubar a tela."""
        assert client.get("/cash/sangria/history?limit=500").status_code == 422

    def test_painel(self, client, stub):
        stub(CRS, get_cash_dashboard=lambda stage_id=None: CashDashboard(
            general_cash=GeneralCashRegister(id="gc1", created_at="2026-06-08T00:00:00Z"),
            rake=RakeRegister(id="rk1", created_at="2026-06-08T00:00:00Z")))
        assert client.get("/cash/dashboard").status_code == 200
