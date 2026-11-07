# -*- coding: utf-8 -*-
"""Cash game: deixa o clube no estado que cada vídeo precisa e aceita rodar de novo.

O cash não tem etapa. A âncora é o DIA, e duas regras do módulo mandam aqui:

- só existe um dia aberto por clube, então um vídeo que abre o dia precisa
  encerrar o anterior antes;
- uma data só abre uma vez (`dia_ja_existe`), então cada regravação usa uma data
  nova. `data_livre` anda para trás a partir de hoje.

Tudo passa pela API e pelos mesmos fluxos das telas. Os valores saem multiplicados
por `fator`, porque 100 reais de buy-in são 100 mil pesos no clube da Colômbia.
"""
import threading
import time
import uuid
from datetime import date, timedelta

from clube_demo import CLUBES

# Os nomes seguem o que o clube escreve no salão. Em pesos, ninguém diz "1/2".
MODALIDADES = {
    "pt-BR": {"base": "NLH 1/2", "alta": "NLH 2/5", "nova": "PLO 2/5"},
    "en-US": {"base": "NLH 1/2", "alta": "NLH 2/5", "nova": "PLO 2/5"},
    "es-ES": {"base": "NLH 1K/2K", "alta": "NLH 2K/5K", "nova": "PLO 2K/5K"},
}
# Quem joga em cada lugar da história. Índices de CLUBES[idioma].jogadores: o
# começo da lista é do vídeo do Caixa, e o fim fica para o fiado.
MESA_UM = (8, 9, 10, 11)
MESA_DOIS = (12, 13)
QUEM_CHEGA = 14
JA_JOGARAM = (15, 16)
FILA = (17, 18)
NA_FILA_NOVO = 19
PASSADO = (20, 21, 22, 23, 24, 25)


def fator(idioma: str) -> int:
    return CLUBES[idioma].fator


def nome(idioma: str, indice: int) -> str:
    return CLUBES[idioma].jogadores[indice]


def ids_dos_jogadores(api) -> dict:
    return {p["name"]: p["id"] for p in api("GET", "/players")}


def _id_de_operacao() -> str:
    return str(uuid.uuid4())


# ── catálogo ────────────────────────────────────────────────────────────────
def catalogo(idioma: str, api) -> dict:
    """As modalidades que todo vídeo do cash usa."""
    f = fator(idioma)
    nomes = MODALIDADES[idioma]
    valores = (
        ("base", 1, 2, 100, 400, 10, 1),
        ("alta", 2, 5, 200, 1000, 15, 2),
    )
    atuais = {g["name"]: g for g in api("GET", "/cash-game/game-types")}
    saida = {}
    for chave, sb, bb, minimo, maximo, cap, jackpot in valores:
        existente = atuais.get(nomes[chave])
        saida[chave] = existente or api("POST", "/cash-game/game-types", {
            "name": nomes[chave], "game_variant": "nlh", "small_blind": sb * f, "big_blind": bb * f,
            "ante": 0, "min_buy_in": minimo * f, "max_buy_in": maximo * f, "default_seats": 9,
            "rake_percent": 5, "rake_cap": cap * f, "jackpot_per_pot": jackpot * f, "active": True,
        })
    return saida


# ── dia e gaveta ────────────────────────────────────────────────────────────
def data_livre(api) -> str:
    usadas = {d["business_date"] for d in api("GET", "/cash-game/days", limit=400)}
    candidata = date.today()
    while candidata.isoformat() in usadas:
        candidata -= timedelta(days=1)
    return candidata.isoformat()


def dia_aberto(api) -> dict:
    return api("GET", "/cash-game/days/current") or api(
        "POST", "/cash-game/days", {"business_date": data_livre(api)},
    )


def gaveta_aberta(idioma: str, api, dia_id: str) -> dict:
    gaveta = api("GET", "/cashboxes/me/current", cash_day_id=dia_id)
    if gaveta["status"] != "open":
        api("POST", f"/cashboxes/{gaveta['id']}/open", {"initial_balance": 5000 * fator(idioma)})
        gaveta = api("GET", "/cashboxes/me/current", cash_day_id=dia_id)
    return gaveta


