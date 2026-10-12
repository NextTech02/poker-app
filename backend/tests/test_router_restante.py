"""Testes da camada HTTP das rotas restantes.

Cobre jogadores (incluindo a importação de outro sistema), etapas, ranking,
patrocinadores, modelos de blind, tickets, créditos, consignação de fichas,
premiação, relatórios, dashboard, sincronização e a TV pública.

Três pontos merecem destaque e estão marcados nos testes:

- **Importação**: `preview` NÃO grava. É o que permite ao clube conferir 483
  linhas de um export sujo antes de comprometer a base. E o estouro de
  limite do plano tem de virar 409 (com a mensagem), não 400 genérico.
- **`/public/tv/{code}`**: a única rota sem autenticação. Um código
  inexistente precisa dar 404 seco, sem revelar nada do torneio.
- **Ranking**: remover alguém do ranking é o que permite o rebuy depois da
  eliminação; a distinção 400/404/500 diz ao operador se ele errou o
  jogador ou se o sistema falhou.
"""
import pytest

from app.models.player import Player, PlayerStats, PlayerHistoryEntry
from app.models.stage import Stage, StageSummary
from app.models.sponsor import Sponsor
from app.models.blind_template import BlindTemplateResponse
from app.models.report import ReportSummary, TournamentReport
from app.models.financial import FinancialSummary
from app.services.player_service import PlayerService as PS
from app.services.player_import_service import PlayerImportService as PIS
from app.services.stage_service import StageService as SS
from app.services.ranking_service import RankingService as RS
from app.services.sponsor_service import SponsorService as SpS
from app.services.blind_template_service import BlindTemplateService as BTS
from app.services.report_service import ReportService as RepS
from app.services.financial_service import FinancialService as FS
from app.services.dashboard_service import DashboardService as DS
from app.services.tournament_day_service import TournamentDayService as TDS


JOGADOR = "44444444-4444-4444-4444-444444444444"
ETAPA = "11111111-1111-1111-1111-111111111111"
TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
MODELO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"
TP = "55555555-5555-5555-5555-555555555555"


def _jogador(nome="Fulano"):
    return Player(id=JOGADOR, name=nome, email="fulano@x.com", phone="11999998888",
                  nationality="Brasil", document_type="national_id",
                  document_number="123456", created_at="2026-06-08T00:00:00Z")


def _corpo_jogador(**kw):
    base = {"name": "Fulano", "email": "fulano@x.com", "phone": "11999998888",
            "nationality": "Brasil", "document_type": "national_id",
            "document_number": "123456"}
    base.update(kw)
    return base


class TestJogadores:
    def test_cria(self, client, stub):
        stub(PS, create_player=lambda d: _jogador())
        assert client.post("/players", json=_corpo_jogador()).status_code == 201

    def test_lista(self, client, stub):
        stub(PS, get_players=lambda busca: [_jogador()])
        assert len(client.get("/players").json()) == 1

    def test_busca_por_texto_chega_ao_service(self, client, stub):
        recebidos = {}

        def _lista(busca):
            recebidos["busca"] = busca
            return []

        stub(PS, get_players=_lista)
        client.get("/players?search=fula")
        assert recebidos["busca"] == "fula"

    def test_estatisticas(self, client, stub):
        stub(PS, get_player_statistics=lambda pid: [PlayerStats(id=JOGADOR, name="Fulano")])
        assert len(client.get("/players/statistics").json()) == 1

    def test_historico(self, client, stub):
        stub(PS, get_player_history=lambda pid: [PlayerHistoryEntry(tournament_player_id=TP)])
        assert len(client.get(f"/players/{JOGADOR}/history").json()) == 1

    def test_busca_um(self, client, stub):
        stub(PS, get_player=lambda pid: _jogador())
        assert client.get(f"/players/{JOGADOR}").json()["id"] == JOGADOR

    def test_inexistente_da_404(self, client, stub):
        stub(PS, get_player=lambda pid: None)
        assert client.get(f"/players/{JOGADOR}").status_code == 404

    def test_atualiza(self, client, stub):
        stub(PS, update_player=lambda pid, d: _jogador(nome="Outro"))
        assert client.patch(f"/players/{JOGADOR}", json={"name": "Outro"}).json()["name"] == "Outro"

    def test_atualizar_inexistente_da_404(self, client, stub):
        stub(PS, update_player=lambda pid, d: None)
        assert client.patch(f"/players/{JOGADOR}", json={"name": "X"}).status_code == 404

    def test_apaga(self, client, stub):
        stub(PS, delete_player=lambda pid: True)
        assert client.delete(f"/players/{JOGADOR}").status_code == 204

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(PS, delete_player=lambda pid: False)
        assert client.delete(f"/players/{JOGADOR}").status_code == 404


