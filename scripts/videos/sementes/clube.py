# -*- coding: utf-8 -*-
"""Conta, equipe e financeiro: tudo na etapa `ETAPA`, com um torneio só.

O DRE, o Demonstrativo e os Relatórios precisam de um clube que já operou: vendas,
recompras, prêmio pago, despesas e uma sessão de caixa fechada. `_cenario` monta
isso uma vez por clube, passo a passo, e cada passo confere se já foi feito.

NADA AQUI ENVIA E-MAIL. O convite de funcionário e o "esqueci a senha" ficam só
nos roteiros, que param antes do envio, e o endereço digitado é fictício.

As categorias de despesa nascem em português em todo clube (a trigger da migração
não olha o idioma). Aqui elas são renomeadas: o vídeo em inglês não pode mostrar
"Aluguel do espaço".
"""
import uuid
from datetime import date, timedelta

from clube_demo import CLUBES
from sementes.torneios_operacao import (
    _achar_etapa, _caixa_geral_com, _torneio_de_um_dia, _torneio_existente, _vender,
)

ETAPA = "Winter Series"
TORNEIO = {"pt-BR": "Copa de Inverno", "en-US": "Winter Cup", "es-ES": "Copa de Invierno"}
INSCRITOS = 14
GRUPO_DE_CAIXA = {"pt-BR": "Caixa", "en-US": "Cashier", "es-ES": "Cajero"}
GRUPO_NOVO = {
    "pt-BR": ("Recepção", "Atende quem chega ao clube"),
    "en-US": ("Front Desk", "Greets people arriving at the club"),
    "es-ES": ("Recepción", "Atiende a quien llega al club"),
}
CONVIDADO = {
    "pt-BR": "novo.funcionario@clube-demo.local",
    "en-US": "new.employee@demo-poker-club.local",
    "es-ES": "nuevo.empleado@club-demo.local",
}
METODO_NOVO = {"pt-BR": "Vale da casa", "en-US": "House voucher", "es-ES": "Vale de la casa"}

# A primeira coluna é o nome com que a categoria nasce no banco.
CATEGORIAS = {
    "Aluguel do espaço": {"en-US": "Venue rent", "es-ES": "Alquiler del local"},
    "Dealers": {"en-US": "Dealers", "es-ES": "Dealers"},
    "Equipe de apoio": {"en-US": "Support staff", "es-ES": "Equipo de apoyo"},
    "Alimentação": {"en-US": "Food", "es-ES": "Alimentación"},
    "Marketing": {"en-US": "Marketing", "es-ES": "Marketing"},
    "Material": {"en-US": "Supplies", "es-ES": "Materiales"},
    "Estrutura": {"en-US": "Infrastructure", "es-ES": "Estructura"},
    "Taxas e impostos": {"en-US": "Fees and taxes", "es-ES": "Tasas e impuestos"},
    "Outros": {"en-US": "Other", "es-ES": "Otros"},
}
# (categoria, descrição por idioma, valor, status, sai do caixa geral)
DESPESAS = (
    ("Aluguel do espaço", {"pt-BR": "Aluguel do salão", "en-US": "Hall rent", "es-ES": "Alquiler del salón"},
     1200, "pago", False),
    ("Dealers", {"pt-BR": "4 dealers - sábado", "en-US": "4 dealers - Saturday", "es-ES": "4 dealers - sábado"},
     800, "pendente", True),
    ("Alimentação", {"pt-BR": "Lanches da equipe", "en-US": "Staff snacks", "es-ES": "Refrigerios del equipo"},
     150, "pendente", True),
    ("Estrutura", {"pt-BR": "Manutenção das mesas", "en-US": "Table maintenance", "es-ES": "Mantenimiento de mesas"},
     300, "pendente", True),
)
DESPESA_NOVA = {
    "descricao": {"pt-BR": "Baralhos novos", "en-US": "New card decks", "es-ES": "Barajas nuevas"},
    "fornecedor": {"pt-BR": "Distribuidora Demo", "en-US": "Demo Supplies", "es-ES": "Distribuidora Demo"},
}


def _fator(idioma: str) -> int:
    return CLUBES[idioma].fator


def _nome_da_categoria(idioma: str, original: str) -> str:
    return original if idioma == "pt-BR" else CATEGORIAS[original][idioma]


# ── etapa e cenário ──────────────────────────────────────────────────────────
def _etapa(idioma: str, api) -> dict:
    """A etapa desta área, com a gaveta aberta: sem ela o clube não vende."""
    etapa = _achar_etapa(api, ETAPA, CLUBES[idioma])
    gaveta = api("GET", "/cashboxes/me/current", etapa=etapa["id"])
    if gaveta and gaveta.get("status") != "open":
        api("POST", f"/cashboxes/{gaveta['id']}/open", {"initial_balance": 300 * _fator(idioma)}, etapa=etapa["id"])
    return etapa


