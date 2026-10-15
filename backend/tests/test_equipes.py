"""Torneio por equipes no serviço: cadastro, a mesa gravada na eliminação, os
pontos da Fase 1, correções, oficialização, a final por revezamento, a
cobrança por equipe e as guardas de mesa ("colegas em mesas diferentes").
"""
from types import SimpleNamespace

import pytest

from app.services import (
    allocation_service,
    knockout_service,
    public_tv_service,
    sales_block_service,
    team_charge_service,
    team_service,
    tournament_day_service,
    tournament_player_service,
    transaction_service,
)
from app.services.allocation_service import AllocationService
from app.services.cashbox_service import CashboxService
from app.services.public_tv_service import PublicTvService
from app.services.team_charge_service import TeamChargeService, id_da_venda, repartir
from app.services.team_service import TeamService as T, id_do_resultado
from app.services.tournament_day_service import TournamentDayService
from app.services.tournament_player_service import TournamentPlayerService as TPS
from app.models.tournament_player import TournamentPlayerCreate
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase

ORG = "33333333-3333-3333-3333-333333333333"
TOUR = "22222222-2222-2222-2222-222222222222"
F1 = "f1f1f1f1-0000-0000-0000-000000000001"
FINAL = "f1f1f1f1-0000-0000-0000-000000000002"
USER = "88888888-8888-8888-8888-888888888888"
EQUIPES = {"A": ["a1", "a2", "a3", "a4"], "B": ["b1", "b2", "b3", "b4"], "C": ["c1", "c2", "c3", "c4"]}


def _torneio(**extra):
    return {
        "id": TOUR, "name": "Torneo por equipos", "organization_id": ORG, "stage_id": "st1",
        "elimination_mode": "table", "has_qualifying": True, "ko_format": "none",
        "team_mode": True, "team_finalists": 2, "team_tiebreak": "best_individual",
        "team_allow_reentry": False, "team_results_official_at": None, **extra,
    }


def _dia(day_id, tipo, numero, **extra):
    return {
        "id": day_id, "tournament_id": TOUR, "day_name": "Fase", "day_number": numero, "day_type": tipo,
        "qualifies_to_day_id": FINAL if tipo == "qualifying" else None, "buy_in": 100,
        "rake_percentage": 10, "max_players": 100, "registered_players": 0, "starting_chips": 20000,
        "rebuy_amount": 100, "rebuy_chips": 20000, "prize_pool": 0, "eliminations_count": 0,
        "created_at": "2026-10-15T00:00:00Z", "timer_started_at": None, "sales_blocked": False, **extra,
    }


def _tp(pid, day=F1, status="active", **extra):
    return {
        "id": f"tp-{pid}", "tournament_id": TOUR, "tournament_day_id": day, "player_id": pid,
        "status": status, "buy_in_count": 1, "rebuy_count": 0, "addon_count": 0, "total_chips": 20000,
        "total_buy_in_amount": 100, "total_rebuy_amount": 0, "total_addon_amount": 0, "total_spent": 100,
        "eliminated_at": None, "created_at": "2026-10-15T00:00:00Z", "registered_at": "2026-10-15T00:00:00Z",
        "players": {"name": f"Jogador {pid.upper()}"},
        **extra,
    }


def _equipes():
    times, membros = [], []
    for nome, jogadores in EQUIPES.items():
        times.append({
            "id": f"team-{nome}", "organization_id": ORG, "tournament_id": TOUR, "name": f"Equipo {nome}",
            "captain_player_id": jogadores[0], "final_tp_id": None, "tiebreak_rank": None,
            "captain_verified_at": None, "stage1_points": None, "stage1_rank": None,
            "created_at": f"2026-10-15T00:00:0{len(times)}Z",
        })
        for i, p in enumerate(jogadores):
            membros.append({
                "id": f"m-{p}", "organization_id": ORG, "tournament_id": TOUR, "team_id": f"team-{nome}",
                "player_id": p, "relay_order": i + 1,
            })
    return times, membros


