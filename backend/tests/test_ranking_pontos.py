"""Ranking de pontos: o torneio no ranking, a oficialização e a classificação.

O que estes testes prendem (Manual de Ranking NSOP):
- N é de PESSOAS: a reentrada em outro dia conta uma vez, a inscrição
  cancelada não conta;
- B padrão é o preço cheio de 1 entrada (não a promoção, não o "Doble", não a
  taxa) e a direção pode gravar outro;
- só as posições premiadas pontuam, e a direção confirma quem ficou em cada
  uma antes de oficializar — sem buraco, sem jogador repetido, sem quem não
  jogou;
- oficializado, congela: mexer na premiação depois não muda o ranking, e
  corrigir exige reabrir com motivo;
- a etapa soma tudo; a temporada só os N melhores.
"""
import pytest

from app.models.staff import MyPermissions
from app.services import ranking_pontos_service as modulo
from app.services.ranking_pontos_regras import RegrasDoRanking, pontos
from app.services.ranking_pontos_service import RankingPontosService as RPS
from app.services.staff_service import ALL_PERMISSIONS, StaffService
from app.utils.erros import ErroDeNegocio
from tests.conftest import FakeSupabase

ORG = "33333333-3333-3333-3333-333333333333"
USUARIO = "88888888-8888-8888-8888-888888888888"


def _torneio(tid, stage="s1", **extra):
    return {
        "id": tid, "name": f"Torneio {tid}", "stage_id": stage, "organization_id": ORG,
        "team_mode": False, "is_satellite": False, "created_at": "2026-10-01T20:00:00Z",
        "ranking_scoring": True, "ranking_buy_in": None, "ranking_official_at": None,
        "ranking_official_by": None, "ranking_reopen_reason": None, **extra,
    }


def _inscricoes(tid, jogadores, **por_jogador):
    return [{"id": f"{tid}-{p}", "tournament_id": tid, "player_id": p, "status": "eliminated",
             "final_position": None, **por_jogador.get(p, {})} for p in jogadores]


JOGADORES = [f"p{i}" for i in range(1, 15)]  # 14 pessoas


def _base():
    inscricoes = _inscricoes("t1", JOGADORES, p2={"final_position": 2})
    # p5 jogou o Dia 1A e reentrou no 1B: duas linhas, uma pessoa.
    inscricoes.append({"id": "t1-p5-b", "tournament_id": "t1", "player_id": "p5", "status": "active",
                       "final_position": None})
    # p99 teve a inscrição cancelada: não conta em N nem pode ficar no ITM.
    inscricoes.append({"id": "t1-p99", "tournament_id": "t1", "player_id": "p99", "status": "cancelled",
                       "final_position": None})
    return {
        "tournaments": [_torneio("t1"), _torneio("t2"), _torneio("t3", stage="s2")],
        "tournament_players": inscricoes,
        "players": [{"id": p, "name": f"Jogador {p}"} for p in JOGADORES + ["p99"]],
        "prize_allocations": [
            {"tournament_id": "t1", "position": 1, "player_id": "p1", "prize_type": "cash"},
            {"tournament_id": "t1", "position": 2, "player_id": None, "prize_type": "cash"},
            {"tournament_id": "t1", "position": 3, "player_id": "p3", "prize_type": "cash"},
        ],
        "buy_types": [
            {"tournament_id": "t1", "category": "buy_in", "amount": 400, "active": True, "per_team": False, "entry_count": 1},
            {"tournament_id": "t1", "category": "buy_in", "amount": 500, "active": True, "per_team": False, "entry_count": 1},
            {"tournament_id": "t1", "category": "buy_in", "amount": 900, "active": True, "per_team": False, "entry_count": 2},
            {"tournament_id": "t1", "category": "fee", "amount": 50, "active": True, "per_team": False, "entry_count": 1},
        ],
        "tournament_days": [{"tournament_id": "t1", "tournament_date": "2026-10-03", "buy_in": 400, "day_type": "regular"}],
        "stages": [{"id": "s1", "name": "NSOP AREQUIPA"}, {"id": "s2", "name": "Outra"}],
        "tournament_ranking_results": [],
        "ranking_rules": [],
        "ranking_seasons": [],
        "ranking_season_stages": [],
    }


@pytest.fixture
def banco(monkeypatch):
    fake = FakeSupabase(_base())
    monkeypatch.setattr(modulo, "supabase", fake)
    monkeypatch.setattr(RPS, "_tabelas_ok", None)
    return fake


