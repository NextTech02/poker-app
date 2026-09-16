"""CATÁLOGO e ESTOQUE do bar.

O que estes testes travam:

1. **Estoque só muda por movimento.** `stock_qty` no PATCH é recusado com
   nome — ignorar em silêncio deixaria o operador achando que gravou, e o
   ledger e a coluna passariam a discordar sem ninguém saber quando.
2. **Produto vendido não some.** O relatório por produto agrupa pela FK;
   apagar perderia a linha. Desativa.
3. **A busca ignora acento e caixa**, e roda em Python — a lista de um clube é
   pequena e o `ilike` do PostgREST não ignora acento (e no FakeSupabase ele
   nem existe: é no-op).
4. **A perda exige saldo; a entrada e o ajuste não.** Não dá para perder o que
   não se tem; mas a venda nunca bloqueia (isso é regra do item, não daqui).
"""
import pytest

from app.models.bar import (
    BarCategoryCreate,
    BarProductCreate,
    BarProductUpdate,
    BarStockMovementCreate,
)
from app.services import bar_product_service as prod_mod
from app.services.bar_product_service import BarProductService as BPS

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
AUTH = "auth-admin"
CAT = "ca111111-1111-1111-1111-111111111111"
CERVEJA = "0a111111-1111-1111-1111-111111111111"
AGUA = "0a222222-2222-2222-2222-222222222222"


def _produto(**extra):
    linha = {"id": CERVEJA, "organization_id": ORG, "category_id": CAT, "name": "Cerveja",
             "price": 10, "cost_price": 4, "track_stock": True, "stock_qty": 24,
             "min_stock": 6, "sku": "CERV", "active": True, "sort_order": 1}
    linha.update(extra)
    return linha


