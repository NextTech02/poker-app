"""Testes da camada HTTP dos dias de torneio.

O router faz duas coisas que o service nao faz: recusa dia de OUTRA etapa
(o X-Stage-ID vem do cliente, entao a checagem tem que existir aqui) e
traduz erro de regra em status HTTP. Um 500 no lugar de um 400 tira do
operador a mensagem que diz o que fazer; um 200 onde deveria haver 403
vaza dado entre etapas.
"""
import pytest

from app.models.tournament_day import TournamentDay, QualifyingDayStats, TimerStatus
from app.models.tournament import Tournament
from app.routers import tournament_days as router_mod
from app.services.tournament_day_service import TournamentDayService as TDS
from app.services.tournament_service import TournamentService as TS


DIA = "77777777-7777-7777-7777-777777777777"
TOUR = "22222222-2222-2222-2222-222222222222"
ETAPA = "11111111-1111-1111-1111-111111111111"
OUTRA_ETAPA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


def _dia(**kw):
    base = {"id": DIA, "tournament_id": TOUR, "day_name": "Dia 1", "buy_in": 100,
            "max_players": 200, "created_at": "2026-06-08T00:00:00Z"}
    base.update(kw)
    return TournamentDay(**base)


def _torneio(stage_id=ETAPA):
    return Tournament(id=TOUR, name="Torneio", buy_in=100, max_players=200,
                      stage_id=stage_id, created_by="88888888-8888-8888-8888-888888888888",
                      created_at="2026-06-08T00:00:00Z")


def _corpo_dia():
    return {"tournament_id": TOUR, "day_name": "Dia 1", "buy_in": 100,
            "max_players": 200}


@pytest.fixture
def dia_valido(stub):
    """Dia existente cujo torneio pertence a ETAPA."""
    stub(TDS, get_tournament_day=lambda did: _dia() if did == DIA else None,
         get_day_with_stage=lambda did: (_dia(), ETAPA) if did == DIA else (None, None))
    stub(TS, get_tournament=lambda tid: _torneio() if tid == TOUR else None)