def _mesas(n=4):
    return [{"id": f"T{i}", "tournament_day_id": F1, "tournament_id": TOUR, "table_number": i, "seats": 9,
             "status": "active", "occupied_seats": 0, "blocked_seats": []} for i in range(1, n + 1)]


@pytest.fixture
def cenario(monkeypatch):
    def montar(torneio=None, tabelas=None, com_equipes=True, sentados=True):
        times, membros = _equipes() if com_equipes else ([], [])
        jogadores = [p for ps in EQUIPES.values() for p in ps]
        alocacoes = []
        if sentados:
            # Mesa i recebe o i-ésimo integrante de cada equipe: colegas separados.
            for nome, ps in EQUIPES.items():
                for i, p in enumerate(ps):
                    alocacoes.append({"id": f"s-{p}", "tournament_id": TOUR, "tournament_day_id": F1,
                                      "player_id": p, "table_id": f"T{i + 1}", "seat_number": "ABC".index(nome) + 1})
        base = {
            "tournaments": [torneio or _torneio()],
            "tournament_days": [_dia(F1, "qualifying", 1), _dia(FINAL, "final", 2, starting_chips=30000)],
            "tournament_players": [_tp(p) for p in jogadores],
            "players": [{"id": p, "name": f"Jogador {p.upper()}", "nickname": None} for p in jogadores],
            "tournament_teams": times,
            "tournament_team_members": membros,
            "tournament_team_results": [],
            "tournament_tables": _mesas(),
            "seat_allocations": alocacoes,
            "transactions": [],
            "buy_types": [],
            "tournament_knockouts": [], "tournament_knockout_payouts": [],
        }
        base.update(tabelas or {})
        fake = FakeSupabase(base)
        fake.rpcs.update({"consumir_eliminacao": True, "desfazer_eliminacoes": 0,
                          "recontar_eliminacoes": 0, "registrar_eliminacao": 0})
        for mod in (team_service, team_charge_service, tournament_player_service, knockout_service,
                    allocation_service, sales_block_service, tournament_day_service, transaction_service):
            monkeypatch.setattr(mod, "supabase", fake)
        monkeypatch.setattr(public_tv_service, "supabase_admin", fake)
        monkeypatch.setattr(tournament_player_service, "_recalcular_ranking", lambda *a, **k: None)
        monkeypatch.setattr(CashboxService, "require_open_cashbox_for_tournament",
                            staticmethod(lambda *a, **k: None))
        team_service.limpar_cache()
        return fake
    return montar


def _eliminar(pid, quando=None):
    tp, _ = TPS.eliminar(f"tp-{pid}", USER)
    return tp


def _resultado(fake, pid):
    return next((r for r in fake.store["tournament_team_results"] if r["tournament_player_id"] == f"tp-{pid}"), None)


def _horas(fake, *pids):
    """Força a ORDEM das eliminações (o relógio do teste é rápido demais)."""
    for i, pid in enumerate(pids):
        _resultado(fake, pid)["eliminated_at"] = f"2026-10-15T21:00:{i:02d}+00:00"


