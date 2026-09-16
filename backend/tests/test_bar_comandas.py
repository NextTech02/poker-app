"""A COMANDA: abrir, lançar, entregar, cancelar, fechar.

O que estes testes travam:

1. **Comanda única por jogador.** Abrir de novo devolve a mesma; a corrida
   (índice do banco) é lida de volta em vez de estourar.
2. **Snapshot de preço.** O item copia nome/preço/custo do produto no
   momento; mudar o produto depois não muda a comanda.
3. **Totais recontados a partir das linhas** — a resposta nunca confia no
   número gravado (o FakeSupabase não roda trigger, e é isso que garante que
   a CONTA está no serviço).
4. **Nunca fica pago a mais.** Cancelar item / cortesia / desconto que
   deixasse `paid > total` é recusado — o gerente estorna antes.
5. **Fechar exige saldo zero**; pendente só fecha com `deliver_pending`.
"""
import pytest

from app.models.bar import (
    BarItemCourtesy,
    BarTabClose,
    BarTabDiscount,
    BarTabItemCreate,
    BarTabOpen,
)
from app.services import bar_shift_service as turno_mod
from app.services import bar_product_service as prod_mod
from app.services import bar_tab_service as tab_mod
from app.services import cashbox_service as caixa_mod
from app.services import player_credit_service as cred_mod
from app.services.bar_tab_service import BarTabService as BTS

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
AUTH = "auth-barman"
TURNO = "b1111111-1111-1111-1111-111111111111"
JOGADOR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"
OUTRO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2"
CERVEJA = "0a111111-1111-1111-1111-111111111111"
PORCAO = "0a333333-3333-3333-3333-333333333333"
COMANDA = "c1111111-1111-1111-1111-111111111111"


def _turno(**extra):
    linha = {"id": TURNO, "organization_id": ORG, "status": "open",
             "business_date": "2026-09-16", "opened_at": "2026-09-16T19:00:00Z",
             "last_tab_number": 0}
    linha.update(extra)
    return linha


def _comanda(**extra):
    linha = {"id": COMANDA, "organization_id": ORG, "bar_shift_id": TURNO, "player_id": JOGADOR,
             "number": 1, "status": "open", "subtotal": 0, "courtesy_amount": 0,
             "discount_amount": 0, "total": 0, "paid_amount": 0,
             "opened_at": "2026-09-16T20:00:00Z"}
    linha.update(extra)
    return linha


def _item(**extra):
    linha = {"id": "i1", "organization_id": ORG, "tab_id": COMANDA, "bar_shift_id": TURNO,
             "product_id": CERVEJA, "product_name": "Cerveja", "unit_price": 10, "unit_cost": 4,
             "quantity": 2, "line_total": 20, "is_courtesy": False, "status": "pending",
             "created_at": "2026-09-16T20:01:00Z"}
    linha.update(extra)
    return linha


def _pagamento(**extra):
    linha = {"id": "p1", "organization_id": ORG, "tab_id": COMANDA, "bar_shift_id": TURNO,
             "amount": 20, "payment_method": "pix", "payment_source": "cash", "status": "active",
             "cashbox_id": "cb1", "created_at": "2026-09-16T20:05:00Z"}
    linha.update(extra)
    return linha


