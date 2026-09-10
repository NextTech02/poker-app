"""FATURAMENTO do cash game e o JACKPOT.

Este é o módulo que motivou o cash game. A pergunta do cliente não era "quanto
entrou de dinheiro", era "quanto faturamos em cada dia, e qual dia rende mais".

O que estes testes travam, e que uma refatoração distraída desfaz:

1. **Faturamento é o RAKE.** Buy-in é giro — troca de dinheiro por ficha, e a
   maior parte volta ao jogador no cash-out. Trocar um pelo outro multiplica a
   receita do clube por dez no papel, e ele contrata gente em cima disso.
2. **Jackpot é PASSIVO.** Dinheiro dos jogadores retido para pagamento futuro.
   Somá-lo ao faturamento contabilizaria como lucro algo que será devolvido.
3. **Melhores dias ordena por RAKE.** Por buy-ins responderia "qual noite girou
   mais", que é outra pergunta — e levaria o clube a repetir a noite que
   movimentou muito e ganhou pouco.
4. **Dia da semana é MÉDIA, não total.** O período quase nunca tem o mesmo
   número de sextas e de terças; o total premiaria o dia que apareceu mais.
5. **O DRE do clube SÓ-CASH não pode ser zero.** Ele cai sempre no ramo de
   "etapa sem torneios", que era o caminho que devolvia tudo zerado.
6. **O DRE não pode CAIR** se as tabelas de cash ainda não foram migradas — o
   deploy do código precede o da migração neste projeto.
"""
import pytest

from app.models.cash_game import JackpotPayoutCreate
from app.services import cash_day_service as dia_mod
from app.services import cash_jackpot_service as jackpot_mod
from app.services import cash_report_service as rel_mod
from app.services import cashbox_service as caixa_mod
from app.services import financial_service as fin_mod
from app.services.cash_jackpot_service import CashJackpotService as CJS
from app.services.cash_report_service import CashReportService as CRS
from app.services.financial_service import FinancialService as FS
from app.services.expense_service import ExpenseService
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
AUTH = "88888888-8888-8888-8888-888888888888"
STAFF = "99999999-9999-9999-9999-999999999999"
CAIXA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1"
ANA = "44444444-4444-4444-4444-444444444441"

# Quinta 2026-09-10, sexta 2026-09-11, quinta 2026-09-17.
SEX = "2026-09-11"
QUI1 = "2026-09-10"
QUI2 = "2026-09-17"


def recusa(exc):
    return exc.value.como_http().detail


def _dia(id_, data, status="closed"):
    return {"id": id_, "organization_id": ORG, "business_date": data,
            "status": status, "opened_at": f"{data}T21:00:00Z"}


def _rake(dia, mesa, rake, jackpot=0):
    return {"id": f"r-{dia}-{mesa}-{rake}", "organization_id": ORG,
            "cash_day_id": dia, "table_id": mesa, "kind": "closing",
            "rake_amount": rake, "jackpot_amount": jackpot,
            "counted_at": "2026-09-10T23:00:00Z"}


def _tx(dia, tipo, valor, status="active", n=0):
    return {"id": f"t-{dia}-{tipo}-{valor}-{n}", "organization_id": ORG,
            "cash_day_id": dia, "type": tipo, "amount": valor, "status": status}


