"""FIADO DA CASA — o que o Python garante.

As regras de dinheiro (limite à prova de corrida, abatimento, estorno, espelho
na gaveta, portas de entrada do razão) moram nos triggers e são testadas num
Postgres de verdade: db/tests/fiado. O FakeSupabase não executa trigger.

Aqui ficam travados:
1. **Recusa com nome antes de tocar em nada**: sem conta, acima do limite ou
   com fiado vencido, a venda não toma a cadeira.
2. **Venda fiada não tem gaveta nem meio de pagamento.**
3. **Cash-out de quem deve exige o abatimento EXPLÍCITO** (inclusive 0): uma
   tela antiga não pode pagar X enquanto a gaveta só moveria X − dívida.
4. **Abater menos que o proposto exige motivo**; mais do que o possível, recusa.
5. **A gaveta é conferida contra o LÍQUIDO.**
6. **Sem dívida, o cash-out não manda coluna nova** (deploy antes da migração).
7. **O retry do levantar fecha a sessão** se a resposta se perdeu no meio.
8. **Recusa do banco vira recusa com código e números.**
9. **Recebimento exige gaveta aberta; baixa vai pelo service role, com motivo.**
10. **A gaveta, o dia e o DRE enxergam o fiado** sem perder um tipo no if/elif.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models.cash_game import CashRebuy, SitPlayer, StandPlayer
from app.models.house_credit import HouseCreditAccountUpdate, HouseCreditPaymentCreate
from app.services import cash_day_service as dia_mod
from app.services import cash_table_service as mesa_mod
from app.services import cash_transaction_service as tx_mod
from app.services import cashbox_service as caixa_mod
from app.services import house_credit_service as fiado_mod
from app.services.cash_day_service import CashDayService
from app.services.cash_transaction_service import CashTransactionService as CTS
from app.services.cashbox_service import CashboxService
from app.services.house_credit_service import (
    HouseCreditService as HCS,
    mais_antiga_em_aberto,
    recusa_do_banco,
)
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
AUTH = "88888888-8888-8888-8888-888888888888"
STAFF = "99999999-9999-9999-9999-999999999999"
DIA = "d1111111-1111-1111-1111-111111111111"
MESA = "1a111111-1111-1111-1111-111111111111"
CAIXA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1"
JOGADOR = "44444444-4444-4444-4444-444444444444"
CONTA = "c0000000-0000-0000-0000-000000000001"


def recusa(exc):
    return exc.value.como_http().detail


def _ha(dias: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=dias)).isoformat()


def _conta(balance=0, limit=500, enabled=True):
    return {"id": CONTA, "organization_id": ORG, "player_id": JOGADOR, "enabled": enabled,
            "credit_limit": limit, "balance": balance, "open_since": None, "notes": None,
            "updated_at": _ha(0)}


def _carga(valor, dias=0, id_="e1"):
    return {"id": id_, "organization_id": ORG, "account_id": CONTA, "player_id": JOGADOR,
            "type": "charge", "amount": valor, "signed_amount": valor, "balance_after": valor,
            "module": "cash", "created_at": _ha(dias)}


def _assentos():
    return [
        {"id": f"a{n}", "organization_id": ORG, "table_id": MESA, "seat_number": n,
         "status": "free", "player_session_id": None, "reserved_for": None,
         "reserved_until": None, "updated_at": _ha(0)}
        for n in range(1, 10)
    ]


def _sessao(**extra):
    linha = {"id": "s1", "organization_id": ORG, "cash_day_id": DIA, "table_id": MESA,
             "player_id": JOGADOR, "seat_number": 3, "status": "active",
             "started_at": _ha(0), "total_buy_in": 500, "total_cash_out": 0, "result": 0}
    linha.update(extra)
    return linha


def _banco(monkeypatch, saldo_gaveta=1000, **tabelas):
    base = {
        "cash_days": [{"id": DIA, "organization_id": ORG, "status": "open",
                       "business_date": "2026-10-22", "opened_at": _ha(0)}],
        "cash_tables": [{"id": MESA, "organization_id": ORG, "cash_day_id": DIA,
                         "table_number": 1, "seats": 9, "game_variant": "nlh",
                         "small_blind": 1, "big_blind": 2, "ante": 0, "min_buy_in": 100,
                         "max_buy_in": 1000, "rake_percent": 5, "rake_cap": 10,
                         "jackpot_per_pot": 0, "status": "open", "opened_at": _ha(0)}],
        "cash_seats": _assentos(),
        "cash_player_sessions": [],
        "cash_transactions": [],
        "cash_rake_entries": [],
        "players": [{"id": JOGADOR, "name": "Ana", "nickname": None, "phone": "+5511999"}],
        "staff": [{"id": STAFF, "auth_user_id": AUTH, "name": "Caixa", "active": True,
                   "permission_groups": {"permissions": ["cash.operate", "cashbox.operate"]}}],
        "cashboxes": [{"id": CAIXA, "staff_id": STAFF, "cash_day_id": DIA, "stage_id": None,
                       "bar_shift_id": None, "status": "open", "current_balance": saldo_gaveta,
                       "current_session_id": "cs1", "organization_id": ORG,
                       "created_at": _ha(0)}],
        "cashbox_transactions": [],
        "cashbox_sessions": [{"id": "cs1", "cashbox_id": CAIXA, "initial_balance": saldo_gaveta,
                              "opened_at": _ha(0)}],
        "house_credit_accounts": [],
        "house_credit_entries": [],
        "house_credit_settings": [],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    for mod in (tx_mod, mesa_mod, dia_mod, caixa_mod, fiado_mod):
        monkeypatch.setattr(mod, "supabase", fake)
    # Pelo service role também: o fake é um banco só.
    monkeypatch.setattr(fiado_mod, "supabase_admin", fake)
    monkeypatch.setattr(HCS, "_tabelas_ok", None)
    return fake


def _sit(valor=300, fonte="house_credit", **extra):
    return SitPlayer(player_id=JOGADOR, buy_in_amount=valor, payment_method="cash",
                     payment_source=fonte, **extra)


# ══════════════════════════════════════════════════════════════════════
# FIFO e tradução
# ══════════════════════════════════════════════════════════════════════

def test_fifo_os_pagamentos_quitam_as_dividas_mais_antigas():
    cargas = [
        {"id": "a", "amount": 300, "signed_amount": 300, "created_at": _ha(50)},
        {"id": "b", "amount": 200, "signed_amount": 200, "created_at": _ha(20)},
        {"id": "c", "amount": 100, "signed_amount": 100, "created_at": _ha(5)},
    ]
    pago = [{"id": "p", "amount": 350, "signed_amount": -350, "created_at": _ha(1)}]
    # 350 quitou a de 300 e 50 da de 200: a mais antiga EM ABERTO é a de 20 dias.
    assert (datetime.now(timezone.utc) - mais_antiga_em_aberto(cargas + pago)).days == 20
    tudo = [{"id": "q", "amount": 600, "signed_amount": -600, "created_at": _ha(0)}]
    assert mais_antiga_em_aberto(cargas + tudo) is None


def test_recusa_do_banco_vira_codigo_com_numeros():
    erro = recusa_do_banco(Exception(
        "{'message': 'REGRA_FIADO:limite_de_fiado_excedido disponivel=200.00 solicitado=300.00'}"
    ))
    d = erro.como_http().detail
    assert d["code"] == "limite_de_fiado_excedido"
    assert d["disponivel"] == 200.0 and d["solicitado"] == 300.0
    assert erro.como_http().status_code == 400
    assert recusa_do_banco(Exception("duplicate key")) is None
    assert recusa_do_banco(Exception("REGRA_FIADO:estorno_de_fiado_ja_quitado devido=50 solicitado=200")).status == 409


# ══════════════════════════════════════════════════════════════════════
# Vender no fiado
# ══════════════════════════════════════════════════════════════════════

def test_sem_conta_recusa_antes_de_tomar_a_cadeira(monkeypatch):
    fake = _banco(monkeypatch)
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 3, _sit(), AUTH, ORG)
    assert recusa(exc)["code"] == "fiado_nao_habilitado"
    assert all(a["status"] == "free" for a in fake.store["cash_seats"])
    assert fake.store["cash_player_sessions"] == []


def test_venda_fiada_sem_gaveta_e_sem_meio(monkeypatch):
    fake = _banco(monkeypatch, house_credit_accounts=[_conta()])
    r = CTS.sit(MESA, 3, _sit(300), AUTH, ORG)
    venda = fake.store["cash_transactions"][0]
    assert venda["payment_source"] == "house_credit"
    assert "cashbox_id" not in venda or venda["cashbox_id"] is None
    assert venda["payment_method"] is None
    assert r.transaction.amount == 300


def test_acima_do_limite_recusa_com_os_numeros(monkeypatch):
    fake = _banco(monkeypatch, house_credit_accounts=[_conta(balance=300)],
                  house_credit_entries=[_carga(300)])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 3, _sit(300), AUTH, ORG)
    d = recusa(exc)
    assert d["code"] == "limite_de_fiado_excedido"
    assert d["disponivel"] == 200 and d["solicitado"] == 300
    assert fake.store["cash_transactions"] == []


def test_fiado_vencido_bloqueia_venda_nova(monkeypatch):
    _banco(monkeypatch, house_credit_accounts=[_conta(balance=100)],
           house_credit_entries=[_carga(100, dias=40)])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 3, _sit(100), AUTH, ORG)
    assert recusa(exc)["code"] == "fiado_vencido"


def test_vencido_sem_bloqueio_configurado_passa(monkeypatch):
    fake = _banco(monkeypatch, house_credit_accounts=[_conta(balance=100)],
                  house_credit_entries=[_carga(100, dias=40)],
                  house_credit_settings=[{"organization_id": ORG, "due_days": 30,
                                          "block_overdue": False, "default_limit": 0}])
    CTS.sit(MESA, 3, _sit(100), AUTH, ORG)
    assert fake.store["cash_transactions"][0]["payment_source"] == "house_credit"


def test_recompra_fiada_tambem_sem_gaveta(monkeypatch):
    fake = _banco(monkeypatch, house_credit_accounts=[_conta()],
                  cash_player_sessions=[_sessao()])
    CTS.rebuy("s1", CashRebuy(amount=200, payment_method="pix", payment_source="house_credit"), AUTH, ORG)
    venda = fake.store["cash_transactions"][0]
    assert venda["payment_source"] == "house_credit" and venda.get("cashbox_id") is None


def test_venda_normal_continua_igual(monkeypatch):
    fake = _banco(monkeypatch)
    CTS.sit(MESA, 3, _sit(300, fonte=None), AUTH, ORG)
    venda = fake.store["cash_transactions"][0]
    assert venda["cashbox_id"] == CAIXA and venda["payment_method"] == "cash"


def test_recusa_do_trigger_sai_traduzida(monkeypatch):
    fake = _banco(monkeypatch, house_credit_accounts=[_conta()])
    original = fake.table

    def tabela(nome):
        q = original(nome)
        if nome == "cash_transactions":
            inserir = q.insert

            def insert_que_estoura(payload):
                if payload.get("payment_source") == "house_credit":
                    raise Exception("REGRA_FIADO:limite_de_fiado_excedido disponivel=0.00 solicitado=300.00")
                return inserir(payload)
            q.insert = insert_que_estoura
        return q
    monkeypatch.setattr(fake, "table", tabela)
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 3, _sit(300), AUTH, ORG)
    assert recusa(exc)["code"] == "limite_de_fiado_excedido"
    # A cadeira e a sessão foram devolvidas.
    assert fake.store["cash_player_sessions"] == []
    assert all(a["status"] == "free" for a in fake.store["cash_seats"])


# ══════════════════════════════════════════════════════════════════════
# Cash-out de quem deve
# ══════════════════════════════════════════════════════════════════════

def _levantar(fake, valor, **extra):
    return CTS.stand("s1", StandPlayer(cash_out_amount=valor, payment_method="cash", **extra), AUTH, ORG)


def test_cash_out_de_devedor_exige_abatimento_explicito(monkeypatch):
    fake = _banco(monkeypatch, house_credit_accounts=[_conta(balance=500)],
                  cash_player_sessions=[_sessao()])
    with pytest.raises(ErroDeNegocio) as exc:
        _levantar(fake, 800)
    d = recusa(exc)
    assert d["code"] == "jogador_com_fiado"
    assert exc.value.status == 409
    assert d["divida"] == 500 and d["abatimento_sugerido"] == 500
    assert fake.store["cash_transactions"] == []
    assert fake.store["cash_player_sessions"][0]["status"] == "active"


def test_abatimento_total_grava_as_fichas_e_o_abatido(monkeypatch):
    fake = _banco(monkeypatch, saldo_gaveta=300, house_credit_accounts=[_conta(balance=500)],
                  cash_player_sessions=[_sessao()])
    # Gaveta com 300 paga o líquido de 300 (800 − 500): passa.
    _levantar(fake, 800, debt_offset_amount=500)
    co = fake.store["cash_transactions"][0]
    assert co["amount"] == 800
    assert co["debt_settled_amount"] == 500 and co["debt_offset_expected"] == 500
    assert fake.store["cash_player_sessions"][0]["status"] == "left"


def test_gaveta_conferida_contra_o_liquido(monkeypatch):
    fake = _banco(monkeypatch, saldo_gaveta=200, house_credit_accounts=[_conta(balance=500)],
                  cash_player_sessions=[_sessao()])
    with pytest.raises(ErroDeNegocio) as exc:
        _levantar(fake, 800, debt_offset_amount=500)
    d = recusa(exc)
    assert d["code"] == "saldo_insuficiente_no_caixa" and d["solicitado"] == 300


def test_abater_menos_exige_motivo(monkeypatch):
    fake = _banco(monkeypatch, house_credit_accounts=[_conta(balance=500)],
                  cash_player_sessions=[_sessao()])
    with pytest.raises(ErroDeNegocio) as exc:
        _levantar(fake, 800, debt_offset_amount=100)
    assert recusa(exc)["code"] == "motivo_do_abatimento_obrigatorio"
    _levantar(fake, 800, debt_offset_amount=100, debt_offset_reason="acordo com o gerente")
    co = fake.store["cash_transactions"][0]
    assert co["debt_settled_amount"] == 100 and co["debt_offset_expected"] == 500
    assert co["debt_offset_reason"] == "acordo com o gerente"


def test_abater_mais_que_o_possivel_recusa(monkeypatch):
    fake = _banco(monkeypatch, house_credit_accounts=[_conta(balance=500)],
                  cash_player_sessions=[_sessao()])
    with pytest.raises(ErroDeNegocio) as exc:
        _levantar(fake, 300, debt_offset_amount=400)
    d = recusa(exc)
    assert d["code"] == "abatimento_maior_que_o_possivel" and d["maximo"] == 300


def test_sem_divida_o_cash_out_nao_manda_coluna_nova(monkeypatch):
    fake = _banco(monkeypatch, cash_player_sessions=[_sessao()])
    _levantar(fake, 300)
    co = fake.store["cash_transactions"][0]
    assert "debt_settled_amount" not in co and "debt_offset_expected" not in co


def test_sem_migracao_cash_out_segue_como_sempre(monkeypatch):
    fake = _banco(monkeypatch, cash_player_sessions=[_sessao()])
    original = fake.table

    def tabela(nome):
        if nome.startswith("house_credit"):
            raise Exception("relation does not exist")
        return original(nome)
    monkeypatch.setattr(fake, "table", tabela)
    _levantar(fake, 300)
    assert "debt_settled_amount" not in fake.store["cash_transactions"][0]


def test_retry_do_levantar_fecha_a_sessao(monkeypatch):
    fake = _banco(monkeypatch, cash_player_sessions=[_sessao()],
                  cash_transactions=[{"id": "t1", "organization_id": ORG, "cash_day_id": DIA,
                                      "type": "cash_out", "amount": 300, "status": "active",
                                      "client_mutation_id": "co-1", "player_session_id": "s1",
                                      "created_at": _ha(0)}])
    CTS.stand("s1", StandPlayer(cash_out_amount=300, client_mutation_id="co-1"), AUTH, ORG)
    assert fake.store["cash_player_sessions"][0]["status"] == "left"
    assert len(fake.store["cash_transactions"]) == 1


# ══════════════════════════════════════════════════════════════════════
# Recebimento, baixa e gestão
# ══════════════════════════════════════════════════════════════════════

def test_recebimento_na_gaveta_do_dia(monkeypatch):
    fake = _banco(monkeypatch, house_credit_accounts=[_conta(balance=500)])
    HCS.receive_payment(JOGADOR, HouseCreditPaymentCreate(
        amount=200, payment_method="pix", cash_day_id=DIA, client_mutation_id="pg-1"), AUTH, ORG)
    e = fake.store["house_credit_entries"][0]
    assert e["type"] == "payment" and e["cashbox_id"] == CAIXA and e["amount"] == 200
    assert e["organization_id"] == ORG and e["client_mutation_id"] == "pg-1"


def test_recebimento_acima_da_divida_recusa(monkeypatch):
    fake = _banco(monkeypatch, house_credit_accounts=[_conta(balance=100)])
    with pytest.raises(ErroDeNegocio) as exc:
        HCS.receive_payment(JOGADOR, HouseCreditPaymentCreate(amount=150, cash_day_id=DIA), AUTH, ORG)
    assert recusa(exc)["code"] == "valor_maior_que_a_divida"
    assert fake.store["house_credit_entries"] == []


def test_recebimento_sem_gaveta_recusa_ate_para_super_admin(monkeypatch):
    _banco(monkeypatch, house_credit_accounts=[_conta(balance=100)])
    monkeypatch.setattr(CashboxService, "require_open_cashbox_for_cash_day", staticmethod(lambda a, d: None))
    with pytest.raises(ErroDeNegocio) as exc:
        HCS.receive_payment(JOGADOR, HouseCreditPaymentCreate(amount=50, cash_day_id=DIA), AUTH, ORG)
    assert recusa(exc)["code"] == "caixa_fechado"


def test_recebimento_exige_uma_ancora_so():
    with pytest.raises(ValueError):
        HouseCreditPaymentCreate(amount=10)
    with pytest.raises(ValueError):
        HouseCreditPaymentCreate(amount=10, cash_day_id=DIA, bar_shift_id="b")


def test_baixa_vai_pelo_service_role_com_motivo_e_autor(monkeypatch):
    fake = _banco(monkeypatch, house_credit_accounts=[_conta(balance=100)])
    HCS.write_off(JOGADOR, 100, "jogador sumiu", AUTH, ORG)
    e = fake.store["house_credit_entries"][0]
    assert e["type"] == "write_off" and e["reason"] == "jogador sumiu"
    assert e["created_by"] == AUTH and e["organization_id"] == ORG


def test_habilitar_jogador_de_outro_clube_nao_encontra(monkeypatch):
    _banco(monkeypatch, players=[])
    with pytest.raises(ErroDeNegocio) as exc:
        HCS.upsert_account(JOGADOR, HouseCreditAccountUpdate(enabled=True, credit_limit=500), AUTH, ORG)
    assert exc.value.status == 404


def test_habilitar_cria_a_conta_com_autor(monkeypatch):
    fake = _banco(monkeypatch)
    conta = HCS.upsert_account(JOGADOR, HouseCreditAccountUpdate(enabled=True, credit_limit=500), AUTH, ORG)
    linha = fake.store["house_credit_accounts"][0]
    assert linha["enabled"] is True and linha["credit_limit"] == 500
    assert linha["updated_by"] == AUTH and linha.get("enabled_at")
    assert conta.available == 500


def test_devedores_ordenados_pela_divida_mais_antiga(monkeypatch):
    outro = "44444444-4444-4444-4444-444444444449"
    _banco(monkeypatch,
           players=[{"id": JOGADOR, "name": "Ana", "phone": None},
                    {"id": outro, "name": "Bia", "phone": None}],
           house_credit_accounts=[_conta(balance=100),
                                  {**_conta(balance=900), "id": "c2", "player_id": outro}],
           house_credit_entries=[_carga(100, dias=45),
                                 {**_carga(900, dias=2, id_="e2"), "account_id": "c2", "player_id": outro}])
    r = HCS.debtors(ORG)
    assert [d.player_name for d in r.rows] == ["Ana", "Bia"]
    assert r.total_open == 1000 and r.total_overdue == 100 and r.overdue_count == 1


# ══════════════════════════════════════════════════════════════════════
# Gaveta, dia e DRE
# ══════════════════════════════════════════════════════════════════════

def test_demonstrativo_tem_coluna_de_fiado_e_bate_com_o_esperado():
    txs = [
        {"type": "supply", "amount": 500, "signed_amount": 500, "created_at": _ha(0)},
        {"type": "cash_buy_in", "amount": 400, "signed_amount": 400, "cash_transaction_id": "x", "created_at": _ha(0)},
        {"type": "cash_out", "amount": 300, "signed_amount": -300, "cash_transaction_id": "y", "created_at": _ha(0)},
        {"type": "debt_payment", "amount": 200, "signed_amount": 200, "house_credit_entry_id": "p", "created_at": _ha(0)},
        {"type": "refund", "amount": 200, "signed_amount": -200, "house_credit_entry_id": "r", "created_at": _ha(0)},
    ]
    sessao = {"id": "cs1", "cashbox_id": CAIXA, "initial_balance": 500, "opened_at": _ha(0), "closed_at": None}
    r = CashboxService._compute_session_report(sessao, {"current_balance": 600}, txs)
    assert r.total_debt_payments == 200 and r.debt_payment_count == 1
    assert r.total_refunds == 200
    colunas = (r.initial_balance + r.total_supply - r.total_sangria + r.total_cash_buy_ins
               - r.total_cash_outs + r.total_debt_payments - r.total_refunds)
    assert round(colunas, 2) == r.expected_balance == 600


def test_debt_payment_entra_no_sinal_das_entradas():
    assert caixa_mod._signed(200, "debt_payment") == 200
    assert caixa_mod._eh_estorno({"type": "adjustment", "house_credit_entry_id": "r"})


def test_dia_separa_fiado_abatido_e_recebido(monkeypatch):
    _banco(monkeypatch,
           cash_transactions=[
               {"id": "1", "cash_day_id": DIA, "type": "buy_in", "amount": 1000, "status": "active", "payment_source": None},
               {"id": "2", "cash_day_id": DIA, "type": "buy_in", "amount": 1000, "status": "active", "payment_source": "house_credit"},
               {"id": "3", "cash_day_id": DIA, "type": "rebuy", "amount": 500, "status": "cancelled", "payment_source": "house_credit"},
               {"id": "4", "cash_day_id": DIA, "type": "cash_out", "amount": 800, "status": "active", "debt_settled_amount": 300},
           ],
           house_credit_entries=[
               {"id": "p1", "cash_day_id": DIA, "type": "payment", "amount": 250},
               {"id": "p2", "cash_day_id": DIA, "type": "payment_reversal", "amount": 50},
           ])
    r = CashDayService._agregar(DIA)
    assert r["total_buy_ins"] == 2000          # fichas: a conta do dia não muda
    assert r["total_credit_issued"] == 1000    # cancelada fica fora
    assert r["total_debt_offset"] == 300
    assert r["total_debt_payments"] == 200


def test_baixa_de_fiado_sai_do_resultado(monkeypatch):
    fake = _banco(monkeypatch, house_credit_entries=[
        {"id": "w1", "organization_id": ORG, "type": "write_off", "amount": 400, "created_at": _ha(1)},
    ])
    r = HCS.summarize(ORG)
    assert r["house_credit_write_offs"] == 400
    assert fake  # banco usado