def _banco(monkeypatch, **tabelas):
    base = {
        "bar_product_categories": [{"id": CAT, "organization_id": ORG, "name": "Cervejas",
                                    "sort_order": 2, "active": True}],
        "bar_products": [_produto(),
                         _produto(id=AGUA, name="Água", price=5, cost_price=1.5,
                                  stock_qty=12, min_stock=20, sku="AGUA", sort_order=2)],
        "bar_stock_movements": [],
        "bar_tab_items": [],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    monkeypatch.setattr(prod_mod, "supabase", fake)
    return fake


def recusa(exc):
    return exc.value.como_http().detail


# ══════════════════════════════════════════════════════════════════════
# Categorias
# ══════════════════════════════════════════════════════════════════════

def test_categorias_vem_com_a_contagem_de_produtos(monkeypatch):
    _banco(monkeypatch)
    cats = BPS.list_categories(ORG)
    assert cats[0].name == "Cervejas"
    assert cats[0].products_count == 2


def test_categoria_com_produto_nao_e_apagada(monkeypatch):
    _banco(monkeypatch)
    with pytest.raises(Exception) as exc:
        BPS.delete_category(CAT)
    d = recusa(exc)
    assert exc.value.status == 409
    assert d["code"] == "categoria_com_produtos"
    assert d["quantidade"] == 2


def test_cria_categoria_na_org(monkeypatch):
    fake = _banco(monkeypatch)
    c = BPS.create_category(BarCategoryCreate(name="Drinks", sort_order=3), ORG)
    assert c.name == "Drinks"
    assert fake.store["bar_product_categories"][-1]["organization_id"] == ORG


# ══════════════════════════════════════════════════════════════════════
# Produtos
# ══════════════════════════════════════════════════════════════════════

def test_lista_com_nome_da_categoria_e_alerta_de_estoque(monkeypatch):
    _banco(monkeypatch)
    lista = BPS.list_products(ORG)
    por_nome = {p.name: p for p in lista}
    assert por_nome["Cerveja"].category_name == "Cervejas"
    assert por_nome["Cerveja"].low_stock is False      # 24 > 6
    assert por_nome["Água"].low_stock is True          # 12 <= 20


def test_busca_ignora_acento_e_caixa(monkeypatch):
    _banco(monkeypatch)
    assert [p.name for p in BPS.list_products(ORG, q="agua")] == ["Água"]
    assert [p.name for p in BPS.list_products(ORG, q="CERV")] == ["Cerveja"]   # pelo SKU
    assert BPS.list_products(ORG, q="vinho") == []


def test_so_estoque_baixo(monkeypatch):
    _banco(monkeypatch)
    assert [p.name for p in BPS.low_stock(ORG)] == ["Água"]


def test_cria_produto(monkeypatch):
    fake = _banco(monkeypatch)
    p = BPS.create_product(BarProductCreate(name="Porção", price=30, cost_price=12), ORG)
    assert p.price == 30 and p.track_stock is False and p.low_stock is False
    assert fake.store["bar_products"][-1]["organization_id"] == ORG


def test_sku_repetido_vira_409(monkeypatch):
    fake = _banco(monkeypatch)

    class Duplica(Exception):
        pass

    original = fake.table

    def _table(nome):
        q = original(nome)
        if nome == "bar_products":
            def _insert(payload):
                raise Exception('duplicate key value violates unique constraint "uq_bar_products_sku_org"')
            q.insert = _insert
        return q

    monkeypatch.setattr(fake, "table", _table)
    with pytest.raises(Exception) as exc:
        BPS.create_product(BarProductCreate(name="Outra", price=1, sku="CERV"), ORG)
    assert exc.value.status == 409
    assert recusa(exc)["code"] == "sku_duplicado"


def test_editar_estoque_pelo_produto_e_recusado(monkeypatch):
    _banco(monkeypatch)
    with pytest.raises(Exception) as exc:
        BPS.update_product(CERVEJA, BarProductUpdate(stock_qty=99))
    assert recusa(exc)["code"] == "estoque_so_por_movimento"


def test_edita_preco_sem_tocar_no_estoque(monkeypatch):
    fake = _banco(monkeypatch)
    p = BPS.update_product(CERVEJA, BarProductUpdate(price=12))
    assert p.price == 12
    assert fake.store["bar_products"][0]["stock_qty"] == 24


def test_produto_vendido_e_desativado_nao_apagado(monkeypatch):
    fake = _banco(monkeypatch, bar_tab_items=[{"id": "i1", "product_id": CERVEJA}])
    r = BPS.delete_product(CERVEJA)
    assert r["deactivated"] is True
    assert fake.store["bar_products"][0]["active"] is False


def test_produto_nunca_vendido_e_apagado(monkeypatch):
    fake = _banco(monkeypatch)
    r = BPS.delete_product(AGUA)
    assert r["deactivated"] is False
    assert all(p["id"] != AGUA for p in fake.store["bar_products"])


# ══════════════════════════════════════════════════════════════════════
# Estoque
# ══════════════════════════════════════════════════════════════════════

def test_entrada_grava_o_movimento_com_sinal_e_org(monkeypatch):
    fake = _banco(monkeypatch)
    r = BPS.add_stock_movement(CERVEJA, BarStockMovementCreate(kind="in", quantity=24, unit_cost=4.5), AUTH, ORG)
    mov = fake.store["bar_stock_movements"][0]
    assert mov["quantity"] == 24 and mov["kind"] == "in"
    assert mov["organization_id"] == ORG and mov["created_by"] == AUTH
    assert r["movement"].quantity == 24
    # Entrada com custo atualiza o custo de referência (é o que a próxima venda copia).
    assert fake.store["bar_products"][0]["cost_price"] == 4.5


def test_perda_vai_negativa_e_exige_saldo(monkeypatch):
    fake = _banco(monkeypatch)
    BPS.add_stock_movement(CERVEJA, BarStockMovementCreate(kind="loss", quantity=3), AUTH, ORG)
    assert fake.store["bar_stock_movements"][0]["quantity"] == -3

    with pytest.raises(Exception) as exc:
        BPS.add_stock_movement(CERVEJA, BarStockMovementCreate(kind="loss", quantity=999), AUTH, ORG)
    d = recusa(exc)
    assert d["code"] == "estoque_insuficiente"
    assert d["disponivel"] == 24 and d["solicitado"] == 999


def test_ajuste_aceita_os_dois_sinais(monkeypatch):
    fake = _banco(monkeypatch)
    BPS.add_stock_movement(CERVEJA, BarStockMovementCreate(kind="adjustment", quantity=-2), AUTH, ORG)
    BPS.add_stock_movement(CERVEJA, BarStockMovementCreate(kind="adjustment", quantity=5), AUTH, ORG)
    assert [m["quantity"] for m in fake.store["bar_stock_movements"]] == [-2, 5]


def test_quantidade_zero_e_recusada(monkeypatch):
    _banco(monkeypatch)
    with pytest.raises(Exception) as exc:
        BPS.add_stock_movement(CERVEJA, BarStockMovementCreate(kind="adjustment", quantity=0), AUTH, ORG)
    assert recusa(exc)["code"] == "quantidade_invalida"


def test_produto_sem_controle_nao_aceita_movimento(monkeypatch):
    _banco(monkeypatch, bar_products=[_produto(track_stock=False)])
    with pytest.raises(Exception) as exc:
        BPS.add_stock_movement(CERVEJA, BarStockMovementCreate(kind="in", quantity=1), AUTH, ORG)
    assert recusa(exc)["code"] == "produto_sem_controle_de_estoque"


def test_movimento_repetido_pelo_mutation_id_nao_duplica(monkeypatch):
    fake = _banco(monkeypatch)
    dados = BarStockMovementCreate(kind="in", quantity=10, client_mutation_id="cm-1")
    primeiro = BPS.add_stock_movement(CERVEJA, dados, AUTH, ORG)
    segundo = BPS.add_stock_movement(CERVEJA, dados, AUTH, ORG)
    assert len(fake.store["bar_stock_movements"]) == 1
    assert segundo["duplicate"] is True
    assert segundo["movement"].id == primeiro["movement"].id
