# -*- coding: utf-8 -*-
"""Clubes fictícios de onde saem as gravações, em produção (projeto São Paulo).

    python clube_demo.py --criar --semear                  # os três clubes
    python clube_demo.py --semear --idioma en-US           # um só

Um clube por idioma: o vídeo em inglês não pode mostrar R$ nem "Dia 1", e quem
assiste em Lima ou Bogotá precisa ver a própria moeda. Precisa de
SUPABASE_SERVICE_KEY no arquivo de VIDEOS_ENV.

NADA AQUI ENVIA E-MAIL: o usuário nasce já confirmado pelo endpoint admin, sem
convite, e os jogadores não têm e-mail, então também não recebem o pedido de
consentimento. Os documentos são passaportes `DEMO...`: um CPF válido gerado por
fórmula pode coincidir com o de uma pessoa real, e aqui ele iria parar num vídeo.

O projeto é fixo de propósito: os .env locais ainda apontam para o banco antigo
de Oregon, e os clubes precisam nascer onde os clientes estão.
"""
import argparse
import json
import os
import secrets
import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import httpx

from produzir import AQUI, IDIOMAS, carregar_env

PROJETO = "https://obhfozqcxbdvuqxugjxz.supabase.co"
API = "https://api.aceblind.net"
MODULOS = ["tournament", "cash", "bar"]


@dataclass(frozen=True)
class Clube:
    nome: str
    slug: str
    email: str
    equipe: str
    moeda: str
    dia: str
    fator: int  # multiplica os valores: buy-in de 500 em real é 500 mil em peso
    jogadores: tuple


CLUBES = {
    "pt-BR": Clube(
        "Clube Demo", "clube-demo", "videos-suporte@clube-demo.local", "Equipe Demo", "BRL", "Dia 1", 1,
        ("Ana Ribeiro", "Bruno Teixeira", "Carla Monteiro", "Daniel Prado", "Elisa Fontes", "Fábio Antunes",
         "Gabriela Moura", "Hugo Sampaio", "Isabel Cardoso", "João Vilela", "Karen Bastos", "Lucas Paiva",
         "Marina Queiroz", "Nicolas Duarte", "Olívia Barros", "Pedro Galvão", "Renata Siqueira", "Samuel Coelho",
         "Tatiana Brandão", "Vitor Medeiros", "Wagner Pacheco", "Yasmin Falcão", "André Leal", "Beatriz Salles",
         "Caio Rezende", "Débora Nogueira", "Eduardo Vieira", "Flávia Tavares", "Gustavo Peixoto", "Helena Aguiar",
         "Igor Mesquita", "Júlia Camargo", "Leandro Rangel", "Mônica Dantas", "Otávio Lacerda", "Patrícia Veloso",
         "Rafael Bittencourt", "Sabrina Guedes", "Thiago Amaral", "Vanessa Portela"),
    ),
    "en-US": Clube(
        "Demo Poker Club", "demo-poker-club", "videos-suporte-en@clube-demo.local", "Demo Team", "USD", "Day 1", 1,
        ("Emma Clark", "Liam Foster", "Olivia Hayes", "Noah Bennett", "Ava Coleman", "Ethan Brooks",
         "Sophia Reed", "Mason Price", "Isabella Ward", "Logan Hughes", "Mia Sanders", "Lucas Ross",
         "Charlotte Long", "Jacob Perry", "Amelia Butler", "Henry Barnes", "Harper Fisher", "Jack Henderson",
         "Evelyn Simmons", "Owen Patterson", "Abigail Jordan", "Wyatt Powell", "Emily Russell", "Caleb Griffin",
         "Ella Diaz", "Nathan Hayes", "Grace Myers", "Ryan Ford", "Chloe Hamilton", "Dylan Graham",
         "Lily Sullivan", "Aaron Wallace", "Zoe Woods", "Adam Cole", "Nora West", "Connor Jordan",
         "Hannah Owens", "Evan Reynolds", "Layla Ellis", "Ian Harrison"),
    ),
    "es-ES": Clube(
        "Club Demo", "club-demo", "videos-suporte-es@clube-demo.local", "Equipo Demo", "COP", "Día 1", 1000,
        ("Sofía Rojas", "Mateo Vargas", "Valentina Castro", "Santiago Herrera", "Camila Ortiz", "Sebastián Mejía",
         "Isabella Ramírez", "Nicolás Gómez", "Mariana Torres", "Andrés Salazar", "Daniela Cárdenas", "Felipe Restrepo",
         "Gabriela Ríos", "Juan Ospina", "Laura Quintero", "Tomás Giraldo", "Paula Londoño", "Diego Zapata",
         "Natalia Muñoz", "Alejandro Duque", "Carolina Vega", "Ricardo Peña", "Andrea Molina", "Julián Arango",
         "Lucía Navarro", "Pablo Cifuentes", "Manuela Bedoya", "Esteban Rincón", "Catalina Silva", "Martín Acosta",
         "Fernanda Lozano", "Hernán Parra", "Elena Serrano", "Óscar Benítez", "Claudia Montoya", "Rodrigo Palacios",
         "Juliana Correa", "Emilio Fuentes", "Adriana Mora", "Gonzalo Pinto"),
    ),
}


