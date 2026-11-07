# -*- coding: utf-8 -*-
"""Configuração de torneios: etapas, torneios, meios de entrada, dias, blinds,
templates, telão e bilhete.

Tudo acontece na etapa `ETAPA`, com um torneio por tema. Estes vídeos criam pela
tela, então cada semente apaga o que a tomada anterior deixou: sem venda, excluir
torneio, etapa ou template não deixa rastro, e o nome digitado é sempre o mesmo.

Só dois temas vendem de verdade. O telão precisa de gente sentada, e por isso
guarda o torneio entre uma tomada e outra. `ETAPA_ARQUIVAR` tem uma venda porque
é o movimento financeiro que faz o sistema oferecer "Arquivar" no lugar de excluir.
"""
from datetime import date, timedelta

from clube_demo import CLUBES
from sementes.torneios_operacao import (
    _achar_etapa, _criar_torneio, _meios, _sentar, _torneio_de_um_dia, _vender,
)

ETAPA = "Spring Open"
ETAPA_ARQUIVAR = "Harbor Cup"

NOVA_ETAPA = {"pt-BR": "Circuito de Verão", "en-US": "Summer Circuit", "es-ES": "Circuito de Verano"}
NOMES = {
    "novo": {"pt-BR": "Copa da Primavera", "en-US": "Spring Cup", "es-ES": "Copa de Primavera"},
    "editado": {"pt-BR": "Grande Copa da Primavera", "en-US": "Grand Spring Cup", "es-ES": "Gran Copa de Primavera"},
    "meios": {"pt-BR": "Torneio de Terça", "en-US": "Tuesday Tournament", "es-ES": "Torneo del Martes"},
    "dias": {"pt-BR": "Torneio de Quarta", "en-US": "Wednesday Tournament", "es-ES": "Torneo del Miércoles"},
    "blinds": {"pt-BR": "Torneio Turbo", "en-US": "Turbo Tournament", "es-ES": "Torneo Turbo"},
    "templates": {"pt-BR": "Torneio Deepstack", "en-US": "Deepstack Tournament", "es-ES": "Torneo Deepstack"},
    "telao": {"pt-BR": "Torneio da Casa", "en-US": "House Tournament", "es-ES": "Torneo de la Casa"},
    "bilhete": {"pt-BR": "Torneio de Aniversário", "en-US": "Anniversary Tournament", "es-ES": "Torneo de Aniversario"},
}
BUYIN_DUPLO = {"pt-BR": "Buy-in Duplo", "en-US": "Double Buy-in", "es-ES": "Buy-in Doble"}
TEMPLATE = {"pt-BR": "Turbo 20 minutos", "en-US": "Turbo 20 minutes", "es-ES": "Turbo 20 minutos"}
TEMPLATE_DESCRICAO = {
    "pt-BR": "Estrutura das noites de semana",
    "en-US": "Weeknight structure",
    "es-ES": "Estructura de las noches de semana",
}
# Cidades e sedes inventadas: o bilhete é impresso com o que estiver aqui.
BILHETE_CLUBE = {
    "pt-BR": ("Vila Serena", "Salão Principal"),
    "en-US": ("Maple Falls", "Main Hall"),
    "es-ES": ("Valle Sereno", "Salón Principal"),
}
BILHETE_TORNEIO = {
    "pt-BR": ("Praia Clara", "Salão de Eventos"),
    "en-US": ("Clearwater Bay", "Event Hall"),
    "es-ES": ("Bahía Clara", "Salón de Eventos"),
}

# (small, big, ante, minutos): sem intervalo, que é o que o vídeo acrescenta.
ESTRUTURA_INICIAL = ((100, 200, 0, 20), (200, 400, 0, 20), (300, 600, 600, 20), (400, 800, 800, 20))


# ── etapa e torneios ─────────────────────────────────────────────────────────
def _etapa(idioma: str, api) -> dict:
    return _achar_etapa(api, ETAPA, CLUBES[idioma])


def _abrir_gaveta(idioma: str, api, eid: str) -> None:
    """Sem a gaveta aberta o clube não vende."""
    gaveta = api("GET", "/cashboxes/me/current", etapa=eid)
    if gaveta and gaveta.get("status") != "open":
        api("POST", f"/cashboxes/{gaveta['id']}/open", {"initial_balance": 300 * CLUBES[idioma].fator}, etapa=eid)


def _apagar_torneios(api, eid: str, *nomes: str) -> None:
    for torneio in api("GET", "/tournaments", etapa=eid):
        if torneio["name"] in nomes:
            api("DELETE", f"/tournaments/{torneio['id']}", etapa=eid)


def _torneio_novo(idioma: str, api, eid: str, tema: str) -> dict:
    """O torneio do tema, zerado, com os três meios de entrada de sempre."""
    nome = NOMES[tema][idioma]
    _apagar_torneios(api, eid, nome)
    torneio = _criar_torneio(api, eid, nome)
    _meios(idioma, api, eid, torneio["id"])
    return torneio


def _dia_vazio(idioma: str, api, eid: str, tema: str) -> tuple:
    """Torneio com um dia sem nenhum nível de blind."""
    torneio = _torneio_novo(idioma, api, eid, tema)
    clube = CLUBES[idioma]
    f = clube.fator
    dia = api("POST", "/tournament-days", {
        "tournament_id": torneio["id"], "day_name": clube.dia, "day_number": 1, "buy_in": 500 * f,
        "rebuy_amount": 500 * f, "addon_amount": 300 * f, "rake_percentage": 20, "max_players": 120,
        "starting_chips": 30000, "rebuy_chips": 30000, "addon_chips": 40000, "currency": clube.moeda,
    }, etapa=eid)
    return torneio, dia


