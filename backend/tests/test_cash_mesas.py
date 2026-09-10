"""MESAS de cash game: abrir, acompanhar e fechar apurando o rake.

Fechar a mesa é o momento em que a RECEITA DO CASH VIRA NÚMERO. O sistema não
vê mão a mão — sem sensor, não há como calcular rake por pote. Quem corta é o
sangeur, em fichas, e o que existe é a CONTAGEM da caixa de rake.

O que estes testes travam:

1. **O SNAPSHOT da modalidade.** A mesa copia stakes, buy-in e rake na
   abertura. Ler sempre pela FK seria mais curto e estaria errado: mudar o rake
   amanhã reescreveria a apuração de ontem e o fechamento assinado pelo
   operador deixaria de bater.
2. **O número identifica a mesa NO SALÃO.** Duas mesas 3 abertas ao mesmo tempo
   fariam o operador levar fichas para a errada.
3. **Não fecha mesa com gente sentada.** Sobrariam fichas compradas sem
   cash-out: o jogador ficaria credor sem registro e a variância apontaria um
   rombo que não existe.
4. **Apuração de rake NÃO é movimento de caixa.** O rake sai do pote, em
   fichas, e já está na gaveta como a diferença entre buy-ins e cash-outs.
   Lançá-lo contaria o mesmo dinheiro duas vezes.
5. **Diminuir a mesa não derruba quem está sentado.**
"""
import pytest

from app.models.cash_game import (
    CashRakeEntryCreate,
    CashTableClose,
    CashTableCreate,
    CashTableUpdate,
)
from app.services import cash_day_service as dia_mod
from app.services import cash_game_type_service as tipo_mod
from app.services import cash_table_service as mesa_mod
from app.services.cash_table_service import CashTableService as CTS
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
AUTH = "88888888-8888-8888-8888-888888888888"
DIA = "d1111111-1111-1111-1111-111111111111"
TIPO = "e1111111-1111-1111-1111-111111111111"
MESA = "1a111111-1111-1111-1111-111111111111"


def recusa(exc):
    return exc.value.como_http().detail


def _tipo(**extra):
    linha = {
        "id": TIPO, "organization_id": ORG, "name": "NLH 1/2",
        "game_variant": "nlh", "small_blind": 1, "big_blind": 2, "ante": 0,
        "straddle_allowed": False, "min_buy_in": 100, "max_buy_in": 400,
        "default_seats": 9, "rake_percent": 5, "rake_cap": 10,
        "jackpot_per_pot": 1, "active": True, "sort_order": 0,
    }
    linha.update(extra)
    return linha


def _mesa(id_=MESA, numero=1, status="open", lugares=9, **extra):
    linha = {
        "id": id_, "organization_id": ORG, "cash_day_id": DIA,
        "game_type_id": TIPO, "table_number": numero, "seats": lugares,
        "game_variant": "nlh", "small_blind": 1, "big_blind": 2, "ante": 0,
        "min_buy_in": 100, "max_buy_in": 400, "rake_percent": 5,
        "rake_cap": 10, "jackpot_per_pot": 1, "status": status,
        "opened_at": "2026-09-10T21:00:00Z",
    }
    linha.update(extra)
    return linha