def _linhas(banco, tabela):
    return banco.table(tabela).select("*").execute().data


def _recusa(fn, *args, **kwargs):
    with pytest.raises(ErroDeNegocio) as erro:
        fn(*args, **kwargs)
    return erro.value


POSICOES_OK = [{"position": 1, "player_id": "p1"}, {"position": 2, "player_id": "p2"},
               {"position": 3, "player_id": "p3"}]


class TestSituacaoDoTorneio:
    def test_n_conta_pessoas_e_b_e_o_preco_cheio_de_uma_entrada(self, banco):
        s = RPS.situacao("t1", ORG)
        assert s["unique_players"] == 14
        assert s["buy_in"] == 500 and s["buy_in_default"] == 500 and s["buy_in_custom"] is None
        assert s["paid_places"] == 3
        assert s["warnings"] == []

    def test_proposta_vem_da_premiacao_e_completa_pela_eliminacao(self, banco):
        posicoes = RPS.situacao("t1", ORG)["positions"]
        assert [(p["position"], p["player_id"], p["source"]) for p in posicoes] == [
            (1, "p1", "premiacao"), (2, "p2", "eliminacao"), (3, "p3", "premiacao"),
        ]
        # 14 jogadores, B = 500: fator 0,853.
        assert [p["points"] for p in posicoes] == [85, 60, 49]
        assert posicoes[0]["player_name"] == "Jogador p1"

    def test_lista_de_jogadores_tem_cada_pessoa_uma_vez_e_sem_os_cancelados(self, banco):
        ids = [p["id"] for p in RPS.situacao("t1", ORG)["players"]]
        assert sorted(ids) == sorted(JOGADORES)

    def test_diz_se_o_clube_ja_salvou_as_regras(self, banco):
        """A tela avisa o clube de outra moeda enquanto o buy-in de referência
        for o padrão (em soles); depois de salvar, não."""
        s = RPS.situacao("t1", ORG)
        assert s["rules_customized"] is False and s["buy_in_reference"] == 350
        RPS.salvar_regras(ORG, {"buy_in_referencia": 100000}, USUARIO)
        s = RPS.situacao("t1", ORG)
        assert s["rules_customized"] is True and s["buy_in_reference"] == 100000

    def test_avisos(self, banco):
        banco.table("tournaments").update({"team_mode": True}).eq("id", "t2").execute()
        avisos = RPS.situacao("t2", ORG)["warnings"]
        assert "torneio_por_equipes" in avisos
        assert "sem_premiacao" in avisos
        assert "poucos_jogadores" in avisos  # t2 não tem inscritos
        banco.table("prize_allocations").insert(
            {"tournament_id": "t2", "position": 2, "player_id": None, "prize_type": "vaga"}).execute()
        avisos = RPS.situacao("t2", ORG)["warnings"]
        assert "satelite" in avisos and "premiacao_com_buracos" in avisos

    def test_torneio_inexistente(self, banco):
        assert _recusa(RPS.situacao, "nao-existe", ORG).code == "torneio_nao_encontrado"


class TestConfigurar:
    def test_grava_buy_in_e_volta_ao_padrao(self, banco):
        s = RPS.configurar("t1", {"buy_in": 700, "scoring": True}, None)
        assert s["buy_in"] == 700 and s["buy_in_custom"] == 700
        s = RPS.configurar("t1", {"buy_in": None}, None)
        assert s["buy_in"] == 500 and s["buy_in_custom"] is None

    def test_buy_in_invalido(self, banco):
        assert _recusa(RPS.configurar, "t1", {"buy_in": 0}, None).code == "ranking_buy_in_invalido"

    def test_torneio_de_outra_etapa(self, banco):
        assert _recusa(RPS.configurar, "t1", {"scoring": False}, "s2").code == "torneio_de_outra_etapa"