def _categorias(idioma: str, api) -> dict:
    """Nome na tela -> id, já no idioma do clube."""
    atuais = api("GET", "/expenses/categories")
    if idioma != "pt-BR":
        for categoria in atuais:
            traduzido = CATEGORIAS.get(categoria["name"], {}).get(idioma)
            if traduzido and traduzido != categoria["name"]:
                api("PATCH", f"/expenses/categories/{categoria['id']}", {"name": traduzido})
                categoria["name"] = traduzido
    return {c["name"]: c["id"] for c in atuais}


def _despesas_de_fundo(idioma: str, api, eid: str, categorias: dict) -> None:
    """Sem lançamentos, a aba de Despesas e o DRE apareceriam vazios."""
    f = _fator(idioma)
    existentes = {e["description"] for e in api("GET", "/expenses", stage_id=eid)}
    for categoria, descricao, valor, status, do_caixa in DESPESAS:
        if descricao[idioma] in existentes:
            continue
        api("POST", "/expenses", {
            "stage_id": eid, "category_id": categorias[_nome_da_categoria(idioma, categoria)],
            "description": descricao[idioma], "amount": valor * f, "status": status, "paid_from_cash": do_caixa,
        })


def _recompras(api, eid: str, dia_id: str, meios: list) -> None:
    """Três recompras e dois add-ons, para o DRE não mostrar só buy-in."""
    rebuy = next(m for m in meios if m["category"] == "rebuy")
    addon = next(m for m in meios if m["category"] == "addon")
    inscritos = api("GET", f"/tournament-players/day/{dia_id}", etapa=eid)
    if any(i.get("rebuy_count") or i.get("addon_count") for i in inscritos):
        return
    for inscrito in inscritos[:3]:
        # Reentrada traz de volta um eliminado: sem ninguém fora, o caixa recusa.
        api("POST", f"/tournament-days/{dia_id}/eliminations", {"day_id": dia_id, "count": 1}, etapa=eid)
        api("POST", f"/tournament-players/{inscrito['id']}/rebuy", etapa=eid, payment_source="cash",
            payment_method="cash", buy_type_id=rebuy["id"], client_mutation_id=str(uuid.uuid4()))
    for inscrito in inscritos[3:5]:
        api("POST", f"/tournament-players/{inscrito['id']}/addon", etapa=eid, payment_source="cash",
            payment_method="cash", buy_type_id=addon["id"])


def _premios(idioma: str, api, etapa: dict, tid: str) -> None:
    """Dois prêmios pagos, para a linha de premiação do DRE não ficar zerada."""
    eid = etapa["id"]
    f = _fator(idioma)
    faixas = api("GET", f"/tournaments/{tid}/prizes", etapa=eid)
    if not faixas:
        faixas = api("POST", f"/tournaments/{tid}/prizes/bulk", {"allocations": [
            {"position": 1, "prize_amount": 3000 * f}, {"position": 2, "prize_amount": 1800 * f},
        ]}, etapa=eid)
    _caixa_geral_com(idioma, api, etapa, 4800 * f)
    pessoas = {p["name"]: p for p in api("GET", "/players")}
    for faixa, nome in zip(sorted(faixas, key=lambda x: x["position"]), CLUBES[idioma].jogadores):
        if faixa["paid"]:
            continue
        if not faixa["released"]:
            api("PATCH", f"/tournaments/{tid}/prizes/{faixa['id']}/release", {"released": True}, etapa=eid)
        pessoa = pessoas[nome]
        api("POST", f"/tournaments/{tid}/prizes/{faixa['id']}/pay", {
            "player_id": pessoa["id"], "document_type": pessoa["document_type"],
            "document_number": pessoa["document_number"],
        }, etapa=eid)


def _sessao_fechada(idioma: str, api, eid: str) -> None:
    """Uma sessão de caixa já conferida, faltando 10: é o que o Demonstrativo existe
    para mostrar. A gaveta abre de novo logo depois, para o clube continuar vendendo."""
    demonstrativo = api("GET", "/cashboxes/demonstrativo", etapa=eid)
    if any(not s["is_open"] for s in demonstrativo.get("sessions", [])):
        return
    gaveta = api("GET", "/cashboxes/me/current", etapa=eid)
    f = _fator(idioma)
    api("POST", f"/cashboxes/{gaveta['id']}/close", {"actual_final_balance": float(gaveta["current_balance"]) - 10 * f}, etapa=eid)
    api("POST", f"/cashboxes/{gaveta['id']}/open", {"initial_balance": 300 * f}, etapa=eid)


