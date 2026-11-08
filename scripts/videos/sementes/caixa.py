# -*- coding: utf-8 -*-
"""Caixa de torneio: gaveta, venda dividida, cancelamento, troca de pagamento,
crédito de patrocinador, tickets e sangria.

Tudo acontece em `ETAPA`, que só estes vídeos usam: fechar a gaveta aqui não
atrapalha as outras áreas. A sangria fica em `ETAPA_SANGRIA` porque, depois dela,
cancelar uma venda abre o painel de pendências, e o vídeo de cancelamento
mostra o caso comum.

Cada gravação vende para alguém que ainda não entrou no dia. Quando faltam
jogadores, o torneio vai para `ARQUIVO` e nasce outro com o mesmo nome.
"""
import uuid

from clube_demo import CLUBES
from sementes.torneios_operacao import _achar_etapa, _ids_dos_jogadores, _sentar, _torneio_de_um_dia

ETAPA = "Summer Cup"
ETAPA_SANGRIA = "Coast Cup"
ARQUIVO = "Summer Archive"
TORNEIO = {"pt-BR": "Torneio de Verão", "en-US": "Summer Tournament", "es-ES": "Torneo de Verano"}

SALDO_INICIAL = 300
BUY_IN = 500
DIFERENCA_NA_CONTAGEM = 10
PARTE_EM_DINHEIRO = 300
VALOR_DO_CREDITO = 1000
SALDO_PARA_SANGRIA = 4000
VALOR_DA_SANGRIA = 2000

MESAS = 5
LUGARES_POR_MESA = 9
VENDAS_PRONTAS = ("cash", "card", "cash", "card", "cash", "card")
MINIMO_DE_LIVRES = 10

OBS_FECHAMENTO = {"pt-BR": "Troco dado a mais", "en-US": "Gave too much change", "es-ES": "Vuelto de más"}
MOTIVO_CANCELAMENTO = {
    "pt-BR": "Cobrança em duplicidade", "en-US": "Charged twice", "es-ES": "Cobro duplicado",
}
PATROCINADOR = {"pt-BR": "Grupo Verão", "en-US": "Summer Group", "es-ES": "Grupo Verano"}
CONTATO = {"pt-BR": "Diretoria", "en-US": "Management", "es-ES": "Gerencia"}
OBS_CREDITO = {"pt-BR": "Pacote da etapa", "en-US": "Stage package", "es-ES": "Paquete de la etapa"}
ONDE_GANHOU = {"pt-BR": "Satélite de sexta", "en-US": "Friday satellite", "es-ES": "Satélite del viernes"}


def _fator(idioma: str) -> int:
    return CLUBES[idioma].fator


def _gaveta(api, eid: str) -> dict:
    return api("GET", "/cashboxes/me/current", etapa=eid)


def _abrir_gaveta(idioma: str, api, eid: str) -> None:
    gaveta = _gaveta(api, eid)
    if gaveta["status"] != "open":
        api("POST", f"/cashboxes/{gaveta['id']}/open", {"initial_balance": SALDO_INICIAL * _fator(idioma)}, etapa=eid)


def _comprar(api, eid: str, torneio: dict, dia: dict, entrada: dict, jogador_id: str, metodo: str = "cash") -> None:
    api("POST", "/tournament-players", {
        "tournament_id": torneio["id"], "tournament_day_id": dia["id"], "player_id": jogador_id,
        "buy_in_count": 1, "payment_source": "cash", "payment_method": metodo, "buy_type_id": entrada["id"],
        "client_id": str(uuid.uuid4()), "client_mutation_id": str(uuid.uuid4()),
    }, etapa=eid)


def _livres(idioma: str, api, eid: str, dia: dict) -> list:
    """Quem ainda não entrou no dia, na ordem do clube."""
    ids = _ids_dos_jogadores(api)
    inscritos = {r["player_id"] for r in api("GET", f"/tournament-players/day/{dia['id']}", etapa=eid)}
    return [nome for nome in CLUBES[idioma].jogadores if ids[nome] not in inscritos]


def _entrada(meios: list) -> dict:
    return next(m for m in meios if m["category"] == "buy_in")