def fechar_gaveta(api, dia_id: str) -> None:
    gaveta = api("GET", "/cashboxes/me/current", cash_day_id=dia_id)
    if gaveta["status"] == "open":
        api("POST", f"/cashboxes/{gaveta['id']}/close", {"actual_final_balance": gaveta["current_balance"]})


# ── mesas e jogadores ───────────────────────────────────────────────────────
def mesa_aberta(api, dia_id: str, tipo_id: str, numero: int) -> dict:
    for mesa in api("GET", "/cash-game/tables", cash_day_id=dia_id):
        if mesa["table_number"] == numero and mesa["status"] != "closed":
            return mesa
    return api("POST", "/cash-game/tables", {
        "cash_day_id": dia_id, "game_type_id": tipo_id, "table_number": numero,
    })


def cadeiras(api, mesa_id: str) -> list:
    return api("GET", f"/cash-game/tables/{mesa_id}/seats")


def sessoes_ativas(api, dia_id: str) -> list:
    return api("GET", "/cash-game/player-sessions", cash_day_id=dia_id, status="active")


def sentar(api, mesa_id: str, lugar: int, jogador_id: str, valor: float, **pagamento) -> dict:
    return api("POST", f"/cash-game/tables/{mesa_id}/seats/{lugar}/sit", {
        "player_id": jogador_id, "buy_in_amount": valor, "client_mutation_id": _id_de_operacao(),
        **(pagamento or {"payment_method": "cash"}),
    })


def levantar(api, sessao: dict, fichas: float) -> None:
    """Quem deve fiado abate tudo o que der, que é o padrão da tela."""
    corpo = {"cash_out_amount": fichas, "payment_method": "cash", "client_mutation_id": _id_de_operacao()}
    divida = float(api("GET", f"/house-credit/players/{sessao['player_id']}")["balance"] or 0)
    if divida > 0:
        corpo["debt_offset_amount"] = min(divida, fichas)
    api("POST", f"/cash-game/player-sessions/{sessao['id']}/stand", corpo)


def ajustar_mesa(idioma: str, api, dia_id: str, mesa: dict, indices: tuple, valor: float) -> list:
    """Deixa na mesa exatamente estes jogadores. Quem sobrou de uma gravação
    anterior levanta com o que comprou, e a reserva esquecida volta para a sala."""
    jogadores = ids_dos_jogadores(api)
    nomes = [nome(idioma, i) for i in indices]
    querem = {jogadores[n] for n in nomes}
    for sessao in sessoes_ativas(api, dia_id):
        aqui = sessao["table_id"] == mesa["id"]
        if (aqui and sessao["player_id"] not in querem) or (not aqui and sessao["player_id"] in querem):
            levantar(api, sessao, float(sessao["total_buy_in"]))
    atuais = cadeiras(api, mesa["id"])
    for cadeira in atuais:
        if cadeira["status"] == "reserved":
            api("DELETE", f"/cash-game/tables/{mesa['id']}/seats/{cadeira['seat_number']}/reserve")
    atuais = cadeiras(api, mesa["id"])
    sentados = {c["player_id"] for c in atuais if c["status"] == "occupied"}
    livres = iter([c["seat_number"] for c in atuais if c["status"] == "free"])
    for nome_do_jogador in nomes:
        if jogadores[nome_do_jogador] not in sentados:
            sentar(api, mesa["id"], next(livres), jogadores[nome_do_jogador], valor)
    return nomes


def salao_em_operacao(idioma: str, api) -> tuple:
    """Dia aberto, gaveta aberta e a mesa 1 com gente: o estado comum."""
    tipos = catalogo(idioma, api)
    dia = dia_aberto(api)
    gaveta_aberta(idioma, api, dia["id"])
    mesa = mesa_aberta(api, dia["id"], tipos["base"]["id"], 1)
    sentados = ajustar_mesa(idioma, api, dia["id"], mesa, MESA_UM, 200 * fator(idioma))
    return tipos, dia, mesa, sentados


