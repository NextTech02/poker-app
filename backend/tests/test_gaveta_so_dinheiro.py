"""O esperado da gaveta do operador é DINHEIRO VIVO.

O trigger espelha na gaveta a venda inteira, seja qual for o meio, e o
esperado somava cartão e PIX: quem conta só as notas fechava a noite com
"falta". Trava:

1. Venda por cartão, PIX ou meio do clube (Yape...) sai do esperado e aparece
   à parte, por meio.
2. Venda dividida conta só a parte em dinheiro.
3. Estorno de venda no cartão não tira nota da gaveta.
4. O fechamento confere o contado contra o dinheiro vivo.
5. Linha sem meio (antiga) conta como dinheiro.
6. Cash game segue o meio: sentar por Yape não põe nota na gaveta, e levantar
   por transferência não tira.
7. Crédito de patrocinador não põe nota na gaveta; na venda mista, só a parte
   paga em dinheiro conta.
"""
from app.services import cashbox_service as caixa_mod
from app.services.cashbox_service import CashboxService as CS

from tests.conftest import FakeSupabase

STAFF = "99999999-9999-9999-9999-999999999999"
CAIXA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3"
SESSAO = "cccccccc-cccc-cccc-cccc-ccccccccccc3"
ETAPA = "11111111-1111-1111-1111-111111111111"


def _mov(n, tipo, assinado, **extra):
    linha = {"id": f"m{n}", "cashbox_id": CAIXA, "session_id": SESSAO, "type": tipo,
             "amount": abs(assinado), "signed_amount": assinado,
             "transaction_id": None, "cash_transaction_id": None, "bar_payment_id": None,
             "house_credit_entry_id": None, "created_at": "2026-11-10T22:00:00Z"}
    linha.update(extra)
    return linha


# Abre com 100; vende 200 em dinheiro, 300 no cartão, 150 por Yape, uma venda
# dividida de 500 (200 em dinheiro + 300 no PIX), uma antiga sem meio de 50 e
# uma de cash game de 80; estorna a do cartão. Dinheiro: 100+200+200+50+80 = 630.
MOVIMENTOS = [
    _mov(0, "supply", 100),
    _mov(1, "buy_in", 200, transaction_id="t-dinheiro"),
    _mov(2, "buy_in", 300, transaction_id="t-cartao"),
    _mov(3, "rebuy", 150, transaction_id="t-yape"),
    _mov(4, "addon", 500, transaction_id="t-dividida"),
    _mov(5, "buy_in", 50, transaction_id="t-antiga"),
    _mov(6, "cash_buy_in", 80, cash_transaction_id="ct-1"),
    _mov(7, "refund", -300, transaction_id="t-cartao"),
]
VENDAS = [
    {"id": "t-dinheiro", "amount": 200, "payment_method": "cash", "payment_split": None},
    {"id": "t-cartao", "amount": 300, "payment_method": "card", "payment_split": None},
    {"id": "t-yape", "amount": 150, "payment_method": "yape", "payment_split": None},
    {"id": "t-dividida", "amount": 500, "payment_method": "split",
     "payment_split": [{"payment_method": "cash", "amount": 200},
                       {"payment_method": "pix", "amount": 300}]},
    {"id": "t-antiga", "amount": 50, "payment_method": None, "payment_split": None},
]
SALDO_DO_RAZAO = 100 + 200 + 300 + 150 + 500 + 50 + 80 - 300   # 1080


def _banco(monkeypatch):
    fake = FakeSupabase({
        "cashboxes": [{"id": CAIXA, "staff_id": STAFF, "stage_id": ETAPA, "cash_day_id": None,
                       "bar_shift_id": None, "status": "open", "current_balance": SALDO_DO_RAZAO,
                       "current_session_id": SESSAO, "created_at": "2026-11-10T19:00:00Z"}],
        "cashbox_sessions": [{"id": SESSAO, "cashbox_id": CAIXA, "initial_balance": 100,
                              "opened_at": "2026-11-10T19:00:00Z", "closed_at": None,
                              "expected_final_balance": None, "actual_final_balance": None,
                              "difference": None, "created_at": "2026-11-10T19:00:00Z"}],
        "cashbox_transactions": [dict(m) for m in MOVIMENTOS],
        "transactions": VENDAS,
        "staff": [{"id": STAFF, "name": "Operador", "auth_user_id": "auth"}],
        "stages": [{"id": ETAPA, "name": "Etapa"}],
    })
    monkeypatch.setattr(caixa_mod, "supabase", fake)
    monkeypatch.setattr(CS, "can_admin", staticmethod(lambda uid: True))
    monkeypatch.setattr(CS, "get_staff_id_for_user", staticmethod(lambda uid: STAFF))
    return fake