class TestImportacaoDeJogadores:
    LINHA = {"source_id": "1", "name": "Fulano", "email": "f@x.com",
             "phone": "11999998888", "document_type": "RG",
             "document_number": "123", "doc_country": "Brasil"}

    def test_previa_nao_grava(self, client, stub):
        """É o que deixa o clube conferir um export de centenas de linhas
        antes de comprometer a base."""
        gravou = {"sim": False}

        def _analisa(org, linhas):
            return {"prontos": len(linhas), "rejeitados": []}

        def _importa(org, linhas):
            gravou["sim"] = True
            return {}

        stub(PIS, analisar=_analisa, importar=_importa)
        r = client.post("/players/import/preview", json={"rows": [self.LINHA]})
        assert r.json()["prontos"] == 1
        assert gravou["sim"] is False

    def test_importa(self, client, stub):
        stub(PIS, importar=lambda org, linhas: {"criados": 1, "rejeitados": []})
        r = client.post("/players/import", json={"rows": [self.LINHA]})
        assert r.json()["criados"] == 1

    def test_limite_de_clientes_do_plano_da_409_com_a_mensagem(self, client, stub):
        """409 e não 400: o clube precisa ler que foi o PLANO que barrou —
        a ação dele é fazer upgrade, não corrigir o arquivo."""
        def _estoura(org, linhas):
            raise ValueError("PLANO_LIMITE_CLIENTES: seu plano permite 100 jogadores")
        stub(PIS, importar=_estoura)
        r = client.post("/players/import", json={"rows": [self.LINHA]})
        assert r.status_code == 409
        # A frase segue em português na `message` (reserva) e os números vão
        # também em `detalhe`, para a tela remontar a frase no idioma dela.
        assert r.json()["detail"] == {
            "code": "limite_de_clientes_do_plano",
            "message": "seu plano permite 100 jogadores",
            "detalhe": "seu plano permite 100 jogadores",
        }

    def test_outro_erro_da_400(self, client, stub):
        def _estoura(org, linhas):
            raise ValueError("arquivo sem colunas reconhecidas")
        stub(PIS, importar=_estoura)
        assert client.post("/players/import", json={"rows": [self.LINHA]}).status_code == 400

    def test_arquivo_grande_demais_e_recusado(self, client):
        """Um arquivo de 50 mil linhas viraria um insert que derruba a
        requisição pelo meio, deixando a base pela metade."""
        r = client.post("/players/import", json={"rows": [self.LINHA] * 5001})
        assert r.status_code == 422

    def test_conta_sem_organizacao_nao_importa(self, client, stub):
        """Sem org não há para onde importar — e importar "sem dono" jogaria
        os jogadores na base de outro clube."""
        client.usuario["organization_id"] = None
        r = client.post("/players/import", json={"rows": [self.LINHA]})
        assert r.status_code == 403