# ── Cadastro ────────────────────────────────────────────────────────────────
class TestCadastro:
    def test_cria_e_lista_com_a_situacao_de_cada_integrante(self, cenario):
        fake = cenario(com_equipes=False, tabelas={"players": [
            {"id": p, "name": f"J {p}", "nickname": None} for p in ("x1", "x2", "x3", "x4")]})
        dados = T.criar(TOUR, " Los Ases ", "x2", ["x1", "x2", "x3", "x4"])
        [equipe] = dados["teams"]
        assert equipe["name"] == "Los Ases"
        assert [m["player_id"] for m in equipe["members"]] == ["x1", "x2", "x3", "x4"]
        assert [m["is_captain"] for m in equipe["members"]] == [False, True, False, False]
        assert all(m["organization_id"] == ORG for m in fake.store["tournament_team_members"])
        assert dados["stage1_day_id"] == F1 and dados["final_day_id"] == FINAL

    @pytest.mark.parametrize("jogadores,capitao,codigo", [
        (["x1", "x1", "x2", "x3"], "x1", "integrante_repetido"),
        (["x1", "x2", "x3", "x4"], "x9", "capitao_fora_da_equipe"),
        (["x1", "x2", "x3", "x4", "x5"], "x1", "equipe_tamanho_invalido"),
        (["a1", "x2", "x3", "x4"], "a1", "jogador_em_outra_equipe"),
    ])
    def test_recusas(self, cenario, jogadores, capitao, codigo):
        cenario()
        with pytest.raises(ErroDeNegocio) as e:
            T.criar(TOUR, "Nova", capitao, jogadores)
        assert e.value.code == codigo

    def test_nome_repetido_sem_diferenciar_maiusculas(self, cenario):
        cenario()
        with pytest.raises(ErroDeNegocio) as e:
            T.criar(TOUR, "equipo a", "x1", ["x1"])
        assert e.value.code == "nome_de_equipe_repetido"

    def test_torneio_comum_recusa(self, cenario):
        cenario(torneio=_torneio(team_mode=False))
        with pytest.raises(ErroDeNegocio) as e:
            T.listar(TOUR)
        assert e.value.code == "torneio_nao_e_por_equipes"

    def test_trocar_integrante_que_ja_caiu_e_recusado(self, cenario):
        fake = cenario()
        _eliminar("a2")
        with pytest.raises(ErroDeNegocio) as e:
            T.editar(TOUR, "team-A", player_ids=["a1", "x9", "a3", "a4"])
        assert e.value.code == "membro_ja_jogou"
        # Trocar quem ainda não jogou passa, e a ordem acompanha.
        T.editar(TOUR, "team-A", player_ids=["a1", "a2", "a4", "x9"])
        ordem = sorted((m for m in fake.store["tournament_team_members"] if m["team_id"] == "team-A"),
                       key=lambda m: m["relay_order"])
        assert [m["player_id"] for m in ordem] == ["a1", "a2", "a4", "x9"]

    def test_ordem_do_revezamento_trava_com_a_final_em_andamento(self, cenario):
        fake = cenario()
        T.definir_ordem(TOUR, "team-B", ["b4", "b3", "b2", "b1"])
        assert [m["relay_order"] for m in fake.store["tournament_team_members"] if m["player_id"] == "b4"] == [1]
        next(d for d in fake.store["tournament_days"] if d["id"] == FINAL)["timer_started_at"] = "2026-10-15T23:00:00Z"
        with pytest.raises(ErroDeNegocio) as e:
            T.definir_ordem(TOUR, "team-B", ["b1", "b2", "b3", "b4"])
        assert e.value.code == "ordem_de_revezamento_travada"
        T.definir_ordem(TOUR, "team-B", ["b1", "b2", "b3", "b4"], force=True)
        with pytest.raises(ErroDeNegocio) as e:
            T.definir_ordem(TOUR, "team-B", ["b1", "b2", "b3", "a1"])
        assert e.value.code == "ordem_com_outros_jogadores"


