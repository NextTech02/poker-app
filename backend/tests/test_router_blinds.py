"""Testes da camada HTTP da estrutura de blinds.

A estrutura vai para a TV e define as apostas obrigatórias da mesa. O que
o router protege é a UNICIDADE do nível: dois níveis 5 no mesmo dia deixam
o relógio ambíguo — qual dos dois vale? — e o erro só aparece quando o
torneio já está rodando.

Há dois conjuntos de rotas quase idênticos (por torneio e por DIA) porque
a estrutura migrou para o dia; ambos continuam de pé e ambos precisam
recusar nível repetido.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.routers import blinds as mod

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
B1 = "55555555-5555-5555-5555-555555555551"
B2 = "55555555-5555-5555-5555-555555555552"
SUMIU = "55555555-5555-5555-5555-55555555ffff"


def _blind(id_, nivel, dia=DIA, torneio=TOUR):
    return {"id": id_, "level": nivel, "small_blind": 100 * nivel,
            "big_blind": 200 * nivel, "ante": 0, "duration": 15,
            "is_break": False, "tournament_id": torneio,
            "tournament_day_id": dia,
            "created_at": "2026-06-08T00:00:00Z",
            "updated_at": "2026-06-08T00:00:00Z"}


@pytest.fixture
def banco(monkeypatch):
    fake = FakeSupabase({
        "tournaments": [{"id": TOUR, "name": "Torneio"}],
        "tournament_days": [{"id": DIA, "tournament_id": TOUR}],
        "blinds": [_blind(B1, 1), _blind(B2, 2)],
    })
    monkeypatch.setattr(mod, "supabase", fake)
    return fake


# ---------------------------------------------------------------------------
# As mesmas regras valem nas duas famílias de rota; a parametrização evita
# duplicar 12 testes e garante que nenhuma das duas fique para trás.
# ---------------------------------------------------------------------------

POR_TORNEIO = (f"/tournaments/{TOUR}/blinds", f"/tournaments/{TOUR}/blinds/{{}}")
POR_DIA = (f"/tournament-days/{DIA}/blinds", f"/tournament-days/{DIA}/blinds/{{}}")


@pytest.fixture(params=[POR_TORNEIO, POR_DIA], ids=["por-torneio", "por-dia"])
def rotas(request):
    return request.param


class TestListagem:
    def test_lista_os_niveis(self, client, banco, rotas):
        r = client.get(rotas[0])
        assert r.status_code == 200
        assert [b["level"] for b in r.json()] == [1, 2]

    def test_pai_inexistente_da_404(self, client, banco):
        banco.store["tournaments"] = []
        banco.store["tournament_days"] = []
        assert client.get(f"/tournaments/{TOUR}/blinds").status_code == 404
        assert client.get(f"/tournament-days/{DIA}/blinds").status_code == 404


class TestCriacao:
    def test_cria_um_nivel(self, client, banco, rotas):
        r = client.post(rotas[0], json={"level": 3, "small_blind": 300,
                                        "big_blind": 600, "duration": 15})
        assert r.status_code == 201
        assert r.json()["level"] == 3

    def test_nivel_repetido_e_recusado(self, client, banco, rotas):
        """Dois níveis com o mesmo número deixariam o relógio sem saber qual
        aplicar."""
        r = client.post(rotas[0], json={"level": 1, "small_blind": 100,
                                        "big_blind": 200, "duration": 15})
        assert r.status_code == 400
        assert "already exists" in r.json()["detail"]["message"]
        assert r.json()["detail"]["code"] == "nivel_de_blind_duplicado"

    def test_pai_inexistente_da_404(self, client, banco):
        banco.store["tournaments"] = []
        banco.store["tournament_days"] = []
        corpo = {"level": 9, "small_blind": 1, "big_blind": 2, "duration": 1}
        assert client.post(f"/tournaments/{TOUR}/blinds", json=corpo).status_code == 404
        assert client.post(f"/tournament-days/{DIA}/blinds", json=corpo).status_code == 404

    def test_nivel_criado_pelo_dia_guarda_tambem_o_torneio(self, client, banco):
        """A tela por torneio ainda lê por `tournament_id`; sem gravar os dois,
        a estrutura sumiria de uma das telas."""
        client.post(f"/tournament-days/{DIA}/blinds",
                    json={"level": 7, "small_blind": 1, "big_blind": 2, "duration": 1})
        novo = [b for b in banco.store["blinds"] if b["level"] == 7][0]
        assert novo["tournament_id"] == TOUR
        assert novo["tournament_day_id"] == DIA

    def test_corpo_sem_nivel_da_422(self, client, banco, rotas):
        assert client.post(rotas[0], json={"small_blind": 100}).status_code == 422

    def test_falha_do_banco_vira_500_com_o_motivo(self, client, banco, rotas, monkeypatch):
        def _estoura(*a, **k):
            raise RuntimeError("conexão perdida")
        monkeypatch.setattr(mod.supabase, "table", _estoura_apos(banco, _estoura, 2))
        r = client.post(rotas[0], json={"level": 8, "small_blind": 1,
                                        "big_blind": 2, "duration": 1})
        assert r.status_code == 500


class TestEdicao:
    def test_altera_os_valores(self, client, banco, rotas):
        r = client.patch(rotas[1].format(B1), json={"small_blind": 999})
        assert r.status_code == 200
        assert r.json()["small_blind"] == 999

    def test_grava_o_horario_da_alteracao(self, client, banco, rotas):
        client.patch(rotas[1].format(B1), json={"duration": 20})
        alterado = [b for b in banco.store["blinds"] if b["id"] == B1][0]
        assert alterado["updated_at"] != "2026-06-08T00:00:00Z"

    def test_mudar_para_um_nivel_ja_usado_e_recusado(self, client, banco, rotas):
        r = client.patch(rotas[1].format(B1), json={"level": 2})
        assert r.status_code == 400
        assert "already exists" in r.json()["detail"]["message"]
        assert r.json()["detail"]["code"] == "nivel_de_blind_duplicado"

    def test_manter_o_proprio_nivel_e_permitido(self, client, banco, rotas):
        """A checagem de duplicidade precisa excluir a própria linha, senão
        salvar sem mexer no nível daria conflito consigo mesmo."""
        r = client.patch(rotas[1].format(B1), json={"level": 1, "duration": 30})
        assert r.status_code == 200

    def test_corpo_vazio_da_400(self, client, banco, rotas):
        r = client.patch(rotas[1].format(B1), json={})
        assert r.status_code == 400
        assert "No fields" in r.json()["detail"]["message"]

    def test_blind_de_outro_pai_da_404(self, client, banco, rotas):
        assert client.patch(rotas[1].format(SUMIU), json={"duration": 5}).status_code == 404


class TestExclusao:
    def test_apaga(self, client, banco, rotas):
        assert client.delete(rotas[1].format(B1)).status_code == 204
        assert [b["id"] for b in banco.store["blinds"]] == [B2]

    def test_apagar_inexistente_da_404(self, client, banco, rotas):
        assert client.delete(rotas[1].format(SUMIU)).status_code == 404


class TestReplicarDuracao:
    """Replicar a duração de um nível para os níveis SEGUINTES.

    "A partir do nível 3, tudo passa a 20 min" é pedido comum minutos antes do
    torneio. A regra que o router protege: só muda o que vem DEPOIS e só do
    mesmo tipo — um intervalo tem a sua própria duração e não pode esticar
    junto com os níveis.
    """

    ROTA = f"/tournament-days/{DIA}/blinds/replicate-duration"
    B3 = "55555555-5555-5555-5555-555555555553"
    B4 = "55555555-5555-5555-5555-555555555554"
    B5 = "55555555-5555-5555-5555-555555555555"
    OUTRO_DIA = "77777777-7777-7777-7777-7777777770ut"

    @pytest.fixture(autouse=True)
    def estrutura(self, banco):
        """N1, N2, BREAK, N4, BREAK — e um nível de OUTRO dia."""
        b3 = _blind(self.B3, 3)
        b3.update({"is_break": True, "duration": 10, "small_blind": 0, "big_blind": 0})
        b5 = _blind(self.B5, 5)
        b5.update({"is_break": True, "duration": 10, "small_blind": 0, "big_blind": 0})
        banco.store["blinds"].extend([b3, _blind(self.B4, 4), b5,
                                      _blind("outro-b", 9, dia=self.OUTRO_DIA)])
        return banco

    def _por_id(self, banco):
        return {b["id"]: b for b in banco.store["blinds"]}

    def test_muda_so_os_niveis_seguintes_e_poupa_os_intervalos(self, client, banco):
        r = client.post(self.ROTA, json={"after_level": 1, "duration": 25, "is_break": False})
        assert r.status_code == 200
        assert r.json() == {"updated": 2, "after_level": 1, "duration": 25, "is_break": False}
        por_id = self._por_id(banco)
        assert por_id[B1]["duration"] == 15            # o editado em si não é tocado
        assert por_id[B2]["duration"] == 25
        assert por_id[self.B4]["duration"] == 25
        assert por_id[self.B3]["duration"] == 10       # intervalos intactos
        assert por_id[self.B5]["duration"] == 10
        assert por_id["outro-b"]["duration"] == 15     # outro dia intacto

    def test_intervalo_replica_so_para_intervalos_seguintes(self, client, banco):
        r = client.post(self.ROTA, json={"after_level": 3, "duration": 12, "is_break": True})
        assert r.status_code == 200
        assert r.json()["updated"] == 1
        por_id = self._por_id(banco)
        assert por_id[self.B5]["duration"] == 12
        assert por_id[self.B3]["duration"] == 10
        assert por_id[self.B4]["duration"] == 15

    def test_grava_o_horario_da_alteracao(self, client, banco):
        client.post(self.ROTA, json={"after_level": 1, "duration": 25})
        por_id = self._por_id(banco)
        assert por_id[B2]["updated_at"] != "2026-06-08T00:00:00Z"
        assert por_id[B1]["updated_at"] == "2026-06-08T00:00:00Z"

    def test_ultimo_do_tipo_responde_zero_sem_erro(self, client, banco):
        r = client.post(self.ROTA, json={"after_level": 5, "duration": 25})
        assert r.status_code == 200
        assert r.json()["updated"] == 0

    def test_dia_inexistente_da_404(self, client, banco):
        banco.store["tournament_days"] = []
        r = client.post(self.ROTA, json={"after_level": 1, "duration": 25})
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "dia_nao_encontrado"

    @pytest.mark.parametrize("corpo", [
        {"after_level": 1, "duration": 0},
        {"after_level": 0, "duration": 20},
        {"duration": 20},
        {},
    ])
    def test_corpo_invalido_da_422(self, client, banco, corpo):
        assert client.post(self.ROTA, json=corpo).status_code == 422

    def test_nao_sombreia_a_edicao_unitaria(self, client, banco):
        """A rota nova mora em `/blinds/<palavra>`; o PATCH `/blinds/<uuid>`
        tem de continuar chegando ao nível certo."""
        r = client.patch(f"/tournament-days/{DIA}/blinds/{B1}", json={"duration": 30})
        assert r.status_code == 200
        assert r.json()["duration"] == 30

    def test_falha_do_banco_vira_500_com_o_motivo(self, client, banco, monkeypatch):
        def _estoura(*a, **k):
            raise RuntimeError("conexão perdida")
        monkeypatch.setattr(mod.supabase, "table", _estoura_apos(banco, _estoura, 1))
        r = client.post(self.ROTA, json={"after_level": 1, "duration": 25})
        assert r.status_code == 500
        assert "conexão perdida" in r.json()["detail"]


class TestExclusaoEmMassa:
    """Limpar a estrutura inteira do dia.

    É a operação mais destrutiva da tela: não há desfazer e o telão fica sem
    blind nenhum. Por isso ela recusa um dia em andamento sem confirmação
    explícita, e zera o relógio — que passaria a contar tempo contra uma
    estrutura que não existe mais.
    """

    ROTA = f"/tournament-days/{DIA}/blinds"

    def test_apaga_a_estrutura_inteira(self, client, banco):
        r = client.delete(self.ROTA)
        assert r.status_code == 200
        assert r.json()["deleted"] == 2
        assert banco.store["blinds"] == []

    def test_nao_toca_na_estrutura_de_outro_dia_do_mesmo_torneio(self, client, banco):
        """Cada dia tem a sua estrutura; limpar o Dia 1A não pode derrubar o
        Dia 1B, que talvez já esteja rodando na sala ao lado."""
        outro = "77777777-7777-7777-7777-7777777770ut"
        banco.store["blinds"].append(_blind("outro-b", 1, dia=outro))
        client.delete(self.ROTA)
        assert [b["id"] for b in banco.store["blinds"]] == ["outro-b"]

    def test_dia_inexistente_da_404(self, client, banco):
        banco.store["tournament_days"] = []
        assert client.delete(self.ROTA).status_code == 404

    def test_dia_ativo_sem_confirmacao_da_409_e_nao_apaga_nada(self, client, banco):
        banco.store["tournament_days"][0]["status"] = "active"
        r = client.delete(self.ROTA)
        assert r.status_code == 409
        assert "force=true" in r.json()["detail"]["message"]
        assert len(banco.store["blinds"]) == 2

    def test_relogio_rodando_tambem_exige_confirmacao(self, client, banco):
        """O status pode estar desatualizado; o que denuncia mesa jogando é o
        cronômetro correndo."""
        banco.store["tournament_days"][0].update(
            {"timer_started_at": "2026-06-08T10:00:00Z", "is_paused": False})
        assert client.delete(self.ROTA).status_code == 409

    def test_relogio_pausado_nao_bloqueia(self, client, banco):
        banco.store["tournament_days"][0].update(
            {"timer_started_at": "2026-06-08T10:00:00Z", "is_paused": True})
        assert client.delete(self.ROTA).status_code == 200

    def test_dia_ativo_com_force_apaga(self, client, banco):
        banco.store["tournament_days"][0]["status"] = "active"
        r = client.delete(self.ROTA, params={"force": "true"})
        assert r.status_code == 200
        assert banco.store["blinds"] == []

    def test_zera_o_relogio_do_dia(self, client, banco):
        banco.store["tournament_days"][0].update({
            "current_level": 7, "elapsed_time": 3000, "manual_time_adjustment": 120,
            "is_paused": False, "timer_started_at": "2026-06-08T10:00:00Z"})
        r = client.delete(self.ROTA, params={"force": "true"})
        assert r.json()["timer_reset"] is True
        linha = banco.store["tournament_days"][0]
        assert (linha["current_level"], linha["elapsed_time"],
                linha["manual_time_adjustment"], linha["is_paused"],
                linha["timer_started_at"]) == (1, 0, 0, True, None)

    def test_estrutura_ja_vazia_nao_mexe_no_relogio(self, client, banco):
        """Clicar por engano num dia sem blinds não pode virar um reset
        silencioso do cronômetro."""
        banco.store["blinds"] = []
        banco.store["tournament_days"][0].update(
            {"current_level": 5, "elapsed_time": 900})
        r = client.delete(self.ROTA)
        assert r.json() == {"deleted": 0, "timer_reset": False}
        assert banco.store["tournament_days"][0]["elapsed_time"] == 900

    def test_sem_a_permissao_de_blinds_da_403(self, client, banco, monkeypatch):
        """Quem só opera o caixa não pode zerar a estrutura do torneio."""
        from app.models.staff import MyPermissions
        from app.services.staff_service import StaffService
        monkeypatch.setattr(
            StaffService, "get_my_permissions",
            staticmethod(lambda uid: MyPermissions(is_admin=False, permissions=["cashier"])),
        )
        assert client.delete(self.ROTA).status_code == 403
        assert len(banco.store["blinds"]) == 2

    def test_falha_do_banco_vira_500_com_o_motivo(self, client, banco, monkeypatch):
        def _estoura():
            raise RuntimeError("conexão perdida")
        # A 1ª ida ao banco é a busca do dia; a 2ª é o delete.
        monkeypatch.setattr(mod.supabase, "table", _estoura_apos(banco, _estoura, 1))
        r = client.delete(self.ROTA)
        assert r.status_code == 500
        assert "conexão perdida" in r.json()["detail"]


class TestGravacaoQueNaoDevolveNada:
    """O insert/update pode responder SEM linha (RLS barrando, por exemplo).

    Esse caso tem tratamento próprio, separado do `except`: a checagem mora
    FORA do try, porque um `except Exception` que a envolvesse capturaria o
    próprio HTTPException e o reescreveria como "erro do servidor" genérico,
    escondendo qual foi o problema.
    """

    def test_criacao_sem_retorno_vira_500_explicito(self, client, banco, rotas, monkeypatch):
        _silencia_escrita(banco, monkeypatch, "insert")
        r = client.post(rotas[0], json={"level": 9, "small_blind": 1,
                                        "big_blind": 2, "duration": 1})
        assert r.status_code == 500
        assert r.json()["detail"] == "Failed to create blind"

    def test_edicao_sem_retorno_vira_500_explicito(self, client, banco, rotas, monkeypatch):
        _silencia_escrita(banco, monkeypatch, "update")
        r = client.patch(rotas[1].format(B1), json={"duration": 30})
        assert r.status_code == 500
        assert r.json()["detail"] == "Failed to update blind"


class TestFalhasDoBanco:
    def test_falha_na_edicao_vira_500_com_o_motivo(self, client, banco, rotas, monkeypatch):
        def _estoura():
            raise RuntimeError("conexão perdida")
        # Sem mexer no nível, a checagem de duplicidade nem acontece: a
        # gravação é a 2ª ida ao banco.
        monkeypatch.setattr(mod.supabase, "table", _estoura_apos(banco, _estoura, 1))
        r = client.patch(rotas[1].format(B1), json={"duration": 30})
        assert r.status_code == 500
        assert "conexão perdida" in r.json()["detail"]

    def test_falha_na_exclusao_vira_500_com_o_motivo(self, client, banco, rotas, monkeypatch):
        def _estoura():
            raise RuntimeError("conexão perdida")
        monkeypatch.setattr(mod.supabase, "table", _estoura_apos(banco, _estoura, 1))
        r = client.delete(rotas[1].format(B1))
        assert r.status_code == 500
        assert "conexão perdida" in r.json()["detail"]


B3 = "55555555-5555-5555-5555-555555555553"
B4 = "55555555-5555-5555-5555-555555555554"


class TestReordenacao:
    """Arrastar na tela manda a ORDEM inteira; o banco renumera numa transação
    (função `reorder_day_blinds`). Nível a nível colidia com o índice único
    (dia, nível) — era o erro ao arrastar um nível ou um intervalo."""

    ROTA = f"/tournament-days/{DIA}/blinds/order"

    @pytest.fixture(autouse=True)
    def quatro_niveis(self, banco):
        banco.store["blinds"] = [
            _blind(B1, 1), _blind(B2, 2),
            {**_blind(B3, 3), "is_break": True, "small_blind": 0, "big_blind": 0, "duration": 10},
            _blind(B4, 4),
        ]

        # O RPC de verdade renumera no banco; o fake faz o mesmo na memória.
        def renumera(params):
            por_id = {b["id"]: b for b in banco.store["blinds"]}
            for pos, id_ in enumerate(params["p_ids"], start=1):
                por_id[id_]["level"] = pos
            return len(params["p_ids"])

        banco.rpcs["reorder_day_blinds"] = renumera

    def test_grava_a_ordem_nova_e_devolve_a_lista_renumerada(self, client, banco):
        r = client.put(self.ROTA, json={"ids": [B4, B1, B2, B3]})
        assert r.status_code == 200
        assert [b["id"] for b in r.json()] == [B4, B1, B2, B3]
        assert [b["level"] for b in r.json()] == [1, 2, 3, 4]
        assert banco.rpc_calls == [
            ("reorder_day_blinds", {"p_day_id": DIA, "p_ids": [B4, B1, B2, B3]})
        ]

    def test_intervalo_tambem_muda_de_lugar(self, client, banco):
        r = client.put(self.ROTA, json={"ids": [B1, B3, B2, B4]})
        assert r.status_code == 200
        assert [b["is_break"] for b in r.json()] == [False, True, False, False]

    def test_mesma_ordem_nao_toca_no_banco(self, client, banco):
        r = client.put(self.ROTA, json={"ids": [B1, B2, B3, B4]})
        assert r.status_code == 200
        assert [b["level"] for b in r.json()] == [1, 2, 3, 4]
        assert banco.rpc_calls == []

    @pytest.mark.parametrize("ids", [
        [B1, B2, B3],                  # faltou um
        [B1, B2, B3, B4, SUMIU],       # sobrou um que não é do dia
        [B1, B1, B2, B3],              # repetido
        [B1, B2, B3, SUMIU],           # trocou um pelo de outro dia
    ])
    def test_lista_que_nao_bate_com_o_dia_e_recusada(self, client, banco, ids):
        r = client.put(self.ROTA, json={"ids": ids})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "ordem_incompleta"
        assert banco.rpc_calls == []

    def test_dia_em_andamento_trava_os_niveis_ate_o_atual(self, client, banco):
        """15 min por nível; 20 min corridos (pausado) = nível 2. Os níveis 1
        e 2 ficam onde estão: o relógio deriva o atual da soma das durações."""
        banco.store["tournament_days"][0].update({"elapsed_time": 1200, "is_paused": True})
        r = client.put(self.ROTA, json={"ids": [B1, B3, B2, B4]})
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "reordenar_nivel_em_andamento"
        assert r.json()["detail"]["nivel_atual"] == 2
        assert banco.rpc_calls == []

    def test_dia_em_andamento_deixa_mexer_no_que_vem_depois(self, client, banco):
        banco.store["tournament_days"][0].update({"elapsed_time": 1200, "is_paused": True})
        r = client.put(self.ROTA, json={"ids": [B1, B2, B4, B3]})
        assert r.status_code == 200
        assert [b["id"] for b in r.json()] == [B1, B2, B4, B3]

    def test_relogio_correndo_conta_o_tempo_desde_o_inicio(self, client, banco):
        """Começou há 20 min e nunca pausou: elapsed_time no banco ainda é 0."""
        inicio = (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat()
        banco.store["tournament_days"][0].update(
            {"timer_started_at": inicio, "is_paused": False, "elapsed_time": 0})
        r = client.put(self.ROTA, json={"ids": [B2, B1, B3, B4]})
        assert r.status_code == 409
        assert r.json()["detail"]["nivel_atual"] == 2

    def test_relogio_nunca_acionado_libera_tudo(self, client, banco):
        r = client.put(self.ROTA, json={"ids": [B4, B3, B2, B1]})
        assert r.status_code == 200
        assert [b["id"] for b in r.json()] == [B4, B3, B2, B1]

    def test_dia_inexistente_da_404(self, client, banco):
        banco.store["tournament_days"] = []
        assert client.put(self.ROTA, json={"ids": [B1, B2, B3, B4]}).status_code == 404

    def test_corpo_sem_ids_da_422(self, client, banco):
        assert client.put(self.ROTA, json={}).status_code == 422
        assert client.put(self.ROTA, json={"ids": []}).status_code == 422

    def test_falha_do_banco_vira_500_com_o_motivo(self, client, banco):
        def explode(_params):
            raise RuntimeError("deadlock")

        banco.rpcs["reorder_day_blinds"] = explode
        r = client.put(self.ROTA, json={"ids": [B4, B1, B2, B3]})
        assert r.status_code == 500
        assert "deadlock" in r.json()["detail"]


def _silencia_escrita(fake, monkeypatch, operacao):
    """Faz `insert`/`update` responderem sem linha nenhuma, como o banco faz
    quando a RLS barra a gravação sem levantar erro."""
    from types import SimpleNamespace
    original = fake.table

    def _table(nome):
        q = original(nome)
        if nome == "blinds":
            metodo = getattr(q, operacao)

            def _sem_retorno(*a, **k):
                metodo(*a, **k)
                return SimpleNamespace(
                    execute=lambda: SimpleNamespace(data=[], count=0),
                    eq=lambda *a, **k: SimpleNamespace(
                        execute=lambda: SimpleNamespace(data=[], count=0)),
                )

            setattr(q, operacao, _sem_retorno)
        return q

    monkeypatch.setattr(mod.supabase, "table", _table)


def _estoura_apos(fake, erro, n):
    """Deixa as `n` primeiras chamadas de `table()` passarem e faz a seguinte
    estourar — é assim que se alcança o `except` do insert sem quebrar as
    validações que vêm antes dele."""
    original = fake.table
    contador = {"n": 0}

    def _table(nome):
        contador["n"] += 1
        if contador["n"] > n:
            erro()
        return original(nome)

    return _table
