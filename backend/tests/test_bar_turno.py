"""O TURNO do bar: abrir, medir e fechar.

Duas regras que parecem burocracia e não são:

1. **Um turno aberto por vez.** Dois turnos abertos são dois fechamentos
   parciais e nenhum que feche. O banco tem o índice parcial; aqui a recusa
   vem com nome e com o turno que está aberto.

2. **Não fecha com comanda aberta nem com gaveta aberta.** Comanda não vira
   dívida (decisão do cliente): quita, ganha desconto ou é cancelada — antes
   de o turno fechar. E a gaveta ancorada no turno também, porque o turno é a
   unidade de conferência; uma sessão de caixa eternamente aberta sobraria no
   demonstrativo.

E uma DIFERENÇA deliberada para o dia de cash: o bar pode ter dois turnos na
mesma data (tarde e noite). Não há UNIQUE (org, data).
"""
import pytest

from app.models.bar import BarShiftCreate
from app.services import bar_shift_service as turno_mod
from app.services import bar_product_service as prod_mod
from app.services.bar_shift_service import BarShiftService as BSS

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
AUTH = "auth-barman"
TURNO = "b1111111-1111-1111-1111-111111111111"
JOGADOR = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"


def _turno(**extra):
    linha = {"id": TURNO, "organization_id": ORG, "status": "open",
             "business_date": "2026-09-16", "opened_at": "2026-09-16T19:00:00Z",
             "last_tab_number": 0}
    linha.update(extra)
    return linha


def _comanda(**extra):
    linha = {"id": "c1", "organization_id": ORG, "bar_shift_id": TURNO, "player_id": JOGADOR,
             "number": 1, "status": "open", "subtotal": 50, "courtesy_amount": 0,
             "discount_amount": 0, "total": 50, "paid_amount": 20,
             "opened_at": "2026-09-16T20:00:00Z"}
    linha.update(extra)
    return linha


