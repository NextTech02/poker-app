# -*- coding: utf-8 -*-
"""Operação de torneios: relógio, mesas, eliminação, premiação, KO, equipes e
fichas dos classificados.

Tudo acontece na etapa `ETAPA`, com um torneio por tema: a gravação de um vídeo
não mexe no de outro, nem nas outras áreas que gravam ao mesmo tempo.

Pagar um prêmio, registrar um KO e oficializar a Fase 1 não têm volta pela API.
Por isso esses temas ganham um torneio novo a cada gravação, e o da gravação
anterior vai para `ARQUIVO`: a lista de torneios continua com um de cada.
"""
import uuid
from datetime import date, timedelta

from clube_demo import CLUBES

ETAPA = "Autumn Classic"
ARQUIVO = "Past Events"

NOMES = {
    "relogio": {"pt-BR": "Torneio Noturno", "en-US": "Night Tournament", "es-ES": "Torneo Nocturno"},
    "mesas": {"pt-BR": "Torneio de Sexta", "en-US": "Friday Tournament", "es-ES": "Torneo del Viernes"},
    "eliminar": {"pt-BR": "Torneio de Sábado", "en-US": "Saturday Tournament", "es-ES": "Torneo del Sábado"},
    "premiacao": {"pt-BR": "Torneio de Domingo", "en-US": "Sunday Tournament", "es-ES": "Torneo del Domingo"},
    "ko": {"pt-BR": "Bounty de Quinta", "en-US": "Thursday Bounty", "es-ES": "Bounty del Jueves"},
    "equipes": {"pt-BR": "Copa de Equipes", "en-US": "Team Cup", "es-ES": "Copa de Equipos"},
    "fase1": {"pt-BR": "Liga de Equipes", "en-US": "Team League", "es-ES": "Liga de Equipos"},
    "fichas": {"pt-BR": "Campeonato do Clube", "en-US": "Club Championship", "es-ES": "Campeonato del Club"},
}
# Como a tela chama os dias de um torneio com classificatório.
DIA_CLASSIFICATORIO = {"pt-BR": "Dia 1A", "en-US": "Day 1A", "es-ES": "Día 1A"}
DIA_FINAL = {"pt-BR": "Dia Final", "en-US": "Final Day", "es-ES": "Día Final"}
DIA_FASE1 = {"pt-BR": "Fase 1 — Pontos por mesa", "en-US": "Stage 1 — Table points", "es-ES": "Fase 1 — Puntos por mesa"}
DIA_REVEZAMENTO = {"pt-BR": "Final por revezamento", "en-US": "Relay final", "es-ES": "Final por relevos"}
EQUIPES = {
    "pt-BR": ("Ases", "Reis", "Damas", "Valetes"),
    "en-US": ("Aces", "Kings", "Queens", "Jacks"),
    "es-ES": ("Ases", "Reyes", "Damas", "Jotas"),
}
MEIO_DA_EQUIPE = {"pt-BR": "Equipe", "en-US": "Team", "es-ES": "Equipo"}
MEIO_DE_PAGAMENTO = "cash"

# (small, big, ante, minutos, intervalo)
ESTRUTURA = (
    (100, 200, 0, 20, False), (200, 400, 0, 20, False), (300, 600, 600, 20, False), (400, 800, 800, 20, False),
    (0, 0, 0, 15, True),
    (500, 1000, 1000, 20, False), (600, 1200, 1200, 20, False), (800, 1600, 1600, 20, False),
)


# ── etapa, torneio e dia ─────────────────────────────────────────────────────
def _achar_etapa(api, nome: str, clube) -> dict:
    etapa = next((e for e in api("GET", "/stages") if e["name"] == nome), None)
    if etapa:
        return etapa
    hoje = date.today()
    return api("POST", "/stages", {
        "name": nome, "location": clube.nome,
        "start_date": (hoje - timedelta(days=1)).isoformat(),
        "end_date": (hoje + timedelta(days=30)).isoformat(),
    })


