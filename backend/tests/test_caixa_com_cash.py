"""O CAIXA DO OPERADOR com movimento de cash game.

ESTE ARQUIVO EXISTE POR CAUSA DE UM BUG QUE SERIA GARANTIDO.

`get_summary` monta o `expected_balance` somando campo a campo por tipo, com
if/elif. Um tipo que não casa com nenhum ramo é DESCARTADO EM SILÊNCIO — mas o
trigger de saldo já somou aquele dinheiro em `current_balance`. Resultado no
primeiro dia de cash: esperado menor que o contado, e o relatório acusando
SOBRA de caixa que ninguém consegue explicar.

Não é hipótese: os comentários de `_compute_session_report` registram que um
tipo mal classificado já fez o relatório ACUSAR UM OPERADOR DE FURTO por um
cancelamento feito pelo admin.

O outro ponto: `_compute_session_report` soma `signed_amount`, então o esperado
dele ficaria numericamente certo mesmo sem os ramos novos — mas os valores não
apareceriam em coluna nenhuma. O conferente veria um esperado que não bate com
a soma do que está na tela, que é como um relatório passa a parecer errado sem
estar.

E a terceira decisão que estes testes travam: **rake e jackpot de cash NÃO são
movimento de gaveta**. Eles saem do pote, em fichas, e já estão no caixa como a
diferença entre buy-ins e cash-outs. Lançá-los contaria o mesmo dinheiro duas
vezes.
"""
import pytest

from app.services import cashbox_service as caixa_mod
from app.services.cashbox_service import CashboxService as CS

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
STAFF = "99999999-9999-9999-9999-999999999999"
DIA = "d1111111-1111-1111-1111-111111111111"
CAIXA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1"
SESSAO = "cccccccc-cccc-cccc-cccc-ccccccccccc1"


def _mov(tipo, valor, assinado=None, **extra):
    linha = {
        "id": f"m-{tipo}-{valor}-{extra.get('n', 0)}",
        "cashbox_id": CAIXA, "session_id": SESSAO,
        "type": tipo, "amount": abs(valor),
        "signed_amount": valor if assinado is None else assinado,
        "transaction_id": None, "cash_transaction_id": None,
        "created_at": "2026-09-10T22:00:00Z",
    }
    linha.update({k: v for k, v in extra.items() if k != "n"})
    return linha


def _banco(monkeypatch, movimentos, saldo, sessao_extra=None):
    sessao = {
        "id": SESSAO, "cashbox_id": CAIXA, "initial_balance": 500,
        "opened_at": "2026-09-10T21:00:00Z", "closed_at": None,
        "expected_final_balance": None, "actual_final_balance": None,
        "difference": None,
    }
    sessao.update(sessao_extra or {})
    fake = FakeSupabase({
        "cashboxes": [{"id": CAIXA, "staff_id": STAFF, "stage_id": None,
                       "cash_day_id": DIA, "status": "open",
                       "current_balance": saldo, "current_session_id": SESSAO,
                       "organization_id": ORG,
                       "created_at": "2026-09-10T21:00:00Z"}],
        "cashbox_sessions": [sessao],
        "cashbox_transactions": movimentos,
        "staff": [{"id": STAFF, "name": "Caixa", "auth_user_id": "auth"}],
        "stages": [],
        "cash_days": [{"id": DIA, "business_date": "2026-09-10", "label": None}],
    })
    monkeypatch.setattr(caixa_mod, "supabase", fake)
    return fake


# O roteiro real de uma noite: abre com 500, vende 200 + 300, recompra 100,
# paga 250 de cash-out e 220 de outro.  500 + 600 - 470 = 630.
NOITE = [
    _mov("supply", 500, n=0),
    _mov("cash_buy_in", 200, n=1),
    _mov("cash_buy_in", 300, n=2),
    _mov("cash_buy_in", 100, n=3),
    _mov("cash_out", 250, assinado=-250, n=4),
    _mov("cash_out", 220, assinado=-220, n=5),
]


# ══════════════════════════════════════════════════════════════════════
# Sumário do caixa
# ══════════════════════════════════════════════════════════════════════

# Só a abertura, sem nenhum movimento de cash. Serve de linha de base.
ABERTURA = [_mov("supply", 500, n=0)]


def _esperado(monkeypatch, movimentos, saldo):
    _banco(monkeypatch, movimentos, saldo=saldo)
    return CS.get_summary(CAIXA).expected_balance


def test_esperado_inclui_o_dinheiro_do_cash(monkeypatch):
    """Mede a CONTRIBUIÇÃO do cash ao esperado, e não o valor absoluto.

    O absoluto embutiria uma convenção pré-existente desta função (ela soma o
    saldo de abertura duas vezes — uma como `initial_balance`, outra como o
    `supply` do ledger), que é assunto do torneio e não deste trabalho.

    O que precisa ser verdade: 600 entraram e 470 saíram pelo cash, então o
    esperado tem de subir exatamente 130. SEM os ramos de cash_buy_in/cash_out
    esta diferença seria ZERO e o relatório acusaria sobra de caixa.
    """
    base = _esperado(monkeypatch, ABERTURA, saldo=500)
    com_cash = _esperado(monkeypatch, NOITE, saldo=630)
    assert com_cash - base == 130