class TestOficializar:
    def test_congela_os_pontos(self, banco):
        s = RPS.oficializar("t1", POSICOES_OK, ORG, USUARIO)
        assert s["official_at"] is not None
        assert [(p["position"], p["player_id"], p["points"], p["source"]) for p in s["positions"]] == [
            (1, "p1", 85, "oficial"), (2, "p2", 60, "oficial"), (3, "p3", 49, "oficial"),
        ]
        foto = _linhas(banco, "tournament_ranking_results")
        assert len(foto) == 3
        assert {(r["unique_players"], r["buy_in"], r["paid_places"]) for r in foto} == {(14, 500, 3)}
        assert all(r["organization_id"] == ORG and r["official_by"] == USUARIO for r in foto)

    def test_mexer_na_premiacao_depois_nao_muda_o_ranking(self, banco):
        RPS.oficializar("t1", POSICOES_OK, ORG, USUARIO)
        banco.table("prize_allocations").delete().eq("position", 3).execute()
        banco.table("tournament_players").update({"status": "cancelled"}).eq("player_id", "p4").execute()
        s = RPS.situacao("t1", ORG)
        assert s["paid_places"] == 3 and s["unique_players"] == 14
        assert [p["points"] for p in s["positions"]] == [85, 60, 49]

    def test_nao_pontuavel(self, banco):
        banco.table("tournaments").update({"ranking_scoring": False}).eq("id", "t1").execute()
        assert _recusa(RPS.oficializar, "t1", POSICOES_OK, ORG, USUARIO).code == "torneio_nao_pontuavel"

    def test_falta_jogador_numa_posicao(self, banco):
        erro = _recusa(RPS.oficializar, "t1", [POSICOES_OK[0], POSICOES_OK[2]], ORG, USUARIO)
        assert erro.code == "ranking_posicao_sem_jogador" and erro.dados["position"] == 2

    def test_mesmo_jogador_em_duas_posicoes(self, banco):
        posicoes = [POSICOES_OK[0], {"position": 2, "player_id": "p1"}, POSICOES_OK[2]]
        assert _recusa(RPS.oficializar, "t1", posicoes, ORG, USUARIO).code == "ranking_jogador_repetido"

    def test_jogador_que_nao_jogou_ou_foi_cancelado(self, banco):
        for intruso in ("p99", "alguem-de-fora"):
            posicoes = [POSICOES_OK[0], POSICOES_OK[1], {"position": 3, "player_id": intruso}]
            assert _recusa(RPS.oficializar, "t1", posicoes, ORG, USUARIO).code == "ranking_jogador_nao_inscrito"

    def test_posicao_fora_do_itm(self, banco):
        posicoes = POSICOES_OK + [{"position": 4, "player_id": "p4"}]
        erro = _recusa(RPS.oficializar, "t1", posicoes, ORG, USUARIO)
        assert erro.code == "ranking_posicao_fora_do_itm" and erro.dados["paid_places"] == 3

    def test_sem_premiacao(self, banco):
        assert _recusa(RPS.oficializar, "t2", [], ORG, USUARIO).code == "ranking_sem_premiacao"

    def test_nao_oficializa_duas_vezes_nem_reconfigura(self, banco):
        RPS.oficializar("t1", POSICOES_OK, ORG, USUARIO)
        assert _recusa(RPS.oficializar, "t1", POSICOES_OK, ORG, USUARIO).code == "ranking_ja_oficializado"
        assert _recusa(RPS.configurar, "t1", {"buy_in": 800}, None).code == "ranking_ja_oficializado"

    def test_abaixo_do_minimo_oficializa_com_zero(self, banco):
        RPS.salvar_regras(ORG, {"minimo_de_jogadores": 20}, USUARIO)
        s = RPS.oficializar("t1", POSICOES_OK, ORG, USUARIO)
        assert [p["points"] for p in s["positions"]] == [0, 0, 0]


class TestReabrir:
    def test_exige_motivo(self, banco):
        RPS.oficializar("t1", POSICOES_OK, ORG, USUARIO)
        assert _recusa(RPS.reabrir, "t1", "  ", ORG).code == "ranking_motivo_obrigatorio"

    def test_apaga_a_foto_e_guarda_o_motivo(self, banco):
        RPS.oficializar("t1", POSICOES_OK, ORG, USUARIO)
        s = RPS.reabrir("t1", "2º e 3º invertidos na ata", ORG)
        assert s["official_at"] is None
        assert s["reopen_reason"] == "2º e 3º invertidos na ata"
        assert _linhas(banco, "tournament_ranking_results") == []
        # Depois de corrigido, oficializa de novo.
        posicoes = [POSICOES_OK[0], {"position": 2, "player_id": "p3"}, {"position": 3, "player_id": "p2"}]
        s = RPS.oficializar("t1", posicoes, ORG, USUARIO)
        assert [p["player_id"] for p in s["positions"]] == ["p1", "p3", "p2"]

    def test_so_reabre_o_que_esta_oficializado(self, banco):
        assert _recusa(RPS.reabrir, "t1", "motivo qualquer", ORG).code == "ranking_nao_oficializado"