# ── A mesa gravada na eliminação ────────────────────────────────────────────
class TestGancho:
    def test_grava_a_mesa_antes_de_liberar_a_cadeira(self, cenario):
        fake = cenario()
        _eliminar("b3")
        linha = _resultado(fake, "b3")
        assert linha["table_id"] == "T3"
        assert linha["id"] == id_do_resultado(F1, "tp-b3")
        assert linha["organization_id"] == ORG and linha["eliminated_at"]
        assert not any(a["player_id"] == "b3" for a in fake.store["seat_allocations"])

    def test_torneio_comum_nao_grava_nada(self, cenario):
        fake = cenario(torneio=_torneio(team_mode=False))
        _eliminar("b3")
        assert fake.store["tournament_team_results"] == []

    def test_linha_da_equipe_na_final_nao_pontua(self, cenario):
        fake = cenario(tabelas={"tournament_players": [_tp("a1", day=FINAL, is_qualified_entry=True)]})
        _eliminar("a1")
        assert fake.store["tournament_team_results"] == []

    def test_replay_repara_a_linha_que_faltou(self, cenario):
        fake = cenario()
        tp = next(t for t in fake.store["tournament_players"] if t["id"] == "tp-c2")
        tp.update(status="eliminated", eliminated_at="2026-10-15T21:00:00+00:00")
        TPS.eliminar("tp-c2", USER, idempotent=True)
        assert _resultado(fake, "c2")["table_id"] == "T2"
        # Repetir não duplica nem sobrescreve.
        TPS.eliminar("tp-c2", USER, idempotent=True)
        assert len(fake.store["tournament_team_results"]) == 1

    def test_desfazer_eliminacao_tira_os_pontos_e_reeliminar_sobrescreve(self, cenario):
        fake = cenario()
        _eliminar("a1")
        TPS.uneliminate_player("tp-a1")
        resumo = T.fase1_resumo(TOUR)
        mesa1 = next(m for m in resumo["tables"] if m["table_id"] == "T1")
        assert all(p["points"] is None for p in mesa1["players"])
        # Senta de novo (em outra mesa) e cai de novo: vale a última.
        fake.store["seat_allocations"].append({"id": "s-a1b", "tournament_day_id": F1, "player_id": "a1",
                                               "table_id": "T2", "seat_number": 9})
        _eliminar("a1")
        assert _resultado(fake, "a1")["table_id"] == "T2"
        assert len([r for r in fake.store["tournament_team_results"] if r["tournament_player_id"] == "tp-a1"]) == 1


class TestReentrada:
    def _com_embed(self, fake, torneio):
        tp = next(t for t in fake.store["tournament_players"] if t["id"] == "tp-a1")
        tp.update(status="eliminated", tournament_days=_dia(F1, "qualifying", 1),
                  tournaments={**torneio, "stages": {"sales_blocked": False}})

    def test_recusada_por_padrao(self, cenario):
        fake = cenario()
        self._com_embed(fake, _torneio())
        with pytest.raises(ErroDeNegocio) as e:
            TPS.add_rebuy("tp-a1", USER)
        assert e.value.code == "reentrada_nao_permitida_em_equipes"

    def test_permitida_quando_o_torneio_libera(self, cenario):
        fake = cenario(torneio=_torneio(team_allow_reentry=True))
        self._com_embed(fake, _torneio(team_allow_reentry=True))
        TPS.add_rebuy("tp-a1", USER)
        assert next(t for t in fake.store["tournament_players"] if t["id"] == "tp-a1")["status"] == "active"


# ── Fase 1: pontos, correções e oficialização ───────────────────────────────
def _jogar_mesa_1(fake):
    """Mesa 1: a1, b1, c1. Caem c1 e depois b1 → a1 vence (mesa de 3)."""
    _eliminar("c1")
    _eliminar("b1")
    _horas(fake, "c1", "b1")