class TestEtapas:
    def _etapa(self, nome="Etapa 1"):
        return Stage(id=ETAPA, name=nome, location="Rio",
                     created_at="2026-06-08T00:00:00Z")

    def test_cria(self, client, stub):
        # A data de início virou obrigatória (ver test_stage_datas_exclusao.py).
        stub(SS, create_stage=lambda d: self._etapa())
        r = client.post(
            "/stages",
            json={"name": "Etapa 1", "location": "Rio", "start_date": "2026-08-02"},
        )
        assert r.status_code == 201

    def test_lista(self, client, stub):
        stub(SS, get_stages=lambda st: [StageSummary(
            id=ETAPA, name="Etapa 1", location="Rio", status="active",
            created_at="2026-06-08T00:00:00Z")])
        assert len(client.get("/stages").json()) == 1

    def test_filtra_por_status(self, client, stub):
        recebidos = {}

        def _lista(st):
            recebidos["status"] = st
            return []

        stub(SS, get_stages=_lista)
        client.get("/stages?status=active")
        assert recebidos["status"] == "active"

    def test_busca_uma(self, client, stub):
        stub(SS, get_stage=lambda sid: self._etapa())
        assert client.get(f"/stages/{ETAPA}").status_code == 200

    def test_inexistente_da_404(self, client, stub):
        stub(SS, get_stage=lambda sid: None)
        assert client.get(f"/stages/{ETAPA}").status_code == 404

    def test_atualiza(self, client, stub):
        stub(SS, update_stage=lambda sid, d: self._etapa(nome="Nova"))
        assert client.patch(f"/stages/{ETAPA}", json={"name": "Nova"}).json()["name"] == "Nova"

    def test_atualizar_inexistente_da_404(self, client, stub):
        stub(SS, update_stage=lambda sid, d: None)
        assert client.patch(f"/stages/{ETAPA}", json={"name": "X"}).status_code == 404

    def test_apaga(self, client, stub):
        stub(SS, delete_stage=lambda sid: True)
        assert client.delete(f"/stages/{ETAPA}").status_code == 204

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(SS, delete_stage=lambda sid: False)
        assert client.delete(f"/stages/{ETAPA}").status_code == 404


class TestRanking:
    def test_lista(self, client, stub):
        stub(RS, get_tournament_rankings=lambda tid: [{"position": 1}])
        assert len(client.get(f"/rankings/tournament/{TOUR}").json()) == 1

    def test_falha_ao_listar_da_500(self, client, stub):
        def _estoura(tid):
            raise RuntimeError("boom")
        stub(RS, get_tournament_rankings=_estoura)
        assert client.get(f"/rankings/tournament/{TOUR}").status_code == 500

    def test_recalcula(self, client, stub):
        stub(RS, calculate_rankings=lambda tid: [{"position": 1}])
        assert client.post(f"/rankings/tournament/{TOUR}/recalculate").status_code == 200

    def test_falha_ao_recalcular_da_500(self, client, stub):
        def _estoura(tid):
            raise RuntimeError("boom")
        stub(RS, calculate_rankings=_estoura)
        assert client.post(f"/rankings/tournament/{TOUR}/recalculate").status_code == 500

    def test_remove_do_ranking(self, client, stub):
        """É o que viabiliza o rebuy depois da eliminação: o jogador sai da
        classificação e as posições abaixo sobem de volta."""
        stub(RS, remove_from_ranking=lambda tpid: True)
        assert client.delete(f"/rankings/tournament-player/{TP}/ranking").status_code == 204

    def test_remover_quem_nao_esta_no_ranking_da_404(self, client, stub):
        stub(RS, remove_from_ranking=lambda tpid: False)
        assert client.delete(f"/rankings/tournament-player/{TP}/ranking").status_code == 404

    def test_erro_de_regra_da_400(self, client, stub):
        def _estoura(tpid):
            raise ValueError("prêmio já pago; não é possível remover")
        stub(RS, remove_from_ranking=_estoura)
        assert client.delete(f"/rankings/tournament-player/{TP}/ranking").status_code == 400

    def test_falha_inesperada_da_500(self, client, stub):
        def _estoura(tpid):
            raise RuntimeError("boom")
        stub(RS, remove_from_ranking=_estoura)
        assert client.delete(f"/rankings/tournament-player/{TP}/ranking").status_code == 500


