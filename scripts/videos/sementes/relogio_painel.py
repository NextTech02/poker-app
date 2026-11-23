# -*- coding: utf-8 -*-
"""Relógio de mesa (tablet do dealer) e Painel de mesas (floor).

Tudo na etapa `ETAPA`, num torneio com eliminação por mesa: o time bank só
existe nesse modo. O Dia 1 está em andamento, com o relógio de blinds rodando no
nível 1 e três mesas montadas como num salão de verdade: uma mais cheia, uma
mais vazia, um assento bloqueado pelo floor, três jogadores que entraram e ainda
não sentaram e dois que já saíram. O Dia 2 está aberto e ainda não começou: é
nele que o tablet mostra o motivo de o relógio não rodar.

Cada gravação devolve as mesas a esse desenho (`PLANO`), porque o vídeo do
painel elimina, desfaz, senta e troca jogadores de lugar.

O painel marca as mesas com um tablet aberto pelo Presence do Realtime, que não
passa pelo banco. Para a marca aparecer, `painel_visao` abre a mesa 1 num
navegador à parte, com sessão própria, como um tablet de verdade
(`python -m sementes.relogio_painel tablet ...`). Ele fecha a sessão e sai
sozinho quando a gravação termina.
"""
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from datetime import date, timedelta
from pathlib import Path

from clube_demo import CLUBES

AQUI = Path(__file__).resolve().parents[1]
BASE = "https://app.aceblind.net"
ETAPA = "Night Series"
NOME = {"pt-BR": "Torneio de Terça", "en-US": "Tuesday Tournament", "es-ES": "Torneo del Martes"}
DIA_2 = {"pt-BR": "Dia 2", "en-US": "Day 2", "es-ES": "Día 2"}
MEIO_DE_PAGAMENTO = "cash"

# (small, big, ante, minutos, intervalo)
ESTRUTURA = (
    (100, 200, 0, 20, False), (200, 400, 0, 20, False), (300, 600, 600, 20, False), (400, 800, 800, 20, False),
    (0, 0, 0, 15, True),
    (500, 1000, 1000, 20, False), (600, 1200, 1200, 20, False), (800, 1600, 1600, 20, False),
)

MESAS = 3
LUGARES = 9
# O floor bloqueou um lugar da mesa 1: (mesa, assento).
BLOQUEADO = (1, 9)
# Índice em CLUBES[idioma].jogadores -> (mesa, assento). Mesa 1 com 7 de 8
# lugares, mesa 2 com 7 de 9 e mesa 3 com 5 de 9: o painel sugere passar um
# jogador da mesa 1 para a 3, e não sugere quebrar mesa.
PLANO = {
    0: (1, 1), 1: (1, 2), 2: (1, 3), 3: (1, 4), 4: (1, 6), 5: (1, 7), 6: (1, 8),
    7: (2, 1), 8: (2, 2), 9: (2, 4), 10: (2, 5), 11: (2, 6), 12: (2, 7), 13: (2, 9),
    14: (3, 1), 15: (3, 3), 16: (3, 4), 17: (3, 6), 18: (3, 8),
}
# Compraram a entrada e ainda não sentaram.
SEM_MESA = (19, 20, 21)
# Sentaram e já foram eliminados.
ELIMINADOS = {22: (2, 3), 23: (2, 8)}
INSCRITOS = 24

# Quem aparece em cada vídeo, pelo índice em CLUBES[idioma].jogadores.
QUEM_USA_CARTAO = (2, 4)   # assentos 3 e 6 da mesa 1, no tablet
QUEM_E_ELIMINADO = 1       # mesa 1, assento 2, no painel
QUEM_TROCA_DE_MESA = 0     # mesa 1, assento 1, no painel
QUEM_GANHA_CARTAO = 7      # mesa 2, assento 1, no ajuste de saldo

# Tempos curtos para o vídeo do tablet não ficar parado esperando. É a
# configuração do próprio dia, a mesma que o clube muda na tela.
CONFIG_CURTA = {
    "enabled": True, "preflop_seconds": 15, "postflop_seconds": 15, "called_clock_seconds": 30,
    "start_level": 1, "time_bank_enabled": True, "card_seconds": 20, "initial_cards": 2,
    "cards_per_break": 1, "max_cards_per_decision": 6,
}
GRUPO = "Dealer"
DESCRICAO_DO_GRUPO = {
    "pt-BR": "Tablet do relógio de mesa",
    "en-US": "Table clock tablet",
    "es-ES": "Tablet del reloj de mesa",
}
MOTIVO_DO_AJUSTE = {
    "pt-BR": "Decisão do diretor",
    "en-US": "Tournament director's call",
    "es-ES": "Decisión del director",
}

