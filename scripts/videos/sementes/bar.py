# -*- coding: utf-8 -*-
"""Estado do bar para os vídeos da área.

O bar é da organização, não da etapa: há um só turno aberto por clube e as
comandas ignoram o X-Stage-ID. Por isso cada função começa arrumando o turno e
as comandas, e os vídeos do bar precisam gravar um de cada vez em cada clube.

Os nomes de produto mudam por idioma e os preços multiplicam pelo `fator` do
clube. Jogadores vêm do fim da lista do clube, longe dos que os vídeos de
torneio usam.
"""
import uuid
from datetime import date, timedelta

from clube_demo import CLUBES

ETAPA = "Club Series"

# O clube nasce com estas cinco categorias, sempre em português: a semente as
# renomeia na ordem em que vêm.
CATEGORIAS = {
    "pt-BR": ("Bebidas", "Cervejas", "Drinks", "Comidas", "Petiscos"),
    "en-US": ("Soft drinks", "Beers", "Cocktails", "Food", "Snacks"),
    "es-ES": ("Bebidas", "Cervezas", "Cócteles", "Comidas", "Aperitivos"),
}

# código: (categoria, nomes, preço, custo, estoque, mínimo). Sem estoque = não controla.
PRODUTOS = {
    "agua": (0, ("Água mineral", "Still water", "Agua mineral"), 6, 1.5, 120, 24),
    "refri": (0, ("Refrigerante lata", "Canned soda", "Gaseosa en lata"), 8, 3, 96, 24),
    "suco": (0, ("Suco de laranja", "Orange juice", "Jugo de naranja"), 12, 4, None, 0),
    "cerveja": (1, ("Cerveja long neck", "Bottled beer", "Cerveza en botella"), 14, 6, 144, 24),
    "chope": (1, ("Chope 300 ml", "Draft beer", "Cerveza de barril"), 12, 4.5, 200, 30),
    "caipirinha": (2, ("Caipirinha", "Mojito", "Mojito"), 28, 8, None, 0),
    "gin": (2, ("Gin tônica", "Gin and tonic", "Gin tonic"), 34, 11, None, 0),
    "hamburguer": (3, ("Hambúrguer", "Cheeseburger", "Hamburguesa"), 38, 14, None, 0),
    "sanduiche": (3, ("Sanduíche natural", "Club sandwich", "Sándwich de pollo"), 24, 9, None, 0),
    "fritas": (4, ("Batata frita", "French fries", "Papas fritas"), 24, 7, None, 0),
    # Abaixo do mínimo de propósito, e nenhuma comanda vende: é o aviso de estoque baixo.
    "amendoim": (4, ("Amendoim torrado", "Roasted peanuts", "Maní tostado"), 10, 3, 8, 12),
}
IDIOMAS = ("pt-BR", "en-US", "es-ES")

NOVO_PRODUTO = {"pt-BR": "Água com gás", "en-US": "Sparkling water", "es-ES": "Agua con gas"}
ROTULO_TURNO = {"pt-BR": "Noite", "en-US": "Night", "es-ES": "Noche"}
PATROCINADOR = {"pt-BR": "Patrocínio Demo", "en-US": "Demo Sponsor", "es-ES": "Patrocinio Demo"}
MOTIVO_CORTESIA = {"pt-BR": "Cortesia da casa", "en-US": "On the house", "es-ES": "Cortesía de la casa"}
MOTIVO_DESCONTO = {"pt-BR": "Cliente frequente", "en-US": "Regular customer", "es-ES": "Cliente frecuente"}
MOTIVO_ESTORNO = {"pt-BR": "Forma errada", "en-US": "Wrong method", "es-ES": "Forma equivocada"}
MOTIVO_LIMPEZA = {"pt-BR": "Teste", "en-US": "Test", "es-ES": "Prueba"}


def _novo_id() -> str:
    return str(uuid.uuid4())


def _meio_digital(idioma: str) -> str:
    """PIX só existe no clube em real; os outros têm cartão."""
    return "pix" if CLUBES[idioma].moeda == "BRL" else "card"


def _jogadores(api) -> dict:
    return {p["name"]: p["id"] for p in api("GET", "/players")}


def etapa_propria(idioma: str, api) -> dict:
    """A etapa dos vídeos desta área: o bar não a usa, mas a barra do topo a mostra."""
    achada = next((e for e in api("GET", "/stages") if e["name"] == ETAPA), None)
    if achada:
        return achada
    hoje = date.today()
    return api("POST", "/stages", {
        "name": ETAPA, "location": CLUBES[idioma].nome,
        "start_date": (hoje - timedelta(days=1)).isoformat(),
        "end_date": (hoje + timedelta(days=60)).isoformat(),
    })