class TestRegrasDoClube:
    def test_padrao_e_o_manual(self, banco):
        regras = RPS.obter_regras(ORG)
        assert regras["personalizadas"] is False
        assert regras["minimo_de_jogadores"] == 12 and regras["buy_in_referencia"] == 350

    def test_gravar_muda_os_pontos(self, banco):
        RPS.salvar_regras(ORG, {"buy_in_referencia": 500}, USUARIO)
        RPS.salvar_regras(ORG, {"jogadores_referencia": 14}, USUARIO)
        regras = RPS.obter_regras(ORG)
        assert regras["personalizadas"] is True
        assert regras["buy_in_referencia"] == 500 and regras["jogadores_referencia"] == 14
        # 14 jogadores e B = 500 viram a referência: fatores 1, o 1º vale 100.
        assert RPS.situacao("t1", ORG)["positions"][0]["points"] == 100
        assert len(_linhas(banco, "ranking_rules")) == 1

    def test_piso_acima_do_teto(self, banco):
        erro = _recusa(RPS.salvar_regras, ORG, {"jogadores_fator_minimo": 2, "jogadores_fator_maximo": 1}, USUARIO)
        assert erro.code == "ranking_regras_invalidas"


def _oficializar_t2(banco):
    banco.table("tournament_players").insert(_inscricoes("t2", JOGADORES)).execute()
    banco.table("prize_allocations").insert([
        {"tournament_id": "t2", "position": 1, "player_id": "p2", "prize_type": "cash"},
        {"tournament_id": "t2", "position": 2, "player_id": "p1", "prize_type": "cash"},
    ]).execute()
    banco.table("buy_types").insert({"tournament_id": "t2", "category": "buy_in", "amount": 500,
                                     "active": True, "per_team": False, "entry_count": 1}).execute()
    RPS.oficializar("t2", [{"position": 1, "player_id": "p2"}, {"position": 2, "player_id": "p1"}], ORG, USUARIO)


class TestClassificacao:
    def test_etapa_soma_os_oficializados_e_lista_os_pendentes(self, banco):
        RPS.oficializar("t1", POSICOES_OK, ORG, USUARIO)
        _oficializar_t2(banco)
        etapa = RPS.ranking_da_etapa("s1")
        assert etapa["stage"]["name"] == "NSOP AREQUIPA"
        # Em ordem de data: t2 (criado 01/10, sem dia) antes de t1 (dia 03/10).
        assert [t["id"] for t in etapa["tournaments"]] == ["t2", "t1"]
        assert etapa["tournaments"][1]["unique_players"] == 14
        # p1: 1º no t1 (85) + 2º no t2 (60); p2: 2º no t1 (60) + 1º no t2 (85).
        # Empatam em tudo (um 1º, um 2º, duas mesas finais, melhor 85).
        topo = {l["player_id"]: l for l in etapa["standings"][:2]}
        assert {(pid, l["total"], l["position"], l["tied"]) for pid, l in topo.items()} == {
            ("p1", 145, 1, True), ("p2", 145, 1, True),
        }
        assert topo["p1"]["by_tournament"] == {"t1": 85, "t2": 60}
        terceiro = etapa["standings"][2]
        assert (terceiro["player_id"], terceiro["total"], terceiro["position"]) == ("p3", 49, 3)
        assert etapa["pending"] == []

    def test_pendente_e_outra_etapa(self, banco):
        RPS.oficializar("t1", POSICOES_OK, ORG, USUARIO)
        etapa = RPS.ranking_da_etapa("s1")
        assert [t["id"] for t in etapa["tournaments"]] == ["t1"]
        assert [t["id"] for t in etapa["pending"]] == ["t2"]  # pontuável, ainda não oficializado
        assert RPS.ranking_da_etapa("s2")["standings"] == []

    def test_etapa_inexistente(self, banco):
        assert _recusa(RPS.ranking_da_etapa, "nao-existe").code == "etapa_nao_encontrada"

    def test_temporada_soma_so_os_melhores(self, banco):
        RPS.oficializar("t1", POSICOES_OK, ORG, USUARIO)
        _oficializar_t2(banco)
        temporada = RPS.criar_temporada(ORG, {"name": "Temporada 2026", "best_results": 1, "stage_ids": ["s1"]},
                                        USUARIO)
        classificacao = RPS.ranking_da_temporada(temporada["id"])
        p1 = next(l for l in classificacao["standings"] if l["player_id"] == "p1")
        assert p1["events"] == 2 and p1["counted"] == 1
        assert p1["total"] == max(pontos(1, 14, 500, 3, RegrasDoRanking()), pontos(2, 14, 500, 2, RegrasDoRanking()))
        assert len(p1["discarded"]) == 1

    def test_temporada_crud(self, banco):
        criada = RPS.criar_temporada(ORG, {"name": "  Liga  ", "best_results": 8, "stage_ids": ["s1", "s2"]}, USUARIO)
        assert criada["name"] == "Liga" and criada["stage_ids"] == ["s1", "s2"]
        atualizada = RPS.atualizar_temporada(criada["id"], ORG, {"stage_ids": ["s2"], "best_results": None}, USUARIO)
        assert atualizada["stage_ids"] == ["s2"] and atualizada["best_results"] is None
        assert [t["id"] for t in RPS.listar_temporadas(ORG)] == [criada["id"]]
        RPS.excluir_temporada(criada["id"])
        assert RPS.listar_temporadas(ORG) == []
        assert _linhas(banco, "ranking_season_stages") == []

    def test_temporada_sem_nome(self, banco):
        assert _recusa(RPS.criar_temporada, ORG, {"name": "  "}, USUARIO).code == "temporada_sem_nome"