def _admin() -> dict:
    chave = os.environ["SUPABASE_SERVICE_KEY"]
    return {"apikey": chave, "Authorization": f"Bearer {chave}", "Content-Type": "application/json"}


def caminho_estado(idioma: str) -> Path:
    return AQUI / "cache" / f"clube-{idioma}.json"


def estado(idioma: str) -> dict:
    caminho = caminho_estado(idioma)
    return json.loads(caminho.read_text(encoding="utf-8")) if caminho.exists() else {}


def _salvar(idioma: str, **novos) -> None:
    caminho = caminho_estado(idioma)
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps({**estado(idioma), **novos}, ensure_ascii=False, indent=1), encoding="utf-8")


def criar(idioma: str) -> None:
    clube = CLUBES[idioma]
    existente = httpx.get(
        f"{PROJETO}/rest/v1/organizations", headers=_admin(), params={"slug": f"eq.{clube.slug}", "select": "id"},
    ).json()
    if existente:
        print(idioma, "clube já existe:", existente[0]["id"])
        _salvar(idioma, org=existente[0]["id"])
        return
    usuario = httpx.post(
        f"{PROJETO}/auth/v1/admin/users", headers=_admin(), timeout=30,
        json={
            "email": clube.email,
            "password": secrets.token_urlsafe(24),  # nunca usada: a sessão vem do link admin
            "email_confirm": True,
            "user_metadata": {"full_name": clube.equipe},
        },
    )
    usuario.raise_for_status()
    resposta = httpx.post(
        f"{PROJETO}/rest/v1/rpc/provision_organization", headers=_admin(), timeout=30,
        json={
            "p_org_name": clube.nome, "p_org_slug": clube.slug, "p_auth_user": usuario.json()["id"],
            "p_admin_name": clube.equipe, "p_admin_email": clube.email, "p_currency": clube.moeda,
            "p_plan": "premium", "p_language": idioma, "p_modules": MODULOS,
        },
    )
    resposta.raise_for_status()
    _salvar(idioma, org=resposta.json(), usuario=usuario.json()["id"])
    print(idioma, "clube criado:", resposta.json())