class TestFase1:
    def test_pontos_por_mesa_e_ranking(self, cenario):
        fake = cenario()
        _jogar_mesa_1(fake)
        resumo = T.fase1_resumo(TOUR)
        mesa1 = next(m for m in resumo["tables"] if m["table_id"] == "T1")
        assert mesa1["finished"] and mesa1["size"] == 3
        assert {p["player_id"]: p["points"] for p in mesa1["players"]} == {"a1": 15.0, "b1": 10.0, "c1": 5.0}
        assert resumo["tables_in_play"] == [2, 3, 4]
        ranking = {l["team_id"]: (l["points"], l["rank"]) for l in resumo["ranking"]}
        assert ranking == {"team-A": (15.0, 1), "team-B": (10.0, 2), "team-C": (5.0, 3)}

    def test_avisos(self, cenario):
        fake = cenario(tabelas={"tournament_players": [_tp(p) for ps in EQUIPES.values() for p in ps] + [_tp("solo")]})
        resumo = T.fase1_resumo(TOUR)
        codigos = {a["code"] for a in resumo["warnings"]}
        assert {"jogadores_sem_equipe", "vivos_sem_assento"} <= codigos

    def test_empate_com_o_anterior_divide(self, cenario):
        fake = cenario()
        _jogar_mesa_1(fake)
        T.corrigir_resultado(TOUR, "tp-b1", tie_with_previous=True)
        mesa1 = next(m for m in T.fase1_resumo(TOUR)["tables"] if m["table_id"] == "T1")
        pontos = {p["player_id"]: p["points"] for p in mesa1["players"]}
        assert pontos["b1"] == pontos["c1"] == 7.5

    def test_trocar_a_ordem_com_o_anterior(self, cenario):
        fake = cenario()
        _jogar_mesa_1(fake)
        T.corrigir_resultado(TOUR, "tp-b1", swap_with_previous=True)
        mesa1 = next(m for m in T.fase1_resumo(TOUR)["tables"] if m["table_id"] == "T1")
        assert {p["player_id"]: p["points"] for p in mesa1["players"]}["b1"] == 5.0
        with pytest.raises(ErroDeNegocio) as e:
            T.corrigir_resultado(TOUR, "tp-b1", swap_with_previous=True)
        assert e.value.code == "sem_eliminacao_anterior"

    def test_posicoes_digitadas_pela_direcao(self, cenario):
        fake = cenario()
        _jogar_mesa_1(fake)
        T.posicoes_da_mesa(TOUR, "T1", {"tp-a1": 2, "tp-b1": 1, "tp-c1": 3})
        mesa1 = next(m for m in T.fase1_resumo(TOUR)["tables"] if m["table_id"] == "T1")
        assert mesa1["manual"]
        assert {p["player_id"]: p["points"] for p in mesa1["players"]} == {"a1": 10.0, "b1": 15.0, "c1": 5.0}
        T.limpar_posicoes_da_mesa(TOUR, "T1")
        mesa1 = next(m for m in T.fase1_resumo(TOUR)["tables"] if m["table_id"] == "T1")
        assert not mesa1["manual"] and {p["player_id"]: p["points"] for p in mesa1["players"]}["a1"] == 15.0

    def test_posicoes_so_com_a_mesa_terminada(self, cenario):
        cenario()
        _eliminar("c2")
        with pytest.raises(ErroDeNegocio) as e:
            T.posicoes_da_mesa(TOUR, "T2", {"tp-a2": 1, "tp-b2": 2, "tp-c2": 3})
        assert e.value.code == "mesa_em_jogo"

    def test_oficializar_recusa_mesas_em_jogo_e_congela_a_foto(self, cenario):
        fake = cenario()
        _jogar_mesa_1(fake)
        with pytest.raises(ErroDeNegocio) as e:
            T.oficializar(TOUR)
        assert e.value.code == "mesas_em_jogo_na_fase1"
        resumo = T.oficializar(TOUR, USER, force=True)
        assert resumo["official"]
        equipe_a = next(e for e in fake.store["tournament_teams"] if e["id"] == "team-A")
        assert (equipe_a["stage1_points"], equipe_a["stage1_rank"]) == (15.0, 1)
        # Depois de oficializar, desfazer uma eliminação não muda o ranking.
        TPS.uneliminate_player("tp-c1")
        assert {l["team_id"]: l["points"] for l in T.fase1_resumo(TOUR)["ranking"]}["team-C"] == 5.0
        with pytest.raises(ErroDeNegocio) as e:
            T.corrigir_resultado(TOUR, "tp-b1", tie_with_previous=True)
        assert e.value.code == "fase1_oficializada"
        T.desoficializar(TOUR)
        assert not T.fase1_resumo(TOUR)["official"]

    def test_empate_na_linha_de_corte_bloqueia(self, cenario):
        fake = cenario()
        _eliminar("c1")
        _eliminar("c2")
        # C soma 10 (5 + 5); A e B ficam com 0 e 0, empatadas na 2ª vaga da final.
        resumo = T.fase1_resumo(TOUR)
        assert [(l["team_id"], l["rank"], l["tied"]) for l in resumo["ranking"]] == [
            ("team-C", 1, False), ("team-A", 2, True), ("team-B", 2, True)]
        assert resumo["cut_tie"]
        with pytest.raises(ErroDeNegocio) as e:
            T.oficializar(TOUR, force=True)
        assert e.value.code == "empate_na_linha_de_corte"