def _banco(monkeypatch, **tabelas):
    base = {
        "cash_days": [{"id": DIA, "organization_id": ORG, "status": "open",
                       "business_date": "2026-09-10",
                       "opened_at": "2026-09-10T21:00:00Z"}],
        "cash_game_types": [_tipo()],
        "cash_tables": [],
        "cash_seats": [],
        "cash_player_sessions": [],
        "cash_rake_entries": [],
        "cash_transactions": [],
        "players": [],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    for mod in (mesa_mod, dia_mod, tipo_mod):
        monkeypatch.setattr(mod, "supabase", fake)
    return fake


# ══════════════════════════════════════════════════════════════════════
# Abertura
# ══════════════════════════════════════════════════════════════════════

def test_abre_a_mesa_copiando_a_modalidade(monkeypatch):
    """O retrato é o ponto: a mesa guarda o que valia HOJE."""
    _banco(monkeypatch)
    mesa = CTS.open_table(
        CashTableCreate(cash_day_id=DIA, game_type_id=TIPO, table_number=1), AUTH, ORG
    )
    assert mesa.small_blind == 1 and mesa.big_blind == 2
    assert mesa.min_buy_in == 100 and mesa.max_buy_in == 400
    assert mesa.rake_percent == 5 and mesa.rake_cap == 10
    assert mesa.jackpot_per_pot == 1
    assert mesa.seats == 9          # veio do default_seats da modalidade
    assert mesa.status == "open"


def test_mudar_a_modalidade_depois_nao_reescreve_a_mesa(monkeypatch):
    """Se a mesa lesse pela FK, o rake de ontem viraria o de hoje e o
    fechamento já assinado deixaria de bater."""
    fake = _banco(monkeypatch)
    mesa = CTS.open_table(
        CashTableCreate(cash_day_id=DIA, game_type_id=TIPO, table_number=1), AUTH, ORG
    )
    for linha in fake.store["cash_game_types"]:
        linha["rake_percent"] = 12
        linha["min_buy_in"] = 500

    depois = CTS.get_table_enriched(mesa.id)
    assert depois.rake_percent == 5
    assert depois.min_buy_in == 100


def test_lugares_podem_sobrepor_o_padrao(monkeypatch):
    _banco(monkeypatch)
    mesa = CTS.open_table(
        CashTableCreate(cash_day_id=DIA, game_type_id=TIPO, table_number=1, seats=6),
        AUTH, ORG,
    )
    assert mesa.seats == 6


def test_recusa_numero_de_mesa_repetido(monkeypatch):
    _banco(monkeypatch, cash_tables=[_mesa(numero=3)])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.open_table(
            CashTableCreate(cash_day_id=DIA, game_type_id=TIPO, table_number=3), AUTH, ORG
        )
    d = recusa(exc)
    assert d["code"] == "numero_de_mesa_em_uso"
    assert d["table_number"] == 3
    assert exc.value.status == 409


def test_mesa_fechada_libera_o_numero(monkeypatch):
    # O número é do SALÃO: quando a mesa fecha, a 3 volta a estar livre.
    _banco(monkeypatch, cash_tables=[_mesa(numero=3, status="closed")])
    mesa = CTS.open_table(
        CashTableCreate(cash_day_id=DIA, game_type_id=TIPO, table_number=3), AUTH, ORG
    )
    assert mesa.table_number == 3


def test_nao_abre_mesa_com_o_dia_fechado(monkeypatch):
    _banco(monkeypatch, cash_days=[{"id": DIA, "organization_id": ORG,
                                    "status": "closed", "business_date": "2026-09-10",
                                    "opened_at": "2026-09-10T21:00:00Z"}])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.open_table(
            CashTableCreate(cash_day_id=DIA, game_type_id=TIPO, table_number=1), AUTH, ORG
        )
    assert recusa(exc)["code"] == "dia_nao_aberto"


# ══════════════════════════════════════════════════════════════════════
# Tamanho da mesa
# ══════════════════════════════════════════════════════════════════════

def test_aumentar_a_mesa_cria_cadeiras(monkeypatch):
    fake = _banco(monkeypatch, cash_tables=[_mesa(lugares=6)], cash_seats=[
        {"id": f"a{n}", "organization_id": ORG, "table_id": MESA,
         "seat_number": n, "status": "free"} for n in range(1, 7)
    ])
    CTS.update_table(MESA, CashTableUpdate(seats=9))
    numeros = sorted(a["seat_number"] for a in fake.store["cash_seats"])
    assert numeros == list(range(1, 10))


def test_diminuir_nao_derruba_quem_esta_sentado(monkeypatch):
    """Tirar uma cadeira ocupada apagaria a ligação com a sessão: o jogador
    continuaria na mesa física com as fichas dele e sumiria da tela."""
    _banco(monkeypatch, cash_tables=[_mesa(lugares=9)], cash_seats=[
        {"id": f"a{n}", "organization_id": ORG, "table_id": MESA, "seat_number": n,
         "status": "occupied" if n == 8 else "free"} for n in range(1, 10)
    ])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.update_table(MESA, CashTableUpdate(seats=6))
    d = recusa(exc)
    assert d["code"] == "assento_ocupado"
    assert d["assentos"] == [8]


def test_diminuir_remove_so_as_livres(monkeypatch):
    fake = _banco(monkeypatch, cash_tables=[_mesa(lugares=9)], cash_seats=[
        {"id": f"a{n}", "organization_id": ORG, "table_id": MESA,
         "seat_number": n, "status": "free"} for n in range(1, 10)
    ])
    CTS.update_table(MESA, CashTableUpdate(seats=6))
    numeros = sorted(a["seat_number"] for a in fake.store["cash_seats"])
    assert numeros == [1, 2, 3, 4, 5, 6]


# ══════════════════════════════════════════════════════════════════════
# Apuração de rake
# ══════════════════════════════════════════════════════════════════════

def test_apuracao_parcial_nao_mexe_no_caixa(monkeypatch):
    """O rake sai do POTE, em fichas. Ele já está na gaveta como a diferença
    entre buy-ins e cash-outs — lançá-lo contaria o mesmo dinheiro duas vezes."""
    fake = _banco(monkeypatch, cash_tables=[_mesa()],
                  cashbox_transactions=[])
    CTS.add_rake_entry(MESA, CashRakeEntryCreate(rake_amount=40, jackpot_amount=8), AUTH)
    assert fake.store.get("cashbox_transactions") == []


def test_apuracao_vazia_e_recusada(monkeypatch):
    _banco(monkeypatch, cash_tables=[_mesa()])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.add_rake_entry(MESA, CashRakeEntryCreate(rake_amount=0, jackpot_amount=0), AUTH)
    assert recusa(exc)["code"] == "apuracao_vazia"


def test_nao_apura_parcial_em_mesa_fechada(monkeypatch):
    _banco(monkeypatch, cash_tables=[_mesa(status="closed")])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.add_rake_entry(MESA, CashRakeEntryCreate(rake_amount=10), AUTH)
    assert recusa(exc)["code"] == "mesa_ja_fechada"


# ══════════════════════════════════════════════════════════════════════
# Fechamento
# ══════════════════════════════════════════════════════════════════════

def test_fecha_somando_parciais_e_fechamento(monkeypatch):
    """`rake_counted` é o TOTAL da mesa, não só o que veio no fechamento — é o
    número que o relatório da noite mostra."""
    _banco(monkeypatch, cash_tables=[_mesa()], cash_rake_entries=[
        {"id": "r1", "organization_id": ORG, "cash_day_id": DIA, "table_id": MESA,
         "kind": "partial", "rake_amount": 40, "jackpot_amount": 8,
         "counted_at": "2026-09-10T23:00:00Z"},
    ])
    mesa = CTS.close_table(MESA, CashTableClose(rake_amount=90, jackpot_amount=18), AUTH)
    assert mesa.status == "closed"
    assert mesa.rake_counted == 130
    assert mesa.jackpot_counted == 26


def test_recusa_fechar_com_jogador_sentado(monkeypatch):
    _banco(monkeypatch, cash_tables=[_mesa()], cash_player_sessions=[
        {"id": "s1", "organization_id": ORG, "cash_day_id": DIA, "table_id": MESA,
         "player_id": "p1", "seat_number": 3, "status": "active",
         "started_at": "2026-09-10T21:30:00Z", "total_buy_in": 200,
         "total_cash_out": 0, "result": 0},
    ])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.close_table(MESA, CashTableClose(rake_amount=90), AUTH)
    d = recusa(exc)
    assert d["code"] == "mesa_com_jogador_sentado"
    assert d["assentos"] == [3]
    assert d["quantidade"] == 1


def test_nao_fecha_duas_vezes(monkeypatch):
    _banco(monkeypatch, cash_tables=[_mesa(status="closed")])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.close_table(MESA, CashTableClose(rake_amount=10), AUTH)
    assert recusa(exc)["code"] == "mesa_ja_fechada"


def test_fechar_grava_a_apuracao_como_documento(monkeypatch):
    fake = _banco(monkeypatch, cash_tables=[_mesa()])
    CTS.close_table(MESA, CashTableClose(rake_amount=90, jackpot_amount=18), AUTH)
    fechamentos = [r for r in fake.store["cash_rake_entries"] if r["kind"] == "closing"]
    assert len(fechamentos) == 1
    assert fechamentos[0]["rake_amount"] == 90
    assert fechamentos[0]["counted_by"] == AUTH


# ══════════════════════════════════════════════════════════════════════
# Leitura do salão
# ══════════════════════════════════════════════════════════════════════

def test_lista_agrega_ocupacao_e_dinheiro(monkeypatch):
    _banco(
        monkeypatch,
        cash_tables=[_mesa()],
        cash_player_sessions=[
            {"id": "s1", "organization_id": ORG, "cash_day_id": DIA, "table_id": MESA,
             "player_id": "p1", "seat_number": 3, "status": "active",
             "started_at": "2026-09-10T21:30:00Z", "total_buy_in": 300,
             "total_cash_out": 0, "result": 0},
            {"id": "s2", "organization_id": ORG, "cash_day_id": DIA, "table_id": MESA,
             "player_id": "p2", "seat_number": 5, "status": "left",
             "started_at": "2026-09-10T21:40:00Z", "total_buy_in": 300,
             "total_cash_out": 250, "result": -50},
        ],
        cash_rake_entries=[
            {"id": "r1", "organization_id": ORG, "cash_day_id": DIA, "table_id": MESA,
             "kind": "partial", "rake_amount": 40, "jackpot_amount": 8,
             "counted_at": "2026-09-10T23:00:00Z"},
        ],
    )
    mesa = CTS.list_tables(cash_day_id=DIA)[0]
    assert mesa.occupied_seats == 1
    assert mesa.free_seats == 8
    assert mesa.total_buy_ins == 600
    assert mesa.total_cash_outs == 250
    assert mesa.rake_partial == 40
    assert mesa.jackpot_partial == 8
    assert mesa.game_type_name == "NLH 1/2"