def _limpar_fila(api, dia_id: str) -> None:
    for entrada in api("GET", "/cash-game/waitlist", cash_day_id=dia_id):
        if entrada["status"] in ("waiting", "called"):
            api("DELETE", f"/cash-game/waitlist/{entrada['id']}")


def _abater_consignacoes(api) -> None:
    for consignacao in api("GET", "/sangi/consignments", status_filter="open"):
        api("POST", f"/sangi/consignments/{consignacao['id']}/reconcile", {})


def fechar_mesas(idioma: str, api, dia_id: str) -> None:
    """Levanta todo mundo e fecha as mesas, como o operador no fim da noite. A
    contagem final é maior que zero porque a API recusa fechar sem rake."""
    f = fator(idioma)
    for sessao in sessoes_ativas(api, dia_id):
        levantar(api, sessao, float(sessao["total_buy_in"]))
    for mesa in api("GET", "/cash-game/tables", cash_day_id=dia_id):
        if mesa["status"] != "closed":
            api("POST", f"/cash-game/tables/{mesa['id']}/close", {"rake_amount": 30 * f, "jackpot_amount": 0})


def encerrar_operacao(idioma: str, api) -> None:
    """Fim da noite completo. Sem dia aberto, não há o que fazer."""
    dia = api("GET", "/cash-game/days/current")
    if not dia:
        return
    gaveta_aberta(idioma, api, dia["id"])
    fechar_mesas(idioma, api, dia["id"])
    _limpar_fila(api, dia["id"])
    _abater_consignacoes(api)
    fechar_gaveta(api, dia["id"])
    api("POST", f"/cash-game/days/{dia['id']}/close", {})


# ── sementes dos vídeos ─────────────────────────────────────────────────────
def modalidades(idioma: str, api) -> dict:
    """A modalidade do vídeo some antes de gravar: nenhuma mesa usa, então sai de vez."""
    catalogo(idioma, api)
    f = fator(idioma)
    nova = MODALIDADES[idioma]["nova"]
    for tipo in api("GET", "/cash-game/game-types"):
        if tipo["name"] == nova:
            api("DELETE", f"/cash-game/game-types/{tipo['id']}")
    return {
        "nova": nova, "sb": 2 * f, "bb": 5 * f, "minimo": 200 * f, "maximo": 1000 * f,
        "cap": 20 * f, "pote": 2 * f,
    }


def sem_dia(idioma: str, api) -> dict:
    tipos = catalogo(idioma, api)
    encerrar_operacao(idioma, api)
    return {
        "data_dia": data_livre(api), "tipo_base": tipos["base"]["id"],
        "saldo_inicial": 5000 * fator(idioma),
    }


def mesa_com_jogadores(idioma: str, api) -> dict:
    f = fator(idioma)
    _, _, mesa, sentados = salao_em_operacao(idioma, api)
    return {
        "mesa": mesa["id"], "pessoa": nome(idioma, QUEM_CHEGA), "buyin": 300 * f,
        "recompra": 100 * f, "fichas": 260 * f,
        "quem_recompra": sentados[0], "quem_levanta": sentados[1],
    }


def mesa_para_fechar(idioma: str, api) -> dict:
    """A mesa 3 já rodou e todo mundo levantou: o que falta é apurar e fechar."""
    f = fator(idioma)
    tipos, dia, _, _ = salao_em_operacao(idioma, api)
    mesa = mesa_aberta(api, dia["id"], tipos["alta"]["id"], 3)
    if not mesa["total_buy_ins"]:
        jogadores = ids_dos_jogadores(api)
        for lugar, indice in enumerate(JA_JOGARAM, start=1):
            sentar(api, mesa["id"], lugar, jogadores[nome(idioma, indice)], 500 * f)
    for sessao in sessoes_ativas(api, dia["id"]):
        if sessao["table_id"] == mesa["id"]:
            levantar(api, sessao, 420 * f)
    return {"mesa": mesa["id"], "rake_parcial": 60 * f, "jackpot_parcial": 20 * f, "rake_final": 90 * f}