def _etapa_encerrada(idioma: str, api) -> None:
    """Etapa que já passou, com uma venda, de volta ao estado de antes de arquivar."""
    etapa = _achar_etapa(api, ETAPA_ARQUIVAR, CLUBES[idioma])
    eid = etapa["id"]
    if not api("GET", "/tournaments", etapa=eid):
        _abrir_gaveta(idioma, api, eid)
        torneio, dia, meios = _torneio_de_um_dia(idioma, api, eid, ETAPA_ARQUIVAR)
        _vender(idioma, api, eid, torneio["id"], dia["id"], meios, 1)
    hoje = date.today()
    api("PATCH", f"/stages/{eid}", {
        "status": "completed",
        "start_date": (hoje - timedelta(days=60)).isoformat(),
        "end_date": (hoje - timedelta(days=45)).isoformat(),
    })


# ── temas ────────────────────────────────────────────────────────────────────
def etapas(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    for antiga in api("GET", "/stages"):
        if antiga["name"] == NOVA_ETAPA[idioma]:
            api("DELETE", f"/stages/{antiga['id']}")
    _etapa_encerrada(idioma, api)
    hoje = date.today()
    return {
        "etapa_selecionada": etapa, "etapa_nova": NOVA_ETAPA[idioma], "local_etapa": CLUBES[idioma].nome,
        "inicio_etapa": hoje.isoformat(), "fim_etapa": (hoje + timedelta(days=14)).isoformat(),
        "etapa_arquivar": ETAPA_ARQUIVAR,
    }


def torneio(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    f = CLUBES[idioma].fator
    _apagar_torneios(api, etapa["id"], NOMES["novo"][idioma], NOMES["editado"][idioma])
    return {
        "etapa_selecionada": etapa, "torneio_novo": NOMES["novo"][idioma], "torneio_editado": NOMES["editado"][idioma],
        "valor_buyin": 500 * f, "valor_rebuy": 500 * f, "valor_addon": 300 * f,
    }


def meios(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    _torneio_novo(idioma, api, etapa["id"], "meios")
    return {
        "etapa_selecionada": etapa, "torneio_meios": NOMES["meios"][idioma], "meio_duplo": BUYIN_DUPLO[idioma],
        "valor_duplo": 900 * CLUBES[idioma].fator,
    }


def dias(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    _torneio_novo(idioma, api, etapa["id"], "dias")
    return {"etapa_selecionada": etapa, "torneio_dias": NOMES["dias"][idioma], "nome_dia": CLUBES[idioma].dia}


def blinds(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    eid = etapa["id"]
    _, dia = _dia_vazio(idioma, api, eid, "blinds")
    for nivel, (small, big, ante, minutos) in enumerate(ESTRUTURA_INICIAL, start=1):
        api("POST", f"/tournament-days/{dia['id']}/blinds", {
            "level": nivel, "small_blind": small, "big_blind": big, "ante": ante, "duration": minutos,
            "is_break": False,
        }, etapa=eid)
    return {"etapa_selecionada": etapa, "torneio_blinds": NOMES["blinds"][idioma]}


def templates(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    for antigo in api("GET", "/blind-templates"):
        if antigo["name"] == TEMPLATE[idioma]:
            api("DELETE", f"/blind-templates/{antigo['id']}")
    _dia_vazio(idioma, api, etapa["id"], "templates")
    return {
        "etapa_selecionada": etapa, "template": TEMPLATE[idioma], "template_descricao": TEMPLATE_DESCRICAO[idioma],
        "torneio_templates": NOMES["templates"][idioma],
    }


def telao(idioma: str, api) -> dict:
    """Torneio com gente sentada e o relógio correndo, com o telão no padrão."""
    etapa = _etapa(idioma, api)
    eid = etapa["id"]
    nome = NOMES["telao"][idioma]
    existente = next((t for t in api("GET", "/tournaments", etapa=eid) if t["name"] == nome), None)
    if existente:
        dia = api("GET", f"/tournament-days/tournament/{existente['id']}", etapa=eid)[0]
    else:
        _abrir_gaveta(idioma, api, eid)
        novo, dia, entradas = _torneio_de_um_dia(idioma, api, eid, nome)
        _vender(idioma, api, eid, novo["id"], dia["id"], entradas, 14)
        api("POST", f"/tables/day/{dia['id']}/bulk", etapa=eid, count=2, seats=9)
        api("PATCH", f"/tournament-days/{dia['id']}", {"status": "active"}, etapa=eid)
        _sentar(api, eid, dia["id"])
    api("PATCH", f"/tournament-days/{dia['id']}", {
        "broadcast_display_name": None, "broadcast_bg_image_url": None, "broadcast_show_buy_types": False,
        "broadcast_show_entries": True, "broadcast_show_reentries": True,
    }, etapa=eid)
    api("POST", f"/tournament-days/{dia['id']}/timer/reset", etapa=eid)
    api("POST", f"/tournament-days/{dia['id']}/timer/start", etapa=eid)
    return {
        "etapa_selecionada": etapa, "torneio_telao": nome, "nome_telao": f"{nome} — {CLUBES[idioma].dia}",
        "codigo_tv": api("GET", f"/tournament-days/{dia['id']}/broadcast-code", etapa=eid)["code"],
    }


def bilhete(idioma: str, api) -> dict:
    etapa = _etapa(idioma, api)
    _torneio_novo(idioma, api, etapa["id"], "bilhete")
    cidade, sede = BILHETE_CLUBE[idioma]
    cidade_torneio, sede_torneio = BILHETE_TORNEIO[idioma]
    return {
        "etapa_selecionada": etapa, "torneio_bilhete": NOMES["bilhete"][idioma], "cidade": cidade, "sede": sede,
        "cidade_torneio": cidade_torneio, "sede_torneio": sede_torneio,
    }