# ── Final por revezamento ───────────────────────────────────────────────────
def _oficializada(fake):
    _jogar_mesa_1(fake)
    T.oficializar(TOUR, USER, force=True)


class TestFinal:
    def test_exige_fase1_oficializada(self, cenario):
        cenario()
        with pytest.raises(ErroDeNegocio) as e:
            T.montar_final(TOUR, 2)
        assert e.value.code == "fase1_nao_oficializada"

    def test_uma_linha_por_equipe_com_o_stack_da_final(self, cenario):
        fake = cenario()
        _oficializada(fake)
        dados = T.montar_final(TOUR, 2)
        linhas = [t for t in fake.store["tournament_players"] if t["tournament_day_id"] == FINAL]
        assert sorted(l["player_id"] for l in linhas) == ["a1", "b1"]
        assert all(l["total_chips"] == 30000 and l["is_qualified_entry"] and l["buy_in_count"] == 0 for l in linhas)
        assert all(l["organization_id"] == ORG for l in linhas)
        assert [t["name"] for t in dados["teams"]] == ["Equipo A", "Equipo B"]
        assert [m["relay_order"] for m in dados["teams"][0]["members"]] == [1, 2, 3, 4]
        with pytest.raises(ErroDeNegocio) as e:
            T.montar_final(TOUR, 2)
        assert e.value.code == "final_ja_montada"
        with pytest.raises(ErroDeNegocio) as e:
            T.desoficializar(TOUR)
        assert e.value.code == "final_ja_montada"

    def test_desfazer_antes_de_comecar(self, cenario):
        fake = cenario()
        _oficializada(fake)
        T.montar_final(TOUR, 2)
        T.desfazer_final(TOUR)
        assert not [t for t in fake.store["tournament_players"] if t["tournament_day_id"] == FINAL]
        assert not any(e.get("final_tp_id") for e in fake.store["tournament_teams"])

    def test_classificacao_da_final(self, cenario):
        fake = cenario()
        _oficializada(fake)
        dados = T.montar_final(TOUR, 2)
        tp_b = next(t["final_tp_id"] for t in dados["teams"] if t["name"] == "Equipo B")
        TPS.eliminar(tp_b, USER)
        posicoes = [(l["name"], l["status"], l["position"]) for l in T.revezamento(TOUR)["standings"]]
        assert posicoes == [("Equipo A", "champion", 1), ("Equipo B", "eliminated", 2), ("Equipo C", "stage1", 3)]

    def test_telao_mostra_equipes_e_apelidos_na_ordem(self, cenario):
        fake = cenario()
        next(p for p in fake.store["players"] if p["id"] == "a2")["nickname"] = "Tiburón"
        _oficializada(fake)
        T.montar_final(TOUR, 2)
        relay = PublicTvService._revezamento(TOUR)
        assert relay["start_level"] == 1
        assert relay["teams"][0] == {"name": "Equipo A", "eliminated": False,
                                     "members": ["Jogador", "Tiburón", "Jogador", "Jogador"]}

    def test_avancar_classificados_e_recusado(self, cenario):
        cenario()
        with pytest.raises(ErroDeNegocio) as e:
            TournamentDayService.advance_qualifiers(F1)
        assert e.value.code == "avancar_equipes_pela_tela_de_equipes"


# ── Cobrança por equipe ─────────────────────────────────────────────────────
def _meio(por_equipe=True, valor=1000.03, **extra):
    return {"id": "bt-eq", "tournament_id": TOUR, "name": "Equipo", "category": "buy_in", "amount": valor,
            "rake_percentage": 10, "chips": 20000, "active": True, "per_team": por_equipe, **extra}


