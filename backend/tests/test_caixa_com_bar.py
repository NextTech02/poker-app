"""O CAIXA DO OPERADOR com movimento de BAR.

Irmão de test_caixa_com_cash.py, e existe pelo mesmo motivo: um tipo que o
relatório não conhece some das colunas em silêncio, e o conferente vê um
esperado que não bate com a soma do que está na tela.

Aqui há um risco a mais, e pior: o ESTORNO de um pagamento de comanda leva
`bar_payment_id` (não `transaction_id` nem `cash_transaction_id`). Se
`_eh_estorno` não o reconhecer, um estorno gravado como `adjustment` vira
"ajuste de FECHAMENTO", é EXCLUÍDO do esperado, e o relatório acusa o barman
de FALTAR o dinheiro que o gerente devolveu. É o mesmo defeito que já fez um
relatório acusar um operador de furto — só que agora com a gaveta do bar.

Terceira decisão travada aqui: a perna paga com CRÉDITO do jogador NÃO passa
pela gaveta. Crédito não é dinheiro na mão do barman; espelhá-lo faria o caixa
acusar SOBRA.
"""
import pytest

from app.services import cashbox_service as caixa_mod
from app.services.cashbox_service import CashboxService as CS, _eh_estorno

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
STAFF = "99999999-9999-9999-9999-999999999999"
TURNO = "b1111111-1111-1111-1111-111111111111"
CAIXA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2"
SESSAO = "cccccccc-cccc-cccc-cccc-ccccccccccc2"


def _mov(tipo, valor, assinado=None, **extra):
    linha = {
        "id": f"m-{tipo}-{valor}-{extra.get('n', 0)}",
        "cashbox_id": CAIXA, "session_id": SESSAO,
        "type": tipo, "amount": abs(valor),
        "signed_amount": valor if assinado is None else assinado,
        "transaction_id": None, "cash_transaction_id": None, "bar_payment_id": None,
        "created_at": "2026-09-16T22:00:00Z",
    }
    linha.update({k: v for k, v in extra.items() if k != "n"})
    return linha


def _banco(monkeypatch, movimentos, saldo, sessao_extra=None):
    sessao = {
        "id": SESSAO, "cashbox_id": CAIXA, "initial_balance": 100,
        "opened_at": "2026-09-16T19:00:00Z", "closed_at": None,
        "expected_final_balance": None, "actual_final_balance": None,
        "difference": None,
    }
    sessao.update(sessao_extra or {})
    fake = FakeSupabase({
        "cashboxes": [{"id": CAIXA, "staff_id": STAFF, "stage_id": None,
                       "cash_day_id": None, "bar_shift_id": TURNO, "status": "open",
                       "current_balance": saldo, "current_session_id": SESSAO,
                       "organization_id": ORG,
                       "created_at": "2026-09-16T19:00:00Z"}],
        "cashbox_sessions": [sessao],
        "cashbox_transactions": movimentos,
        "staff": [{"id": STAFF, "name": "Barman", "auth_user_id": "auth"}],
        "stages": [],
        "cash_days": [],
        "bar_shifts": [{"id": TURNO, "business_date": "2026-09-16", "label": "Noite"}],
    })
    monkeypatch.setattr(caixa_mod, "supabase", fake)
    return fake


# O roteiro do plano (seção H): abre com 100, recebe 20 (PIX) + 15 (dinheiro;
# a perna de crédito de 15 NÃO aparece aqui) + 20 + 20 + 5; estorna 20.
# 100 + 20 + 15 + 20 − 20 + 20 + 5 = 160.
NOITE = [
    _mov("supply", 100, n=0),
    _mov("bar_sale", 20, n=1, bar_payment_id="bp-1"),
    _mov("bar_sale", 15, n=2, bar_payment_id="bp-2"),
    _mov("bar_sale", 20, n=3, bar_payment_id="bp-3"),
    _mov("refund", 20, assinado=-20, n=4, bar_payment_id="bp-3"),
    _mov("bar_sale", 20, n=5, bar_payment_id="bp-4"),
    _mov("bar_sale", 5, n=6, bar_payment_id="bp-5"),
]


# ══════════════════════════════════════════════════════════════════════
# _eh_estorno — a guarda contra a acusação de falta
# ══════════════════════════════════════════════════════════════════════