# O navegador do tablet fica aberto no máximo isto, em segundos, depois de
# abrir a mesa. Antes disso ele sai se a gravação acabar.
VIDA_DO_TABLET = 140
_TABLETS: list = []  # segura o cano do tablet: quando a gravação sai, ele fecha


# ── etapa, torneio e dias ────────────────────────────────────────────────────
def _etapa(idioma: str, api) -> dict:
    """A etapa desta área, com a gaveta aberta: sem ela o clube não vende."""
    clube = CLUBES[idioma]
    etapa = next((e for e in api("GET", "/stages") if e["name"] == ETAPA), None)
    if not etapa:
        hoje = date.today()
        etapa = api("POST", "/stages", {
            "name": ETAPA, "location": clube.nome,
            "start_date": (hoje - timedelta(days=1)).isoformat(),
            "end_date": (hoje + timedelta(days=30)).isoformat(),
        })
    gaveta = api("GET", "/cashboxes/me/current", etapa=etapa["id"])
    if gaveta and gaveta.get("status") != "open":
        api("POST", f"/cashboxes/{gaveta['id']}/open", {"initial_balance": 300 * clube.fator}, etapa=etapa["id"])
    return etapa


def _corpo_do_dia(idioma: str, tid: str, nome: str, numero: int) -> dict:
    clube = CLUBES[idioma]
    f = clube.fator
    return {
        "tournament_id": tid, "day_name": nome, "day_number": numero, "buy_in": 500 * f, "rebuy_amount": 500 * f,
        "addon_amount": 300 * f, "rake_percentage": 20, "max_players": 120, "starting_chips": 30000,
        "rebuy_chips": 30000, "addon_chips": 40000, "blind_duration": 20, "initial_small_blind": 100,
        "initial_big_blind": 200, "currency": clube.moeda,
    }


def _blinds(api, eid: str, dia_id: str) -> None:
    for nivel, (small, big, ante, minutos, intervalo) in enumerate(ESTRUTURA, start=1):
        api("POST", f"/tournament-days/{dia_id}/blinds", {
            "level": nivel, "small_blind": small, "big_blind": big, "ante": ante,
            "duration": minutos, "is_break": intervalo,
        }, etapa=eid)


def _meios(idioma: str, api, eid: str, tid: str) -> list:
    f = CLUBES[idioma].fator
    api("PUT", f"/tournaments/{tid}/buy-types", {"items": [
        {"name": "Buy-in", "category": "buy_in", "amount": 500 * f, "rake_percentage": 20, "chips": 30000},
        {"name": "Rebuy", "category": "rebuy", "amount": 500 * f, "rake_percentage": 20, "chips": 30000},
        {"name": "Add-on", "category": "addon", "amount": 300 * f, "rake_percentage": 10, "chips": 40000},
    ]}, etapa=eid)
    return api("GET", f"/tournaments/{tid}/buy-types", etapa=eid)


def _ids_dos_jogadores(api) -> dict:
    return {p["name"]: p["id"] for p in api("GET", "/players")}


def _vender(idioma: str, api, eid: str, tid: str, dia_id: str, meios: list) -> None:
    """Os primeiros `INSCRITOS` jogadores do clube entram no Dia 1."""
    ids = _ids_dos_jogadores(api)
    entrada = next(m for m in meios if m["category"] == "buy_in")
    inscritos = {r["player_id"] for r in api("GET", f"/tournament-players/day/{dia_id}", etapa=eid)}
    for nome in CLUBES[idioma].jogadores[:INSCRITOS]:
        if ids[nome] in inscritos:
            continue
        api("POST", "/tournament-players", {
            "tournament_id": tid, "tournament_day_id": dia_id, "player_id": ids[nome],
            "buy_in_count": 1, "payment_source": "cash", "payment_method": MEIO_DE_PAGAMENTO,
            "buy_type_id": entrada["id"], "client_id": str(uuid.uuid4()), "client_mutation_id": str(uuid.uuid4()),
        }, etapa=eid)