def fila(idioma: str, api) -> dict:
    """Duas pessoas já esperando, uma por modalidade não: a fila é por stake."""
    tipos, dia, mesa, _ = salao_em_operacao(idioma, api)
    mesa_dois = mesa_aberta(api, dia["id"], tipos["alta"]["id"], 2)
    ajustar_mesa(idioma, api, dia["id"], mesa_dois, MESA_DOIS, 500 * fator(idioma))
    _limpar_fila(api, dia["id"])
    jogadores = ids_dos_jogadores(api)
    for indice in FILA:
        api("POST", "/cash-game/waitlist", {
            "player_id": jogadores[nome(idioma, indice)], "game_type_id": tipos["base"]["id"],
        }, cash_day_id=dia["id"])
    livre = next(c["seat_number"] for c in cadeiras(api, mesa["id"]) if c["status"] == "free")
    return {
        "pessoa": nome(idioma, NA_FILA_NOVO), "tipo_base": tipos["base"]["id"],
        "mesa_base": mesa["id"], "lugar_livre": str(livre), "primeiro": nome(idioma, FILA[0]),
    }


def jackpot(idioma: str, api) -> dict:
    """O fundo só cresce pela apuração da mesa, então é por ela que ele enche."""
    f = fator(idioma)
    _, _, mesa, _ = salao_em_operacao(idioma, api)
    falta = 800 * f - float(api("GET", "/cash-game/jackpot")["current_balance"] or 0)
    if falta > 0:
        api("POST", f"/cash-game/tables/{mesa['id']}/rake-entries", {"rake_amount": 40 * f, "jackpot_amount": falta})
    return {"pessoa": nome(idioma, MESA_UM[2]), "premio": 500 * f}


def _vender_depois_de_liberar(api, mesa_id: str, vendas: list, ja_havia: set) -> None:
    """A sangeur vende pelo login dela, em outra tela, enquanto o vídeo roda. O
    gerente pode lançar pela mesma rota, e é isso que faz o dado aparecer no meio
    da gravação. Espera um pouco para o vídeo mostrar o vendido ainda zerado."""
    def trabalho():
        limite = time.time() + 300
        while time.time() < limite:
            novas = [c for c in api("GET", "/sangi/consignments", status_filter="open") if c["id"] not in ja_havia]
            if novas:
                time.sleep(9)
                for jogador_id, valor in vendas:
                    api("POST", f"/sangi/consignments/{novas[0]['id']}/sales", {
                        "amount": valor, "buyer_player_id": jogador_id, "table_id": mesa_id,
                        "client_mutation_id": _id_de_operacao(),
                    })
                return
            time.sleep(1.5)

    threading.Thread(target=trabalho, daemon=True).start()


def sangeur(idioma: str, api) -> dict:
    f = fator(idioma)
    _, _, mesa, sentados = salao_em_operacao(idioma, api)
    _abater_consignacoes(api)
    jogadores = ids_dos_jogadores(api)
    equipe = next(s for s in api("GET", "/staff") if "sangi" in (s.get("permissions") or []))
    _vender_depois_de_liberar(
        api, mesa["id"], [(jogadores[sentados[0]], 300 * f), (jogadores[sentados[1]], 200 * f)], set(),
    )
    return {"sangeur_id": equipe["id"], "liberado": 1000 * f}


# Rake da noite e o total que cada jogador comprou, sem o fator.
NOITES = (
    (620, [2000, 1500, 1800, 1200, 1000]), (380, [1000, 900, 800, 700, 600]),
    (910, [3000, 2200, 2500, 1600, 1500]), (450, [1300, 1000, 900, 800, 700]),
    (740, [2400, 1800, 1600, 1500, 1200]),
)
JACKPOT_DA_NOITE = 10