def _banco(monkeypatch, **tabelas):
    base = {
        "cash_days": [], "cash_rake_entries": [], "cash_transactions": [],
        "cash_tables": [], "cash_player_sessions": [], "cash_game_types": [],
        "cash_jackpot_fund": [], "cash_jackpot_payouts": [],
        "players": [{"id": ANA, "name": "Ana", "nickname": None}],
        "staff": [{"id": STAFF, "auth_user_id": AUTH, "name": "Caixa", "active": True,
                   "permission_groups": {"permissions": ["cash.admin", "cashbox.operate"]}}],
        "cashboxes": [{"id": CAIXA, "staff_id": STAFF, "cash_day_id": "d1",
                       "stage_id": None, "status": "open", "current_balance": 500,
                       "current_session_id": "cs1",
                       "created_at": "2026-09-10T21:00:00Z"}],
        "cashbox_transactions": [],
        "cashbox_sessions": [{"id": "cs1", "cashbox_id": CAIXA, "initial_balance": 500,
                              "opened_at": "2026-09-10T21:00:00Z"}],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    for mod in (rel_mod, jackpot_mod, dia_mod, caixa_mod):
        monkeypatch.setattr(mod, "supabase", fake)
    return fake


def _duas_noites(monkeypatch):
    return _banco(
        monkeypatch,
        cash_days=[_dia("d1", QUI1), _dia("d2", SEX)],
        cash_tables=[{"id": "m1", "organization_id": ORG, "cash_day_id": "d1",
                      "game_type_id": "g1", "table_number": 1, "seats": 9,
                      "small_blind": 1, "big_blind": 2, "status": "closed",
                      "opened_at": f"{QUI1}T21:00:00Z", "closed_at": f"{QUI1}T23:00:00Z"},
                     {"id": "m2", "organization_id": ORG, "cash_day_id": "d2",
                      "game_type_id": "g1", "table_number": 1, "seats": 9,
                      "small_blind": 1, "big_blind": 2, "status": "closed",
                      "opened_at": f"{SEX}T21:00:00Z", "closed_at": f"{SEX}T23:00:00Z"}],
        cash_game_types=[{"id": "g1", "organization_id": ORG, "name": "NLH 1/2"}],
        cash_rake_entries=[_rake("d1", "m1", 130, 26), _rake("d2", "m2", 400, 80)],
        cash_transactions=[
            _tx("d1", "buy_in", 600), _tx("d1", "cash_out", 470),
            _tx("d2", "buy_in", 2000), _tx("d2", "cash_out", 1520),
        ],
        cash_player_sessions=[
            {"id": "s1", "organization_id": ORG, "cash_day_id": "d1", "table_id": "m1",
             "player_id": ANA, "seat_number": 1, "status": "left",
             "started_at": f"{QUI1}T21:30:00Z", "ended_at": f"{QUI1}T23:30:00Z",
             "total_buy_in": 600, "total_cash_out": 470, "result": -130},
            {"id": "s2", "organization_id": ORG, "cash_day_id": "d2", "table_id": "m2",
             "player_id": ANA, "seat_number": 1, "status": "left",
             "started_at": f"{SEX}T21:00:00Z", "ended_at": f"{SEX}T22:00:00Z",
             "total_buy_in": 2000, "total_cash_out": 1520, "result": -480},
        ],
    )


# ══════════════════════════════════════════════════════════════════════
# Série por dia
# ══════════════════════════════════════════════════════════════════════

def test_faturamento_por_dia_e_o_rake(monkeypatch):
    _duas_noites(monkeypatch)
    linhas = CRS.daily()
    por_data = {l["business_date"]: l for l in linhas}
    assert por_data[QUI1]["revenue"] == 130
    assert por_data[SEX]["revenue"] == 400


def test_o_giro_aparece_separado_do_faturamento(monkeypatch):
    """600 entraram na quinta, mas o clube ficou com 130. São dois números
    diferentes e nunca podem ocupar o mesmo campo."""
    _duas_noites(monkeypatch)
    linha = next(l for l in CRS.daily() if l["business_date"] == QUI1)
    assert linha["buy_ins"] == 600
    assert linha["cash_outs"] == 470
    assert linha["revenue"] == 130


def test_jackpot_sai_em_campo_proprio(monkeypatch):
    _duas_noites(monkeypatch)
    linha = next(l for l in CRS.daily() if l["business_date"] == QUI1)
    assert linha["jackpot"] == 26
    assert linha["revenue"] == 130   # e não 156


def test_venda_cancelada_nao_conta_no_giro(monkeypatch):
    fake = _duas_noites(monkeypatch)
    fake.store["cash_transactions"].append(
        _tx("d1", "buy_in", 300, status="cancelled", n=9)
    )
    linha = next(l for l in CRS.daily() if l["business_date"] == QUI1)
    assert linha["buy_ins"] == 600


def test_ordena_do_mais_recente_para_o_mais_antigo(monkeypatch):
    _duas_noites(monkeypatch)
    assert [l["business_date"] for l in CRS.daily()] == [SEX, QUI1]


def test_recorte_de_periodo(monkeypatch):
    _duas_noites(monkeypatch)
    assert [l["business_date"] for l in CRS.daily(SEX, SEX)] == [SEX]


def test_sem_dia_nenhum_devolve_lista_vazia(monkeypatch):
    _banco(monkeypatch)
    assert CRS.daily() == []


# ══════════════════════════════════════════════════════════════════════
# Melhores dias e dia da semana
# ══════════════════════════════════════════════════════════════════════

def test_melhores_dias_ordena_por_rake(monkeypatch):
    """Por buy-ins responderia 'qual noite girou mais dinheiro' — e levaria o
    clube a repetir a noite que movimentou muito e ganhou pouco."""
    fake = _duas_noites(monkeypatch)
    # Uma terceira noite: giro enorme, rake pequeno.
    fake.store["cash_days"].append(_dia("d3", QUI2))
    fake.store["cash_rake_entries"].append(_rake("d3", "m3", 50))
    fake.store["cash_transactions"].append(_tx("d3", "buy_in", 9000))

    melhores = CRS.best_days(limit=3)
    assert [l["business_date"] for l in melhores] == [SEX, QUI1, QUI2]
    # A de maior giro é a ÚLTIMA: ela rendeu menos.
    assert melhores[-1]["buy_ins"] == 9000


def test_media_por_dia_da_semana(monkeypatch):
    """MÉDIA, e não total: o período quase nunca tem o mesmo número de sextas e
    de quintas, e o total premiaria o dia que apareceu mais vezes."""
    fake = _duas_noites(monkeypatch)
    fake.store["cash_days"].append(_dia("d3", QUI2))
    fake.store["cash_rake_entries"].append(_rake("d3", "m3", 70))

    semana = {l["weekday_key"]: l for l in CRS.by_weekday()}
    # Duas quintas: 130 e 70 → média 100 (o total, 200, superaria a sexta).
    assert semana["thu"]["days"] == 2
    assert semana["thu"]["total_revenue"] == 200
    assert semana["thu"]["avg_revenue"] == 100
    # Uma sexta, de 400: ela é a melhor por média, e é a resposta certa.
    assert semana["fri"]["avg_revenue"] == 400


def test_dia_da_semana_sem_operacao_fica_zerado(monkeypatch):
    _duas_noites(monkeypatch)
    semana = {l["weekday_key"]: l for l in CRS.by_weekday()}
    # Todos os sete dias aparecem: o clube precisa ver que a segunda está vazia
    # para decidir se vale abrir.
    assert len(semana) == 7
    assert semana["mon"]["days"] == 0
    assert semana["mon"]["avg_revenue"] == 0


# ══════════════════════════════════════════════════════════════════════
# Por mesa e por jogador
# ══════════════════════════════════════════════════════════════════════

def test_rake_por_mesa(monkeypatch):
    _duas_noites(monkeypatch)
    mesas = CRS.by_table(date_from=QUI1, date_to=SEX)
    assert [m["revenue"] for m in mesas] == [400, 130]   # maior primeiro
    assert mesas[0]["game_type_name"] == "NLH 1/2"
    assert mesas[0]["hours"] == 2.0


def test_jogador_com_volume_e_resultado(monkeypatch):
    """`result` é do JOGADOR. Negativo significa que ele perdeu — não é despesa
    do clube: o dinheiro foi para os outros jogadores da mesa."""
    _duas_noites(monkeypatch)
    jogadores = CRS.by_player(date_from=QUI1, date_to=SEX)
    assert len(jogadores) == 1
    ana = jogadores[0]
    assert ana["player_name"] == "Ana"
    assert ana["sessions"] == 2 and ana["days"] == 2
    assert ana["buy_ins"] == 2600 and ana["cash_outs"] == 1990
    assert ana["result"] == -610


def test_mesa_ainda_aberta_nao_inventa_horas(monkeypatch):
    """Contar até 'agora' faria o número mudar a cada refresh, e dois
    operadores veriam relatórios diferentes do mesmo dia."""
    fake = _duas_noites(monkeypatch)
    for m in fake.store["cash_tables"]:
        m["closed_at"] = None
    assert all(m["hours"] == 0 for m in CRS.by_table(date_from=QUI1, date_to=SEX))


# ══════════════════════════════════════════════════════════════════════
# Jackpot
# ══════════════════════════════════════════════════════════════════════

def test_fundo_vazio_e_zero_nao_erro(monkeypatch):
    _banco(monkeypatch)
    fundo = CJS.get_fund(ORG)
    assert fundo.current_balance == 0


def test_paga_o_jackpot_saindo_da_gaveta(monkeypatch):
    """Baixar só no fundo deixaria o caixa acusando falta sem explicação: o
    operador entregou o dinheiro de verdade."""
    fake = _banco(
        monkeypatch,
        cash_days=[_dia("d1", QUI1, status="open")],
        cash_jackpot_fund=[{"id": "j1", "organization_id": ORG,
                            "current_balance": 500, "total_collected": 500,
                            "total_paid": 0}],
    )
    pago = CJS.pay(
        JackpotPayoutCreate(cash_day_id="d1", player_id=ANA, amount=300,
                            kind="bad_beat", description="Quadra vs straight flush"),
        AUTH, ORG,
    )
    assert pago.amount == 300
    assert pago.player_name == "Ana"

    # A saída existe como movimento de caixa, para entrar na conferência.
    saidas = [t for t in fake.store["cash_transactions"] if t["type"] == "jackpot_payout"]
    assert len(saidas) == 1 and saidas[0]["amount"] == 300
    assert saidas[0]["cashbox_id"] == CAIXA
    assert pago.cash_transaction_id == saidas[0]["id"]


def test_nao_paga_mais_do_que_o_fundo_tem(monkeypatch):
    _banco(
        monkeypatch,
        cash_days=[_dia("d1", QUI1, status="open")],
        cash_jackpot_fund=[{"id": "j1", "organization_id": ORG,
                            "current_balance": 200, "total_collected": 200,
                            "total_paid": 0}],
    )
    with pytest.raises(ErroDeNegocio) as exc:
        CJS.pay(JackpotPayoutCreate(cash_day_id="d1", player_id=ANA, amount=300), AUTH, ORG)
    d = recusa(exc)
    assert d["code"] == "jackpot_saldo_insuficiente"
    # Sem o saldo nomeado, quem está no balcão não saberia quanto pode pagar.
    assert d["disponivel"] == 200 and d["solicitado"] == 300


def test_nao_paga_com_o_dia_fechado(monkeypatch):
    _banco(
        monkeypatch,
        cash_days=[_dia("d1", QUI1, status="closed")],
        cash_jackpot_fund=[{"id": "j1", "organization_id": ORG,
                            "current_balance": 500, "total_collected": 500,
                            "total_paid": 0}],
    )
    with pytest.raises(ErroDeNegocio) as exc:
        CJS.pay(JackpotPayoutCreate(cash_day_id="d1", player_id=ANA, amount=100), AUTH, ORG)
    assert recusa(exc)["code"] == "dia_nao_aberto"


# ══════════════════════════════════════════════════════════════════════
# DRE
# ══════════════════════════════════════════════════════════════════════

def _dre_so_cash(monkeypatch, fake):
    """O DRE de um clube que NÃO tem torneio nenhum."""
    monkeypatch.setattr(fin_mod, "supabase", fake)
    monkeypatch.setattr(ExpenseService, "summarize", staticmethod(
        lambda *a, **k: {"total": 1000.0, "paid": 1000.0, "pending": 0.0, "by_category": []}))
    monkeypatch.setattr(ExpenseService, "summarize_revenues", staticmethod(
        lambda *a, **k: {"total": 0.0, "received": 0.0, "pending": 0.0, "by_source": []}))
    monkeypatch.setattr(ExpenseService, "guarantee_committed", staticmethod(lambda *a, **k: 0.0))
    return FS.get_financial_summary(stage_id="etapa-vazia", organization_id=ORG)


def test_dre_do_clube_so_cash_nao_e_zero(monkeypatch):
    """Ele cai SEMPRE no ramo de 'etapa sem torneios' — que era o caminho que
    devolvia tudo zerado. Sem isto, o único DRE que ele tem mostraria nada."""
    fake = _duas_noites(monkeypatch)
    fake.store["tournaments"] = []
    resumo = _dre_so_cash(monkeypatch, fake)

    assert resumo.cash_revenue == 530          # 130 + 400 de rake
    assert resumo.gross_revenue == 530
    assert resumo.rake == 530
    # 530 de receita menos 1000 de despesa: o clube deu prejuízo, e o DRE diz.
    assert resumo.net_result == -470


def test_dre_nao_conta_buy_in_como_receita(monkeypatch):
    """2600 passaram pela gaveta. Somá-los multiplicaria a receita por cinco."""
    fake = _duas_noites(monkeypatch)
    fake.store["tournaments"] = []
    resumo = _dre_so_cash(monkeypatch, fake)

    assert resumo.cash_buy_ins == 2600
    assert resumo.cash_cash_outs == 1990
    assert resumo.gross_revenue == 530


def test_dre_deixa_o_jackpot_fora_do_resultado(monkeypatch):
    """106 de jackpot acumulado é PASSIVO: o clube vai devolver."""
    fake = _duas_noites(monkeypatch)
    fake.store["tournaments"] = []
    resumo = _dre_so_cash(monkeypatch, fake)

    assert resumo.cash_jackpot_collected == 106   # 26 + 80
    assert resumo.gross_revenue == 530            # e não 636
    assert resumo.net_result == -470


def test_dre_nao_cai_se_o_cash_nao_foi_migrado(monkeypatch):
    """O deploy do código precede o da migração. Nesse intervalo `cash_days`
    não existe — e o DRE do clube de TORNEIO não pode parar de abrir."""
    class BancoSemCash:
        def __init__(self, real):
            self._real = real

        def table(self, nome):
            if nome.startswith("cash_"):
                raise RuntimeError("Could not find the table 'public.cash_days'")
            return self._real.table(nome)

        def rpc(self, *a, **k):
            raise RuntimeError("RPC ausente")

    fake = _duas_noites(monkeypatch)
    fake.store["tournaments"] = []
    monkeypatch.setattr(rel_mod, "supabase", BancoSemCash(fake))

    resumo = _dre_so_cash(monkeypatch, fake)
    assert resumo.cash_revenue == 0
    assert resumo.net_result == -1000    # só as despesas