def _torneio(idioma: str, api, eid: str) -> tuple:
    """O torneio e os dois dias, criados na primeira vez."""
    nome = NOME[idioma]
    torneio = next((t for t in api("GET", "/tournaments", etapa=eid) if t["name"] == nome), None)
    if not torneio:
        torneio = api("POST", "/tournaments", {"name": nome, "stage_id": eid, "elimination_mode": "table"}, etapa=eid)
    tid = torneio["id"]
    dias = {d["day_number"]: d for d in api("GET", f"/tournament-days/tournament/{tid}", etapa=eid)}

    if 1 not in dias:
        dias[1] = api("POST", "/tournament-days", _corpo_do_dia(idioma, tid, CLUBES[idioma].dia, 1), etapa=eid)
        _blinds(api, eid, dias[1]["id"])
    meios = api("GET", f"/tournaments/{tid}/buy-types", etapa=eid) or _meios(idioma, api, eid, tid)
    # Vende antes de montar as mesas: com mesa, a venda já senta o jogador.
    _vender(idioma, api, eid, tid, dias[1]["id"], meios)
    if not api("GET", f"/tables/day/{dias[1]['id']}", etapa=eid):
        api("POST", f"/tables/day/{dias[1]['id']}/bulk", etapa=eid, count=MESAS, seats=LUGARES)

    if 2 not in dias:
        dias[2] = api("POST", "/tournament-days", _corpo_do_dia(idioma, tid, DIA_2[idioma], 2), etapa=eid)
        _blinds(api, eid, dias[2]["id"])
    if not api("GET", f"/tables/day/{dias[2]['id']}", etapa=eid):
        api("POST", f"/tables/day/{dias[2]['id']}/bulk", etapa=eid, count=1, seats=LUGARES)
    return torneio, dias[1], dias[2]


def _mesas(api, eid: str, dia_id: str) -> dict:
    return {m["table_number"]: m for m in api("GET", f"/tables/day/{dia_id}", etapa=eid)}


# ── estado do salão ──────────────────────────────────────────────────────────
def _salao(idioma: str, api, eid: str, dia_id: str) -> dict:
    """Devolve as mesas do Dia 1 ao `PLANO`, com os mesmos eliminados e os
    mesmos jogadores sem mesa. Só mexe no que mudou desde a última gravação."""
    nomes = CLUBES[idioma].jogadores
    ids = _ids_dos_jogadores(api)
    mesas = _mesas(api, eid, dia_id)
    numero, assento_bloqueado = BLOQUEADO
    if assento_bloqueado not in (mesas[numero].get("blocked_seats") or []):
        api("PATCH", f"/tables/{mesas[numero]['id']}/seats/{assento_bloqueado}", {"active": False}, etapa=eid)

    inscritos = {i["player_id"]: i for i in api("GET", f"/tournament-players/day/{dia_id}", etapa=eid)}
    plano = {ids[nomes[i]]: (mesas[m]["id"], s) for i, (m, s) in PLANO.items()}

    # Quem tem de estar jogando volta ao torneio (o vídeo do painel elimina).
    for indice in (*PLANO, *SEM_MESA):
        inscrito = inscritos[ids[nomes[indice]]]
        if inscrito["status"] == "eliminated":
            api("POST", f"/tournament-players/{inscrito['id']}/uneliminate", etapa=eid)

    for alocacao in api("GET", f"/allocations/day/{dia_id}", etapa=eid):
        if plano.get(alocacao["player_id"]) != (alocacao["table_id"], alocacao["seat_number"]):
            api("DELETE", f"/allocations/{alocacao['id']}", etapa=eid)
    sentados = {a["player_id"] for a in api("GET", f"/allocations/day/{dia_id}", etapa=eid)}
    for jogador, (mesa_id, assento) in plano.items():
        if jogador not in sentados:
            api("POST", f"/allocations/day/{dia_id}/manual", {
                "player_id": jogador, "table_id": mesa_id, "seat_number": assento,
            }, etapa=eid)

    # Os que já saíram sentam e são eliminados, como no salão.
    for indice, (m, s) in ELIMINADOS.items():
        inscrito = inscritos[ids[nomes[indice]]]
        if inscrito["status"] == "eliminated":
            continue
        api("POST", f"/allocations/day/{dia_id}/manual", {
            "player_id": inscrito["player_id"], "table_id": mesas[m]["id"], "seat_number": s,
        }, etapa=eid)
        api("POST", f"/tournament-players/{inscrito['id']}/eliminate", {}, etapa=eid)
    return mesas


