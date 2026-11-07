# -*- coding: utf-8 -*-
"""Clube fictício de onde saem as gravações, em produção (projeto São Paulo).

    python clube_demo.py --criar      # cria o clube, se ainda não existir
    python clube_demo.py --semear     # cria etapa, torneio, mesas e jogadores

Precisa de SUPABASE_SERVICE_KEY no arquivo de VIDEOS_ENV.

NADA AQUI ENVIA E-MAIL: o usuário nasce já confirmado pelo endpoint admin, sem
convite, e os jogadores não têm e-mail, então também não recebem o pedido de
consentimento. Os documentos são passaportes `DEMO...`: um CPF válido gerado por
fórmula pode coincidir com o de uma pessoa real, e aqui ele iria parar num vídeo.

O projeto é fixo de propósito: os .env locais ainda apontam para o banco antigo
de Oregon, e o clube precisa nascer onde os clientes estão.
"""
import argparse
import json
import os
import secrets
import uuid
from datetime import date, timedelta
from pathlib import Path

import httpx

from produzir import AQUI, carregar_env

PROJETO = "https://obhfozqcxbdvuqxugjxz.supabase.co"
API = "https://api.aceblind.net"
EMAIL = "videos-suporte@clube-demo.local"
ORG_NOME, ORG_SLUG = "Clube Demo", "clube-demo"
ESTADO = AQUI / "cache" / "clube.json"
MODULOS = ["tournament", "cash", "bar"]

JOGADORES = [
    "Ana Ribeiro", "Bruno Teixeira", "Carla Monteiro", "Daniel Prado", "Elisa Fontes", "Fábio Antunes",
    "Gabriela Moura", "Hugo Sampaio", "Isabel Cardoso", "João Vilela", "Karen Bastos", "Lucas Paiva",
    "Marina Queiroz", "Nicolas Duarte", "Olívia Barros", "Pedro Galvão", "Renata Siqueira", "Samuel Coelho",
    "Tatiana Brandão", "Vitor Medeiros", "Wagner Pacheco", "Yasmin Falcão", "André Leal", "Beatriz Salles",
]


def _admin() -> dict:
    chave = os.environ["SUPABASE_SERVICE_KEY"]
    return {"apikey": chave, "Authorization": f"Bearer {chave}", "Content-Type": "application/json"}


def _estado() -> dict:
    return json.loads(ESTADO.read_text(encoding="utf-8")) if ESTADO.exists() else {}


def _salvar(**novos) -> None:
    ESTADO.parent.mkdir(parents=True, exist_ok=True)
    ESTADO.write_text(json.dumps({**_estado(), **novos}, ensure_ascii=False, indent=1), encoding="utf-8")


def criar() -> None:
    existente = httpx.get(
        f"{PROJETO}/rest/v1/organizations", headers=_admin(), params={"slug": f"eq.{ORG_SLUG}", "select": "id"},
    ).json()
    if existente:
        print("clube já existe:", existente[0]["id"])
        _salvar(org=existente[0]["id"])
        return
    usuario = httpx.post(
        f"{PROJETO}/auth/v1/admin/users", headers=_admin(), timeout=30,
        json={
            "email": EMAIL,
            "password": secrets.token_urlsafe(24),  # nunca usada: a sessão vem do link admin
            "email_confirm": True,
            "user_metadata": {"full_name": "Equipe Demo"},
        },
    )
    usuario.raise_for_status()
    resposta = httpx.post(
        f"{PROJETO}/rest/v1/rpc/provision_organization", headers=_admin(), timeout=30,
        json={
            "p_org_name": ORG_NOME, "p_org_slug": ORG_SLUG, "p_auth_user": usuario.json()["id"],
            "p_admin_name": "Equipe Demo", "p_admin_email": EMAIL, "p_currency": "BRL",
            "p_plan": "premium", "p_language": "pt-BR", "p_modules": MODULOS,
        },
    )
    resposta.raise_for_status()
    _salvar(org=resposta.json(), usuario=usuario.json()["id"])
    print("clube criado:", resposta.json())


def abrir_sessao() -> dict:
    """Sessão sem senha e sem captcha: o link admin é conferido aqui mesmo e não sai e-mail."""
    link = httpx.post(
        f"{PROJETO}/auth/v1/admin/generate_link", headers=_admin(), timeout=30,
        json={"type": "magiclink", "email": EMAIL},
    )
    link.raise_for_status()
    corpo = link.json()
    token = corpo.get("hashed_token") or corpo["properties"]["hashed_token"]
    verificado = httpx.post(
        f"{PROJETO}/auth/v1/verify", headers=_admin(), timeout=30,
        json={"type": "magiclink", "token_hash": token},
    )
    verificado.raise_for_status()
    return verificado.json()


class Api:
    def __init__(self, sessao: dict):
        self.cliente = httpx.Client(
            base_url=API, timeout=60, headers={"Authorization": f"Bearer {sessao['access_token']}"},
        )

    def __call__(self, metodo: str, caminho: str, corpo=None, etapa: str | None = None, **params):
        cabecalhos = {"X-Stage-ID": etapa} if etapa else {}
        r = self.cliente.request(metodo, caminho, json=corpo, headers=cabecalhos, params=params or None)
        if r.status_code >= 400:
            raise RuntimeError(f"{metodo} {caminho} -> {r.status_code}: {r.text[:300]}")
        return r.json() if r.text else None