def _dia_vazio(idioma: str, api) -> dict:
    """Um dia aberto sem nenhum movimento. O dia que já girou nas gravações vai
    para o histórico: as somas dele não fecham, porque cada regravação levanta
    jogadores com valores diferentes."""
    atual = api("GET", "/cash-game/days/current")
    if atual and api("GET", f"/cash-game/days/{atual['id']}/summary")["total_buy_ins"]:
        encerrar_operacao(idioma, api)
    return dia_aberto(api)


def _noite(idioma: str, api, dia: dict, tipos: dict, rake: int, compras: list) -> None:
    """Uma noite pelos fluxos reais, até a gaveta conferida. Quem compra acima do
    teto da mesa senta no teto e recompra o resto, como no salão. O cash-out soma
    o que entrou menos rake e jackpot, para o dia fechar sem sobra."""
    f = fator(idioma)
    teto = float(tipos["base"]["max_buy_in"])
    jogadores = ids_dos_jogadores(api)
    gaveta_aberta(idioma, api, dia["id"])
    mesa = mesa_aberta(api, dia["id"], tipos["base"]["id"], 1)
    sessoes = []
    for lugar, (indice, valor) in enumerate(zip(PASSADO, compras), start=1):
        sentado = sentar(api, mesa["id"], lugar, jogadores[nome(idioma, indice)], min(valor * f, teto))
        sessao = sentado["player_session"]
        sessoes.append(sessao)
        if valor * f > teto:
            api("POST", f"/cash-game/player-sessions/{sessao['id']}/rebuy", {
                "amount": valor * f - teto, "payment_method": "cash", "client_mutation_id": _id_de_operacao(),
            })
    sobra = sum(compras) - rake - JACKPOT_DA_NOITE
    resultado = [round(sobra * (c / sum(compras))) for c in compras]
    resultado[0] += sobra - sum(resultado)
    # Numa mesa de verdade o dinheiro troca de mão: o primeiro leva do segundo.
    troca = min(resultado[1], compras[0] // 2)
    resultado[0] += troca
    resultado[1] -= troca
    for sessao, fichas in zip(sessoes, resultado):
        levantar(api, sessao, fichas * f)
    api("POST", f"/cash-game/tables/{mesa['id']}/close", {
        "rake_amount": rake * f, "jackpot_amount": JACKPOT_DA_NOITE * f,
    })
    fechar_gaveta(api, dia["id"])


def dia_para_encerrar(idioma: str, api) -> dict:
    """A noite já rodou, as mesas estão fechadas e a gaveta conferida: falta só
    encerrar. A linha congelada é o resultado do vídeo, então os números fecham."""
    tipos = catalogo(idioma, api)
    dia = _dia_vazio(idioma, api)
    rake, compras = NOITES[0]
    _noite(idioma, api, dia, tipos, rake, compras)
    return {"data_dia": dia["business_date"], "de": primeiro_dia_do_periodo(dia["business_date"])}


def primeiro_dia_do_periodo(data_iso: str) -> str:
    return date.fromisoformat(data_iso).replace(day=1).isoformat()


def relatorio(idioma: str, api) -> dict:
    """Cinco noites com números diferentes: um dia só não mostra ranking nenhum."""
    tipos = catalogo(idioma, api)
    inicio = (date.today() - timedelta(days=35)).isoformat()
    jogadas = [
        d for d in api("GET", "/cash-game/reports/daily", date_from=inicio, date_to=date.today().isoformat())
        if d["revenue"] >= 300 * fator(idioma) and d["status"] == "closed"
    ]
    for rake, compras in NOITES[len(jogadas):]:
        dia = _dia_vazio(idioma, api)
        _noite(idioma, api, dia, tipos, rake, compras)
        api("POST", f"/cash-game/days/{dia['id']}/close", {})
    encerrar_operacao(idioma, api)
    # A tela já abre no mês corrente: a data só anda para trás se alguma noite
    # ficou antes dele.
    noites = api("GET", "/cash-game/reports/daily", date_from=inicio, date_to=date.today().isoformat())
    return {"de": min([primeiro_dia_do_periodo(date.today().isoformat())] + [d["business_date"] for d in noites])}