def abrir_sessao(idioma: str) -> dict:
    """Sessão sem senha e sem captcha: o link admin é conferido aqui mesmo e não sai e-mail."""
    link = httpx.post(
        f"{PROJETO}/auth/v1/admin/generate_link", headers=_admin(), timeout=30,
        json={"type": "magiclink", "email": CLUBES[idioma].email},
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


def semear(idioma: str) -> None:
    clube = CLUBES[idioma]
    api = Api(abrir_sessao(idioma))
    hoje = date.today()
    f = clube.fator

    # Todo clube nasce com PIX ativo, e ele só existe no Brasil.
    if clube.moeda != "BRL":
        httpx.patch(
            f"{PROJETO}/rest/v1/payment_methods", headers=_admin(), timeout=30,
            params={"organization_id": f"eq.{estado(idioma)['org']}", "code": "eq.pix"}, json={"active": False},
        ).raise_for_status()

    existentes = {p["name"] for p in api("GET", "/players")}
    for indice, nome in enumerate(clube.jogadores, start=1):
        if nome in existentes:
            continue
        primeiro, resto = nome.split(" ", 1)
        api("POST", "/players", {
            "name": nome, "first_name": primeiro, "last_name": resto,
            "document_type": "passport", "document_number": f"DEMO{indice:04d}",
        })

    etapas = api("GET", "/stages")
    etapa = next((e for e in etapas if e["name"] == "Demo Series"), None) or api("POST", "/stages", {
        "name": "Demo Series", "location": clube.nome,
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
        "tournament_id": tid, "day_name": clube.dia, "day_number": 1, "buy_in": 500 * f, "rebuy_amount": 500 * f,
        "addon_amount": 300 * f, "rake_percentage": 20, "max_players": 120, "starting_chips": 30000,
        "rebuy_chips": 30000, "addon_chips": 40000, "blind_duration": 20,
        "initial_small_blind": 100, "initial_big_blind": 200,
    }, etapa=eid)

    if not api("GET", f"/tournaments/{tid}/buy-types", etapa=eid):
        api("PUT", f"/tournaments/{tid}/buy-types", {"items": [
            {"name": "Buy-in", "category": "buy_in", "amount": 500 * f, "rake_percentage": 20, "chips": 30000},
            {"name": "Rebuy", "category": "rebuy", "amount": 500 * f, "rake_percentage": 20, "chips": 30000},
            {"name": "Add-on", "category": "addon", "amount": 300 * f, "rake_percentage": 10, "chips": 40000},
        ]}, etapa=eid)
    meios = api("GET", f"/tournaments/{tid}/buy-types", etapa=eid)
    entrada = next(m for m in meios if m["category"] == "buy_in")

    if not api("GET", f"/tables/day/{dia['id']}", etapa=eid):
        api("POST", f"/tables/day/{dia['id']}/bulk", etapa=eid, count=3, seats=9)

    gaveta = api("GET", "/cashboxes/me/current", etapa=eid)
    if gaveta and gaveta.get("status") != "open":
        api("POST", f"/cashboxes/{gaveta['id']}/open", {"initial_balance": 300 * f}, etapa=eid)

    # Algumas vendas prontas: a tela de Vendas não pode aparecer vazia no vídeo.
    jogadores = {p["name"]: p["id"] for p in api("GET", "/players")}
    inscritos = {r["player_id"] for r in api("GET", f"/tournament-players/tournament/{tid}", etapa=eid)}
    for nome, meio in zip(clube.jogadores[:6], ("cash", "card", "cash", "card", "cash", "card")):
        if jogadores[nome] in inscritos:
            continue
        api("POST", "/tournament-players", {
            "tournament_id": tid, "tournament_day_id": dia["id"], "player_id": jogadores[nome],
            "buy_in_count": 1, "payment_source": "cash", "payment_method": meio,
            "buy_type_id": entrada["id"], "client_id": str(uuid.uuid4()), "client_mutation_id": str(uuid.uuid4()),
        }, etapa=eid)

    _salvar(idioma, etapa=etapa, torneio=tid, dia=dia["id"])
    print(idioma, "semeado:", len(jogadores), "jogadores,", len(inscritos), "inscritos antes desta rodada")


def proximo_jogador(idioma: str) -> str:
    """Quem ainda não entrou no torneio: cada gravação vende para alguém novo,
    porque o sistema recusa uma segunda entrada de quem não foi eliminado."""
    dados = estado(idioma)
    api = Api(abrir_sessao(idioma))
    eid = dados["etapa"]["id"]
    inscritos = {r["player_id"] for r in api("GET", f"/tournament-players/tournament/{dados['torneio']}", etapa=eid)}
    for jogador in api("GET", "/players"):
        if jogador["id"] not in inscritos and jogador["name"] in CLUBES[idioma].jogadores:
            return jogador["name"]
    raise RuntimeError("todos os jogadores fictícios já entraram no torneio")


def main() -> None:
    carregar_env()
    args = argparse.ArgumentParser()
    args.add_argument("--criar", action="store_true")
    args.add_argument("--semear", action="store_true")
    args.add_argument("--idioma", choices=IDIOMAS, action="append")
    opcoes = args.parse_args()
    for idioma in opcoes.idioma or IDIOMAS:
        if opcoes.criar:
            criar(idioma)
        if opcoes.semear:
            semear(idioma)


if __name__ == "__main__":
    main()