def test_separa_o_cash_do_torneio(monkeypatch):
    """Colunas próprias: reusar `buy_in`/`prize` misturaria as duas receitas em
    toda tela existente, sem forma de separar depois."""
    _banco(monkeypatch, NOITE, saldo=630)
    s = CS.get_summary(CAIXA)
    assert s.total_cash_buy_ins == 600
    assert s.cash_buy_in_count == 3
    assert s.total_cash_outs == 470
    assert s.cash_out_count == 2
    # Nada vazou para os contadores de torneio.
    assert s.total_buy_ins == 0 and s.total_prizes_paid == 0


def test_caixa_do_dia_mostra_a_data(monkeypatch):
    _banco(monkeypatch, NOITE, saldo=630)
    s = CS.get_summary(CAIXA)
    assert s.cash_day_id == DIA
    assert s.cash_day_label == "2026-09-10"


def test_rake_nao_entra_na_gaveta(monkeypatch):
    """O rake sai do POTE, em fichas. Ele já está na gaveta como a diferença
    entre o que entrou e o que saiu — um movimento a mais o contaria duas vezes
    e o caixa passaria a acusar falta todo dia."""
    _banco(monkeypatch, NOITE, saldo=630)
    s = CS.get_summary(CAIXA)
    # 600 - 470 = 130, que é exatamente o rake apurado na mesa daquela noite.
    assert s.total_cash_buy_ins - s.total_cash_outs == 130
    assert s.current_balance == 630


def test_estorno_de_cash_desce_do_esperado(monkeypatch):
    """A venda cancelada continua no ledger (que é append-only) e o dinheiro já
    voltou para o jogador: o estorno tem de DESCER do esperado."""
    movimentos = NOITE + [
        _mov("refund", 200, assinado=-200, n=6, cash_transaction_id="ct-1"),
    ]
    com_estorno = _esperado(monkeypatch, movimentos, saldo=430)
    sem_estorno = _esperado(monkeypatch, NOITE, saldo=630)
    assert sem_estorno - com_estorno == 200

    _banco(monkeypatch, movimentos, saldo=430)
    assert CS.get_summary(CAIXA).total_refunds == 200


def test_torneio_e_cash_na_mesma_gaveta(monkeypatch):
    """É UMA gaveta só — financeiramente correto somar os dois. O que não pode
    é os números se confundirem: cada linha na sua coluna."""
    movimentos = NOITE + [
        _mov("buy_in", 150, n=7),
        _mov("prize", 100, assinado=-100, n=8),
    ]
    _banco(monkeypatch, movimentos, saldo=680)
    s = CS.get_summary(CAIXA)
    assert s.total_buy_ins == 150
    assert s.total_prizes_paid == 100
    assert s.total_cash_buy_ins == 600
    assert s.total_cash_outs == 470

    so_cash = _esperado(monkeypatch, NOITE, saldo=630)
    com_torneio = _esperado(monkeypatch, movimentos, saldo=680)
    assert com_torneio - so_cash == 50   # +150 de entrada, -100 de prêmio


# ══════════════════════════════════════════════════════════════════════
# Demonstrativo por sessão
# ══════════════════════════════════════════════════════════════════════

def test_demonstrativo_mostra_as_colunas_de_cash(monkeypatch):
    """O esperado já ficaria certo (a conta soma signed_amount), mas sem estas
    colunas o conferente veria um esperado que não bate com a soma do que está
    na tela."""
    _banco(monkeypatch, NOITE, saldo=630)
    d = CS.get_demonstrativo(cash_day_id=DIA)
    assert len(d.sessions) == 1
    linha = d.sessions[0]
    assert linha.total_cash_buy_ins == 600
    assert linha.cash_buy_in_count == 3
    assert linha.total_cash_outs == 470
    assert linha.cash_out_count == 2
    assert linha.expected_balance == 630
    assert linha.actual_balance == 630
    assert linha.difference == 0
    assert linha.cash_day_label == "2026-09-10"


def test_demonstrativo_soma_os_totais_de_cash(monkeypatch):
    _banco(monkeypatch, NOITE, saldo=630)
    d = CS.get_demonstrativo(cash_day_id=DIA)
    assert d.grand_cash_buy_ins == 600
    assert d.grand_cash_outs == 470
    assert d.grand_expected == 630


def test_diferenca_de_contagem_aparece_como_diferenca(monkeypatch):
    """O caso que o relatório precisa acertar: a gaveta tem R$ 20 a menos que o
    esperado. Isso é diferença de contagem — não pode virar 'sobra' por um tipo
    que o cálculo ignorou."""
    _banco(monkeypatch, NOITE, saldo=610)
    d = CS.get_demonstrativo(cash_day_id=DIA)
    linha = d.sessions[0]
    assert linha.expected_balance == 630
    assert linha.actual_balance == 610
    assert linha.difference == -20


def test_sessao_fechada_mantem_o_numero_conferido(monkeypatch):
    """Resultado congelado: o operador contou, assinou e foi embora. Recalcular
    daria um esperado que não bate com a diferença gravada."""
    _banco(monkeypatch, NOITE, saldo=630, sessao_extra={
        "closed_at": "2026-09-11T04:00:00Z",
        "expected_final_balance": 630,
        "actual_final_balance": 625,
        "difference": -5,
    })
    d = CS.get_demonstrativo(cash_day_id=DIA)
    linha = d.sessions[0]
    assert linha.is_open is False
    assert linha.expected_balance == 630
    assert linha.actual_balance == 625
    assert linha.difference == -5