class TestPatrocinadores:
    def _patrocinador(self, nome="Casa de Apostas"):
        return Sponsor(id="sp1", name=nome, created_at="2026-06-08T00:00:00Z")

    def test_cria(self, client, stub):
        stub(SpS, create_sponsor=lambda d: self._patrocinador())
        assert client.post("/sponsors", json={"name": "Casa de Apostas"}).status_code == 200

    def test_lista_com_filtros(self, client, stub):
        recebidos = {}

        def _lista(search=None, status=None):
            recebidos.update(busca=search, status=status)
            return []

        stub(SpS, get_sponsors=_lista)
        client.get("/sponsors?search=casa&status=active")
        assert recebidos == {"busca": "casa", "status": "active"}

    def test_busca_um(self, client, stub):
        stub(SpS, get_sponsor=lambda sid: self._patrocinador())
        assert client.get("/sponsors/sp1").status_code == 200

    def test_inexistente_da_404(self, client, stub):
        stub(SpS, get_sponsor=lambda sid: None)
        assert client.get("/sponsors/sp1").status_code == 404

    def test_atualiza(self, client, stub):
        stub(SpS, update_sponsor=lambda sid, d: self._patrocinador(nome="Outro"))
        assert client.patch("/sponsors/sp1", json={"name": "Outro"}).json()["name"] == "Outro"

    def test_atualizar_inexistente_da_404(self, client, stub):
        stub(SpS, update_sponsor=lambda sid, d: None)
        assert client.patch("/sponsors/sp1", json={"name": "X"}).status_code == 404

    def test_apaga(self, client, stub):
        stub(SpS, delete_sponsor=lambda sid: True)
        assert client.delete("/sponsors/sp1").status_code == 200

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(SpS, delete_sponsor=lambda sid: False)
        assert client.delete("/sponsors/sp1").status_code == 404


