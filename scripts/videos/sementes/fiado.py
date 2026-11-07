# -*- coding: utf-8 -*-
"""Fiado: cada vídeo pega um jogador de conta limpa, porque o extrato não apaga.

Os jogadores daqui ficam no fim da lista do clube, longe das mesas do cash. A
conta nasce e muda pela API de gestão; a dívida nasce de uma venda de verdade na
mesa, porque o banco só aceita lançamento que venha de uma operação de caixa.
"""
import uuid

from sementes.cash import (
    fator, gaveta_aberta, ids_dos_jogadores, levantar, nome, salao_em_operacao, sentar, sessoes_ativas,
)

CONTAS = tuple(range(26, 40))  # Índices de CLUBES[idioma].jogadores
MOTIVOS = {
    "pt-BR": {"estorno": "Recebido no jogador errado", "baixa": "Acordo com o jogador"},
    "en-US": {"estorno": "Received from the wrong player", "baixa": "Settled with the player"},
    "es-ES": {"estorno": "Cobrado al jugador equivocado", "baixa": "Acuerdo con el jugador"},
}


def _sem_conta(idioma: str, api) -> tuple:
    jogadores = ids_dos_jogadores(api)
    for indice in CONTAS:
        pessoa = nome(idioma, indice)
        if not api("GET", f"/house-credit/players/{jogadores[pessoa]}")["exists"]:
            return pessoa, jogadores[pessoa]
    raise RuntimeError("acabaram os jogadores sem conta de fiado neste clube")


def _sem_divida(idioma: str, api, dia_id: str) -> tuple:
    """Alguém que pode comprar agora: não está sentado e não deve nada."""
    jogadores = ids_dos_jogadores(api)
    sentados = {s["player_id"] for s in sessoes_ativas(api, dia_id)}
    for indice in CONTAS:
        pessoa = nome(idioma, indice)
        conta = api("GET", f"/house-credit/players/{jogadores[pessoa]}")
        if jogadores[pessoa] not in sentados and not float(conta["balance"] or 0):
            return pessoa, jogadores[pessoa]
    raise RuntimeError("todos os jogadores do fiado têm dívida neste clube")


def configurar(idioma: str, api) -> dict:
    api("PUT", "/house-credit/settings", {"due_days": 30, "block_overdue": True, "default_limit": 0})
    pessoa, pessoa_id = _sem_conta(idioma, api)
    return {"pessoa": pessoa, "pessoa_id": pessoa_id, "limite": 1000 * fator(idioma)}


def venda(idioma: str, api) -> dict:
    f = fator(idioma)
    _, dia, mesa, _ = salao_em_operacao(idioma, api)
    pessoa, pessoa_id = _sem_divida(idioma, api, dia["id"])
    api("PUT", f"/house-credit/players/{pessoa_id}", {"enabled": True, "credit_limit": 1000 * f})
    return {"mesa": mesa["id"], "pessoa": pessoa, "buyin": 300 * f, "fichas": 450 * f}


def _vender_e_levantar(api, dia_id: str, mesa_id: str, pessoa_id: str, valor: float, limite: float) -> None:
    """A dívida só nasce de uma venda: senta no fiado e sai sem devolver fichas."""
    api("PUT", f"/house-credit/players/{pessoa_id}", {"enabled": True, "credit_limit": limite})
    lugar = next(c["seat_number"] for c in api("GET", f"/cash-game/tables/{mesa_id}/seats") if c["status"] == "free")
    sentar(api, mesa_id, lugar, pessoa_id, valor, payment_source="house_credit")
    levantar(api, next(s for s in sessoes_ativas(api, dia_id) if s["player_id"] == pessoa_id), 0)


def divida_com_recebimento(idioma: str, api) -> dict:
    """Deve 300, pagou 100: o extrato chega com o que o vídeo estorna e dá baixa.
    Um segundo devedor fica de fundo, para a lista não ter uma linha só."""
    f = fator(idioma)
    _, dia, mesa, _ = salao_em_operacao(idioma, api)
    gaveta_aberta(idioma, api, dia["id"])
    jogadores = ids_dos_jogadores(api)
    de_fundo = jogadores[nome(idioma, CONTAS[-1])]
    if not float(api("GET", f"/house-credit/players/{de_fundo}")["balance"] or 0):
        _vender_e_levantar(api, dia["id"], mesa["id"], de_fundo, 150 * f, 500 * f)
    pessoa, pessoa_id = _sem_divida(idioma, api, dia["id"])
    _vender_e_levantar(api, dia["id"], mesa["id"], pessoa_id, 300 * f, 1000 * f)
    api("POST", f"/house-credit/players/{pessoa_id}/payments", {
        "amount": 100 * f, "payment_method": "cash", "cash_day_id": dia["id"],
        "client_mutation_id": str(uuid.uuid4()),
    })
    return {"pessoa_id": pessoa_id, **{f"motivo_{k}": v for k, v in MOTIVOS[idioma].items()}}