def catalogo(idioma: str, api) -> dict:
    """Categorias no idioma do clube e produtos com estoque. Devolve {código: produto}."""
    f = CLUBES[idioma].fator
    categorias = sorted(api("GET", "/bar/categories"), key=lambda c: c["sort_order"])[:5]
    for categoria, nome in zip(categorias, CATEGORIAS[idioma]):
        if categoria["name"] != nome:
            api("PATCH", f"/bar/categories/{categoria['id']}", {"name": nome})

    existentes = {p["name"]: p for p in api("GET", "/bar/products")}
    # Sobra do vídeo de produtos. Sem venda nem movimento de estoque, sai de verdade.
    sobra = existentes.pop(NOVO_PRODUTO[idioma], None)
    if sobra:
        api("DELETE", f"/bar/products/{sobra['id']}")

    produtos = {}
    for codigo, (indice, nomes, preco, custo, estoque, minimo) in PRODUTOS.items():
        nome = nomes[IDIOMAS.index(idioma)]
        produto = existentes.get(nome) or api("POST", "/bar/products", {
            "name": nome, "category_id": categorias[indice]["id"], "price": preco * f, "cost_price": custo * f,
            "track_stock": estoque is not None, "min_stock": minimo,
        })
        # Repõe só quando a saída das gravações comeu metade do estoque.
        if estoque is not None and produto.get("stock_qty", 0) < estoque / 2:
            api("POST", f"/bar/products/{produto['id']}/stock-movements", {
                "kind": "in", "quantity": estoque - produto.get("stock_qty", 0), "unit_cost": custo * f,
                "client_mutation_id": _novo_id(),
            })
        produtos[codigo] = produto
    return produtos


def turno_aberto(idioma: str, api, dia: date | None = None) -> dict:
    return api("GET", "/bar/shifts/current") or api("POST", "/bar/shifts", {
        "business_date": (dia or date.today()).isoformat(), "label": ROTULO_TURNO[idioma],
    })


def gaveta_aberta(idioma: str, api, turno: dict) -> dict:
    gaveta = api("GET", "/cashboxes/me/current", bar_shift_id=turno["id"])
    if gaveta["status"] != "open":
        api("POST", f"/cashboxes/{gaveta['id']}/open", {"initial_balance": 200 * CLUBES[idioma].fator})
        gaveta = api("GET", "/cashboxes/me/current", bar_shift_id=turno["id"])
    return gaveta


def zerar_comandas(idioma: str, api, turno: dict) -> None:
    """Sem pagamento, cancela e o estoque volta. Com pagamento, quita e fecha."""
    for tab in api("GET", "/bar/tabs", bar_shift_id=turno["id"], status="open"):
        if tab["paid_amount"] <= 0:
            api("POST", f"/bar/tabs/{tab['id']}/cancel", {"reason": MOTIVO_LIMPEZA[idioma]})
            continue
        if tab["balance_due"] > 0:
            api("POST", f"/bar/tabs/{tab['id']}/payments", {
                "legs": [{"payment_method": "cash", "amount": tab["balance_due"], "payment_source": "cash"}],
                "client_mutation_id": _novo_id(),
            })
        api("POST", f"/bar/tabs/{tab['id']}/close", {"deliver_pending": True})


def encerrar_turno(idioma: str, api) -> None:
    turno = api("GET", "/bar/shifts/current")
    if not turno:
        return
    gaveta = gaveta_aberta(idioma, api, turno)
    zerar_comandas(idioma, api, turno)
    gaveta = api("GET", "/cashboxes/me/current", bar_shift_id=turno["id"])
    api("POST", f"/cashboxes/{gaveta['id']}/close", {"actual_final_balance": gaveta["current_balance"]})
    api("POST", f"/bar/shifts/{turno['id']}/close", {})


def comanda(api, jogador: str, itens: list, entregar: bool = True) -> dict:
    """`itens`: [(produto, quantidade)]. Abre a comanda do jogador e lança tudo."""
    tab = api("POST", "/bar/tabs/open", {"player_id": jogador, "client_mutation_id": _novo_id()})
    for produto, quantidade in itens:
        api("POST", f"/bar/tabs/{tab['id']}/items", {
            "product_id": produto["id"], "quantity": quantidade, "client_mutation_id": _novo_id(),
        })
    if entregar:
        api("POST", f"/bar/tabs/{tab['id']}/deliver-all")
    return api("GET", f"/bar/tabs/{tab['id']}")