def test_estorno_do_bar_gravado_como_ajuste_e_reconhecido():
    """Backend antigo (ou o dia do deploy sem a migração): o estorno sai como
    `adjustment` com bar_payment_id. Tratá-lo como ajuste de fechamento o
    excluiria do esperado — esperado alto, operador acusado de FALTA."""
    assert _eh_estorno({"type": "adjustment", "bar_payment_id": "bp-1"}) is True
    assert _eh_estorno({"type": "refund", "bar_payment_id": "bp-1"}) is True


def test_ajuste_de_fechamento_continua_fora():
    assert _eh_estorno({"type": "adjustment", "bar_payment_id": None,
                        "transaction_id": None, "cash_transaction_id": None}) is False


# ══════════════════════════════════════════════════════════════════════
# Sumário do caixa
# ══════════════════════════════════════════════════════════════════════

def test_esperado_bate_com_a_gaveta(monkeypatch):
    _banco(monkeypatch, NOITE, saldo=160)
    s = CS.get_summary(CAIXA)
    assert s.expected_balance == 160
    assert s.current_balance == 160


def test_vendas_do_bar_tem_coluna_propria(monkeypatch):
    """Reusar `buy_in` misturaria a receita do bar com a do torneio em toda
    tela existente, sem forma de separar depois."""
    _banco(monkeypatch, NOITE, saldo=160)
    s = CS.get_summary(CAIXA)
    assert s.total_bar_sales == 80
    assert s.bar_sale_count == 5
    assert s.total_refunds == 20
    assert s.refund_count == 1
    # Nada vazou para torneio nem cash.
    assert s.total_buy_ins == 0 and s.total_cash_buy_ins == 0 and s.total_prizes_paid == 0


def test_caixa_do_turno_mostra_o_rotulo(monkeypatch):
    _banco(monkeypatch, NOITE, saldo=160)
    s = CS.get_summary(CAIXA)
    assert s.bar_shift_id == TURNO
    assert s.bar_shift_label == "Noite"


def test_estorno_como_ajuste_nao_acusa_falta(monkeypatch):
    """O cenário do bug: estorno gravado como `adjustment` com bar_payment_id.
    Tem de continuar no esperado (é saída real), e aparecer como estorno."""
    movimentos = [
        _mov("supply", 100, n=0),
        _mov("bar_sale", 50, n=1, bar_payment_id="bp-9"),
        _mov("adjustment", 50, assinado=-50, n=2, bar_payment_id="bp-9"),
    ]
    _banco(monkeypatch, movimentos, saldo=100)
    s = CS.get_summary(CAIXA)
    assert s.expected_balance == 100          # e não 150
    assert s.total_refunds == 50
    assert s.total_adjustments == 0


def test_bar_e_torneio_na_mesma_gaveta(monkeypatch):
    """Uma gaveta só: somar é correto, confundir não. Cada linha na sua coluna."""
    movimentos = NOITE + [
        _mov("buy_in", 150, n=7),
        _mov("prize", 100, assinado=-100, n=8),
    ]
    _banco(monkeypatch, movimentos, saldo=210)
    s = CS.get_summary(CAIXA)
    assert s.total_bar_sales == 80
    assert s.total_buy_ins == 150
    assert s.total_prizes_paid == 100
    assert s.expected_balance == 210


# ══════════════════════════════════════════════════════════════════════
# Demonstrativo por sessão
# ══════════════════════════════════════════════════════════════════════

def test_demonstrativo_mostra_as_colunas_do_bar(monkeypatch):
    _banco(monkeypatch, NOITE, saldo=160)
    d = CS.get_demonstrativo(bar_shift_id=TURNO)
    assert len(d.sessions) == 1
    linha = d.sessions[0]
    assert linha.total_bar_sales == 80
    assert linha.bar_sale_count == 5
    assert linha.total_refunds == 20
    assert linha.expected_balance == 160
    assert linha.actual_balance == 160
    assert linha.difference == 0
    assert linha.bar_shift_label == "Noite"
    assert d.grand_bar_sales == 80
    assert d.grand_expected == 160