class TestModelosDeBlind:
    def _modelo(self, nome="Turbo"):
        return BlindTemplateResponse(id=MODELO, name=nome,
                                     created_at="2026-06-08T00:00:00Z",
                                     updated_at="2026-06-08T00:00:00Z")

    def test_lista(self, client, stub):
        stub(BTS, get_templates=lambda stage_id=None: [self._modelo()])
        assert len(client.get("/blind-templates").json()) == 1

    def test_filtra_por_etapa(self, client, stub):
        recebidos = {}

        def _lista(stage_id=None):
            recebidos["stage"] = stage_id
            return []

        stub(BTS, get_templates=_lista)
        client.get(f"/blind-templates?stage_id={ETAPA}")
        assert recebidos["stage"] == ETAPA

    def test_busca_um(self, client, stub):
        stub(BTS, get_template=lambda tid: self._modelo())
        assert client.get(f"/blind-templates/{MODELO}").status_code == 200

    def test_inexistente_da_404(self, client, stub):
        stub(BTS, get_template=lambda tid: None)
        assert client.get(f"/blind-templates/{MODELO}").status_code == 404

    def test_cria(self, client, stub):
        stub(BTS, create_template=lambda t, user_id=None: self._modelo())
        r = client.post("/blind-templates", json={"name": "Turbo", "levels": []})
        assert r.status_code == 201

    def test_falha_ao_criar_da_500(self, client, stub):
        def _estoura(t, user_id=None):
            raise RuntimeError("boom")
        stub(BTS, create_template=_estoura)
        r = client.post("/blind-templates", json={"name": "Turbo", "levels": []})
        assert r.status_code == 500

    def test_atualiza(self, client, stub):
        stub(BTS, update_template=lambda tid, d: self._modelo(nome="Lento"))
        r = client.patch(f"/blind-templates/{MODELO}", json={"name": "Lento"})
        assert r.json()["name"] == "Lento"

    def test_atualizar_inexistente_da_404(self, client, stub):
        stub(BTS, update_template=lambda tid, d: None)
        assert client.patch(f"/blind-templates/{MODELO}", json={"name": "X"}).status_code == 404

    def test_apaga(self, client, stub):
        stub(BTS, delete_template=lambda tid: True)
        assert client.delete(f"/blind-templates/{MODELO}").status_code == 204

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(BTS, delete_template=lambda tid: False)
        assert client.delete(f"/blind-templates/{MODELO}").status_code == 404

    def test_aplica_ao_dia(self, client, stub):
        stub(BTS, apply_template_to_day=lambda template_id, tournament_day_id,
             clear_existing=False: [{
                 "id": "55555555-5555-5555-5555-5555555555b1", "level": 1, "small_blind": 100, "big_blind": 200,
                 "ante": 0, "duration": 15, "is_break": False,
                 "created_at": "2026-06-08T00:00:00Z",
                 "updated_at": "2026-06-08T00:00:00Z"}])
        r = client.post("/blind-templates/apply", json={
            "template_id": MODELO, "tournament_day_id": DIA, "clear_existing": True})
        assert r.status_code == 200

    def test_aplicar_modelo_inexistente_da_404(self, client, stub):
        def _estoura(template_id, tournament_day_id, clear_existing=False):
            raise ValueError("Template not found")
        stub(BTS, apply_template_to_day=_estoura)
        r = client.post("/blind-templates/apply", json={
            "template_id": MODELO, "tournament_day_id": DIA})
        assert r.status_code == 404

    def test_falha_ao_aplicar_da_500(self, client, stub):
        def _estoura(template_id, tournament_day_id, clear_existing=False):
            raise RuntimeError("boom")
        stub(BTS, apply_template_to_day=_estoura)
        r = client.post("/blind-templates/apply", json={
            "template_id": MODELO, "tournament_day_id": DIA})
        assert r.status_code == 500

    def test_salva_a_estrutura_de_um_dia_como_modelo(self, client, stub):
        """Caminho inverso: o clube monta a estrutura no dia, gosta, e guarda
        para reusar — sem redigitar nível por nível."""
        stub(BTS, save_blinds_as_template=lambda tournament_day_id, template_name,
             description=None, stage_id=None, user_id=None: self._modelo(template_name))
        r = client.post(f"/blind-templates/save-from-day?tournament_day_id={DIA}"
                        f"&template_name=Meu%20Turbo&stage_id={ETAPA}")
        assert r.status_code == 201
        assert r.json()["name"] == "Meu Turbo"

    def test_dia_sem_blinds_da_400(self, client, stub):
        def _estoura(tournament_day_id, template_name, description=None,
                     stage_id=None, user_id=None):
            raise ValueError("Este dia não tem blinds cadastrados")
        stub(BTS, save_blinds_as_template=_estoura)
        r = client.post(f"/blind-templates/save-from-day?tournament_day_id={DIA}"
                        "&template_name=X")
        assert r.status_code == 400

    def test_falha_ao_salvar_da_500(self, client, stub):
        def _estoura(tournament_day_id, template_name, description=None,
                     stage_id=None, user_id=None):
            raise RuntimeError("boom")
        stub(BTS, save_blinds_as_template=_estoura)
        r = client.post(f"/blind-templates/save-from-day?tournament_day_id={DIA}"
                        "&template_name=X")
        assert r.status_code == 500


