"""DIA DE OPERAÇÃO do cash game — a unidade que o cliente mede.

Torneio se organiza em etapas (circuitos com começo e fim). Cash game abre,
roda a noite, conta e fecha — todo dia. É esse recorte que responde "quanto
faturamos ontem?", "qual dia rende mais?" e "vale abrir na terça?".

O que estes testes travam, e que uma refatoração distraída desfaz:

1. **A data é ESCOLHIDA, não deduzida do relógio.** A noite que começa 21h e
   termina 05h é UM dia. Trocar por `now()::date` jogaria o faturamento da
   madrugada no dia seguinte e torceria justamente o relatório que motivou o
   módulo.
2. **Um dia aberto por vez.** Dois dias abertos = dois fechamentos parciais e
   nenhum que feche; o dinheiro fica partido e ninguém sabe qual contagem vale.
3. **Não fecha o dia com mesa aberta.** Fechar congela o faturamento, e uma
   mesa aberta ainda vai receber apuração de rake — o número congelado nasceria
   errado sem nunca mais ser recalculado.
4. **Faturamento é RAKE, não buy-in.** Buy-in é troca de dinheiro por ficha e a
   maior parte volta ao jogador no cash-out. Somá-lo como receita multiplicaria
   o faturamento do clube por dez no papel.
5. **Fechado é resultado CONGELADO.** É contra ele que a conferência foi feita;
   recalcular daria um número que não bate com o que ficou assinado.
"""
import pytest

from app.models.cash_game import CashDayCreate
from app.services import cash_day_service as dia_mod
from app.services.cash_day_service import CashDayService as CDS
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
AUTH = "88888888-8888-8888-8888-888888888888"
DIA = "d1111111-1111-1111-1111-111111111111"
MESA = "1a111111-1111-1111-1111-111111111111"


def recusa(exc):
    return exc.value.como_http().detail


def _dia(id_=DIA, data="2026-09-10", status="open", **extra):
    linha = {"id": id_, "organization_id": ORG, "business_date": data,
             "status": status, "opened_at": "2026-09-10T21:00:00Z",
             "label": None, "notes": None}
    linha.update(extra)
    return linha