def credito_garantido(idioma: str, api, jogador: str, valor: float) -> None:
    """Crédito é sempre de um patrocinador: garante o saldo sem acumular a cada gravação."""
    saldo = api("GET", f"/player-credits/player/{jogador}/balance")["available_credit"]
    if saldo >= valor:
        return
    nome = PATROCINADOR[idioma]
    patrocinador = next((s for s in api("GET", "/sponsors") if s["name"] == nome), None) \
        or api("POST", "/sponsors", {"name": nome})
    api("POST", "/player-credits", {"player_id": jogador, "sponsor_id": patrocinador["id"], "amount": valor - saldo})


def _vendas_do_dia(idioma: str, api, produtos: dict, nomes: dict, numero: int) -> None:
    """Quatro comandas fechadas: uma com cortesia, uma com desconto, uma com crédito."""
    clube = CLUBES[idioma]
    f = clube.fator
    jogadores = [nomes[n] for n in clube.jogadores[26:32]]
    digital = _meio_digital(idioma)
    extra = numero % 3

    def pagar_e_fechar(detalhe: dict, pernas: list) -> None:
        tab = detalhe["tab"]
        api("POST", f"/bar/tabs/{tab['id']}/payments", {"legs": pernas, "client_mutation_id": _novo_id()})
        api("POST", f"/bar/tabs/{tab['id']}/close", {"deliver_pending": True})

    def tudo_em(detalhe: dict, meio: str) -> None:
        pagar_e_fechar(detalhe, [{
            "payment_method": meio, "amount": detalhe["tab"]["balance_due"], "payment_source": "cash",
        }])

    tudo_em(comanda(api, jogadores[numero % 6], [
        (produtos["cerveja"], 3 + extra), (produtos["fritas"], 1), (produtos["hamburguer"], 1 + numero % 2),
    ]), digital)

    detalhe = comanda(api, jogadores[(numero + 1) % 6], [(produtos["gin"], 2), (produtos["sanduiche"], 1 + extra)])
    detalhe = api("POST", f"/bar/tabs/{detalhe['tab']['id']}/discount", {
        "amount": 10 * f, "reason": MOTIVO_DESCONTO[idioma],
    })
    tudo_em(detalhe, "cash")

    detalhe = comanda(api, jogadores[(numero + 2) % 6], [
        (produtos["agua"], 2), (produtos["refri"], 1), (produtos["caipirinha"], 2 + extra),
    ])
    agua = next(i for i in detalhe["items"] if i["product_id"] == produtos["agua"]["id"])
    detalhe = api("POST", f"/bar/tabs/{detalhe['tab']['id']}/items/{agua['id']}/courtesy", {
        "courtesy": True, "reason": MOTIVO_CORTESIA[idioma],
    })
    tudo_em(detalhe, "card")

    detalhe = comanda(api, jogadores[(numero + 3) % 6], [(produtos["chope"], 4 + extra), (produtos["suco"], 2)])
    credito = 30 * f
    credito_garantido(idioma, api, detalhe["tab"]["player_id"], credito)
    pagar_e_fechar(detalhe, [
        {"payment_method": "credit", "amount": credito, "payment_source": "credit"},
        {"payment_method": "cash", "amount": detalhe["tab"]["balance_due"] - credito, "payment_source": "cash"},
    ])


def historico(idioma: str, api, produtos: dict | None = None) -> None:
    """Noites passadas já encerradas, dentro do mês: é o que o relatório e a lista de
    turnos mostram. Fica pronto uma vez só por clube."""
    hoje = date.today()
    primeiro = hoje.replace(day=1)
    fechados = api(
        "GET", "/bar/shifts", status="closed", date_from=primeiro.isoformat(),
        date_to=(hoje - timedelta(days=1)).isoformat(),
    )
    if len(fechados) >= 4:
        return
    produtos = produtos or catalogo(idioma, api)
    nomes = _jogadores(api)
    encerrar_turno(idioma, api)
    for numero, atras in enumerate((5, 4, 2, 1)):
        dia = max(hoje - timedelta(days=atras), primeiro)
        turno = turno_aberto(idioma, api, dia)
        gaveta_aberta(idioma, api, turno)
        _vendas_do_dia(idioma, api, produtos, nomes, numero)
        encerrar_turno(idioma, api)


def _noite_pronta(idioma: str, api) -> tuple:
    """Catálogo, turno e gaveta abertos, e nenhuma comanda de gravação anterior."""
    produtos = catalogo(idioma, api)
    turno = turno_aberto(idioma, api)
    gaveta_aberta(idioma, api, turno)
    zerar_comandas(idioma, api, turno)
    return produtos, turno


def _nome(produto: dict) -> str:
    return produto["name"]


# ── uma função por vídeo ────────────────────────────────────────────────────