class TestMigracaoPendente:
    def test_responde_503_com_codigo(self, banco, monkeypatch):
        original = banco.table

        def tabela(nome):
            if nome == "tournament_ranking_results":
                raise RuntimeError('relation "tournament_ranking_results" does not exist')
            return original(nome)

        monkeypatch.setattr(banco, "table", tabela)
        erro = _recusa(RPS.situacao, "t1", ORG)
        assert erro.code == "ranking_migracao_pendente" and erro.status == 503


# ── Rotas ────────────────────────────────────────────────────────────────────

def _com(monkeypatch, *perms):
    monkeypatch.setattr(
        StaffService, "get_my_permissions",
        staticmethod(lambda uid: MyPermissions(is_admin=False, permissions=list(perms))),
    )


def test_chave_de_permissao_existe():
    assert "points_ranking" in ALL_PERMISSIONS


def test_sem_a_permissao_nada_passa(client, monkeypatch, stub):
    _com(monkeypatch, "prizes", "rankings")
    chamadas = []
    stub(RPS, obter_regras=lambda *a: chamadas.append("regras"),
         oficializar=lambda *a, **k: chamadas.append("oficializar"),
         ranking_da_etapa=lambda *a: chamadas.append("etapa"))
    assert client.get("/points-ranking/rules").status_code == 403
    assert client.post("/points-ranking/tournaments/t1/official", json={"positions": []}).status_code == 403
    assert client.get("/points-ranking/stages/s1").status_code == 403
    assert chamadas == []


def test_com_a_permissao_e_a_org_do_token(client, monkeypatch, stub):
    _com(monkeypatch, "points_ranking")
    recebido = {}
    stub(RPS, obter_regras=lambda org: recebido.setdefault("org", org) and {"minimo_de_jogadores": 12})
    assert client.get("/points-ranking/rules").status_code == 200
    assert recebido["org"] == ORG


def test_buy_in_nulo_limpa_e_ausente_nao_mexe(client, stub):
    recebidos = []
    stub(RPS, configurar=lambda tid, dados, stage: recebidos.append(dados) or {})
    assert client.put("/points-ranking/tournaments/t1", json={"buy_in": None}).status_code == 200
    assert client.put("/points-ranking/tournaments/t1", json={"scoring": True}).status_code == 200
    assert recebidos == [{"buy_in": None}, {"scoring": True}]


def test_recusa_vira_http_com_codigo(client, stub):
    def recusa(*a, **k):
        raise ErroDeNegocio("ranking_posicao_sem_jogador", "Falta o jogador da posição 2.", position=2)

    stub(RPS, oficializar=recusa)
    resposta = client.post("/points-ranking/tournaments/t1/official", json={"positions": []})
    assert resposta.status_code == 400
    assert "ranking_posicao_sem_jogador" in resposta.text


def test_migracao_pendente_vira_503(client, stub):
    def pendente(*a, **k):
        raise ErroDeNegocio("ranking_migracao_pendente", "pendente", 503)

    stub(RPS, situacao=pendente)
    assert client.get("/points-ranking/tournaments/t1").status_code == 503