def _banco(monkeypatch, **tabelas):
    base = {
        "cash_days": [],
        "cash_tables": [],
        "cash_transactions": [],
        "cash_rake_entries": [],
        "cash_player_sessions": [],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    monkeypatch.setattr(dia_mod, "supabase", fake)
    return fake


# ══════════════════════════════════════════════════════════════════════
# Abertura
# ══════════════════════════════════════════════════════════════════════

def test_abre_o_dia_com_a_data_informada(monkeypatch):
    """A data vem do formulário. Uma noite que atravessa a meia-noite é
    registrada pelo operador como o dia em que ela começou."""
    _banco(monkeypatch)
    dia = CDS.open_day(CashDayCreate(business_date="2026-09-10"), AUTH, ORG)
    assert str(dia.business_date) == "2026-09-10"
    assert dia.status == "open"
    assert dia.opened_by == AUTH


def test_recusa_segundo_dia_aberto(monkeypatch):
    _banco(monkeypatch, cash_days=[_dia()])
    with pytest.raises(ErroDeNegocio) as exc:
        CDS.open_day(CashDayCreate(business_date="2026-09-11"), AUTH, ORG)
    d = recusa(exc)
    assert d["code"] == "dia_ja_aberto"
    assert exc.value.status == 409
    # O id e a data vão como dado nomeado: é com eles que a tela leva o operador
    # ao dia que precisa ser fechado, em vez de só dizer "não pode".
    assert d["cash_day_id"] == DIA
    assert d["business_date"] == "2026-09-10"


def test_dia_fechado_nao_impede_abrir_outro(monkeypatch):
    _banco(monkeypatch, cash_days=[_dia(status="closed")])
    dia = CDS.open_day(CashDayCreate(business_date="2026-09-11"), AUTH, ORG)
    assert dia.status == "open"


def test_dia_aberto_de_outro_clube_nao_bloqueia(monkeypatch):
    # O RLS já isola, mas a consulta também filtra: sem isso um clube movimentado
    # travaria a abertura do vizinho.
    _banco(monkeypatch, cash_days=[_dia(id_="outro", **{"organization_id": "outra-org"})])
    dia = CDS.open_day(CashDayCreate(business_date="2026-09-10"), AUTH, ORG)
    assert dia.status == "open"


# ══════════════════════════════════════════════════════════════════════
# Leitura
# ══════════════════════════════════════════════════════════════════════

def test_dia_corrente_e_o_aberto(monkeypatch):
    _banco(monkeypatch, cash_days=[_dia(id_="antigo", data="2026-09-09", status="closed"),
                                   _dia()])
    atual = CDS.get_current(ORG)
    assert atual.id == DIA


def test_sem_dia_aberto_devolve_nada(monkeypatch):
    _banco(monkeypatch, cash_days=[_dia(status="closed")])
    assert CDS.get_current(ORG) is None


def test_dia_inexistente_e_404(monkeypatch):
    _banco(monkeypatch)
    with pytest.raises(ErroDeNegocio) as exc:
        CDS.get_day("nao-existe")
    assert recusa(exc)["code"] == "dia_nao_encontrado"
    assert exc.value.status == 404


# ══════════════════════════════════════════════════════════════════════
# Números do dia
# ══════════════════════════════════════════════════════════════════════

def _movimento():
    return {
        "cash_transactions": [
            {"id": "t1", "cash_day_id": DIA, "type": "buy_in", "amount": 200,
             "status": "active", "player_session_id": "s1"},
            {"id": "t2", "cash_day_id": DIA, "type": "buy_in", "amount": 300,
             "status": "active", "player_session_id": "s2"},
            {"id": "t3", "cash_day_id": DIA, "type": "rebuy", "amount": 100,
             "status": "active", "player_session_id": "s1"},
            {"id": "t4", "cash_day_id": DIA, "type": "cash_out", "amount": 250,
             "status": "active", "player_session_id": "s2"},
        ],
        "cash_rake_entries": [
            {"id": "r1", "cash_day_id": DIA, "table_id": MESA,
             "rake_amount": 40, "jackpot_amount": 8},
            {"id": "r2", "cash_day_id": DIA, "table_id": MESA,
             "rake_amount": 90, "jackpot_amount": 18},
        ],
        "cash_tables": [{"id": MESA, "cash_day_id": DIA, "status": "open"}],
        "cash_player_sessions": [
            {"id": "s1", "cash_day_id": DIA, "status": "active",
             "total_buy_in": 300, "total_cash_out": 0},
            {"id": "s2", "cash_day_id": DIA, "status": "left",
             "total_buy_in": 300, "total_cash_out": 250},
        ],
    }


def test_faturamento_do_dia_e_o_rake(monkeypatch):
    """600 entraram e 250 saíram — mas a receita do clube são os 130 de rake.
    Confundir os dois multiplicaria o faturamento por dez."""
    _banco(monkeypatch, cash_days=[_dia()], **_movimento())
    s = CDS.summary(DIA)
    assert s.total_buy_ins == 600
    assert s.total_cash_outs == 250
    assert s.revenue == 130


def test_jackpot_nao_e_receita(monkeypatch):
    # É passivo: dinheiro dos jogadores retido para pagamento futuro. Sai numa
    # linha própria, nunca somado ao faturamento.
    _banco(monkeypatch, cash_days=[_dia()], **_movimento())
    s = CDS.summary(DIA)
    assert s.jackpot_collected == 26
    assert s.revenue == 130


def test_variancia_expoe_o_que_ainda_esta_na_mesa(monkeypatch):
    # (600 - 250) - (130 + 26) = 194. Diferente de zero é NORMAL com jogador
    # sentado: são as fichas que ainda não voltaram para o caixa.
    _banco(monkeypatch, cash_days=[_dia()], **_movimento())
    s = CDS.summary(DIA)
    assert s.variance == 194
    assert s.cash_in_play == 300
    assert s.players_seated == 1
    assert s.players_total == 2


def test_venda_cancelada_sai_da_conta(monkeypatch):
    dados = _movimento()
    dados["cash_transactions"][0]["status"] = "cancelled"
    _banco(monkeypatch, cash_days=[_dia()], **dados)
    s = CDS.summary(DIA)
    # O dinheiro voltou para a mão do jogador: 600 - 200.
    assert s.total_buy_ins == 400


# ══════════════════════════════════════════════════════════════════════
# Fechamento
# ══════════════════════════════════════════════════════════════════════

def test_fecha_congelando_os_numeros(monkeypatch):
    dados = _movimento()
    dados["cash_tables"][0]["status"] = "closed"
    _banco(monkeypatch, cash_days=[_dia()], **dados)

    dia = CDS.close_day(DIA, AUTH, notes="tudo certo")
    assert dia.status == "closed"
    assert dia.total_buy_ins == 600
    assert dia.total_cash_outs == 250
    assert dia.total_rake == 130
    assert dia.total_jackpot == 26
    assert dia.variance == 194
    assert dia.closed_by == AUTH


def test_recusa_fechar_com_mesa_aberta(monkeypatch):
    dados = _movimento()
    dados["cash_tables"][0]["table_number"] = 3
    _banco(monkeypatch, cash_days=[_dia()], **dados)

    with pytest.raises(ErroDeNegocio) as exc:
        CDS.close_day(DIA, AUTH)
    d = recusa(exc)
    assert d["code"] == "dia_com_mesa_aberta"
    assert exc.value.status == 409
    # Diz QUAIS mesas: sem isso o operador procura no salão inteiro.
    assert d["mesas"] == [3]
    assert d["quantidade"] == 1


def test_nao_fecha_duas_vezes(monkeypatch):
    _banco(monkeypatch, cash_days=[_dia(status="closed")])
    with pytest.raises(ErroDeNegocio) as exc:
        CDS.close_day(DIA, AUTH)
    assert recusa(exc)["code"] == "dia_ja_fechado"


def test_dia_fechado_devolve_o_congelado(monkeypatch):
    """Mesmo que apareça movimento novo depois (um estorno lançado no dia
    seguinte), o resumo do dia fechado é o número que foi conferido."""
    fechado = _dia(status="closed", total_buy_ins=600, total_cash_outs=250,
                   total_rake=130, total_jackpot=26, variance=194,
                   tables_count=1, players_count=2)
    dados = _movimento()
    dados["cash_rake_entries"].append(
        {"id": "r3", "cash_day_id": DIA, "table_id": MESA,
         "rake_amount": 999, "jackpot_amount": 0}
    )
    _banco(monkeypatch, cash_days=[fechado], **dados)

    s = CDS.summary(DIA)
    assert s.revenue == 130      # e não 1129
    assert s.status == "closed"


# ══════════════════════════════════════════════════════════════════════
# Guarda usada por quem movimenta dinheiro
# ══════════════════════════════════════════════════════════════════════

def test_exige_dia_aberto_para_movimentar(monkeypatch):
    """Uma aba esquecida aberta lançaria venda num dia já conferido — e o
    fechamento passaria a não bater sem ninguém ter errado hoje."""
    _banco(monkeypatch, cash_days=[_dia(status="closed")])
    with pytest.raises(ErroDeNegocio) as exc:
        CDS.require_open_day(DIA)
    d = recusa(exc)
    assert d["code"] == "dia_nao_aberto"
    assert d["cash_day_id"] == DIA


def test_dia_aberto_passa(monkeypatch):
    _banco(monkeypatch, cash_days=[_dia()])
    assert CDS.require_open_day(DIA)["id"] == DIA