def _torneio_novo(idioma: str, api, eid: str) -> tuple:
    """Um dia com mesas e algumas vendas: a tela de Vendas não pode aparecer vazia."""
    torneio, dia, meios = _torneio_de_um_dia(idioma, api, eid, TORNEIO[idioma])
    api("POST", f"/tables/day/{dia['id']}/bulk", etapa=eid, count=MESAS, seats=LUGARES_POR_MESA)
    api("PATCH", f"/tournament-days/{dia['id']}", {"status": "active"}, etapa=eid)
    ids = _ids_dos_jogadores(api)
    for nome, metodo in zip(CLUBES[idioma].jogadores, VENDAS_PRONTAS):
        _comprar(api, eid, torneio, dia, _entrada(meios), ids[nome], metodo)
    _sentar(api, eid, dia["id"])
    return torneio, dia, _entrada(meios)


def _palco(idioma: str, api, nome_da_etapa: str = ETAPA) -> tuple:
    """A etapa, o torneio, o dia e o meio de entrada, com a gaveta aberta."""
    clube = CLUBES[idioma]
    etapa = _achar_etapa(api, nome_da_etapa, clube)
    eid = etapa["id"]
    _abrir_gaveta(idioma, api, eid)
    torneio = next((t for t in api("GET", "/tournaments", etapa=eid) if t["name"] == TORNEIO[idioma]), None)
    if not torneio:
        return (etapa, *_torneio_novo(idioma, api, eid))
    dia = api("GET", f"/tournament-days/tournament/{torneio['id']}", etapa=eid)[0]
    if len(_livres(idioma, api, eid, dia)) < MINIMO_DE_LIVRES:
        arquivo = _achar_etapa(api, ARQUIVO, clube)
        api("PATCH", f"/tournaments/{torneio['id']}", {"stage_id": arquivo["id"]}, etapa=eid)
        return (etapa, *_torneio_novo(idioma, api, eid))
    return etapa, torneio, dia, _entrada(api("GET", f"/tournaments/{torneio['id']}/buy-types", etapa=eid))


# ── temas ────────────────────────────────────────────────────────────────────
def abrir_fechar(idioma: str, api) -> dict:
    """O vídeo começa com a gaveta fechada e faz uma venda antes de fechá-la."""
    f = _fator(idioma)
    etapa, torneio, dia, _ = _palco(idioma, api)
    eid = etapa["id"]
    gaveta = _gaveta(api, eid)
    api("POST", f"/cashboxes/{gaveta['id']}/close", {"actual_final_balance": gaveta["current_balance"]}, etapa=eid)
    return {
        "etapa_selecionada": etapa, "nome_torneio": torneio["name"], "comprador": _livres(idioma, api, eid, dia)[0],
        "saldo_inicial": str(SALDO_INICIAL * f),
        "saldo_contado": str((SALDO_INICIAL + BUY_IN - DIFERENCA_NA_CONTAGEM) * f),
        "obs_fechamento": OBS_FECHAMENTO[idioma],
    }


def dividido(idioma: str, api) -> dict:
    etapa, torneio, dia, _ = _palco(idioma, api)
    return {
        "etapa_selecionada": etapa, "nome_torneio": torneio["name"],
        "comprador": _livres(idioma, api, etapa["id"], dia)[0], "parte1": str(PARTE_EM_DINHEIRO * _fator(idioma)),
    }


def cancelar(idioma: str, api) -> dict:
    """Uma venda nova, a primeira da lista, com o jogador já sentado."""
    etapa, torneio, dia, entrada = _palco(idioma, api)
    eid = etapa["id"]
    comprador = _livres(idioma, api, eid, dia)[0]
    _comprar(api, eid, torneio, dia, entrada, _ids_dos_jogadores(api)[comprador])
    _sentar(api, eid, dia["id"])
    return {"etapa_selecionada": etapa, "comprador": comprador, "motivo": MOTIVO_CANCELAMENTO[idioma]}


