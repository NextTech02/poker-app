"""FILA DE ESPERA e gestão de assentos do cash game.

A fila é o que faz a sala girar. Numa noite cheia há mais gente do que cadeira,
e quem decide a ordem é um papel na mão de alguém — que se perde, some, e vira
discussão na frente da mesa.

O que estes testes travam, e que uma refatoração distraída desfaz:

1. **A posição NUNCA é reciclada.** Quando alguém senta ou desiste, quem está
   atrás não sobe de número. A posição é o registro de quem chegou quando;
   renumerar apagaria a única prova de que a ordem foi respeitada — e é
   exatamente isso que o jogador contesta no balcão.
2. **Visitante entra na fila sem cadastro.** Exigir documento com cinco pessoas
   esperando faria o operador voltar para o papel, que é o que a fila veio
   substituir.
3. **Reservar NÃO é sentar.** Sentar é vender fichas e passa pelo caixa. Juntar
   as duas coisas criaria jogador sentado sem ter pago.
4. **A reserva vence.** Uma chamada esquecida travaria a cadeira a noite
   inteira — numa sala cheia, é um lugar que não gira.
5. **Trocar de mesa NÃO move dinheiro.** O jogador levou as fichas com ele.
   Tratar como cash-out + buy-in inflaria o giro do dia com dinheiro que nunca
   passou pela gaveta.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models.cash_game import (
    CashWaitlistCreate,
    CashWaitlistSeat,
    CashWaitlistUpdate,
)
from app.services import cash_day_service as dia_mod
from app.services import cash_table_service as mesa_mod
from app.services import cash_transaction_service as tx_mod
from app.services import cash_waitlist_service as fila_mod
from app.services import cashbox_service as caixa_mod
from app.services.cash_table_service import CashTableService as CTaS
from app.services.cash_transaction_service import CashTransactionService as CTS
from app.services.cash_waitlist_service import CashWaitlistService as CWS
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
AUTH = "88888888-8888-8888-8888-888888888888"
STAFF = "99999999-9999-9999-9999-999999999999"
DIA = "d1111111-1111-1111-1111-111111111111"
MESA = "1a111111-1111-1111-1111-111111111111"
MESA2 = "1a111111-1111-1111-1111-111111111112"
CAIXA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1"
ANA = "44444444-4444-4444-4444-444444444441"
BRUNO = "44444444-4444-4444-4444-444444444442"


def recusa(exc):
    return exc.value.como_http().detail


def _mesa(id_=MESA, numero=1, status="open"):
    return {
        "id": id_, "organization_id": ORG, "cash_day_id": DIA,
        "game_type_id": "tipo", "table_number": numero, "seats": 3,
        "game_variant": "nlh", "small_blind": 1, "big_blind": 2, "ante": 0,
        "min_buy_in": 100, "max_buy_in": 400, "rake_percent": 5,
        "rake_cap": 10, "jackpot_per_pot": 1, "status": status,
        "opened_at": "2026-09-10T21:00:00Z",
    }


def _assentos(table_id=MESA, ocupado=None, reservado=None, para=None, ate=None):
    return [
        {"id": f"{table_id}-a{n}", "organization_id": ORG, "table_id": table_id,
         "seat_number": n,
         "status": ("occupied" if n == ocupado else
                    "reserved" if n == reservado else "free"),
         "player_session_id": None,
         "reserved_for": para if n == reservado else None,
         "reserved_until": ate if n == reservado else None,
         "updated_at": "2026-09-10T21:00:00Z"}
        for n in range(1, 4)
    ]


def _fila(id_="f1", jogador=ANA, nome=None, pos=1, status="waiting", **extra):
    linha = {"id": id_, "organization_id": ORG, "cash_day_id": DIA,
             "game_type_id": None, "table_id": None, "player_id": jogador,
             "guest_name": nome, "position": pos, "status": status,
             "called_at": None, "seated_at": None, "seat_id": None, "notes": None}
    linha.update(extra)
    return linha


def _banco(monkeypatch, **tabelas):
    base = {
        "cash_days": [{"id": DIA, "organization_id": ORG, "status": "open",
                       "business_date": "2026-09-10",
                       "opened_at": "2026-09-10T21:00:00Z"}],
        "cash_tables": [_mesa()],
        "cash_seats": _assentos(),
        "cash_player_sessions": [],
        "cash_transactions": [],
        "cash_waitlist": [],
        "cash_game_types": [{"id": "tipo", "organization_id": ORG, "name": "NLH 1/2"}],
        "players": [{"id": ANA, "name": "Ana", "nickname": None},
                    {"id": BRUNO, "name": "Bruno", "nickname": None}],
        "staff": [{"id": STAFF, "auth_user_id": AUTH, "name": "Caixa", "active": True,
                   "permission_groups": {"permissions": ["cash.operate", "cashbox.operate"]}}],
        "cashboxes": [{"id": CAIXA, "staff_id": STAFF, "cash_day_id": DIA,
                       "stage_id": None, "status": "open", "current_balance": 500,
                       "current_session_id": "cs1",
                       "created_at": "2026-09-10T21:00:00Z"}],
        "cashbox_transactions": [],
        "cashbox_sessions": [{"id": "cs1", "cashbox_id": CAIXA, "initial_balance": 500,
                              "opened_at": "2026-09-10T21:00:00Z"}],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    for mod in (fila_mod, mesa_mod, dia_mod, tx_mod, caixa_mod):
        monkeypatch.setattr(mod, "supabase", fake)
    return fake


# ══════════════════════════════════════════════════════════════════════
# Entrar na fila
# ══════════════════════════════════════════════════════════════════════

def test_entra_na_fila_na_ordem_de_chegada(monkeypatch):
    _banco(monkeypatch)
    a = CWS.add(DIA, CashWaitlistCreate(player_id=ANA), ORG)
    b = CWS.add(DIA, CashWaitlistCreate(player_id=BRUNO), ORG)
    assert (a.position, b.position) == (1, 2)
    assert a.status == "waiting"


def test_visitante_entra_so_com_o_nome(monkeypatch):
    """Exigir cadastro com gente esperando no balcão faria o operador voltar
    para o papel."""
    _banco(monkeypatch)
    e = CWS.add(DIA, CashWaitlistCreate(guest_name="  Carlos  "), ORG)
    assert e.guest_name == "Carlos"
    assert e.player_id is None
    # A tela mostra o nome anotado no mesmo lugar do jogador cadastrado.
    assert e.player_name == "Carlos"


def test_sem_jogador_e_sem_nome_e_recusado(monkeypatch):
    _banco(monkeypatch)
    with pytest.raises(ErroDeNegocio) as exc:
        CWS.add(DIA, CashWaitlistCreate(), ORG)
    assert recusa(exc)["code"] == "fila_sem_identificacao"


def test_nao_entra_duas_vezes_na_fila(monkeypatch):
    """Quem pergunta 'já me anotou?' e é anotado de novo passaria na frente de
    quem chegou antes."""
    _banco(monkeypatch, cash_waitlist=[_fila(pos=3)])
    with pytest.raises(ErroDeNegocio) as exc:
        CWS.add(DIA, CashWaitlistCreate(player_id=ANA), ORG)
    d = recusa(exc)
    assert d["code"] == "jogador_ja_na_fila"
    # A posição vai junto: é com ela que o operador mostra ao jogador que ele
    # já está anotado, e em que lugar.
    assert d["position"] == 3


def test_quem_ja_esta_sentado_nao_entra_na_fila(monkeypatch):
    _banco(monkeypatch, cash_player_sessions=[
        {"id": "s1", "organization_id": ORG, "cash_day_id": DIA, "table_id": MESA,
         "player_id": ANA, "seat_number": 1, "status": "active",
         "started_at": "2026-09-10T21:30:00Z", "total_buy_in": 200,
         "total_cash_out": 0, "result": 0},
    ])
    with pytest.raises(ErroDeNegocio) as exc:
        CWS.add(DIA, CashWaitlistCreate(player_id=ANA), ORG)
    assert recusa(exc)["code"] == "jogador_ja_sentado"


def test_quem_ja_desistiu_pode_voltar(monkeypatch):
    _banco(monkeypatch, cash_waitlist=[_fila(status="cancelled")])
    e = CWS.add(DIA, CashWaitlistCreate(player_id=ANA), ORG)
    assert e.status == "waiting"


def test_a_posicao_nunca_e_reciclada(monkeypatch):
    """Reaproveitar o número de quem sentou faria duas pessoas da mesma noite
    terem a posição 2 — e a ordem deixaria de ser prova de nada."""
    _banco(monkeypatch, cash_waitlist=[
        _fila(id_="f1", pos=1, status="seated"),
        _fila(id_="f2", jogador=BRUNO, pos=2, status="cancelled"),
    ])
    nova = CWS.add(DIA, CashWaitlistCreate(guest_name="Carlos"), ORG)
    assert nova.position == 3


def test_nao_entra_na_fila_com_o_dia_fechado(monkeypatch):
    _banco(monkeypatch, cash_days=[{"id": DIA, "organization_id": ORG,
                                    "status": "closed", "business_date": "2026-09-10",
                                    "opened_at": "2026-09-10T21:00:00Z"}])
    with pytest.raises(ErroDeNegocio) as exc:
        CWS.add(DIA, CashWaitlistCreate(player_id=ANA), ORG)
    assert recusa(exc)["code"] == "dia_nao_aberto"


# ══════════════════════════════════════════════════════════════════════
# Chamar e reservar
# ══════════════════════════════════════════════════════════════════════

def test_chamar_nao_reserva_cadeira(monkeypatch):
    """Chamar e reservar são passos separados porque na sala eles são: o
    operador grita o nome antes de saber em qual mesa vai abrir o lugar."""
    fake = _banco(monkeypatch, cash_waitlist=[_fila()])
    e = CWS.call("f1")
    assert e.status == "called"
    assert e.called_at is not None
    assert all(a["status"] == "free" for a in fake.store["cash_seats"])


def test_reservar_prende_a_cadeira_com_prazo(monkeypatch):
    fake = _banco(monkeypatch, cash_waitlist=[_fila(status="called")])
    e = CWS.seat("f1", CashWaitlistSeat(table_id=MESA, seat_number=2, minutes=10))

    assento = next(a for a in fake.store["cash_seats"] if a["seat_number"] == 2)
    assert assento["status"] == "reserved"
    assert assento["reserved_for"] == ANA
    assert assento["reserved_until"] is not None
    # Reservar NÃO senta: a venda das fichas continua sendo feita no caixa.
    assert e.status == "called"
    assert fake.store["cash_player_sessions"] == []


def test_nao_reserva_cadeira_ocupada(monkeypatch):
    _banco(monkeypatch, cash_seats=_assentos(ocupado=2), cash_waitlist=[_fila()])
    with pytest.raises(ErroDeNegocio) as exc:
        CWS.seat("f1", CashWaitlistSeat(table_id=MESA, seat_number=2))
    assert recusa(exc)["code"] == "assento_ocupado"


def test_visitante_sem_cadastro_nao_reserva(monkeypatch):
    """A reserva prende a cadeira para uma PESSOA identificada; um nome anotado
    não dá para conferir quando outro jogador senta ali."""
    _banco(monkeypatch, cash_waitlist=[_fila(jogador=None, nome="Carlos")])
    with pytest.raises(ErroDeNegocio) as exc:
        CWS.seat("f1", CashWaitlistSeat(table_id=MESA, seat_number=2))
    assert recusa(exc)["code"] == "fila_sem_cadastro"


def test_quem_saiu_da_fila_nao_pode_ser_chamado(monkeypatch):
    _banco(monkeypatch, cash_waitlist=[_fila(status="seated")])
    with pytest.raises(ErroDeNegocio) as exc:
        CWS.call("f1")
    d = recusa(exc)
    assert d["code"] == "fila_registro_encerrado"
    assert d["status_atual"] == "seated"


# ══════════════════════════════════════════════════════════════════════
# Sair da fila
# ══════════════════════════════════════════════════════════════════════

def test_desistir_devolve_a_cadeira_reservada(monkeypatch):
    fake = _banco(
        monkeypatch,
        cash_seats=_assentos(reservado=2, para=ANA, ate="2026-09-10T22:00:00Z"),
        cash_waitlist=[_fila(status="called", seat_id=f"{MESA}-a2")],
    )
    e = CWS.give_up("f1")
    assert e.status == "cancelled"
    assento = next(a for a in fake.store["cash_seats"] if a["seat_number"] == 2)
    assert assento["status"] == "free"
    assert assento["reserved_for"] is None


def test_nao_apareceu_tem_estado_proprio(monkeypatch):
    """`no_show` separado da desistência é o que explica ao próximo da fila por
    que ele passou na frente de alguém."""
    _banco(monkeypatch, cash_waitlist=[_fila(status="called")])
    e = CWS.give_up("f1", no_show=True)
    assert e.status == "no_show"


def test_sair_da_fila_nao_derruba_quem_ja_sentou(monkeypatch):
    # A cadeira já está OCUPADA (o jogador comprou fichas). Marcar 'free' aqui
    # apagaria a ligação com a sessão e ele sumiria da tela ainda na mesa.
    fake = _banco(
        monkeypatch,
        cash_seats=_assentos(ocupado=2),
        cash_waitlist=[_fila(status="called", seat_id=f"{MESA}-a2")],
    )
    CWS.give_up("f1")
    assento = next(a for a in fake.store["cash_seats"] if a["seat_number"] == 2)
    assert assento["status"] == "occupied"


def test_marca_sentado_depois_da_venda(monkeypatch):
    _banco(monkeypatch, cash_waitlist=[_fila(status="called")])
    e = CWS.mark_seated("f1")
    assert e.status == "seated"
    assert e.seated_at is not None


def test_operador_pode_reordenar_quem_cedeu_a_vez(monkeypatch):
    _banco(monkeypatch, cash_waitlist=[_fila(pos=1)])
    e = CWS.update("f1", CashWaitlistUpdate(position=5, notes="cedeu a vez"))
    assert e.position == 5
    assert e.notes == "cedeu a vez"


# ══════════════════════════════════════════════════════════════════════
# Reserva vencida
# ══════════════════════════════════════════════════════════════════════

def test_reserva_vencida_volta_para_a_sala(monkeypatch):
    """Uma chamada esquecida travaria a cadeira a noite inteira."""
    passado = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    fake = _banco(monkeypatch, cash_seats=_assentos(reservado=2, para=ANA, ate=passado))
    assert CWS.release_expired(DIA) == 1
    assento = next(a for a in fake.store["cash_seats"] if a["seat_number"] == 2)
    assert assento["status"] == "free"


def test_reserva_no_prazo_e_mantida(monkeypatch):
    futuro = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    fake = _banco(monkeypatch, cash_seats=_assentos(reservado=2, para=ANA, ate=futuro))
    assert CWS.release_expired(DIA) == 0
    assento = next(a for a in fake.store["cash_seats"] if a["seat_number"] == 2)
    assert assento["status"] == "reserved"


# ══════════════════════════════════════════════════════════════════════
# Reserva avulsa (sem passar pela fila)
# ══════════════════════════════════════════════════════════════════════

def test_reserva_e_liberacao_avulsas(monkeypatch):
    fake = _banco(monkeypatch)
    CTaS.reserve_seat(MESA, 3, ANA, minutes=15)
    assento = next(a for a in fake.store["cash_seats"] if a["seat_number"] == 3)
    assert assento["status"] == "reserved"

    CTaS.release_seat(MESA, 3)
    assento = next(a for a in fake.store["cash_seats"] if a["seat_number"] == 3)
    assert assento["status"] == "free"


def test_nao_libera_cadeira_que_nao_esta_reservada(monkeypatch):
    _banco(monkeypatch, cash_seats=_assentos(ocupado=3))
    with pytest.raises(ErroDeNegocio) as exc:
        CTaS.release_seat(MESA, 3)
    d = recusa(exc)
    assert d["code"] == "assento_nao_reservado"
    assert d["status_atual"] == "occupied"


def test_jogador_senta_no_lugar_reservado_para_ele(monkeypatch):
    from app.models.cash_game import SitPlayer
    futuro = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    _banco(monkeypatch, cash_seats=_assentos(reservado=2, para=ANA, ate=futuro))
    r = CTS.sit(MESA, 2, SitPlayer(player_id=ANA, buy_in_amount=200), AUTH, ORG)
    assert r.player_session.seat_number == 2


def test_reserva_de_outro_jogador_bloqueia(monkeypatch):
    from app.models.cash_game import SitPlayer
    futuro = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    _banco(monkeypatch, cash_seats=_assentos(reservado=2, para=BRUNO, ate=futuro))
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 2, SitPlayer(player_id=ANA, buy_in_amount=200), AUTH, ORG)
    assert recusa(exc)["code"] == "assento_reservado"


# ══════════════════════════════════════════════════════════════════════
# Trocar de mesa
# ══════════════════════════════════════════════════════════════════════

def _com_duas_mesas(monkeypatch):
    return _banco(
        monkeypatch,
        cash_tables=[_mesa(), _mesa(id_=MESA2, numero=2)],
        cash_seats=_assentos(MESA) + _assentos(MESA2),
    )


def test_trocar_de_mesa_nao_move_dinheiro(monkeypatch):
    """O jogador levou as fichas com ele. Tratar como cash-out + buy-in
    inflaria o giro do dia com dinheiro que nunca passou pela gaveta."""
    from app.models.cash_game import SitPlayer
    fake = _com_duas_mesas(monkeypatch)
    r = CTS.sit(MESA, 1, SitPlayer(player_id=ANA, buy_in_amount=200), AUTH, ORG)
    antes = len(fake.store["cash_transactions"])

    nova = CTS.move(r.player_session.id, MESA2, 3, AUTH, ORG)

    assert nova.table_id == MESA2
    assert nova.seat_number == 3
    assert nova.status == "active"
    # Nenhum lançamento novo: nada entrou nem saiu do caixa.
    assert len(fake.store["cash_transactions"]) == antes
    assert not [t for t in fake.store["cash_transactions"] if t["type"] == "cash_out"]


def test_a_venda_segue_o_jogador(monkeypatch):
    from app.models.cash_game import SitPlayer
    fake = _com_duas_mesas(monkeypatch)
    r = CTS.sit(MESA, 1, SitPlayer(player_id=ANA, buy_in_amount=200), AUTH, ORG)
    nova = CTS.move(r.player_session.id, MESA2, 3, AUTH, ORG)

    venda = fake.store["cash_transactions"][0]
    assert venda["player_session_id"] == nova.id
    assert venda["table_id"] == MESA2


def test_a_origem_para_de_somar_o_dinheiro(monkeypatch):
    """Deixar os totais na origem faria a mesa de partida continuar somando
    dinheiro que já está noutra mesa — o salão contaria o mesmo buy-in duas
    vezes."""
    from app.models.cash_game import SitPlayer
    fake = _com_duas_mesas(monkeypatch)
    r = CTS.sit(MESA, 1, SitPlayer(player_id=ANA, buy_in_amount=200), AUTH, ORG)
    CTS.move(r.player_session.id, MESA2, 3, AUTH, ORG)

    origem = next(s for s in fake.store["cash_player_sessions"]
                  if s["id"] == r.player_session.id)
    assert origem["status"] == "moved"
    assert origem["total_buy_in"] == 0
    assert origem["moved_to_id"] is not None


def test_a_cadeira_de_origem_volta_para_a_sala(monkeypatch):
    from app.models.cash_game import SitPlayer
    fake = _com_duas_mesas(monkeypatch)
    r = CTS.sit(MESA, 1, SitPlayer(player_id=ANA, buy_in_amount=200), AUTH, ORG)
    CTS.move(r.player_session.id, MESA2, 3, AUTH, ORG)

    antiga = next(a for a in fake.store["cash_seats"]
                  if a["table_id"] == MESA and a["seat_number"] == 1)
    nova = next(a for a in fake.store["cash_seats"]
                if a["table_id"] == MESA2 and a["seat_number"] == 3)
    assert antiga["status"] == "free" and antiga["player_session_id"] is None
    assert nova["status"] == "occupied" and nova["player_session_id"] is not None


def test_nao_troca_para_cadeira_ocupada(monkeypatch):
    from app.models.cash_game import SitPlayer
    fake = _com_duas_mesas(monkeypatch)
    r = CTS.sit(MESA, 1, SitPlayer(player_id=ANA, buy_in_amount=200), AUTH, ORG)
    CTS.sit(MESA2, 3, SitPlayer(player_id=BRUNO, buy_in_amount=200), AUTH, ORG)

    with pytest.raises(ErroDeNegocio) as exc:
        CTS.move(r.player_session.id, MESA2, 3, AUTH, ORG)
    assert recusa(exc)["code"] == "assento_ocupado"
    # E o jogador continua exatamente onde estava.
    origem = next(s for s in fake.store["cash_player_sessions"]
                  if s["id"] == r.player_session.id)
    assert origem["status"] == "active"


def test_nao_troca_para_o_mesmo_lugar(monkeypatch):
    from app.models.cash_game import SitPlayer
    _com_duas_mesas(monkeypatch)
    r = CTS.sit(MESA, 1, SitPlayer(player_id=ANA, buy_in_amount=200), AUTH, ORG)
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.move(r.player_session.id, MESA, 1, AUTH, ORG)
    assert recusa(exc)["code"] == "mesa_de_destino_igual"


def test_nao_troca_para_mesa_fechada(monkeypatch):
    from app.models.cash_game import SitPlayer
    fake = _com_duas_mesas(monkeypatch)
    r = CTS.sit(MESA, 1, SitPlayer(player_id=ANA, buy_in_amount=200), AUTH, ORG)
    for m in fake.store["cash_tables"]:
        if m["id"] == MESA2:
            m["status"] = "closed"
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.move(r.player_session.id, MESA2, 3, AUTH, ORG)
    assert recusa(exc)["code"] == "mesa_ja_fechada"