def test_demonstrativo_filtra_pelo_turno_e_ignora_a_etapa(monkeypatch):
    """A etapa selecionada por acaso no header não pode esconder a gaveta do
    turno: a âncora explícita vence."""
    _banco(monkeypatch, NOITE, saldo=160)
    d = CS.get_demonstrativo(stage_id="etapa-qualquer", bar_shift_id=TURNO)
    assert len(d.sessions) == 1


def test_estorno_depois_do_fechamento_fica_a_parte(monkeypatch):
    """A sessão foi contada e assinada; o gerente estornou no dia seguinte. O
    fechamento não muda; a devolução aparece à parte."""
    movimentos = [
        _mov("supply", 100, n=0),
        _mov("bar_sale", 30, n=1, bar_payment_id="bp-7"),
        _mov("refund", 30, assinado=-30, n=2, bar_payment_id="bp-7",
             created_at="2026-09-17T12:00:00Z"),
    ]
    _banco(monkeypatch, movimentos, saldo=130, sessao_extra={
        "closed_at": "2026-09-17T02:00:00Z",
        "expected_final_balance": 130, "actual_final_balance": 130, "difference": 0,
    })
    d = CS.get_demonstrativo(bar_shift_id=TURNO)
    linha = d.sessions[0]
    assert linha.total_bar_sales == 30
    assert linha.total_refunds == 0
    assert linha.total_refunds_after_close == 30
    assert linha.expected_balance == 130
    assert linha.difference == 0


# ══════════════════════════════════════════════════════════════════════
# Terceira âncora
# ══════════════════════════════════════════════════════════════════════

def test_gaveta_do_turno_e_criada_sob_demanda(monkeypatch):
    fake = _banco(monkeypatch, [], saldo=0)
    fake.store["cashboxes"] = []
    fake.store["staff"] = [{"id": STAFF, "name": "Barman", "auth_user_id": "auth-barman"}]
    caixa = CS.get_my_current("auth-barman", bar_shift_id=TURNO)
    assert caixa is not None
    assert caixa.bar_shift_id == TURNO
    assert caixa.stage_id is None and caixa.cash_day_id is None
    assert caixa.status == "closed"
    assert caixa.bar_shift_label == "Noite"


def test_ancora_precisa_ser_exatamente_uma(monkeypatch):
    _banco(monkeypatch, [], saldo=0)
    with pytest.raises(Exception) as exc:
        CS._get_or_create(STAFF, stage_id="e1", bar_shift_id=TURNO)
    assert exc.value.code == "ancora_de_caixa_invalida"
    with pytest.raises(Exception) as exc:
        CS._get_or_create(STAFF)
    assert exc.value.code == "ancora_de_caixa_invalida"


def test_listagem_por_turno_ignora_a_etapa_do_header(monkeypatch):
    fake = _banco(monkeypatch, NOITE, saldo=160)
    fake.store["cashboxes"].append({
        "id": "outra", "staff_id": STAFF, "stage_id": "etapa-x", "cash_day_id": None,
        "bar_shift_id": None, "status": "closed", "current_balance": 0,
        "current_session_id": None, "organization_id": ORG,
        "created_at": "2026-09-16T19:00:00Z",
    })
    fake.store["stages"] = [{"id": "etapa-x", "name": "Etapa X"}]
    monkeypatch.setattr(CS, "can_admin", staticmethod(lambda uid: True))
    lista = CS.list_cashboxes("auth", stage_id="etapa-x", bar_shift_id=TURNO)
    assert [c.id for c in lista] == [CAIXA]
    assert lista[0].bar_shift_label == "Noite"


def test_require_open_cashbox_for_bar_shift(monkeypatch):
    fake = _banco(monkeypatch, NOITE, saldo=160)
    fake.store["staff"] = [{"id": STAFF, "name": "Barman", "auth_user_id": "auth-barman",
                            "permission_groups": {"permissions": ["bar.operate", "cashbox.operate"]}}]
    caixa = CS.require_open_cashbox_for_bar_shift("auth-barman", TURNO)
    assert caixa["id"] == CAIXA

    fake.store["cashboxes"][0]["status"] = "closed"
    with pytest.raises(Exception) as exc:
        CS.require_open_cashbox_for_bar_shift("auth-barman", TURNO)
    assert exc.value.code == "caixa_fechado"