def _etapa(idioma: str, api) -> dict:
    """A etapa desta área, com a gaveta aberta: sem ela o clube não vende."""
    clube = CLUBES[idioma]
    etapa = _achar_etapa(api, ETAPA, clube)
    gaveta = api("GET", "/cashboxes/me/current", etapa=etapa["id"])
    if gaveta and gaveta.get("status") != "open":
        api("POST", f"/cashboxes/{gaveta['id']}/open", {"initial_balance": 300 * clube.fator}, etapa=etapa["id"])
    return etapa


def _torneio_existente(api, eid: str, nome: str):
    return next((t for t in api("GET", "/tournaments", etapa=eid) if t["name"] == nome), None)


def _arquivar(idioma: str, api, eid: str, nome: str) -> None:
    """Tira da lista o torneio da gravação anterior, que já não pode ser refeito."""
    antigos = [t for t in api("GET", "/tournaments", etapa=eid) if t["name"] == nome]
    if not antigos:
        return
    arquivo = _achar_etapa(api, ARQUIVO, CLUBES[idioma])
    for torneio in antigos:
        api("PATCH", f"/tournaments/{torneio['id']}", {"stage_id": arquivo["id"]}, etapa=eid)


def _criar_torneio(api, eid: str, nome: str, **campos) -> dict:
    return api("POST", "/tournaments", {"name": nome, "stage_id": eid, **campos}, etapa=eid)


def _meios(idioma: str, api, eid: str, tid: str, por_equipe: bool = False) -> list:
    f = CLUBES[idioma].fator
    itens = [
        {"name": "Buy-in", "category": "buy_in", "amount": 500 * f, "rake_percentage": 20, "chips": 30000},
        {"name": "Rebuy", "category": "rebuy", "amount": 500 * f, "rake_percentage": 20, "chips": 30000},
        {"name": "Add-on", "category": "addon", "amount": 300 * f, "rake_percentage": 10, "chips": 40000},
    ]
    if por_equipe:
        itens.append({
            "name": MEIO_DA_EQUIPE[idioma], "category": "buy_in", "amount": 2000 * f, "rake_percentage": 20,
            "chips": 30000, "per_team": True,
        })
    api("PUT", f"/tournaments/{tid}/buy-types", {"items": itens}, etapa=eid)
    return api("GET", f"/tournaments/{tid}/buy-types", etapa=eid)


def _corpo_do_dia(idioma: str, tid: str, nome: str, numero: int = 1, **campos) -> dict:
    clube = CLUBES[idioma]
    f = clube.fator
    return {
        "tournament_id": tid, "day_name": nome, "day_number": numero, "buy_in": 500 * f, "rebuy_amount": 500 * f,
        "addon_amount": 300 * f, "rake_percentage": 20, "max_players": 120, "starting_chips": 30000,
        "rebuy_chips": 30000, "addon_chips": 40000, "blind_duration": 20, "initial_small_blind": 100,
        "initial_big_blind": 200, "currency": clube.moeda, **campos,
    }


def _blinds(api, eid: str, dia_id: str) -> None:
    for nivel, (small, big, ante, minutos, intervalo) in enumerate(ESTRUTURA, start=1):
        api("POST", f"/tournament-days/{dia_id}/blinds", {
            "level": nivel, "small_blind": small, "big_blind": big, "ante": ante,
            "duration": minutos, "is_break": intervalo,
        }, etapa=eid)


def _torneio_de_um_dia(idioma: str, api, eid: str, nome: str, **campos) -> tuple:
    torneio = _criar_torneio(api, eid, nome, **campos)
    meios = _meios(idioma, api, eid, torneio["id"])
    dia = api("POST", "/tournament-days", _corpo_do_dia(idioma, torneio["id"], CLUBES[idioma].dia), etapa=eid)
    _blinds(api, eid, dia["id"])
    return torneio, dia, meios


def _ids_dos_jogadores(api) -> dict:
    return {p["name"]: p["id"] for p in api("GET", "/players")}