def _banco(monkeypatch, **tabelas):
    base = {
        "bar_shifts": [_turno()],
        "bar_tabs": [],
        "bar_tab_items": [],
        "bar_tab_payments": [],
        "bar_products": [],
        "bar_product_categories": [],
        "cashboxes": [],
        "staff": [],
        "players": [{"id": JOGADOR, "name": "Ana"}],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    for mod in (turno_mod, prod_mod):
        monkeypatch.setattr(mod, "supabase", fake)
    return fake


def recusa(exc):
    return exc.value.como_http().detail


# ══════════════════════════════════════════════════════════════════════
# Abrir
# ══════════════════════════════════════════════════════════════════════

def test_abre_o_turno_com_a_data_escolhida(monkeypatch):
    _banco(monkeypatch, bar_shifts=[])
    t = BSS.open_shift(BarShiftCreate(business_date="2026-09-16", label="Noite"), AUTH, ORG)
    assert str(t.business_date) == "2026-09-16"
    assert t.status == "open"
    assert t.label == "Noite"


def test_segundo_turno_aberto_e_recusado_com_o_aberto_no_dado(monkeypatch):
    _banco(monkeypatch)
    with pytest.raises(Exception) as exc:
        BSS.open_shift(BarShiftCreate(business_date="2026-09-17"), AUTH, ORG)
    d = recusa(exc)
    assert exc.value.status == 409
    assert d["code"] == "turno_ja_aberto"
    assert d["bar_shift_id"] == TURNO
    assert d["business_date"] == "2026-09-16"


def test_dois_turnos_na_mesma_data_sao_permitidos(monkeypatch):
    """Tarde e noite. O que é único é o turno ABERTO, não a data."""
    _banco(monkeypatch, bar_shifts=[_turno(status="closed")])
    t = BSS.open_shift(BarShiftCreate(business_date="2026-09-16"), AUTH, ORG)
    assert t.status == "open"


def test_turno_corrente(monkeypatch):
    _banco(monkeypatch)
    assert BSS.get_current(ORG).id == TURNO
    _banco(monkeypatch, bar_shifts=[_turno(status="closed")])
    assert BSS.get_current(ORG) is None


# ══════════════════════════════════════════════════════════════════════
# Medir
# ══════════════════════════════════════════════════════════════════════

def test_resumo_ao_vivo_conta_o_que_importa(monkeypatch):
    _banco(
        monkeypatch,
        bar_tabs=[
            _comanda(),
            _comanda(id="c2", number=2, status="closed", subtotal=30, discount_amount=5,
                     total=25, paid_amount=25),
            _comanda(id="c3", number=3, status="cancelled", subtotal=99, total=99, paid_amount=0),
        ],
        bar_tab_items=[
            {"id": "i1", "bar_shift_id": TURNO, "tab_id": "c1", "status": "delivered",
             "quantity": 2, "unit_cost": 4},
            {"id": "i2", "bar_shift_id": TURNO, "tab_id": "c1", "status": "pending",
             "quantity": 1, "unit_cost": 12},
            {"id": "i3", "bar_shift_id": TURNO, "tab_id": "c3", "status": "cancelled",
             "quantity": 9, "unit_cost": 9},
        ],
        bar_tab_payments=[
            {"id": "p1", "bar_shift_id": TURNO, "tab_id": "c1", "amount": 20,
             "payment_method": "pix", "payment_source": "cash", "status": "active"},
            {"id": "p2", "bar_shift_id": TURNO, "tab_id": "c2", "amount": 15,
             "payment_method": "credit", "payment_source": "credit", "status": "active"},
            {"id": "p3", "bar_shift_id": TURNO, "tab_id": "c2", "amount": 10,
             "payment_method": "cash", "payment_source": "cash", "status": "active"},
            {"id": "p4", "bar_shift_id": TURNO, "tab_id": "c2", "amount": 7,
             "payment_method": "cash", "payment_source": "cash", "status": "cancelled"},
        ],
    )
    s = BSS.summary(TURNO)
    assert s.total_gross == 80            # 50 + 30 (a cancelada fica de fora)
    assert s.total_discounts == 5
    assert s.total_net == 75
    assert s.total_paid == 45             # 20 + 25
    assert s.total_paid_cash == 30        # pix 20 + dinheiro 10 (o cancelado não)
    assert s.total_paid_credit == 15
    assert s.total_cogs == 20             # 2×4 + 1×12 (o cancelado não)
    assert s.gross_margin == 55
    assert s.tabs_open == 1 and s.tabs_total == 2
    assert s.items_pending == 1 and s.items_count == 2
    assert s.balance_due == 30            # 50 − 20 da comanda aberta
    assert {m.payment_method: m.amount for m in s.by_method} == {"pix": 20, "credit": 15, "cash": 10}


def test_resumo_de_turno_fechado_e_o_congelado(monkeypatch):
    """Foi contra o congelado que a conferência foi feita; recalcular daria um
    número que não bate com o que ficou assinado."""
    _banco(monkeypatch, bar_shifts=[_turno(status="closed", total_net=75, total_paid=75,
                                           total_gross=80, total_discounts=5, total_cogs=31,
                                           tabs_count=4, items_count=7,
                                           totals_by_method={"pix": {"amount": 20, "count": 1}})],
           bar_tabs=[_comanda()])   # uma comanda "esquecida" não muda o congelado
    s = BSS.summary(TURNO)
    assert s.total_net == 75 and s.total_cogs == 31 and s.gross_margin == 44
    assert s.tabs_total == 4 and s.tabs_open == 0
    assert s.by_method[0].payment_method == "pix" and s.by_method[0].amount == 20


# ══════════════════════════════════════════════════════════════════════
# Fechar
# ══════════════════════════════════════════════════════════════════════

def test_fechar_com_comanda_aberta_lista_as_comandas(monkeypatch):
    _banco(monkeypatch, bar_tabs=[_comanda(), _comanda(id="c2", number=2, status="closed")])
    with pytest.raises(Exception) as exc:
        BSS.close_shift(TURNO, AUTH)
    d = recusa(exc)
    assert exc.value.status == 409
    assert d["code"] == "turno_com_comanda_aberta"
    assert d["quantidade"] == 1
    assert d["comandas"][0]["number"] == 1
    assert d["comandas"][0]["player_name"] == "Ana"
    assert d["comandas"][0]["balance_due"] == 30


def test_fechar_com_gaveta_aberta_e_recusado(monkeypatch):
    _banco(monkeypatch,
           cashboxes=[{"id": "cb1", "staff_id": "s1", "bar_shift_id": TURNO, "status": "open"}],
           staff=[{"id": "s1", "name": "Barman"}])
    with pytest.raises(Exception) as exc:
        BSS.close_shift(TURNO, AUTH)
    d = recusa(exc)
    assert d["code"] == "turno_com_caixa_aberto"
    assert d["caixas"] == ["Barman"]


def test_fechar_congela_os_totais(monkeypatch):
    fake = _banco(
        monkeypatch,
        bar_tabs=[_comanda(status="closed", paid_amount=50)],
        bar_tab_items=[{"id": "i1", "bar_shift_id": TURNO, "tab_id": "c1", "status": "delivered",
                        "quantity": 5, "unit_cost": 4}],
        bar_tab_payments=[{"id": "p1", "bar_shift_id": TURNO, "tab_id": "c1", "amount": 50,
                           "payment_method": "card", "payment_source": "cash", "status": "active"}],
        cashboxes=[{"id": "cb1", "staff_id": "s1", "bar_shift_id": TURNO, "status": "closed"}],
    )
    t = BSS.close_shift(TURNO, AUTH, notes="tudo certo")
    assert t.status == "closed"
    assert t.total_net == 50 and t.total_paid == 50 and t.total_paid_cash == 50
    assert t.total_cogs == 20 and t.tabs_count == 1 and t.items_count == 1
    assert t.totals_by_method == {"card": {"amount": 50, "count": 1}}
    assert t.notes == "tudo certo"
    assert fake.store["bar_shifts"][0]["closed_by"] == AUTH


def test_fechar_duas_vezes_e_recusado(monkeypatch):
    _banco(monkeypatch, bar_shifts=[_turno(status="closed")])
    with pytest.raises(Exception) as exc:
        BSS.close_shift(TURNO, AUTH)
    assert recusa(exc)["code"] == "turno_ja_fechado"


def test_turno_inexistente_e_404(monkeypatch):
    _banco(monkeypatch, bar_shifts=[])
    with pytest.raises(Exception) as exc:
        BSS.get_shift("nao-existe")
    assert exc.value.status == 404
    assert recusa(exc)["code"] == "turno_nao_encontrado"


def test_guarda_de_turno_aberto(monkeypatch):
    _banco(monkeypatch, bar_shifts=[_turno(status="closed")])
    with pytest.raises(Exception) as exc:
        BSS.require_open_shift(TURNO)
    assert recusa(exc)["code"] == "turno_nao_aberto"
    with pytest.raises(Exception) as exc:
        BSS.require_current_open(ORG)
    assert recusa(exc)["code"] == "turno_nao_aberto"