def _banco(monkeypatch, **tabelas):
    base = {
        "bar_shifts": [_turno()],
        "bar_tabs": [],
        "bar_tab_items": [],
        "bar_tab_payments": [],
        "bar_products": [
            {"id": CERVEJA, "organization_id": ORG, "name": "Cerveja", "price": 10, "cost_price": 4,
             "track_stock": True, "stock_qty": 24, "min_stock": 6, "active": True},
            {"id": PORCAO, "organization_id": ORG, "name": "Porção", "price": 30, "cost_price": 12,
             "track_stock": False, "stock_qty": 0, "min_stock": 0, "active": True},
        ],
        "bar_product_categories": [],
        "players": [{"id": JOGADOR, "name": "Ana", "nickname": "aninha"},
                    {"id": OUTRO, "name": "Bruno", "nickname": None}],
        "player_credits": [],
        "credit_transactions": [],
        "staff": [{"id": "s1", "auth_user_id": AUTH, "name": "Barman", "active": True,
                   "permission_groups": {"permissions": ["bar.operate", "cashbox.operate"]}}],
        "cashboxes": [{"id": "cb1", "staff_id": "s1", "bar_shift_id": TURNO, "stage_id": None,
                       "cash_day_id": None, "status": "open", "current_balance": 100,
                       "current_session_id": "cs1", "created_at": "2026-09-16T19:00:00Z"}],
        "cashbox_sessions": [{"id": "cs1", "cashbox_id": "cb1", "initial_balance": 100,
                              "opened_at": "2026-09-16T19:00:00Z"}],
        "cashbox_transactions": [],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    for mod in (turno_mod, prod_mod, tab_mod, caixa_mod, cred_mod):
        monkeypatch.setattr(mod, "supabase", fake)
    return fake


def recusa(exc):
    return exc.value.como_http().detail


# ══════════════════════════════════════════════════════════════════════
# Abrir
# ══════════════════════════════════════════════════════════════════════

def test_abre_a_comanda_no_turno_aberto(monkeypatch):
    fake = _banco(monkeypatch)
    c = BTS.open_tab(BarTabOpen(player_id=JOGADOR), AUTH, ORG)
    assert c.status == "open" and c.player_name == "Ana" and c.player_nickname == "aninha"
    assert c.bar_shift_id == TURNO
    assert c.total == 0 and c.balance_due == 0
    assert fake.store["bar_tabs"][0]["organization_id"] == ORG
    assert fake.store["bar_tabs"][0]["opened_by"] == AUTH


def test_comanda_e_unica_por_jogador(monkeypatch):
    _banco(monkeypatch)
    a = BTS.open_tab(BarTabOpen(player_id=JOGADOR), AUTH, ORG)
    b = BTS.open_tab(BarTabOpen(player_id=JOGADOR), AUTH, ORG)
    assert a.id == b.id
    outro = BTS.open_tab(BarTabOpen(player_id=OUTRO), AUTH, ORG)
    assert outro.id != a.id


def test_sem_turno_aberto_nao_abre(monkeypatch):
    _banco(monkeypatch, bar_shifts=[_turno(status="closed")])
    with pytest.raises(Exception) as exc:
        BTS.open_tab(BarTabOpen(player_id=JOGADOR), AUTH, ORG)
    assert recusa(exc)["code"] == "turno_nao_aberto"


def test_jogador_inexistente_e_404(monkeypatch):
    _banco(monkeypatch)
    with pytest.raises(Exception) as exc:
        BTS.open_tab(BarTabOpen(player_id="nao-existe"), AUTH, ORG)
    assert exc.value.status == 404
    assert recusa(exc)["code"] == "jogador_nao_encontrado"


# ══════════════════════════════════════════════════════════════════════
# Itens
# ══════════════════════════════════════════════════════════════════════

def test_lancar_item_copia_o_produto_e_reconta(monkeypatch):
    fake = _banco(monkeypatch, bar_tabs=[_comanda()])
    d = BTS.add_item(COMANDA, BarTabItemCreate(product_id=CERVEJA, quantity=2), AUTH)
    item = fake.store["bar_tab_items"][0]
    assert item["product_name"] == "Cerveja" and item["unit_price"] == 10 and item["unit_cost"] == 4
    assert item["line_total"] == 20 and item["status"] == "pending"
    assert item["bar_shift_id"] == TURNO and item["organization_id"] == ORG
    # A resposta é recontada das linhas: a linha da comanda no banco ainda
    # tem total 0 (sem trigger), e mesmo assim a tela recebe 20.
    assert d.tab.subtotal == 20 and d.tab.total == 20 and d.tab.balance_due == 20
    assert d.tab.items_count == 1 and d.tab.pending_count == 1


def test_mudar_o_produto_depois_nao_muda_a_comanda(monkeypatch):
    fake = _banco(monkeypatch, bar_tabs=[_comanda()])
    BTS.add_item(COMANDA, BarTabItemCreate(product_id=CERVEJA, quantity=1), AUTH)
    fake.store["bar_products"][0]["price"] = 99
    d = BTS.detail(COMANDA)
    assert d.items[0].unit_price == 10
    assert d.tab.total == 10


def test_item_repetido_pelo_mutation_id_nao_duplica(monkeypatch):
    fake = _banco(monkeypatch, bar_tabs=[_comanda()])
    dados = BarTabItemCreate(product_id=CERVEJA, quantity=1, client_mutation_id="cm-1")
    BTS.add_item(COMANDA, dados, AUTH)
    d = BTS.add_item(COMANDA, dados, AUTH)
    assert len(fake.store["bar_tab_items"]) == 1
    assert d.tab.total == 10


def test_produto_inativo_nao_e_lancado(monkeypatch):
    fake = _banco(monkeypatch, bar_tabs=[_comanda()])
    fake.store["bar_products"][0]["active"] = False
    with pytest.raises(Exception) as exc:
        BTS.add_item(COMANDA, BarTabItemCreate(product_id=CERVEJA), AUTH)
    assert recusa(exc)["code"] == "produto_inativo"


def test_comanda_fechada_nao_recebe_item(monkeypatch):
    _banco(monkeypatch, bar_tabs=[_comanda(status="closed")])
    with pytest.raises(Exception) as exc:
        BTS.add_item(COMANDA, BarTabItemCreate(product_id=CERVEJA), AUTH)
    d = recusa(exc)
    assert exc.value.status == 409
    assert d["code"] == "comanda_nao_aberta" and d["status_atual"] == "closed"


def test_entregar_e_idempotente_e_cancelado_nao_entrega(monkeypatch):
    fake = _banco(monkeypatch, bar_tabs=[_comanda()], bar_tab_items=[_item()])
    d = BTS.deliver_item(COMANDA, "i1", AUTH)
    assert d.items[0].status == "delivered" and d.tab.pending_count == 0
    BTS.deliver_item(COMANDA, "i1", AUTH)   # de novo: nada muda, nada estoura
    fake.store["bar_tab_items"][0]["status"] = "cancelled"
    with pytest.raises(Exception) as exc:
        BTS.deliver_item(COMANDA, "i1", AUTH)
    assert recusa(exc)["code"] == "item_cancelado"


def test_operador_cancela_pendente_mas_nao_entregue(monkeypatch):
    fake = _banco(monkeypatch, bar_tabs=[_comanda()],
                  bar_tab_items=[_item(), _item(id="i2", status="delivered")])
    d = BTS.cancel_item(COMANDA, "i1", "lançou errado", AUTH, pode_admin=False)
    assert fake.store["bar_tab_items"][0]["status"] == "cancelled"
    assert fake.store["bar_tab_items"][0]["cancel_reason"] == "lançou errado"
    assert d.tab.total == 20   # só o entregue ficou

    with pytest.raises(Exception) as exc:
        BTS.cancel_item(COMANDA, "i2", "x", AUTH, pode_admin=False)
    assert exc.value.status == 403
    assert recusa(exc)["code"] == "item_entregue_requer_admin"

    d = BTS.cancel_item(COMANDA, "i2", "x", AUTH, pode_admin=True)
    assert d.tab.total == 0


def test_cancelar_item_nao_pode_deixar_a_comanda_paga_a_mais(monkeypatch):
    """Pagou 20 de uma comanda de 20; cancelar o item deixaria o clube
    devendo. O gerente estorna primeiro."""
    _banco(monkeypatch, bar_tabs=[_comanda()], bar_tab_items=[_item()], bar_tab_payments=[_pagamento()])
    with pytest.raises(Exception) as exc:
        BTS.cancel_item(COMANDA, "i1", "x", AUTH, pode_admin=True)
    d = recusa(exc)
    assert d["code"] == "comanda_ficaria_paga_a_mais"
    assert d["pago"] == 20 and d["total_apos"] == 0


def test_cortesia_exige_motivo_e_sai_do_subtotal(monkeypatch):
    fake = _banco(monkeypatch, bar_tabs=[_comanda()], bar_tab_items=[_item(), _item(id="i2", product_id=PORCAO,
                  product_name="Porção", unit_price=30, unit_cost=12, quantity=1, line_total=30)])
    with pytest.raises(Exception) as exc:
        BTS.set_courtesy(COMANDA, "i1", BarItemCourtesy(courtesy=True, reason=""), AUTH)
    assert recusa(exc)["code"] == "motivo_obrigatorio"

    d = BTS.set_courtesy(COMANDA, "i1", BarItemCourtesy(courtesy=True, reason="VIP"), AUTH)
    assert fake.store["bar_tab_items"][0]["is_courtesy"] is True
    assert d.tab.subtotal == 30 and d.tab.courtesy_amount == 20 and d.tab.total == 30


# ══════════════════════════════════════════════════════════════════════
# Desconto
# ══════════════════════════════════════════════════════════════════════

def test_desconto_com_motivo_baixa_o_total(monkeypatch):
    fake = _banco(monkeypatch, bar_tabs=[_comanda()], bar_tab_items=[_item()])
    d = BTS.set_discount(COMANDA, BarTabDiscount(amount=5, reason="fidelidade"), AUTH)
    assert d.tab.total == 15 and d.tab.discount_amount == 5
    assert fake.store["bar_tabs"][0]["discount_reason"] == "fidelidade"


def test_desconto_total_e_como_se_fecha_quem_saiu_sem_pagar(monkeypatch):
    """Decisão do cliente: comanda não vira dívida. "Saiu sem pagar" é
    desconto de 100% com motivo, e a comanda fecha com total zero."""
    _banco(monkeypatch, bar_tabs=[_comanda()], bar_tab_items=[_item(status="delivered")])
    d = BTS.set_discount(COMANDA, BarTabDiscount(amount=20, reason="saiu sem pagar"), AUTH)
    assert d.tab.total == 0 and d.tab.balance_due == 0
    fechada = BTS.close_tab(COMANDA, BarTabClose(), AUTH)
    assert fechada.status == "closed"


def test_desconto_recusas(monkeypatch):
    _banco(monkeypatch, bar_tabs=[_comanda()], bar_tab_items=[_item()], bar_tab_payments=[_pagamento(amount=15)])
    with pytest.raises(Exception) as exc:
        BTS.set_discount(COMANDA, BarTabDiscount(amount=5, reason=""), AUTH)
    assert recusa(exc)["code"] == "motivo_obrigatorio"
    with pytest.raises(Exception) as exc:
        BTS.set_discount(COMANDA, BarTabDiscount(amount=25, reason="x"), AUTH)
    assert recusa(exc)["code"] == "desconto_acima_do_subtotal"
    with pytest.raises(Exception) as exc:
        BTS.set_discount(COMANDA, BarTabDiscount(amount=10, reason="x"), AUTH)   # ficaria 10, pago 15
    assert recusa(exc)["code"] == "desconto_abaixo_do_pago"


# ══════════════════════════════════════════════════════════════════════
# Fechar / reabrir / cancelar
# ══════════════════════════════════════════════════════════════════════

def test_fechar_exige_saldo_zero(monkeypatch):
    _banco(monkeypatch, bar_tabs=[_comanda()], bar_tab_items=[_item(status="delivered")])
    with pytest.raises(Exception) as exc:
        BTS.close_tab(COMANDA, BarTabClose(), AUTH)
    d = recusa(exc)
    assert d["code"] == "comanda_com_saldo" and d["saldo"] == 20


def test_fechar_com_pendente_so_entregando(monkeypatch):
    fake = _banco(monkeypatch, bar_tabs=[_comanda()], bar_tab_items=[_item()], bar_tab_payments=[_pagamento()])
    with pytest.raises(Exception) as exc:
        BTS.close_tab(COMANDA, BarTabClose(), AUTH)
    d = recusa(exc)
    assert exc.value.status == 409
    assert d["code"] == "comanda_com_pedido_pendente" and d["pendentes"] == 1

    fechada = BTS.close_tab(COMANDA, BarTabClose(deliver_pending=True, notes="ok"), AUTH)
    assert fechada.status == "closed"
    assert fake.store["bar_tab_items"][0]["status"] == "delivered"
    assert fake.store["bar_tabs"][0]["closed_by"] == AUTH


def test_fechar_de_novo_devolve_a_fechada(monkeypatch):
    _banco(monkeypatch, bar_tabs=[_comanda(status="closed")])
    assert BTS.close_tab(COMANDA, BarTabClose(), AUTH).status == "closed"


def test_reabrir_exige_turno_aberto_e_nenhuma_outra_aberta(monkeypatch):
    fake = _banco(monkeypatch, bar_tabs=[_comanda(status="closed"),
                                         _comanda(id="c2", number=2, status="open")])
    with pytest.raises(Exception) as exc:
        BTS.reopen_tab(COMANDA, AUTH)
    d = recusa(exc)
    assert d["code"] == "jogador_com_comanda_aberta" and d["comanda"] == "c2"

    fake.store["bar_tabs"][1]["status"] = "closed"
    assert BTS.reopen_tab(COMANDA, AUTH).status == "open"


def test_cancelar_comanda_com_pagamento_e_recusado(monkeypatch):
    _banco(monkeypatch, bar_tabs=[_comanda()], bar_tab_items=[_item()], bar_tab_payments=[_pagamento()])
    with pytest.raises(Exception) as exc:
        BTS.cancel_tab(COMANDA, "erro", AUTH)
    assert exc.value.status == 409
    assert recusa(exc)["code"] == "comanda_com_pagamento"


def test_cancelar_comanda_cancela_os_itens(monkeypatch):
    fake = _banco(monkeypatch, bar_tabs=[_comanda()], bar_tab_items=[_item(), _item(id="i2", status="delivered")])
    c = BTS.cancel_tab(COMANDA, "mesa errada", AUTH)
    assert c.status == "cancelled"
    assert all(i["status"] == "cancelled" for i in fake.store["bar_tab_items"])
    assert fake.store["bar_tabs"][0]["cancel_reason"] == "mesa errada"


# ══════════════════════════════════════════════════════════════════════
# Listagens
# ══════════════════════════════════════════════════════════════════════

def test_lista_do_turno_vem_recontada_e_com_nome(monkeypatch):
    _banco(monkeypatch, bar_tabs=[_comanda(), _comanda(id="c2", number=2, player_id=OUTRO)],
           bar_tab_items=[_item(), _item(id="i2", tab_id="c2", quantity=3, line_total=30, status="delivered")],
           bar_tab_payments=[_pagamento(tab_id="c2", amount=10)])
    lista = {c.number: c for c in BTS.list_tabs(ORG, TURNO, "open")}
    assert lista[1].player_name == "Ana" and lista[1].balance_due == 20 and lista[1].pending_count == 1
    assert lista[2].player_name == "Bruno" and lista[2].total == 30 and lista[2].paid_amount == 10
    assert lista[2].balance_due == 20 and lista[2].pending_count == 0


def test_pedidos_pendentes_do_turno(monkeypatch):
    _banco(monkeypatch, bar_tabs=[_comanda()], bar_tab_items=[_item(), _item(id="i2", status="delivered")])
    pendentes = BTS.pending_orders(ORG, TURNO)
    assert len(pendentes) == 1
    assert pendentes[0].tab_number == 1 and pendentes[0].player_name == "Ana"
    assert pendentes[0].product_name == "Cerveja" and pendentes[0].quantity == 2