def test_esperado_conta_so_o_dinheiro_e_mostra_os_outros_meios(monkeypatch):
    _banco(monkeypatch)
    s = CS.get_summary(CAIXA)
    assert s.expected_balance == 630
    assert {m.method: m.amount for m in s.non_cash} == {"pix": 300, "yape": 150}


def test_a_gaveta_aberta_traz_o_dinheiro_vivo(monkeypatch):
    _banco(monkeypatch)
    caixa = CS.get_cashbox(CAIXA)
    assert caixa.current_balance == SALDO_DO_RAZAO
    assert caixa.cash_balance == 630


def test_fechar_contando_so_as_notas_nao_da_falta(monkeypatch):
    fake = _banco(monkeypatch)
    sessao = CS.close_session(CAIXA, "auth", 630, None)
    assert sessao.expected_final_balance == 630
    assert sessao.difference == 0
    assert not [m for m in fake.store["cashbox_transactions"] if m["type"] == "adjustment"]


def test_demonstrativo_da_sessao_aberta_fecha_no_dinheiro(monkeypatch):
    _banco(monkeypatch)
    linha = CS._compute_session_report(
        {"id": SESSAO, "cashbox_id": CAIXA, "initial_balance": 100,
         "opened_at": "2026-11-10T19:00:00Z", "closed_at": None},
        {"current_balance": SALDO_DO_RAZAO},
        MOVIMENTOS,
        fora=caixa_mod._fora_da_gaveta(MOVIMENTOS),
    )
    assert linha.expected_balance == 630
    assert linha.actual_balance == 630 and linha.difference == 0
    assert {m.method: m.amount for m in linha.non_cash} == {"pix": 300, "yape": 150}


def test_sem_o_meio_da_venda_tudo_conta_como_dinheiro(monkeypatch):
    """Banco que não devolve a venda (ou linha antiga): fica como sempre foi."""
    fake = _banco(monkeypatch)
    fake.store["transactions"] = []
    assert CS.get_summary(CAIXA).expected_balance == SALDO_DO_RAZAO


# ── Cash game ───────────────────────────────────────────────────────────────
# Abre com 100. Senta 400 em dinheiro + 600 por transferência, recompra 300 por
# Yape, uma antiga de 80 sem meio, levanta 200 em dinheiro e 250 por Yape.
# Dinheiro: 100 + 400 + 80 - 200 = 380. Razão: 100+1000+300+80-200-250 = 1030.
MOV_CASH = [
    _mov(0, "supply", 100),
    _mov(1, "cash_buy_in", 1000, cash_transaction_id="c-dividida"),
    _mov(2, "cash_buy_in", 300, cash_transaction_id="c-yape"),
    _mov(3, "cash_buy_in", 80, cash_transaction_id="c-antiga"),
    _mov(4, "cash_out", -200, cash_transaction_id="c-saida"),
    _mov(5, "cash_out", -250, cash_transaction_id="c-saida-yape"),
]
VENDAS_CASH = [
    {"id": "c-dividida", "amount": 1000, "payment_method": "split",
     "payment_split": [{"payment_method": "cash", "amount": 400}, {"payment_method": "transfer", "amount": 600}]},
    {"id": "c-yape", "amount": 300, "payment_method": "yape", "payment_split": None},
    {"id": "c-antiga", "amount": 80, "payment_method": None, "payment_split": None},
    {"id": "c-saida", "amount": 200, "payment_method": "cash", "payment_split": None},
    {"id": "c-saida-yape", "amount": 250, "payment_method": "yape", "payment_split": None},
]


def _gaveta_de_cash(monkeypatch):
    fake = _banco(monkeypatch)
    fake.store["cashbox_transactions"] = [dict(m) for m in MOV_CASH]
    fake.store["cash_transactions"] = [dict(v) for v in VENDAS_CASH]
    fake.store["cashboxes"][0]["current_balance"] = 1030
    return fake


def test_cash_game_conta_so_o_dinheiro(monkeypatch):
    _gaveta_de_cash(monkeypatch)
    s = CS.get_summary(CAIXA)
    assert s.expected_balance == 380
    assert {m.method: m.amount for m in s.non_cash} == {"transfer": 600, "yape": 50}
    assert CS.get_cashbox(CAIXA).cash_balance == 380


def test_fechar_a_gaveta_do_cash_contando_as_notas_nao_da_falta(monkeypatch):
    fake = _gaveta_de_cash(monkeypatch)
    sessao = CS.close_session(CAIXA, "auth", 380, None)
    assert sessao.expected_final_balance == 380 and sessao.difference == 0
    assert not [m for m in fake.store["cashbox_transactions"] if m["type"] == "adjustment"]


