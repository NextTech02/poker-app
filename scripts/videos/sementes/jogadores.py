# -*- coding: utf-8 -*-
"""Estado dos vídeos de Jogadores.

Cadastro e importação criam jogadores de verdade. Os nomes começam com "Demo"
para ficarem fora de `CLUBES[idioma].jogadores`, e saem antes de cada gravação,
pelo nome exato, porque o documento não pode repetir no clube. Nenhum tem
e-mail: sem e-mail não sai pedido de autorização de contatos.
"""
import asyncio
import uuid
from html import escape
from pathlib import Path

import gravador
from clube_demo import CLUBES
from sementes import bar

NOVO_JOGADOR = {
    "pt-BR": ("Demo Rita", "Alves"),
    "en-US": ("Demo Kate", "Morgan"),
    "es-ES": ("Demo Inés", "Rueda"),
}
DOCUMENTO_NOVO = "DEMO7001"

IMPORTADOS = {
    "pt-BR": ("Demo Caio Lima", "Demo Lia Rocha", "Demo Tito Reis", "Demo Nina Melo", "Demo Davi Luz"),
    "en-US": ("Demo Cole Banks", "Demo Ruth Lane", "Demo Max Hale", "Demo Ivy Stone", "Demo Theo Marsh"),
    "es-ES": ("Demo Iker Soto", "Demo Alba Cruz", "Demo Bruno Paz", "Demo Noa Gil", "Demo Leo Vera"),
}
CABECALHO = {
    "pt-BR": ("Nome", "Doc. tipo", "Doc. numero", "País"),
    "en-US": ("Name", "Doc. type", "Doc. number", "Country"),
    "es-ES": ("Nombre", "Doc. tipo", "Doc. numero", "País"),
}
PAIS = {"pt-BR": "Brasil", "en-US": "United States", "es-ES": "Colombia"}

SATELITE = {"pt-BR": "Satélite de sexta", "en-US": "Friday satellite", "es-ES": "Satélite del viernes"}
RECOMPENSAS = {  # o clube nasce com "R$ 25 em crédito" em qualquer moeda
    "en-US": (("$25 credit", "$25 credit at the cashier"), ("$50 credit", "$50 credit at the cashier"),
              ("$100 credit", "$100 credit at the cashier")),
    "es-ES": (("$ 25.000 en crédito", "Crédito de $ 25.000 en la caja"),
              ("$ 50.000 en crédito", "Crédito de $ 50.000 en la caja"),
              ("$ 100.000 en crédito", "Crédito de $ 100.000 en la caja")),
}
CUPOM = "DEMOVIDEO"

_arquivo = {"caminho": None}
_abrir_gravador = gravador.Gravador.__aenter__


async def _gravador_com_arquivo(self):
    """O roteiro não tem ação de anexar arquivo. Com este ouvinte, o clique em
    Escolher arquivo recebe a planilha no lugar do seletor do sistema."""
    aberto = await _abrir_gravador(self)
    aberto.pagina.on("filechooser", lambda seletor: asyncio.ensure_future(seletor.set_files(_arquivo["caminho"])))
    return aberto


def _remover(api, nomes) -> None:
    for jogador in api("GET", "/players"):
        if jogador["name"] in nomes:
            api("DELETE", f"/players/{jogador['id']}")


def _planilha(idioma: str) -> Path:
    """Tabela HTML com extensão .xls, o formato que os sistemas antigos exportam.
    A última linha é de quem já está no clube, para a prévia mostrar a duplicidade."""
    linhas = [
        (nome, "passport", f"DEMO71{numero:02d}", PAIS[idioma])
        for numero, nome in enumerate(IMPORTADOS[idioma], start=1)
    ]
    linhas.append((CLUBES[idioma].jogadores[0], "passport", "DEMO0001", PAIS[idioma]))
    celulas = lambda valores, tag: "".join(f"<{tag}>{escape(v)}</{tag}>" for v in valores)
    html = "<table><tr>" + celulas(CABECALHO[idioma], "th") + "</tr>"
    html += "".join(f"<tr>{celulas(linha, 'td')}</tr>" for linha in linhas) + "</table>"
    caminho = Path(__file__).resolve().parents[1] / "cache" / f"jogadores-exemplo-{idioma}.xls"
    caminho.write_text(html, encoding="utf-8")
    return caminho