class TestCriacao:
    def test_cria_o_dia(self, client, stub):
        stub(TS, get_tournament=lambda tid: _torneio())
        stub(TDS, create_tournament_day=lambda d: _dia())
        r = client.post("/tournament-days", json=_corpo_dia())
        assert r.status_code == 201
        assert r.json()["day_name"] == "Dia 1"

    def test_torneio_inexistente_da_404(self, client, stub):
        stub(TS, get_tournament=lambda tid: None)
        r = client.post("/tournament-days", json=_corpo_dia())
        assert r.status_code == 404

    def test_torneio_de_outra_etapa_da_403(self, client, stub):
        """Sem isso, quem tem acesso a etapa A criaria dias dentro da etapa B."""
        stub(TS, get_tournament=lambda tid: _torneio(stage_id=OUTRA_ETAPA))
        r = client.post("/tournament-days", json=_corpo_dia(),
                        headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 403

    def test_corpo_invalido_da_422(self, client):
        r = client.post("/tournament-days", json={"day_name": "so o nome"})
        assert r.status_code == 422


class TestListagem:
    def test_lista_por_torneio(self, client, stub):
        stub(TDS, get_tournament_days=lambda tournament_id=None, status=None: [_dia()])
        r = client.get(f"/tournament-days?tournament_id={TOUR}")
        assert r.status_code == 200
        assert len(r.json()) == 1

    def test_com_etapa_e_sem_torneio_varre_os_torneios_da_etapa(self, client, stub):
        """A etapa nao esta no dia, so no torneio — o router precisa resolver
        a lista de torneios antes de conseguir listar os dias."""
        stub(TS, get_tournaments=lambda stage_id=None: [_torneio()])
        stub(TDS, get_tournament_days=lambda tournament_id=None, status=None: [_dia()])
        r = client.get("/tournament-days", headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 200
        assert len(r.json()) == 1

    def test_resumo_por_etapa(self, client, stub):
        stub(TS, get_tournaments=lambda stage_id=None: [_torneio()])
        stub(TDS, get_tournament_day_summary=lambda tournament_id=None, day_id=None: [])
        r = client.get("/tournament-days/summary", headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 200

    def test_resumo_por_torneio(self, client, stub):
        stub(TDS, get_tournament_day_summary=lambda tournament_id=None, day_id=None: [])
        r = client.get(f"/tournament-days/summary?tournament_id={TOUR}")
        assert r.status_code == 200

    def test_dias_de_um_torneio(self, client, stub):
        stub(TS, get_tournament=lambda tid: _torneio())
        stub(TDS, get_days_by_tournament=lambda tid: [_dia()])
        r = client.get(f"/tournament-days/tournament/{TOUR}")
        assert r.status_code == 200

    def test_dias_de_torneio_inexistente_da_404(self, client, stub):
        stub(TS, get_tournament=lambda tid: None)
        r = client.get(f"/tournament-days/tournament/{TOUR}")
        assert r.status_code == 404

    def test_dias_de_torneio_de_outra_etapa_da_403(self, client, stub):
        stub(TS, get_tournament=lambda tid: _torneio(stage_id=OUTRA_ETAPA))
        r = client.get(f"/tournament-days/tournament/{TOUR}",
                       headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 403


class TestLeituraEEdicao:
    def test_busca_um_dia(self, client, dia_valido):
        r = client.get(f"/tournament-days/{DIA}")
        assert r.status_code == 200
        assert r.json()["id"] == DIA

    def test_dia_inexistente_da_404(self, client, stub):
        stub(TDS, get_tournament_day=lambda did: None)
        r = client.get("/tournament-days/nao-existe")
        assert r.status_code == 404

    def test_dia_de_outra_etapa_da_403(self, client, stub):
        stub(TDS, get_tournament_day=lambda did: _dia())
        stub(TS, get_tournament=lambda tid: _torneio(stage_id=OUTRA_ETAPA))
        r = client.get(f"/tournament-days/{DIA}", headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 403

    def test_atualiza(self, client, dia_valido, stub):
        stub(TDS, update_tournament_day=lambda did, d: _dia(day_name="Dia 2"))
        r = client.patch(f"/tournament-days/{DIA}", json={"day_name": "Dia 2"})
        assert r.status_code == 200
        assert r.json()["day_name"] == "Dia 2"

    def test_atualizar_inexistente_da_404(self, client, stub):
        stub(TDS, get_tournament_day=lambda did: None)
        r = client.patch(f"/tournament-days/{DIA}", json={"day_name": "X"})
        assert r.status_code == 404

    def test_apaga(self, client, dia_valido, stub):
        stub(TDS, delete_tournament_day=lambda did: True)
        assert client.delete(f"/tournament-days/{DIA}").status_code == 204

    def test_apagar_o_que_sumiu_no_meio_do_caminho_da_404(self, client, dia_valido, stub):
        """Existia na validacao e nao existia mais na hora de apagar (outra
        aba do operador apagou antes)."""
        stub(TDS, delete_tournament_day=lambda did: False)
        assert client.delete(f"/tournament-days/{DIA}").status_code == 404


class TestQualificacao:
    def test_lista_sobreviventes(self, client, dia_valido, stub):
        stub(TDS, get_survivors=lambda did: [{"player_id": "p1", "chips": 30000}])
        r = client.get(f"/tournament-days/{DIA}/survivors")
        assert r.status_code == 200
        assert len(r.json()) == 1

    def test_avanca_classificados(self, client, dia_valido, stub):
        stub(TDS, advance_qualifiers=lambda did: {
            "advanced_count": 5, "final_day_id": "d-final",
            "final_day_name": "Final", "total_chips": 100000,
            "total_entries": 5, "players": [],
        })
        r = client.post(f"/tournament-days/{DIA}/advance-qualifiers")
        assert r.status_code == 200
        assert r.json()["advanced_count"] == 5

    def test_dia_sem_final_vinculada_da_400(self, client, dia_valido, stub):
        """Erro de configuracao do clube, nao falha do servidor: precisa
        chegar como 400 com o texto, senao o operador so ve 'erro'."""
        def _estoura(did):
            raise ValueError("Este dia não qualifica para nenhum dia final")
        stub(TDS, advance_qualifiers=_estoura)
        r = client.post(f"/tournament-days/{DIA}/advance-qualifiers")
        assert r.status_code == 400
        assert "qualifica" in r.json()["detail"]

    def test_atualiza_fichas_de_um_jogador(self, client, dia_valido, stub):
        stub(TDS, update_player_chips=lambda did, pid, chips: True)
        r = client.patch(f"/tournament-days/{DIA}/player-chips/p1?chip_count=42000")
        assert r.status_code == 200
        assert r.json()["chip_count"] == 42000

    def test_jogador_fora_do_dia_da_404(self, client, dia_valido, stub):
        stub(TDS, update_player_chips=lambda did, pid, chips: False)
        r = client.patch(f"/tournament-days/{DIA}/player-chips/p1?chip_count=1")
        assert r.status_code == 404

    def test_atualiza_fichas_em_lote(self, client, dia_valido, stub):
        stub(TDS, bulk_update_chips=lambda did, ups: len(ups))
        r = client.post(f"/tournament-days/{DIA}/bulk-update-chips", json={
            "updates": [{"player_id": "p1", "chip_count": 1000},
                        {"player_id": "p2", "chip_count": 2000}]})
        assert r.status_code == 200
        assert r.json()["updated_count"] == 2


class TestEstatisticas:
    def test_estatisticas_do_dia(self, client, dia_valido, stub):
        stub(TDS, get_qualifying_day_stats=lambda did: QualifyingDayStats(
            day_id=DIA, day_name="Dia 1", day_number=1, status="active"))
        r = client.get(f"/tournament-days/{DIA}/stats")
        assert r.status_code == 200

    def test_estatisticas_com_erro_de_regra_da_400(self, client, dia_valido, stub):
        def _estoura(did):
            raise ValueError("dia inválido")
        stub(TDS, get_qualifying_day_stats=_estoura)
        assert client.get(f"/tournament-days/{DIA}/stats").status_code == 400

    def test_agregado_da_final(self, client, dia_valido, stub):
        from app.models.tournament_day import FinalDayAggregatedStats
        stub(TDS, get_final_day_aggregated_stats=lambda did: FinalDayAggregatedStats(
            final_day_id=DIA, final_day_name="Final"))
        r = client.get(f"/tournament-days/{DIA}/aggregated-stats")
        assert r.status_code == 200

    def test_agregado_com_erro_de_regra_da_400(self, client, dia_valido, stub):
        def _estoura(did):
            raise ValueError("não é um dia final")
        stub(TDS, get_final_day_aggregated_stats=_estoura)
        assert client.get(f"/tournament-days/{DIA}/aggregated-stats").status_code == 400


class TestRelogio:
    """Os comandos do relogio sao os endpoints mais chamados do sistema (a TV
    consulta em loop). A validacao aqui usa `get_day_with_stage`, que resolve
    dia + etapa numa consulta so — trocar por duas voltaria a onerar o poll."""

    @pytest.mark.parametrize("acao", ["start", "pause", "next-level", "prev-level", "reset"])
    def test_comandos_respondem_sucesso(self, client, dia_valido, stub, acao):
        stub(TDS, start_timer=lambda did, day=None: {"ok": True},
             pause_timer=lambda did, day=None: {"ok": True},
             next_level=lambda did, day=None: {"ok": True},
             previous_level=lambda did, day=None: {"ok": True},
             reset_timer=lambda did, day=None: {"ok": True})
        r = client.post(f"/tournament-days/{DIA}/timer/{acao}")
        assert r.status_code == 200
        assert r.json()["success"] is True

    def test_dia_inexistente_da_404(self, client, stub):
        stub(TDS, get_day_with_stage=lambda did: (None, None))
        assert client.post(f"/tournament-days/{DIA}/timer/start").status_code == 404

    def test_dia_de_outra_etapa_da_403(self, client, stub):
        stub(TDS, get_day_with_stage=lambda did: (_dia(), OUTRA_ETAPA))
        r = client.post(f"/tournament-days/{DIA}/timer/start",
                        headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 403

    def test_ajusta_o_tempo(self, client, dia_valido, stub):
        stub(TDS, adjust_timer=lambda did, seg, day=None: {"elapsed": seg})
        r = client.post(f"/tournament-days/{DIA}/timer/adjust", json={"seconds": -60})
        assert r.status_code == 200
        assert r.json()["data"]["elapsed"] == -60

    def test_erro_de_regra_no_comando_da_400(self, client, dia_valido, stub):
        def _estoura(did, day=None):
            raise ValueError("já está no primeiro nível")
        stub(TDS, previous_level=_estoura)
        assert client.post(f"/tournament-days/{DIA}/timer/prev-level").status_code == 400

    def test_status_simples(self, client, dia_valido, stub):
        stub(TDS, get_timer_status=lambda did, day=None: TimerStatus(day_id=DIA))
        r = client.get(f"/tournament-days/{DIA}/timer/status")
        assert r.status_code == 200

    def test_status_enriquecido(self, client, dia_valido, stub):
        stub(TDS, get_enriched_timer_status=lambda did, day=None: {"level": 3})
        r = client.get(f"/tournament-days/{DIA}/timer/status-enriched")
        assert r.json()["level"] == 3

    def test_falha_inesperada_no_status_vira_503_e_nao_500(self, client, dia_valido, stub):
        """A TV consulta em loop. 503 diz "tente de novo"; 500 seria lido como
        defeito permanente pelo cliente e pelo monitoramento."""
        def _estoura(did, day=None):
            raise RuntimeError("supabase fora do ar")
        stub(TDS, get_enriched_timer_status=_estoura)
        r = client.get(f"/tournament-days/{DIA}/timer/status-enriched")
        assert r.status_code == 503

    def test_status_enriquecido_preserva_o_404(self, client, stub):
        """O except amplo do 503 nao pode engolir o HTTPException do 404."""
        stub(TDS, get_day_with_stage=lambda did: (None, None))
        r = client.get(f"/tournament-days/{DIA}/timer/status-enriched")
        assert r.status_code == 404


class TestEliminacoesEMesas:
    def test_ajusta_o_contador(self, client, dia_valido, stub):
        stub(TDS, adjust_eliminations=lambda did, n: {"eliminations_count": n})
        r = client.post(f"/tournament-days/{DIA}/eliminations", json={"count": 3})
        assert r.json()["eliminations_count"] == 3

    def test_contador_invalido_da_400(self, client, dia_valido, stub):
        def _estoura(did, n):
            raise ValueError("contador não pode ficar negativo")
        stub(TDS, adjust_eliminations=_estoura)
        r = client.post(f"/tournament-days/{DIA}/eliminations", json={"count": -99})
        assert r.status_code == 400

    def test_eliminacao_em_dia_inexistente_da_404(self, client, stub):
        stub(TDS, get_tournament_day=lambda did: None)
        r = client.post(f"/tournament-days/{DIA}/eliminations", json={"count": 1})
        assert r.status_code == 404

    def test_trava_das_mesas_alterna(self, client, dia_valido, monkeypatch):
        from tests.conftest import FakeSupabase
        import app.database as db
        fake = FakeSupabase({"tournament_days": [{"id": DIA, "tables_locked": False}]})
        monkeypatch.setattr(db, "supabase", fake)
        r = client.post(f"/tournament-days/{DIA}/tables-lock")
        assert r.json()["tables_locked"] is True

    def test_codigo_de_tv(self, client, stub):
        stub(TDS, get_or_create_broadcast_code=lambda did: "ABC234")
        r = client.get(f"/tournament-days/{DIA}/broadcast-code")
        assert r.json()["code"] == "ABC234"

    def test_codigo_de_tv_de_dia_inexistente_da_404(self, client, stub):
        def _estoura(did):
            raise ValueError("Dia não encontrado")
        stub(TDS, get_or_create_broadcast_code=_estoura)
        assert client.get(f"/tournament-days/{DIA}/broadcast-code").status_code == 404