def test_abatimento_de_fiado_no_cash_out_segue_o_meio(monkeypatch):
    """Levantou 500 por Yape e 200 quitaram o fiado: o razão só tem os 300."""
    fake = _banco(monkeypatch)
    fake.store["cashbox_transactions"] = [_mov(0, "supply", 1000), _mov(1, "cash_out", -300, cash_transaction_id="c1")]
    fake.store["cash_transactions"] = [{"id": "c1", "amount": 500, "payment_method": "yape", "payment_split": None}]
    fake.store["cashboxes"][0]["current_balance"] = 700
    assert CS.get_cashbox(CAIXA).cash_balance == 1000


# ── Crédito de patrocinador ─────────────────────────────────────────────────
def _venda_com_credito(id_, valor, origem, quando, metodo="cash", tipo="buy_in", torneio="T1"):
    return {"id": id_, "amount": valor, "payment_method": metodo, "payment_split": None, "payment_source": origem,
            "player_id": "p1", "tournament_id": torneio, "type": tipo, "created_at": quando}


def _consumo(id_, valor, quando, tipo="credit_used_buyin", torneio="T1"):
    return {"id": id_, "player_id": "p1", "tournament_id": torneio, "type": tipo, "amount": valor, "created_at": quando}


def _gaveta_com_credito(monkeypatch, vendas, consumos):
    fake = _banco(monkeypatch)
    fake.store["cashbox_transactions"] = [
        _mov(0, "supply", 100),
        *[_mov(i + 1, v["type"], v["amount"], transaction_id=v["id"]) for i, v in enumerate(vendas)],
    ]
    fake.store["transactions"] = vendas
    fake.store["credit_transactions"] = consumos
    fake.store["cashboxes"][0]["current_balance"] = 100 + sum(v["amount"] for v in vendas)
    return fake


def test_venda_so_com_credito_nao_poe_nota_na_gaveta(monkeypatch):
    _gaveta_com_credito(monkeypatch, [_venda_com_credito("v1", 500, "credit", "2026-11-10T22:00:05Z")], [])
    s = CS.get_summary(CAIXA)
    assert s.expected_balance == 100
    assert {m.method: m.amount for m in s.non_cash} == {"credit": 500}


def test_venda_mista_conta_so_o_que_foi_pago_em_dinheiro(monkeypatch):
    _gaveta_com_credito(
        monkeypatch, [_venda_com_credito("v1", 500, "mixed", "2026-11-10T22:00:05Z")],
        # Dois créditos diferentes, na mesma venda.
        [_consumo("c1", 200, "2026-11-10T22:00:03Z"), _consumo("c2", 100, "2026-11-10T22:00:04Z")],
    )
    s = CS.get_summary(CAIXA)
    assert s.expected_balance == 300
    assert {m.method: m.amount for m in s.non_cash} == {"credit": 300}


def test_mista_com_o_resto_no_yape_nao_poe_nota(monkeypatch):
    _gaveta_com_credito(
        monkeypatch, [_venda_com_credito("v1", 500, "mixed", "2026-11-10T22:00:05Z", metodo="yape")],
        [_consumo("c1", 300, "2026-11-10T22:00:03Z")],
    )
    assert CS.get_summary(CAIXA).expected_balance == 100


def test_cada_mista_fica_com_o_credito_dela(monkeypatch):
    """Entrada só com crédito e depois duas reentradas mistas: o consumo de uma
    não entra na outra, nem o de outro torneio."""
    vendas = [
        _venda_com_credito("r1", 300, "mixed", "2026-11-10T22:00:05Z", tipo="rebuy"),
        _venda_com_credito("r2", 300, "mixed", "2026-11-10T22:10:05Z", tipo="rebuy"),
    ]
    _gaveta_com_credito(monkeypatch, vendas, [
        _consumo("a", 250, "2026-11-10T22:00:04Z", "credit_used_rebuy"),
        _consumo("b", 100, "2026-11-10T22:10:04Z", "credit_used_rebuy"),
        _consumo("x", 999, "2026-11-10T22:10:03Z", "credit_used_rebuy", torneio="T2"),
        _consumo("y", 999, "2026-11-10T22:10:03Z", "credit_used_buyin"),
    ])
    s = CS.get_summary(CAIXA)
    assert {m.method: m.amount for m in s.non_cash} == {"credit": 350}
    assert s.expected_balance == 100 + 50 + 200


def test_sem_ler_o_credito_a_mista_conta_inteira(monkeypatch):
    """Falha de leitura não pode travar o fechamento: fica como sempre foi."""
    _gaveta_com_credito(monkeypatch, [_venda_com_credito("v1", 500, "mixed", "2026-11-10T22:00:05Z")], [])
    assert CS.get_summary(CAIXA).expected_balance == 600