def _cenario(idioma: str, api) -> tuple:
    etapa = _etapa(idioma, api)
    eid = etapa["id"]
    nome = TORNEIO[idioma]
    torneio = _torneio_existente(api, eid, nome)
    if torneio:
        dia = api("GET", f"/tournament-days/tournament/{torneio['id']}", etapa=eid)[0]
        meios = api("GET", f"/tournaments/{torneio['id']}/buy-types", etapa=eid)
    else:
        torneio, dia, meios = _torneio_de_um_dia(idioma, api, eid, nome)
        api("POST", f"/tables/day/{dia['id']}/bulk", etapa=eid, count=2, seats=9)
        api("PATCH", f"/tournament-days/{dia['id']}", {"status": "active"}, etapa=eid)
    _vender(idioma, api, eid, torneio["id"], dia["id"], meios, INSCRITOS)
    _recompras(api, eid, dia["id"], meios)
    _premios(idioma, api, etapa, torneio["id"])
    categorias = _categorias(idioma, api)
    _despesas_de_fundo(idioma, api, eid, categorias)
    _sessao_fechada(idioma, api, eid)
    return etapa, torneio, dia, categorias


# ── temas ────────────────────────────────────────────────────────────────────
def base(idioma: str, api) -> dict:
    return {"etapa_selecionada": _etapa(idioma, api)}


def convite(idioma: str, api) -> dict:
    return {
        "etapa_selecionada": _etapa(idioma, api),
        "convidado": CONVIDADO[idioma], "grupo_do_convite": GRUPO_DE_CAIXA[idioma],
    }


def grupos(idioma: str, api) -> dict:
    nome, descricao = GRUPO_NOVO[idioma]
    for grupo in api("GET", "/staff/groups"):
        if grupo["name"] == nome:
            api("DELETE", f"/staff/groups/{grupo['id']}")
    return {"etapa_selecionada": _etapa(idioma, api), "grupo_novo": nome, "grupo_descricao": descricao}


def pagamentos(idioma: str, api) -> dict:
    """O log mostra o IP de cada `login`, e esse IP é o de quem grava. A primeira
    chamada desta sessão já gravou um `login`: refazer as despesas de fundo põe
    linhas de atividade acima dele, e o vídeo não chega a mostrar nenhum."""
    etapa, _, _, categorias = _cenario(idioma, api)
    eid = etapa["id"]
    for despesa in api("GET", "/expenses", stage_id=eid):
        api("DELETE", f"/expenses/{despesa['id']}")
    _despesas_de_fundo(idioma, api, eid, categorias)
    return {"etapa_selecionada": etapa, "valor_staff": 200 * _fator(idioma)}


def dre(idioma: str, api) -> dict:
    etapa, *_ = _cenario(idioma, api)
    return {"etapa_selecionada": etapa, "nome_etapa": ETAPA}


def despesa(idioma: str, api) -> dict:
    etapa, _, _, _ = _cenario(idioma, api)
    eid = etapa["id"]
    descricao = DESPESA_NOVA["descricao"][idioma]
    for anterior in api("GET", "/expenses", stage_id=eid):
        if anterior["description"] == descricao:
            api("DELETE", f"/expenses/{anterior['id']}")
    return {
        "etapa_selecionada": etapa, "nome_etapa": ETAPA, "despesa": descricao,
        "fornecedor": DESPESA_NOVA["fornecedor"][idioma], "valor_despesa": 240 * _fator(idioma),
        "categoria_despesa": _nome_da_categoria(idioma, "Material"),
        "vencimento": (date.today() + timedelta(days=7)).isoformat(),
    }


def metodos(idioma: str, api) -> dict:
    return {"etapa_selecionada": _etapa(idioma, api), "metodo_novo": METODO_NOVO[idioma]}


def relatorio(idioma: str, api) -> dict:
    etapa, *_ = _cenario(idioma, api)
    return {"etapa_selecionada": etapa, "amanha": (date.today() + timedelta(days=1)).isoformat()}


def offline(idioma: str, api) -> dict:
    etapa, torneio, dia, _ = _cenario(idioma, api)
    inscritos = {r["player_id"] for r in api("GET", f"/tournament-players/day/{dia['id']}", etapa=etapa["id"])}
    ids = {p["name"]: p["id"] for p in api("GET", "/players")}
    pessoa = next(n for n in CLUBES[idioma].jogadores if ids[n] not in inscritos)
    return {"etapa_selecionada": etapa, "nome_torneio": torneio["name"], "pessoa": pessoa}