def _vender(idioma: str, api, eid: str, tid: str, dia_id: str, meios: list, quantos: int) -> None:
    """Os primeiros `quantos` jogadores do clube entram no dia, quem já entrou fica."""
    jogadores = _ids_dos_jogadores(api)
    entrada = next(m for m in meios if m["category"] == "buy_in" and not m.get("per_team"))
    inscritos = {r["player_id"] for r in api("GET", f"/tournament-players/day/{dia_id}", etapa=eid)}
    for nome in CLUBES[idioma].jogadores[:quantos]:
        if jogadores[nome] in inscritos:
            continue
        api("POST", "/tournament-players", {
            "tournament_id": tid, "tournament_day_id": dia_id, "player_id": jogadores[nome],
            "buy_in_count": 1, "payment_source": "cash", "payment_method": MEIO_DE_PAGAMENTO,
            "buy_type_id": entrada["id"], "client_id": str(uuid.uuid4()), "client_mutation_id": str(uuid.uuid4()),
        }, etapa=eid)


def _caixa_geral_com(idioma: str, api, etapa: dict, valor: float) -> None:
    """Prêmio sai do caixa geral: sem sangria, o pagamento é recusado."""
    if float(api("GET", "/cash/general")["current_balance"]) >= valor:
        return
    saldo = float(api("GET", f"/cash/stage/{etapa['id']}")["current_balance"])
    api("POST", "/cash/sangria", {
        "stage_id": etapa["id"], "stage_name": etapa["name"], "amount": saldo,
        "client_mutation_id": str(uuid.uuid4()),
    })


def _sentar(api, eid: str, dia_id: str) -> None:
    api("POST", f"/allocations/day/{dia_id}/bulk", {"mode": "balanced", "player_ids": []}, etapa=eid)