class TestRelatoriosEDashboard:
    def test_relatorio_do_torneio(self, client, stub):
        stub(RepS, get_tournament_report=lambda tid: TournamentReport(
            tournament_id=TOUR, tournament_name="Torneio"))
        assert client.get(f"/reports/tournament/{TOUR}").status_code == 200

    def test_relatorio_por_periodo(self, client, stub):
        recebidos = {}

        def _relatorio(ini, fim):
            recebidos.update(ini=ini, fim=fim)
            return ReportSummary(totalRevenue=0, totalTournaments=0, totalPlayers=0,
                                 avgBuyIn=0, totalBuyIns=0, totalRebuys=0,
                                 totalAddons=0, playerReports=[])

        stub(RepS, get_reports=_relatorio)
        client.get("/reports?start=2026-06-01&end=2026-06-30")
        assert recebidos == {"ini": "2026-06-01", "fim": "2026-06-30"}

    def test_resumo_financeiro_recebe_a_organizacao_do_claim(self, client, stub):
        """O DRE soma dinheiro; consultar sem o filtro de org misturaria o
        resultado de dois clubes."""
        recebidos = {}

        def _resumo(stage, ini, fim, tour, org):
            recebidos["org"] = org
            return FinancialSummary(revenue=0)

        stub(FS, get_financial_summary=_resumo)
        client.get("/reports/financial")
        assert recebidos["org"] == client.usuario["organization_id"]

    def test_dashboard(self, client, stub):
        recebidos = {}

        def _stats(stage_id=None):
            recebidos["stage"] = stage_id
            return {"active_tournaments": 2}

        stub(DS, get_stats=_stats)
        r = client.get("/dashboard/stats", headers={"X-Stage-ID": ETAPA})
        assert r.json()["active_tournaments"] == 2
        assert recebidos["stage"] == ETAPA


class TestTvPublica:
    """A única rota sem autenticação: a TV do salão não faz login."""

    def test_codigo_valido_resolve_o_dia(self, client, stub):
        stub(TDS, resolve_broadcast_code=lambda code: {"day_id": DIA,
                                                       "tournament_id": TOUR})
        assert client.get("/public/tv/ABC234").json()["day_id"] == DIA

    def test_token_de_outra_organizacao_nao_entra_na_rota_publica(self, client, stub):
        """O navegador do operador manda Authorization em TODA requisição. Na
        rota pública o middleware tem de ignorá-lo: com o token no contexto, a
        busca rodava sob o RLS de quem abriu a TV, e um código certo "não
        existia" para quem estava logado em outra organização."""
        from app.database import supabase_client as sc
        visto = {}

        def _resolve(code):
            visto["jwt"] = sc._request_jwt.get()
            return {"day_id": DIA, "tournament_id": TOUR}
        stub(TDS, resolve_broadcast_code=_resolve)
        r = client.get("/public/tv/ABC234",
                       headers={"Authorization": "Bearer token-de-outra-org"})
        assert r.status_code == 200
        assert visto["jwt"] is None

    def test_fora_de_public_o_token_segue_para_o_contexto(self, client, stub):
        """Contraprova: a exceção é só para /public. Nas demais rotas o JWT
        continua indo para o contexto, que é o que faz o RLS valer."""
        from app.database import supabase_client as sc
        visto = {}

        def _stats(stage_id=None):
            visto["jwt"] = sc._request_jwt.get()
            return {"active_tournaments": 0}
        stub(DS, get_stats=_stats)
        client.get("/dashboard/stats", headers={"Authorization": "Bearer token-do-operador"})
        assert visto["jwt"] == "token-do-operador"

    def test_codigo_inexistente_da_404_seco(self, client, stub):
        """Sem revelar nada do torneio: a rota é aberta à internet."""
        def _estoura(code):
            raise ValueError("Código não encontrado")
        stub(TDS, resolve_broadcast_code=_estoura)
        r = client.get("/public/tv/ZZZZZZ")
        assert r.status_code == 404
        # `detail` estruturado: a tela da TV escolhe a frase pelo `code`.
        assert r.json()["detail"]["code"] == "codigo_de_tv_invalido"
        assert r.json()["detail"]["message"] == "Código não encontrado"
