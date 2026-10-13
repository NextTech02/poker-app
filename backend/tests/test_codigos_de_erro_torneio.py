"""O CONTRATO de recusa da área de torneio: `code` + `message` + dados.

O sistema atende clubes no Brasil, no Peru e na Colômbia. Enquanto o `detail`
era a frase pronta em português, o operador colombiano lia "Dia não encontrado"
no meio da operação — a tela não tinha como traduzir o que chegava. Agora o
`detail` vai estruturado e quem escolhe o idioma é a tela, pelo `code`.

Por isso estes testes olham o CÓDIGO, não a frase: o código é o que o frontend
consome (`errors.<code>`) e o que fica gravado na fila offline dos aparelhos.
Renomear um código já usado quebra a tradução de quem não atualizou — então
esta suíte existe para o rename doer aqui, e não no salão.

O que cada teste afirma:
  1. o `code` exato (o contrato com a tela);
  2. que a `message` em português continua lá (a RESERVA, para outros clientes
     da API e para a tela que ainda não conhece o código);
  3. que o que era interpolado na frase (posição, nível, id) vai TAMBÉM como
     dado nomeado — sem isso a tela não consegue remontar a frase no idioma
     dela sem perder a informação.
"""
import pytest

from app.models.tournament import Tournament
from app.models.tournament_day import TournamentDay
from app.routers import blinds as blinds_mod
from app.services.blind_template_service import BlindTemplateService as BTS
from app.services.cashbox_service import CashboxService
from app.services.sales_block_service import SalesBlockService
from app.services.stage_service import StageService as SS
from app.services.table_service import TableService as TSvc
from app.services.allocation_service import AllocationService as ASvc
from app.services.tournament_day_service import TournamentDayService as TDS
from app.services.tournament_service import TournamentService as TS
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
ETAPA = "11111111-1111-1111-1111-111111111111"
OUTRA_ETAPA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
MESA = "33333333-3333-3333-3333-333333333333"
ALOC = "44444444-4444-4444-4444-444444444444"
BLIND = "55555555-5555-5555-5555-555555555551"
BLIND_SUMIU = "55555555-5555-5555-5555-55555555ffff"


def _dia(**kw):
    base = {"id": DIA, "tournament_id": TOUR, "day_name": "Dia 1", "buy_in": 100,
            "max_players": 200, "created_at": "2026-06-08T00:00:00Z"}
    base.update(kw)
    return TournamentDay(**base)


def _torneio(stage_id=ETAPA):
    return Tournament(id=TOUR, name="Torneio", buy_in=100, max_players=200,
                      stage_id=stage_id,
                      created_by="88888888-8888-8888-8888-888888888888",
                      created_at="2026-06-08T00:00:00Z")


@pytest.fixture
def dia_valido(stub):
    stub(TDS, get_tournament_day=lambda did: _dia() if did == DIA else None,
         get_day_with_stage=lambda did: (_dia(), ETAPA) if did == DIA else (None, None))
    stub(TS, get_tournament=lambda tid: _torneio() if tid == TOUR else None)


def codigo(resposta):
    """O `code` da recusa. Falha com a resposta inteira se o formato mudou."""
    detalhe = resposta.json()["detail"]
    assert isinstance(detalhe, dict), detalhe
    return detalhe["code"]


# ─────────────────────────────────────────────────────────────────────────────
# Dias de torneio
# ─────────────────────────────────────────────────────────────────────────────