def reimprimir(idioma: str, api) -> dict:
    """A venda começa em dinheiro: a da gravação anterior terminou em outro meio."""
    etapa, torneio, _, _ = _palco(idioma, api)
    eid = etapa["id"]
    jogador = CLUBES[idioma].jogadores[0]
    venda = next(
        v for v in api("GET", "/transactions", etapa=eid)
        if v["player_name"] == jogador and v["tournament_id"] == torneio["id"] and v["type"] == "buy_in"
    )
    if venda["payment_method"] != "cash":
        api("PATCH", f"/transactions/{venda['id']}/payment-method", {"payment_method": "cash"}, etapa=eid)
    return {"etapa_selecionada": etapa, "jogador_bilhete": jogador}


def _patrocinador_novo(idioma: str, api) -> str:
    """O crédito segura o patrocinador no banco: cada gravação usa um nome livre."""
    existentes = {s["name"] for s in api("GET", "/sponsors")}
    base = PATROCINADOR[idioma]
    if base not in existentes:
        return base
    return next(f"{base} {n}" for n in range(2, 100) if f"{base} {n}" not in existentes)


def _sem_credito(idioma: str, api) -> str:
    """Alguém de conta limpa: o extrato não apaga."""
    ids = _ids_dos_jogadores(api)
    for nome in CLUBES[idioma].jogadores[10:26]:
        if not api("GET", f"/player-credits/player/{ids[nome]}/credits"):
            return nome
    raise RuntimeError("acabaram os jogadores sem crédito neste clube")


def limite(idioma: str, api) -> dict:
    etapa, torneio, _, _ = _palco(idioma, api)
    return {
        "etapa_selecionada": etapa, "nome_torneio": torneio["name"],
        "patrocinador": _patrocinador_novo(idioma, api), "contato": CONTATO[idioma],
        "beneficiado": _sem_credito(idioma, api), "valor_credito": str(VALOR_DO_CREDITO * _fator(idioma)),
        "obs_credito": OBS_CREDITO[idioma],
    }


def tickets(idioma: str, api) -> dict:
    """Dois tickets prontos, para o resgate na tela e para a venda no Caixa.
    O terceiro nasce no vídeo. Os que sobraram da gravação anterior saem da lista."""
    etapa, torneio, dia, _ = _palco(idioma, api)
    eid = etapa["id"]
    for sobra in api("GET", "/satellite-tickets/available", target_tournament_id=torneio["id"]):
        api("POST", f"/satellite-tickets/{sobra['id']}/cancel", etapa=eid)
    resgate, caixa, dono, novo_dono = _livres(idioma, api, eid, dia)[:4]
    ids = _ids_dos_jogadores(api)

    def emitir(nome: str) -> dict:
        return api("POST", "/satellite-tickets", {
            "player_id": ids[nome], "target_tournament_id": torneio["id"], "target_tournament_day_id": dia["id"],
            "won_at": ONDE_GANHOU[idioma], "funded_by": CLUBES[idioma].nome, "stage_id": eid,
        }, etapa=eid)

    emitir(caixa)
    return {
        "etapa_selecionada": etapa, "nome_torneio": torneio["name"], "ticket_resgate": emitir(resgate)["id"],
        "jogador_caixa": caixa, "dono": dono, "novo_dono": novo_dono, "onde_ganhou": ONDE_GANHOU[idioma],
        "financiador": CLUBES[idioma].nome,
    }


def sangria(idioma: str, api) -> dict:
    """A etapa precisa de saldo: cada gravação sangra parte dele."""
    f = _fator(idioma)
    etapa, torneio, dia, entrada = _palco(idioma, api, ETAPA_SANGRIA)
    eid = etapa["id"]
    ids = _ids_dos_jogadores(api)
    saldo = float(api("GET", f"/cash/stage/{eid}")["current_balance"])
    for indice, nome in enumerate(_livres(idioma, api, eid, dia)):
        if saldo >= SALDO_PARA_SANGRIA * f:
            break
        _comprar(api, eid, torneio, dia, entrada, ids[nome], VENDAS_PRONTAS[indice % len(VENDAS_PRONTAS)])
        saldo += BUY_IN * f
    return {"etapa_selecionada": etapa, "valor_sangria": str(VALOR_DA_SANGRIA * f)}