def semear() -> None:
    api = Api(abrir_sessao())
    hoje = date.today()

    existentes = {p["name"] for p in api("GET", "/players")}
    for indice, nome in enumerate(JOGADORES, start=1):
        if nome in existentes:
            continue
        primeiro, resto = nome.split(" ", 1)
        api("POST", "/players", {
            "name": nome, "first_name": primeiro, "last_name": resto,
            "document_type": "passport", "document_number": f"DEMO{indice:04d}",
        })

    etapas = api("GET", "/stages")
    etapa = next((e for e in etapas if e["name"] == "Demo Series"), None) or api("POST", "/stages", {
        "name": "Demo Series", "location": "Clube Demo",
        "start_date": (hoje - timedelta(days=1)).isoformat(),
        "end_date": (hoje + timedelta(days=30)).isoformat(),
    })
    eid = etapa["id"]

    torneios = api("GET", "/tournaments", etapa=eid)
    torneio = next((t for t in torneios if t["name"] == "Main Event"), None) or api(
        "POST", "/tournaments", {"name": "Main Event", "stage_id": eid}, etapa=eid,
    )
    tid = torneio["id"]

    dias = api("GET", f"/tournament-days/tournament/{tid}", etapa=eid)
    dia = dias[0] if dias else api("POST", "/tournament-days", {
        "tournament_id": tid, "day_name": "Dia 1", "day_number": 1, "buy_in": 500, "rebuy_amount": 500,
        "addon_amount": 300, "rake_percentage": 20, "max_players": 120, "starting_chips": 30000,
        "rebuy_chips": 30000, "addon_chips": 40000, "blind_duration": 20,
        "initial_small_blind": 100, "initial_big_blind": 200,
    }, etapa=eid)

    if not api("GET", f"/tournaments/{tid}/buy-types", etapa=eid):
        api("PUT", f"/tournaments/{tid}/buy-types", {"items": [
            {"name": "Buy-in", "category": "buy_in", "amount": 500, "rake_percentage": 20, "chips": 30000},
            {"name": "Rebuy", "category": "rebuy", "amount": 500, "rake_percentage": 20, "chips": 30000},
            {"name": "Add-on", "category": "addon", "amount": 300, "rake_percentage": 10, "chips": 40000},
        ]}, etapa=eid)
    meios = api("GET", f"/tournaments/{tid}/buy-types", etapa=eid)
    entrada = next(m for m in meios if m["category"] == "buy_in")

    if not api("GET", f"/tables/day/{dia['id']}", etapa=eid):
        api("POST", f"/tables/day/{dia['id']}/bulk", etapa=eid, count=3, seats=9)

    gaveta = api("GET", "/cashboxes/me/current", etapa=eid)
    if gaveta and gaveta.get("status") != "open":
        api("POST", f"/cashboxes/{gaveta['id']}/open", {"initial_balance": 300}, etapa=eid)

    # Algumas vendas prontas: a tela de Vendas não pode aparecer vazia no vídeo.
    jogadores = {p["name"]: p["id"] for p in api("GET", "/players")}
    inscritos = {r["player_id"] for r in api("GET", f"/tournament-players/tournament/{tid}", etapa=eid)}
    for nome, meio in zip(JOGADORES[:6], ("pix", "cash", "card", "pix", "cash", "pix")):
        if jogadores[nome] in inscritos:
            continue
        api("POST", "/tournament-players", {
            "tournament_id": tid, "tournament_day_id": dia["id"], "player_id": jogadores[nome],
            "buy_in_count": 1, "payment_source": "cash", "payment_method": meio,
            "buy_type_id": entrada["id"], "client_id": str(uuid.uuid4()), "client_mutation_id": str(uuid.uuid4()),
        }, etapa=eid)

    _salvar(etapa=etapa, torneio=tid, dia=dia["id"])
    print("semeado:", len(jogadores), "jogadores,", len(inscritos), "inscritos antes desta rodada")


def proximo_jogador() -> str:
    """Quem ainda não entrou no torneio: cada gravação vende para alguém novo,
    porque o sistema recusa uma segunda entrada de quem não foi eliminado."""
    estado = _estado()
    api = Api(abrir_sessao())
    eid = estado["etapa"]["id"]
    inscritos = {r["player_id"] for r in api("GET", f"/tournament-players/tournament/{estado['torneio']}", etapa=eid)}
    for jogador in api("GET", "/players"):
        if jogador["id"] not in inscritos and jogador["name"] in JOGADORES:
            return jogador["name"]
    raise RuntimeError("todos os jogadores fictícios já entraram no torneio")


def main() -> None:
    carregar_env()
    args = argparse.ArgumentParser()
    args.add_argument("--criar", action="store_true")
    args.add_argument("--semear", action="store_true")
    opcoes = args.parse_args()
    if opcoes.criar:
        criar()
    if opcoes.semear:
        semear()


if __name__ == "__main__":
    main()