class TestDiasDeTorneio:
    def test_dia_inexistente(self, client, stub):
        stub(TDS, get_tournament_day=lambda did: None)
        r = client.get(f"/tournament-days/{DIA}")
        assert r.status_code == 404
        assert codigo(r) == "dia_nao_encontrado"

    def test_dia_de_outra_etapa(self, client, dia_valido):
        r = client.get(f"/tournament-days/{DIA}", headers={"X-Stage-ID": OUTRA_ETAPA})
        assert r.status_code == 403
        assert codigo(r) == "dia_fora_da_etapa"
        # A frase de escopo de etapa é de DESENVOLVEDOR (o X-Stage-ID vem do
        # cliente, não da mão do operador) e fica em inglês de propósito.
        assert r.json()["detail"]["message"] == (
            "Tournament day does not belong to the selected stage"
        )

    def test_dia_de_outra_etapa_no_relogio(self, client, stub):
        """O relógio tem guarda própria (uma consulta só) — e o mesmo código."""
        stub(TDS, get_day_with_stage=lambda did: (_dia(), OUTRA_ETAPA))
        r = client.post(f"/tournament-days/{DIA}/timer/start",
                        headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 403
        assert codigo(r) == "dia_fora_da_etapa"

    def test_criar_dia_de_torneio_inexistente_leva_o_id_junto(self, client, stub):
        stub(TS, get_tournament=lambda tid: None)
        r = client.post("/tournament-days", json={
            "tournament_id": TOUR, "day_name": "Dia 1", "buy_in": 100,
            "max_players": 200})
        assert r.status_code == 404
        assert codigo(r) == "torneio_nao_encontrado"
        # O id vai como DADO: a tela monta a frase no idioma dela e ainda diz
        # de qual torneio se trata.
        assert r.json()["detail"]["tournament_id"] == TOUR

    def test_criar_dia_em_torneio_de_outra_etapa(self, client, stub):
        stub(TS, get_tournament=lambda tid: _torneio(stage_id=OUTRA_ETAPA))
        r = client.post("/tournament-days", headers={"X-Stage-ID": ETAPA}, json={
            "tournament_id": TOUR, "day_name": "Dia 1", "buy_in": 100,
            "max_players": 200})
        assert r.status_code == 403
        assert codigo(r) == "torneio_fora_da_etapa"

    def test_jogador_fora_do_dia_leva_o_id_do_jogador(self, client, dia_valido, stub):
        stub(TDS, update_player_chips=lambda did, pid, chips: False)
        r = client.patch(f"/tournament-days/{DIA}/player-chips/p1?chip_count=1")
        assert r.status_code == 404
        assert codigo(r) == "jogador_nao_encontrado_no_dia"
        assert r.json()["detail"]["player_id"] == "p1"

    def test_codigo_de_tv_de_dia_inexistente(self, client, stub):
        def _estoura(did):
            raise ErroDeNegocio("dia_nao_encontrado", "Dia não encontrado", status=404)
        stub(TDS, get_or_create_broadcast_code=_estoura)
        r = client.get(f"/tournament-days/{DIA}/broadcast-code")
        assert r.status_code == 404
        assert codigo(r) == "dia_nao_encontrado"

    def test_bloqueio_de_vendas_sem_permissao(self, client, dia_valido, stub):
        stub(CashboxService, can_admin=lambda uid: False)
        r = client.post(f"/tournament-days/{DIA}/sales-block", json={"blocked": True})
        assert r.status_code == 403
        assert codigo(r) == "sem_permissao_bloquear_vendas"

    def test_bloqueio_sem_migracao_preserva_o_codigo_do_service(self, client, dia_valido, stub):
        """`da_excecao` tem que PRESERVAR o código que o service escolheu, em
        vez de achatar tudo no código genérico da rota."""
        def _estoura(day_id, blocked, reason, user_id):
            raise ErroDeNegocio("bloqueio_sem_migracao", "migração pendente")
        stub(CashboxService, can_admin=lambda uid: True)
        stub(SalesBlockService, set_day_block=_estoura)
        r = client.post(f"/tournament-days/{DIA}/sales-block", json={"blocked": True})
        assert r.status_code == 400
        assert codigo(r) == "bloqueio_sem_migracao"

    def test_valueerror_ainda_nao_convertido_cai_no_codigo_da_rota(self, client, dia_valido, stub):
        """Serviço que ainda levanta ValueError puro não pode quebrar a tela:
        vira o código genérico da rota, com a frase de sempre."""
        def _estoura(did):
            raise ValueError("qualquer coisa")
        stub(TDS, advance_qualifiers=_estoura)
        r = client.post(f"/tournament-days/{DIA}/advance-qualifiers")
        assert r.status_code == 400
        assert codigo(r) == "avanco_de_classificados_recusado"
        assert r.json()["detail"]["message"] == "qualquer coisa"


# ─────────────────────────────────────────────────────────────────────────────
# Regras do dia (service)
# ─────────────────────────────────────────────────────────────────────────────

class TestRegrasDoDia:
    """As recusas nascem no service, com código; o router só as traduz em HTTP."""

    def _sem_final(self, monkeypatch):
        monkeypatch.setattr(
            TDS, "get_tournament_day",
            staticmethod(lambda did, **k: _dia(day_type="qualifying")),
        )

    def test_dia_nao_e_classificatorio(self, monkeypatch):
        monkeypatch.setattr(TDS, "get_tournament_day",
                            staticmethod(lambda did, **k: _dia(day_type="final")))
        with pytest.raises(ErroDeNegocio) as exc:
            TDS.advance_qualifiers(DIA)
        assert exc.value.code == "dia_nao_e_classificatorio"
        assert exc.value.status == 400

    def test_dia_sem_final_vinculada(self, monkeypatch):
        self._sem_final(monkeypatch)
        with pytest.raises(ErroDeNegocio) as exc:
            TDS.advance_qualifiers(DIA)
        assert exc.value.code == "dia_sem_final_vinculada"

    def test_erro_de_negocio_continua_sendo_valueerror(self, monkeypatch):
        """A conversão é incremental: todo `except ValueError` já escrito
        precisa continuar capturando estas recusas."""
        self._sem_final(monkeypatch)
        with pytest.raises(ValueError):
            TDS.advance_qualifiers(DIA)

    def test_sem_sobreviventes_para_avancar(self):
        qualificatorio = _dia(registered_players=5, eliminations_count=5)
        final = _dia(id="d-final")
        with pytest.raises(ErroDeNegocio) as exc:
            TDS._avancar_por_contador(qualificatorio, final)
        assert exc.value.code == "sem_sobreviventes_para_avancar"

    def test_fichas_faltando_levam_a_contagem_como_dado(self, monkeypatch):
        """"2 de 5" precisa chegar em NÚMEROS: a tela monta a frase no idioma
        dela, e "2 de 5" dentro de uma string em português não serve."""
        sobreviventes = [
            {"player_id": "p1", "final_chip_count": 1000},
            {"player_id": "p2", "final_chip_count": None},
            {"player_id": "p3", "final_chip_count": 0},
        ]
        with pytest.raises(ErroDeNegocio) as exc:
            TDS._avancar_por_jogador(_dia(), _dia(id="d-final"), sobreviventes)
        assert exc.value.code == "fichas_dos_classificados_faltando"
        assert exc.value.dados == {"sem_fichas": 2, "total": 3}

    def test_nivel_minimo_de_blind(self, monkeypatch):
        monkeypatch.setattr(TDS, "get_tournament_day",
                            staticmethod(lambda did, **k: _dia()))
        with pytest.raises(ErroDeNegocio) as exc:
            TDS.set_level(DIA, 0)
        assert exc.value.code == "nivel_minimo_de_blind"
        assert exc.value.dados == {"minimo": 1}


# ─────────────────────────────────────────────────────────────────────────────
# Torneios
# ─────────────────────────────────────────────────────────────────────────────

class TestTorneios:
    def test_torneio_inexistente(self, client, stub):
        stub(TS, get_tournament=lambda tid: None)
        r = client.get(f"/tournaments/{TOUR}")
        assert r.status_code == 404
        assert codigo(r) == "torneio_nao_encontrado"

    def test_torneio_de_outra_etapa(self, client, stub):
        stub(TS, get_tournament=lambda tid: _torneio(stage_id=OUTRA_ETAPA))
        r = client.patch(f"/tournaments/{TOUR}", headers={"X-Stage-ID": ETAPA},
                         json={"name": "Novo"})
        assert r.status_code == 403
        assert codigo(r) == "torneio_fora_da_etapa"

    def test_criar_sem_etapa_selecionada(self, client):
        r = client.post("/tournaments", json={"name": "T", "buy_in": 100,
                                              "max_players": 200})
        assert r.status_code == 400
        assert codigo(r) == "etapa_obrigatoria"

    def test_criar_com_etapa_inexistente_leva_o_id_junto(self, client, monkeypatch):
        import app.database.supabase_client as sc
        monkeypatch.setattr(sc, "supabase", FakeSupabase({"stages": []}))
        r = client.post("/tournaments", headers={"X-Stage-ID": ETAPA},
                        json={"name": "T", "buy_in": 100, "max_players": 200})
        assert r.status_code == 404
        assert codigo(r) == "etapa_nao_encontrada"
        assert r.json()["detail"]["stage_id"] == ETAPA


# ─────────────────────────────────────────────────────────────────────────────
# Etapas
# ─────────────────────────────────────────────────────────────────────────────

class TestEtapas:
    def test_etapa_inexistente(self, client, stub):
        stub(SS, get_stage=lambda sid: None)
        r = client.get(f"/stages/{ETAPA}")
        assert r.status_code == 404
        assert codigo(r) == "etapa_nao_encontrada"

    def test_fim_antes_do_inicio(self, client, monkeypatch):
        import app.services.stage_service as mod
        monkeypatch.setattr(mod, "supabase", FakeSupabase({"stages": []}))
        r = client.post("/stages", json={"name": "E", "location": "Rio",
                                         "start_date": "2026-08-10",
                                         "end_date": "2026-08-02"})
        assert r.status_code == 400
        assert codigo(r) == "etapa_fim_antes_do_inicio"

    def test_etapa_sem_data_de_inicio(self, client, monkeypatch):
        import app.services.stage_service as mod
        monkeypatch.setattr(mod, "supabase", FakeSupabase({"stages": []}))
        r = client.post("/stages", json={"name": "E", "location": "Rio"})
        assert r.status_code == 400
        assert codigo(r) == "etapa_sem_data_de_inicio"

    def test_exclusao_com_movimento_financeiro(self, client, stub):
        from app.services.stage_service import MSG_ETAPA_COM_MOVIMENTO

        def _recusa(sid):
            raise ErroDeNegocio("etapa_com_movimento_financeiro",
                                MSG_ETAPA_COM_MOVIMENTO, status=409)
        stub(SS, delete_stage=_recusa)
        r = client.delete(f"/stages/{ETAPA}")
        assert r.status_code == 409
        assert codigo(r) == "etapa_com_movimento_financeiro"

    def test_bloqueio_de_vendas_sem_permissao(self, client, stub):
        stub(CashboxService, can_admin=lambda uid: False)
        r = client.post(f"/stages/{ETAPA}/sales-block", json={"blocked": True})
        assert r.status_code == 403
        assert codigo(r) == "sem_permissao_bloquear_vendas"


# ─────────────────────────────────────────────────────────────────────────────
# Blinds e templates
# ─────────────────────────────────────────────────────────────────────────────

class TestBlinds:
    @pytest.fixture
    def banco(self, monkeypatch):
        fake = FakeSupabase({
            "tournaments": [{"id": TOUR, "name": "Torneio"}],
            "tournament_days": [{"id": DIA, "tournament_id": TOUR}],
            "blinds": [{"id": BLIND, "level": 1, "small_blind": 100,
                        "big_blind": 200, "ante": 0, "duration": 15,
                        "is_break": False, "tournament_id": TOUR,
                        "tournament_day_id": DIA,
                        "created_at": "2026-06-08T00:00:00Z",
                        "updated_at": "2026-06-08T00:00:00Z"}],
        })
        monkeypatch.setattr(blinds_mod, "supabase", fake)
        return fake

    def test_nivel_repetido_leva_o_nivel_como_dado(self, client, banco):
        r = client.post(f"/tournament-days/{DIA}/blinds", json={
            "level": 1, "small_blind": 100, "big_blind": 200, "duration": 15})
        assert r.status_code == 400
        assert codigo(r) == "nivel_de_blind_duplicado"
        # O nível vai como número: a tela diz "Nível 1 já existe" no idioma dela.
        assert r.json()["detail"]["level"] == 1

    def test_blind_inexistente(self, client, banco):
        r = client.patch(f"/tournament-days/{DIA}/blinds/{BLIND_SUMIU}",
                         json={"duration": 20})
        assert r.status_code == 404
        assert codigo(r) == "blind_nao_encontrado"

    def test_corpo_vazio(self, client, banco):
        r = client.patch(f"/tournament-days/{DIA}/blinds/{BLIND}", json={})
        assert r.status_code == 400
        assert codigo(r) == "nada_para_atualizar"

    def test_dia_inexistente(self, client, banco):
        banco.store["tournament_days"] = []
        r = client.get(f"/tournament-days/{DIA}/blinds")
        assert r.status_code == 404
        assert codigo(r) == "dia_nao_encontrado"

    def test_limpeza_em_massa_com_dia_em_andamento(self, client, banco):
        banco.store["tournament_days"][0]["status"] = "active"
        r = client.delete(f"/tournament-days/{DIA}/blinds")
        assert r.status_code == 409
        assert codigo(r) == "estrutura_de_blinds_em_dia_em_andamento"

    def test_template_inexistente(self, client, stub):
        stub(BTS, get_template=lambda tid: None)
        r = client.get("/blind-templates/99999999-9999-9999-9999-999999999999")
        assert r.status_code == 404
        assert codigo(r) == "template_de_blinds_nao_encontrado"


# ─────────────────────────────────────────────────────────────────────────────
# Mesas e alocação
# ─────────────────────────────────────────────────────────────────────────────

class TestMesasEAlocacao:
    def test_mesa_inexistente(self, client, stub):
        stub(TSvc, get_table=lambda tid: None)
        r = client.get(f"/tables/{MESA}")
        assert r.status_code == 404
        assert codigo(r) == "mesa_nao_encontrada"

    def test_lote_com_quantidade_invalida_leva_os_limites(self, client):
        r = client.post(f"/tables/tournament/{TOUR}/bulk?count=0&seats=9")
        assert r.status_code == 400
        assert codigo(r) == "quantidade_de_mesas_invalida"
        assert (r.json()["detail"]["minimo"], r.json()["detail"]["maximo"]) == (1, 50)

    def test_lote_com_lugares_invalidos_leva_os_limites(self, client):
        r = client.post(f"/tables/tournament/{TOUR}/bulk?count=2&seats=0")
        assert r.status_code == 400
        assert codigo(r) == "lugares_por_mesa_invalido"
        # Assentos não têm teto: só o mínimo viaja para a tela.
        assert r.json()["detail"]["minimo"] == 1
        assert "maximo" not in r.json()["detail"]

    def test_alocacao_inexistente(self, client, stub):
        stub(ASvc, remove_allocation=lambda aid: False)
        r = client.delete(f"/allocations/{ALOC}")
        assert r.status_code == 404
        assert codigo(r) == "alocacao_nao_encontrada"

    def test_alocacao_recusada_pela_regra(self, client, stub):
        def _estoura(tid, pid):
            raise ValueError("Nenhum lugar livre")
        stub(ASvc, auto_allocate_player=_estoura)
        r = client.post(f"/allocations/tournament/{TOUR}/auto?player_id=p1")
        assert r.status_code == 400
        assert codigo(r) == "alocacao_recusada"
        assert r.json()["detail"]["message"] == "Nenhum lugar livre"


# ─────────────────────────────────────────────────────────────────────────────
# Premiação
# ─────────────────────────────────────────────────────────────────────────────

class TestPremiacao:
    """A premiação levanta HTTPException direto do service (é assim desde
    sempre aqui); o que muda é o `detail` levar código e números."""

    def _servico(self, monkeypatch, tabelas):
        import app.services.prize_allocation_service as mod
        monkeypatch.setattr(mod, "supabase", FakeSupabase(tabelas))
        return mod.PrizeAllocationService

    def test_faixa_inexistente(self, monkeypatch):
        from fastapi import HTTPException
        S = self._servico(monkeypatch, {"prize_allocations": []})
        with pytest.raises(HTTPException) as exc:
            S.delete_allocation(TOUR, ALOC)
        assert exc.value.status_code == 404
        assert exc.value.detail["code"] == "faixa_de_premio_nao_encontrada"

    def test_faixa_paga_nao_pode_ser_apagada(self, monkeypatch):
        from fastapi import HTTPException
        S = self._servico(monkeypatch, {"prize_allocations": [
            {"id": ALOC, "tournament_id": TOUR, "position": 1, "paid": True}]})
        with pytest.raises(HTTPException) as exc:
            S.delete_allocation(TOUR, ALOC)
        assert exc.value.detail["code"] == "faixa_de_premio_paga"

    def test_posicao_duplicada_leva_a_posicao_como_dado(self, monkeypatch):
        from fastapi import HTTPException
        from app.models.prize_allocation import PrizeAllocationCreate
        S = self._servico(monkeypatch, {
            "tournaments": [{"id": TOUR, "name": "T"}],
            "prize_allocations": [{"id": ALOC, "tournament_id": TOUR,
                                   "position": 1, "paid": False}],
        })
        nova = PrizeAllocationCreate(position=1, prize_amount=100)
        with pytest.raises(HTTPException) as exc:
            S.create_allocation(TOUR, nova)
        assert exc.value.detail["code"] == "posicao_de_premio_duplicada"
        # A posição vai como número: "1º já tem prêmio" é montado na tela.
        assert exc.value.detail["position"] == 1