def _relogio_no_nivel_1(api, eid: str, dia_id: str) -> None:
    """Relógio de blinds rodando no começo do nível 1: longe do intervalo, que
    pararia o relógio da mesa e daria um cartão a mais a cada jogador."""
    api("POST", f"/tournament-days/{dia_id}/timer/reset", etapa=eid)
    api("POST", f"/tournament-days/{dia_id}/timer/start", etapa=eid)


def _cartoes_de_volta(api, eid: str, dia_id: str) -> None:
    """Desfaz os cartões usados na gravação anterior, pelo mesmo Desfazer do
    tablet. Desfazer de novo um cartão já desfeito não muda nada."""
    for evento in api("GET", f"/table-clock/day/{dia_id}/events", etapa=eid):
        if evento["kind"] == "use":
            api("POST", f"/table-clock/events/{evento['id']}/undo", etapa=eid)


def _cenario(idioma: str, api) -> tuple:
    etapa = _etapa(idioma, api)
    eid = etapa["id"]
    torneio, dia_1, dia_2 = _torneio(idioma, api, eid)
    mesas = _salao(idioma, api, eid, dia_1["id"])
    _relogio_no_nivel_1(api, eid, dia_1["id"])
    # Sem configuração salva, a versão no ar deixa o relógio desligado no dia.
    api("PUT", f"/table-clock/day/{dia_1['id']}/settings", CONFIG_CURTA, etapa=eid)
    variaveis = {
        "nome_torneio": torneio["name"], "dia_1": dia_1["id"], "nome_dia_1": CLUBES[idioma].dia,
        "dia_2": dia_2["id"], "mesa_1": mesas[1]["id"], "mesa_dia_2": _mesas(api, eid, dia_2["id"])[1]["id"],
    }
    return etapa, variaveis


# ── temas ────────────────────────────────────────────────────────────────────
def abrir(idioma: str, api) -> dict:
    """Sem `etapa_selecionada`: o vídeo começa na etapa padrão e troca para a
    desta área no seletor do relógio, como o dealer faz no tablet."""
    _, variaveis = _cenario(idioma, api)
    return {**variaveis, "etapa_da_area": ETAPA}


def usar(idioma: str, api) -> dict:
    etapa, variaveis = _cenario(idioma, api)
    _cartoes_de_volta(api, etapa["id"], variaveis["dia_1"])
    return {"etapa_selecionada": etapa, **variaveis}


def configurar(idioma: str, api) -> dict:
    """Os tempos curtos que o vídeo do tablet deixou, e o grupo Dealer pronto
    em Funcionários. Um grupo com esse nome que já exista não é alterado."""
    etapa, variaveis = _cenario(idioma, api)
    if not any(g["name"] == GRUPO for g in api("GET", "/staff/groups")):
        api("POST", "/staff/groups", {
            "name": GRUPO, "description": DESCRICAO_DO_GRUPO[idioma], "permissions": ["table_clock"],
        })
    return {
        "etapa_selecionada": etapa, **variaveis, "grupo": GRUPO,
        "ganha_cartao": CLUBES[idioma].jogadores[QUEM_GANHA_CARTAO], "motivo": MOTIVO_DO_AJUSTE[idioma],
    }


def painel_visao(idioma: str, api) -> dict:
    etapa, variaveis = _cenario(idioma, api)
    _abrir_tablet(idioma, etapa, variaveis["dia_1"], variaveis["mesa_1"])
    return {"etapa_selecionada": etapa, **variaveis}


def painel_acoes(idioma: str, api) -> dict:
    etapa, variaveis = _cenario(idioma, api)
    jogadores = CLUBES[idioma].jogadores
    return {
        "etapa_selecionada": etapa, **variaveis,
        "eliminado": jogadores[QUEM_E_ELIMINADO], "troca_de_mesa": jogadores[QUEM_TROCA_DE_MESA],
    }