def _torneio(idioma: str, api, etapa: str, nome: str) -> tuple:
    """Torneio de um dia na etapa desta área. Devolve (id, dia, meio de entrada)."""
    clube = CLUBES[idioma]
    f = clube.fator
    torneio = next((t for t in api("GET", "/tournaments", etapa=etapa) if t["name"] == nome), None) \
        or api("POST", "/tournaments", {"name": nome, "stage_id": etapa}, etapa=etapa)
    tid = torneio["id"]
    dias = api("GET", f"/tournament-days/tournament/{tid}", etapa=etapa)
    dia = dias[0] if dias else api("POST", "/tournament-days", {
        "tournament_id": tid, "day_name": clube.dia, "day_number": 1, "buy_in": 300 * f, "rebuy_amount": 300 * f,
        "addon_amount": 200 * f, "rake_percentage": 20, "max_players": 90, "starting_chips": 30000,
        "rebuy_chips": 30000, "addon_chips": 40000, "blind_duration": 20,
        "initial_small_blind": 100, "initial_big_blind": 200,
    }, etapa=etapa)
    if not api("GET", f"/tournaments/{tid}/buy-types", etapa=etapa):
        api("PUT", f"/tournaments/{tid}/buy-types", {"items": [
            {"name": "Buy-in", "category": "buy_in", "amount": 300 * f, "rake_percentage": 20, "chips": 30000},
            {"name": "Rebuy", "category": "rebuy", "amount": 300 * f, "rake_percentage": 20, "chips": 30000},
        ]}, etapa=etapa)
    entrada = next(m for m in api("GET", f"/tournaments/{tid}/buy-types", etapa=etapa) if m["category"] == "buy_in")
    if not api("GET", f"/tables/day/{dia['id']}", etapa=etapa):
        api("POST", f"/tables/day/{dia['id']}/bulk", etapa=etapa, count=1, seats=9)
    return tid, dia, entrada


def _inscrever(api, etapa: str, jogador: str, tid: str, dia: dict, entrada: dict) -> None:
    if any(r["player_id"] == jogador for r in api("GET", f"/tournament-players/tournament/{tid}", etapa=etapa)):
        return
    api("POST", "/tournament-players", {
        "tournament_id": tid, "tournament_day_id": dia["id"], "player_id": jogador, "buy_in_count": 1,
        "payment_source": "cash", "payment_method": "cash", "buy_type_id": entrada["id"],
        "client_id": str(uuid.uuid4()), "client_mutation_id": str(uuid.uuid4()),
    }, etapa=etapa)


def _fidelidade(idioma: str, api, jogador: str) -> None:
    clube = CLUBES[idioma]
    if idioma in RECOMPENSAS:
        catalogo = sorted(api("GET", "/loyalty/rewards"), key=lambda r: r["sort_order"])
        for recompensa, (nome, descricao), (credito, pontos) in zip(
            catalogo, RECOMPENSAS[idioma], ((25, 500), (50, 900), (100, 1700)),
        ):
            if recompensa["name"] != nome:
                api("PATCH", f"/loyalty/rewards/{recompensa['id']}", {
                    "name": nome, "description": descricao,
                    "credit_value": credito * clube.fator, "cost_points": pontos * clube.fator,
                })
    # Os níveis nascem em português e não há rota para renomeá-los. No nível
    # máximo a tela não cita o próximo, e sobra só o nome do nível atual.
    if idioma == "en-US" and api("GET", f"/loyalty/players/{jogador}")["lifetime_points"] < 10000:
        if not any(c["code"] == CUPOM for c in api("GET", "/loyalty/coupons")):
            api("POST", "/loyalty/coupons", {"code": CUPOM, "reward_type": "points", "points_value": 10000})
        api("POST", f"/loyalty/players/{jogador}/coupon", {"code": CUPOM})


# ── uma função por vídeo ────────────────────────────────────────────────────

def cadastrar(idioma: str, api) -> dict:
    nome, sobrenome = NOVO_JOGADOR[idioma]
    _remover(api, {f"{nome} {sobrenome}"})
    return {
        "etapa_selecionada": bar.etapa_propria(idioma, api),
        "nome": nome,
        "sobrenome": sobrenome,
        "documento": DOCUMENTO_NOVO,
    }


def importar(idioma: str, api) -> dict:
    # O do vídeo de cadastro sai junto: a busca final mostra só os importados.
    _remover(api, {*IMPORTADOS[idioma], " ".join(NOVO_JOGADOR[idioma])})
    _arquivo["caminho"] = str(_planilha(idioma))
    gravador.Gravador.__aenter__ = _gravador_com_arquivo
    return {"etapa_selecionada": bar.etapa_propria(idioma, api)}


def detalhe(idioma: str, api) -> dict:
    """Um jogador com torneios, ticket, comandas e pontos. Os torneios ficam na
    etapa desta área; o Main Event da Demo Series não é tocado."""
    clube = CLUBES[idioma]
    etapa = bar.etapa_propria(idioma, api)
    eid = etapa["id"]
    bar.historico(idioma, api)

    cliente = clube.jogadores[29]
    jogador = next(p["id"] for p in api("GET", "/players") if p["name"] == cliente)

    gaveta = api("GET", "/cashboxes/me/current", etapa=eid)
    if gaveta and gaveta.get("status") != "open":
        api("POST", f"/cashboxes/{gaveta['id']}/open", {"initial_balance": 300 * clube.fator}, etapa=eid)
    for nome in ("Friday Turbo", "Sunday Deepstack"):
        _inscrever(api, eid, jogador, *_torneio(idioma, api, eid, nome))

    if not api("GET", f"/players/{jogador}/tickets"):
        tid, dia, _ = _torneio(idioma, api, eid, "Club Championship")
        api("POST", "/satellite-tickets", {
            "player_id": jogador, "target_tournament_id": tid, "target_tournament_day_id": dia["id"],
            "won_at": SATELITE[idioma], "funded_by": clube.nome, "stage_id": eid,
        }, etapa=eid)

    _fidelidade(idioma, api, jogador)
    return {"etapa_selecionada": etapa, "cliente": cliente}