class TestCobranca:
    def test_divide_ao_centavo_com_a_sobra_no_capitao(self):
        assert repartir(__import__("decimal").Decimal("1000.03"), 4)[0] == __import__("decimal").Decimal("250.01")
        assert sum(repartir(__import__("decimal").Decimal("1000.03"), 4)) == __import__("decimal").Decimal("1000.03")

    def test_cobra_os_quatro_em_lote(self, cenario):
        fake = cenario(tabelas={"tournament_players": [], "buy_types": [_meio()]})
        dados = TeamChargeService.cobrar(TOUR, "team-A", "bt-eq", "cash", "cm1", USER)
        assert dados["charged"] == 4 and dados["amount"] == 1000.03
        vendas = fake.store["transactions"]
        assert sorted(v["amount"] for v in vendas) == [250.0, 250.01, 250.01, 250.01]
        capitao = next(v for v in vendas if v["player_id"] == "a1")
        assert capitao["amount"] == 250.01 and capitao["rake_amount"] == 25.0
        assert {v["client_id"] for v in vendas} == {id_da_venda("cm1", i) for i in range(4)}
        assert len(fake.store["tournament_players"]) == 4
        # O mesmo clique de novo não cobra duas vezes.
        assert TeamChargeService.cobrar(TOUR, "team-A", "bt-eq", "cash", "cm1", USER)["charged"] == 0
        assert len(fake.store["transactions"]) == 4

    def test_quem_ja_se_inscreveu_nao_paga_de_novo(self, cenario):
        fake = cenario(tabelas={"tournament_players": [_tp("a3")], "buy_types": [_meio(valor=1000)]})
        dados = TeamChargeService.cobrar(TOUR, "team-A", "bt-eq", "cash", None, USER)
        assert dados["charged"] == 3 and dados["amount"] == 750.0

    def test_meio_que_nao_e_por_equipe_e_recusado(self, cenario):
        cenario(tabelas={"tournament_players": [], "buy_types": [_meio(por_equipe=False)]})
        with pytest.raises(ErroDeNegocio) as e:
            TeamChargeService.cobrar(TOUR, "team-A", "bt-eq", "cash", None, USER)
        assert e.value.code == "meio_de_entrada_nao_e_por_equipe"

    def test_meio_por_equipe_nao_vende_para_um_jogador_so(self, cenario):
        cenario(tabelas={"tournament_players": [], "buy_types": [_meio()]})
        with pytest.raises(ErroDeNegocio) as e:
            TPS.register_player(TournamentPlayerCreate(
                tournament_id=TOUR, tournament_day_id=F1, player_id="a1", buy_type_id="bt-eq",
            ), USER)
        assert e.value.code == "meio_de_entrada_por_equipe"

    def test_estorno_da_equipe(self, cenario, monkeypatch):
        fake = cenario(tabelas={"tournament_players": [], "buy_types": [_meio()]})
        TeamChargeService.cobrar(TOUR, "team-A", "bt-eq", "cash", None, USER)
        estornadas = []
        monkeypatch.setattr(transaction_service.TransactionService, "cancel_transaction",
                            staticmethod(lambda tx, user, motivo: estornadas.append(tx)))
        assert TeamChargeService.estornar(TOUR, "team-A", None, USER)["cancelled"] == 4
        assert len(estornadas) == 4