def produtos(idioma: str, api) -> dict:
    catalogados = catalogo(idioma, api)
    f = CLUBES[idioma].fator
    return {
        "etapa_selecionada": etapa_propria(idioma, api),
        "novo_produto": NOVO_PRODUTO[idioma],
        "categoria": CATEGORIAS[idioma][0],
        "preco": 7 * f,
        "custo": 2 * f,
        "cerveja": _nome(catalogados["cerveja"]),
        "custo_entrada": 6500 if f == 1000 else 6.5,
    }


def turnos(idioma: str, api) -> dict:
    catalogados = catalogo(idioma, api)
    historico(idioma, api, catalogados)
    encerrar_turno(idioma, api)
    clube = CLUBES[idioma]
    return {
        "etapa_selecionada": etapa_propria(idioma, api),
        "rotulo": ROTULO_TURNO[idioma],
        "saldo_inicial": 200 * clube.fator,
        "cliente": clube.jogadores[32],
        "cerveja": _nome(catalogados["cerveja"]),
    }


def abrir_comanda(idioma: str, api) -> dict:
    catalogados, _ = _noite_pronta(idioma, api)
    clube = CLUBES[idioma]
    nomes = _jogadores(api)
    comanda(api, nomes[clube.jogadores[33]], [(catalogados["chope"], 2), (catalogados["fritas"], 1)])
    comanda(api, nomes[clube.jogadores[34]], [(catalogados["gin"], 1)])
    return {
        "etapa_selecionada": etapa_propria(idioma, api),
        "cliente": clube.jogadores[35],
        "categoria_cerveja": CATEGORIAS[idioma][1],
        "cerveja": _nome(catalogados["cerveja"]),
        "categoria_petisco": CATEGORIAS[idioma][4],
        "fritas": _nome(catalogados["fritas"]),
    }


def pedidos(idioma: str, api) -> dict:
    catalogados, _ = _noite_pronta(idioma, api)
    clube = CLUBES[idioma]
    nomes = _jogadores(api)
    comanda(api, nomes[clube.jogadores[33]], [
        (catalogados["chope"], 2), (catalogados["fritas"], 1), (catalogados["agua"], 1),
    ], entregar=False)
    comanda(api, nomes[clube.jogadores[34]], [(catalogados["gin"], 2), (catalogados["hamburguer"], 1)], entregar=False)
    comanda(api, nomes[clube.jogadores[36]], [(catalogados["cerveja"], 3)], entregar=False)
    return {"etapa_selecionada": etapa_propria(idioma, api)}


def receber(idioma: str, api) -> dict:
    catalogados, _ = _noite_pronta(idioma, api)
    clube = CLUBES[idioma]
    f = clube.fator
    nomes = _jogadores(api)
    cliente = clube.jogadores[37]
    # 3 x 14 + 2 x 24 = 90: parcial de 30, depois 20 + 20 + 20 no dividido.
    comanda(api, nomes[cliente], [(catalogados["cerveja"], 3), (catalogados["fritas"], 2)])
    credito_garantido(idioma, api, nomes[cliente], 50 * f)
    comanda(api, nomes[clube.jogadores[33]], [(catalogados["chope"], 2)])
    return {
        "etapa_selecionada": etapa_propria(idioma, api),
        "cliente": cliente,
        "parcial": 30 * f,
        "perna": 20 * f,
        "meio_digital": _meio_digital(idioma),
    }


def ajustes(idioma: str, api) -> dict:
    catalogados, _ = _noite_pronta(idioma, api)
    clube = CLUBES[idioma]
    f = clube.fator
    nomes = _jogadores(api)
    cliente = clube.jogadores[38]
    detalhe = comanda(api, nomes[cliente], [
        (catalogados["gin"], 2), (catalogados["fritas"], 1), (catalogados["agua"], 1),
    ])
    api("POST", f"/bar/tabs/{detalhe['tab']['id']}/payments", {
        "legs": [{"payment_method": "cash", "amount": 20 * f, "payment_source": "cash"}],
        "client_mutation_id": _novo_id(),
    })
    return {
        "etapa_selecionada": etapa_propria(idioma, api),
        "cliente": cliente,
        "agua": _nome(catalogados["agua"]),
        "motivo_cortesia": MOTIVO_CORTESIA[idioma],
        "motivo_desconto": MOTIVO_DESCONTO[idioma],
        "motivo_estorno": MOTIVO_ESTORNO[idioma],
        "desconto": 10 * f,
    }


def relatorios(idioma: str, api) -> dict:
    historico(idioma, api)
    return {"etapa_selecionada": etapa_propria(idioma, api)}