# ── o tablet aberto na mesa 1 ────────────────────────────────────────────────
def _sinal_do_tablet(idioma: str) -> Path:
    return AQUI / "cache" / f"tablet-{idioma}.txt"


def _abrir_tablet(idioma: str, etapa: dict, dia_id: str, mesa_id: str) -> None:
    """Abre o relógio da mesa num navegador à parte e espera ele entrar no ar.

    O tablet lê a entrada padrão até o fim: quando a gravação sai, o cano fecha e
    ele encerra a própria sessão. Nada dele vai para o log: um erro do
    navegador repetiria a URL com os tokens."""
    sinal = _sinal_do_tablet(idioma)
    sinal.parent.mkdir(parents=True, exist_ok=True)
    sinal.unlink(missing_ok=True)
    tablet = subprocess.Popen(
        [sys.executable, "-m", "sementes.relogio_painel", "tablet", idioma, dia_id, mesa_id],
        cwd=AQUI, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={**os.environ, "TABLET_ETAPA": json.dumps(etapa)},
    )
    _TABLETS.append(tablet)
    limite = time.time() + 120
    while time.time() < limite:
        if sinal.exists():
            if sinal.read_text(encoding="utf-8") == "pronto":
                return
            raise RuntimeError("o tablet não conseguiu abrir a mesa")
        if tablet.poll() is not None:
            raise RuntimeError("o tablet fechou antes de abrir a mesa")
        time.sleep(1)
    raise RuntimeError("o tablet demorou demais para abrir a mesa")


def _avisar(sinal: Path, texto: str) -> None:
    provisorio = sinal.with_suffix(".tmp")
    provisorio.write_text(texto, encoding="utf-8")
    os.replace(provisorio, sinal)


def _tablet(idioma: str, dia_id: str, mesa_id: str) -> None:
    import clube_demo
    from playwright.sync_api import sync_playwright
    from produzir import CHAVE_IDIOMA, carregar_env

    carregar_env()
    sinal = _sinal_do_tablet(idioma)
    fim = threading.Event()

    def esperar_a_gravacao():
        sys.stdin.buffer.read()
        fim.set()

    threading.Thread(target=esperar_a_gravacao, daemon=True).start()
    sessao = clube_demo.abrir_sessao(idioma)
    playwright = sync_playwright().start()
    try:
        navegador = playwright.chromium.launch()
        contexto = navegador.new_context(viewport={"width": 1280, "height": 800}, locale=idioma)
        guardado = {
            CHAVE_IDIOMA: idioma, "i18nextLng": idioma, "selected_module": "tournament",
            "selected_stage": os.environ["TABLET_ETAPA"],
        }
        contexto.add_init_script(
            f"for (const [k, v] of Object.entries({json.dumps(guardado)})) localStorage.setItem(k, v);"
        )
        pagina = contexto.new_page()
        entrada = (
            f"{BASE}/#access_token={sessao['access_token']}&refresh_token={sessao['refresh_token']}"
            f"&expires_in={sessao.get('expires_in', 3600)}&token_type=bearer&type=magiclink"
        )
        aberto = False
        try:
            pagina.goto(entrada, wait_until="domcontentloaded", timeout=60000)
            pagina.wait_for_function(
                "() => Object.keys(localStorage).some((k) => k.endsWith('-auth-token'))", timeout=20000
            )
            pagina.goto(f"{BASE}/relogio-mesa/{dia_id}/mesa/{mesa_id}", wait_until="domcontentloaded", timeout=60000)
            pagina.wait_for_selector(".rm-oval", timeout=30000)
            aberto = True
        except Exception:  # noqa: BLE001 - a mensagem traria a URL com os tokens
            pass
        if not aberto:
            _avisar(sinal, "falhou")
            return
        time.sleep(3)  # o Presence anuncia a mesa logo depois de entrar no canal
        _avisar(sinal, "pronto")
        fim.wait(VIDA_DO_TABLET)
    finally:
        clube_demo.encerrar_sessao(sessao)
        if sinal.exists() and sinal.read_text(encoding="utf-8") == "pronto":
            _avisar(sinal, "encerrado")  # para conferir depois que a sessão fechou
        playwright.stop()


if __name__ == "__main__" and len(sys.argv) == 5 and sys.argv[1] == "tablet":
    _tablet(*sys.argv[2:5])