# ── temas ────────────────────────────────────────────────────────────────────
def relogio(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    eid = etapa["id"]
    nome = NOMES["relogio"][idioma]
    torneio = _torneio_existente(api, eid, nome)
    if torneio:
        dia = api("GET", f"/tournament-days/tournament/{torneio['id']}", etapa=eid)[0]
    else:
        torneio, dia, meios = _torneio_de_um_dia(idioma, api, eid, nome)
        _vender(idioma, api, eid, torneio["id"], dia["id"], meios, 12)
    api("POST", f"/tournament-days/{dia['id']}/timer/reset", etapa=eid)
    api("PATCH", f"/tournament-days/{dia['id']}", {"status": "active"}, etapa=eid)
    return {"etapa_selecionada": etapa, "nome_relogio": nome}


def mesas(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    eid = etapa["id"]
    nome = NOMES["mesas"][idioma]
    torneio = _torneio_existente(api, eid, nome)
    if torneio:
        dia = api("GET", f"/tournament-days/tournament/{torneio['id']}", etapa=eid)[0]
    else:
        torneio, dia, meios = _torneio_de_um_dia(idioma, api, eid, nome)
        _vender(idioma, api, eid, torneio["id"], dia["id"], meios, 18)
    # O vídeo começa com todo mundo sem mesa e nenhuma mesa criada.
    for alocacao in api("GET", f"/allocations/day/{dia['id']}", etapa=eid):
        api("DELETE", f"/allocations/{alocacao['id']}", etapa=eid)
    for mesa in api("GET", f"/tables/day/{dia['id']}", etapa=eid):
        api("DELETE", f"/tables/{mesa['id']}", etapa=eid)
    if api("GET", f"/tournament-days/{dia['id']}", etapa=eid).get("tables_locked"):
        api("POST", f"/tournament-days/{dia['id']}/tables-lock", etapa=eid)
    api("PATCH", f"/tournament-days/{dia['id']}", {"status": "active", "allocation_mode": "balanced"}, etapa=eid)
    return {"etapa_selecionada": etapa, "nome_mesas": nome}


def eliminar(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    eid = etapa["id"]
    nome = NOMES["eliminar"][idioma]
    torneio = _torneio_existente(api, eid, nome)
    if torneio:
        dia = api("GET", f"/tournament-days/tournament/{torneio['id']}", etapa=eid)[0]
    else:
        torneio, dia, meios = _torneio_de_um_dia(idioma, api, eid, nome, elimination_mode="table")
        _vender(idioma, api, eid, torneio["id"], dia["id"], meios, 16)
        api("POST", f"/tables/day/{dia['id']}/bulk", etapa=eid, count=2, seats=9)
        api("PATCH", f"/tournament-days/{dia['id']}", {"status": "active"}, etapa=eid)
    # Quem saiu na gravação anterior volta para a mesa.
    for inscrito in api("GET", f"/tournament-players/day/{dia['id']}", etapa=eid):
        if inscrito["status"] == "eliminated":
            api("POST", f"/tournament-players/{inscrito['id']}/uneliminate", etapa=eid)
    if api("GET", f"/allocations/day/{dia['id']}/unallocated", etapa=eid):
        _sentar(api, eid, dia["id"])
    return {"etapa_selecionada": etapa, "nome_eliminar": nome}


def premiacao(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    eid = etapa["id"]
    f = CLUBES[idioma].fator
    nome = NOMES["premiacao"][idioma]
    _arquivar(idioma, api, eid, nome)
    torneio, dia, meios = _torneio_de_um_dia(idioma, api, eid, nome)
    _vender(idioma, api, eid, torneio["id"], dia["id"], meios, 18)
    api("PATCH", f"/tournament-days/{dia['id']}", {"status": "active"}, etapa=eid)
    _caixa_geral_com(idioma, api, etapa, 4000 * f)
    primeiro = next(p for p in api("GET", "/players") if p["name"] == CLUBES[idioma].jogadores[0])
    return {
        "etapa_selecionada": etapa, "nome_premiacao": nome,
        "documento": primeiro["document_number"],
    }


def ko(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    eid = etapa["id"]
    f = CLUBES[idioma].fator
    nome = NOMES["ko"][idioma]
    _arquivar(idioma, api, eid, nome)
    torneio, dia, meios = _torneio_de_um_dia(
        idioma, api, eid, nome, elimination_mode="table", ko_format="ko", ko_percentage=25,
    )
    _vender(idioma, api, eid, torneio["id"], dia["id"], meios, 16)
    api("POST", f"/tables/day/{dia['id']}/bulk", etapa=eid, count=2, seats=9)
    api("PATCH", f"/tournament-days/{dia['id']}", {"status": "active"}, etapa=eid)
    _sentar(api, eid, dia["id"])
    _caixa_geral_com(idioma, api, etapa, 1000 * f)
    return {"etapa_selecionada": etapa, "nome_ko": nome}


def _torneio_por_equipes(idioma: str, api, eid: str, nome: str) -> tuple:
    torneio = _criar_torneio(
        api, eid, nome, has_qualifying=True, elimination_mode="table", team_mode=True,
    )
    meios = _meios(idioma, api, eid, torneio["id"], por_equipe=True)
    final = api("POST", "/tournament-days", {
        "tournament_id": torneio["id"], "day_name": DIA_REVEZAMENTO[idioma], "day_number": 2, "day_type": "final",
        "buy_in": 0, "max_players": 1000, "starting_chips": 0, "rake_percentage": 0,
        "currency": CLUBES[idioma].moeda,
    }, etapa=eid)
    fase_1 = api("POST", "/tournament-days", _corpo_do_dia(
        idioma, torneio["id"], DIA_FASE1[idioma], 1, day_type="qualifying", qualifies_to_day_id=final["id"],
        allocation_type="manual", rake_percentage=0,
    ), etapa=eid)
    _blinds(api, eid, fase_1["id"])
    _blinds(api, eid, final["id"])
    api("POST", f"/tables/day/{fase_1['id']}/bulk", etapa=eid, count=4, seats=9)
    api("PATCH", f"/tournament-days/{fase_1['id']}", {"status": "active"}, etapa=eid)
    return torneio, fase_1, final, meios


def _equipe(idioma: str, api, eid: str, tid: str, indice: int, ids: dict, meios: list) -> dict:
    """Uma equipe, com o capitão em primeiro, já cobrada no meio "por equipe"."""
    nomes = CLUBES[idioma].jogadores[indice * 4:indice * 4 + 4]
    integrantes = [ids[n] for n in nomes]
    nome = EQUIPES[idioma][indice]
    lista = api("POST", f"/tournaments/{tid}/teams", {
        "name": nome, "captain_player_id": integrantes[0], "player_ids": integrantes,
    }, etapa=eid)
    equipe = next(e for e in lista["teams"] if e["name"] == nome)
    por_equipe = next(m for m in meios if m.get("per_team"))
    api("POST", f"/tournaments/{tid}/teams/{equipe['id']}/charge", {
        "buy_type_id": por_equipe["id"], "payment_method": MEIO_DE_PAGAMENTO, "client_mutation_id": str(uuid.uuid4()),
    }, etapa=eid)
    return equipe


def equipes(idioma: str, api) -> dict:
    """Três equipes prontas; a quarta nasce no vídeo."""
    etapa = _etapa(idioma, api)
    eid = etapa["id"]
    clube = CLUBES[idioma]
    nome = NOMES["equipes"][idioma]
    _arquivar(idioma, api, eid, nome)
    torneio, _, _, meios = _torneio_por_equipes(idioma, api, eid, nome)
    ids = _ids_dos_jogadores(api)
    for indice in range(3):
        _equipe(idioma, api, eid, torneio["id"], indice, ids, meios)
    novos = clube.jogadores[12:16]
    return {
        "etapa_selecionada": etapa, "nome_equipes": nome,
        "equipe_nova": EQUIPES[idioma][3], "membro1": novos[0], "membro2": novos[1], "membro3": novos[2],
        "membro4": novos[3],
    }


def fase1(idioma: str, api) -> dict:
    """Quatro equipes, cada mesa jogada até sobrar um: a classificação já existe."""
    etapa = _etapa(idioma, api)
    eid = etapa["id"]
    nome = NOMES["fase1"][idioma]
    _arquivar(idioma, api, eid, nome)
    torneio, _, _, meios = _torneio_por_equipes(idioma, api, eid, nome)
    tid = torneio["id"]
    ids = _ids_dos_jogadores(api)
    for indice in range(4):
        _equipe(idioma, api, eid, tid, indice, ids, meios)
    api("POST", f"/tournaments/{tid}/teams/seating", {}, etapa=eid)
    # A ordem de saída em cada mesa, por equipe: nenhuma equipe empata com outra.
    ordens = ((3, 2, 1), (2, 3, 1), (3, 1, 2), (3, 2, 0))
    resumo = api("GET", f"/tournaments/{tid}/teams/stage1", etapa=eid)
    for mesa, ordem in zip(resumo["tables"], ordens):
        por_equipe = {p["team_name"]: p for p in mesa["players"]}
        for indice in ordem:
            jogador = por_equipe[EQUIPES[idioma][indice]]
            api("POST", f"/tournament-players/{jogador['tp_id']}/eliminate", {}, etapa=eid)
    return {"etapa_selecionada": etapa, "nome_fase1": nome}


def fichas(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    eid = etapa["id"]
    nome = NOMES["fichas"][idioma]
    _arquivar(idioma, api, eid, nome)
    torneio = _criar_torneio(api, eid, nome, has_qualifying=True, elimination_mode="table")
    tid = torneio["id"]
    meios = _meios(idioma, api, eid, tid)
    final = api("POST", "/tournament-days", {
        "tournament_id": tid, "day_name": DIA_FINAL[idioma], "day_number": 2, "day_type": "final",
        "buy_in": 0, "max_players": 1000, "starting_chips": 0, "rake_percentage": 0,
        "currency": CLUBES[idioma].moeda,
    }, etapa=eid)
    dia = api("POST", "/tournament-days", _corpo_do_dia(
        idioma, tid, DIA_CLASSIFICATORIO[idioma], 1, day_type="qualifying", qualifies_to_day_id=final["id"],
    ), etapa=eid)
    _blinds(api, eid, dia["id"])
    api("POST", f"/tables/day/{dia['id']}/bulk", etapa=eid, count=1, seats=9)
    _vender(idioma, api, eid, tid, dia["id"], meios, 8)
    api("PATCH", f"/tournament-days/{dia['id']}", {"status": "active"}, etapa=eid)
    _sentar(api, eid, dia["id"])
    inscritos = api("GET", f"/tournament-players/day/{dia['id']}", etapa=eid)
    for inscrito in inscritos[:3]:
        api("POST", f"/tournament-players/{inscrito['id']}/eliminate", {}, etapa=eid)
    return {"etapa_selecionada": etapa, "nome_fichas": nome}