# ── Mesas: colegas separados ────────────────────────────────────────────────
class TestMesas:
    def test_alocacao_automatica_foge_da_mesa_do_colega(self, cenario):
        fake = cenario(sentados=False)
        fake.store["seat_allocations"] = [
            {"id": "s1", "tournament_day_id": F1, "player_id": "a1", "table_id": "T1", "seat_number": 1},
            {"id": "s2", "tournament_day_id": F1, "player_id": "a2", "table_id": "T2", "seat_number": 1},
        ]
        monkeypatch_details = AllocationService.get_allocation_with_details
        AllocationService.get_allocation_with_details = staticmethod(lambda i: SimpleNamespace(id=i))
        try:
            for _ in range(3):
                AllocationService.auto_allocate_player_for_day(TOUR, F1, "a3", mode="balanced")
                mesa = next(a for a in fake.store["seat_allocations"] if a["player_id"] == "a3")["table_id"]
                assert mesa in ("T3", "T4")
        finally:
            AllocationService.get_allocation_with_details = monkeypatch_details

    def test_sentar_a_mao_ao_lado_do_colega_e_recusado(self, cenario):
        cenario()
        with pytest.raises(ErroDeNegocio) as e:
            AllocationService.manual_allocate_player_for_day(TOUR, F1, "a2", "T1", 7)
        assert e.value.code == "mesa_com_companheiro"
        assert e.value.dados["mesa"] == 1

    def test_sorteio_por_equipes_separa_os_integrantes(self, cenario):
        fake = cenario(sentados=False)
        AllocationService.bulk_allocate_players(TOUR, F1, "sequential")
        mesa_de = {a["player_id"]: a["table_id"] for a in fake.store["seat_allocations"]}
        assert len(mesa_de) == 12
        for jogadores in EQUIPES.values():
            assert len({mesa_de[p] for p in jogadores}) == 4
        _eliminar("a1")
        with pytest.raises(ErroDeNegocio) as e:
            T.sortear_mesas(TOUR, refazer=True)
        assert e.value.code == "sorteio_com_eliminacoes"

    def test_torneio_comum_continua_igual(self, cenario):
        fake = cenario(com_equipes=False, sentados=False)
        AllocationService.bulk_allocate_players(TOUR, F1, "sequential")
        mesas = [a["table_id"] for a in fake.store["seat_allocations"]]
        assert mesas.count("T1") == 9  # sequencial enche a mesa 1 primeiro


# ── Configuração do torneio ─────────────────────────────────────────────────
class TestConfiguracao:
    @pytest.fixture
    def servico(self, monkeypatch):
        from app.services import tournament_service
        from app.services.tournament_service import TournamentService

        def montar(torneio=None, inscritos=()):
            fake = FakeSupabase({"tournaments": [torneio] if torneio else [], "tournament_players": list(inscritos)})
            monkeypatch.setattr(tournament_service, "supabase", fake)
            return TournamentService, fake
        return montar

    def _criar(self, S, **campos):
        from app.models.tournament import TournamentCreate
        return S.create_tournament(TournamentCreate(name="Equipos", stage_id="st1", **campos), USER)

    def test_exige_classificatorio_e_eliminacao_por_mesa(self, servico):
        S, _ = servico()
        with pytest.raises(ErroDeNegocio) as e:
            self._criar(S, team_mode=True, elimination_mode="table")
        assert e.value.code == "equipes_exige_classificatorio"
        with pytest.raises(ErroDeNegocio) as e:
            self._criar(S, team_mode=True, has_qualifying=True)
        assert e.value.code == "equipes_exige_modo_mesa"

    def test_cria_com_as_colunas_e_o_comum_sem_elas(self, servico):
        S, fake = servico()
        self._criar(S, team_mode=True, has_qualifying=True, elimination_mode="table", team_finalists=4)
        self._criar(S)
        por_equipes, comum = fake.store["tournaments"]
        assert por_equipes["team_mode"] is True and por_equipes["team_finalists"] == 4
        assert "team_mode" not in comum and "team_tiebreak" not in comum

    def test_ligar_com_inscritos_e_recusado(self, servico):
        from app.models.tournament import TournamentUpdate
        S, _ = servico(
            torneio={"id": TOUR, "name": "X", "team_mode": False, "has_qualifying": True,
                     "elimination_mode": "table", "ko_format": "none", "created_by": USER,
                     "created_at": "2026-10-15T00:00:00Z"},
            inscritos=[{"id": "tp1", "tournament_id": TOUR, "status": "active"}],
        )
        with pytest.raises(ErroDeNegocio) as e:
            S.update_tournament(TOUR, TournamentUpdate(team_mode=True))
        assert e.value.code == "modo_equipes_bloqueado_com_inscritos"
