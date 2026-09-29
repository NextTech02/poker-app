"""O DINHEIRO do cash game: sentar, recomprar, levantar e estornar.

O que estes testes travam, e que uma refatoração distraída desfaz:

1. **A cadeira é recurso físico disputado.** Dois caixas atendendo com a tela
   recarregando a cada 5s têm janela de sobra para sentar duas pessoas no mesmo
   lugar. A tomada é um compare-and-set; quem perde a corrida não pode ter
   deixado sessão nem venda para trás.
2. **O jogador não senta em duas mesas ao mesmo tempo.** Duas sessões ativas
   acumulariam buy-in em paralelo e o resultado da noite dele viraria ficção.
3. **Sentar e pagar são um passo só.** Cadeira ocupada por alguém sem fichas é
   um estado que não existe na mesa real.
4. **Os limites de buy-in são os da MESA** (o retrato da abertura), não os da
   modalidade de hoje.
5. **O teto NÃO se aplica à recompra.** No cash ele limita quanto o jogador põe
   na mesa ao SENTAR; a recompra repõe fichas perdidas, e validar aqui impediria
   o jogador de voltar ao teto.
6. **Cash-out de zero é válido.** Quem perdeu tudo levanta do mesmo jeito, e a
   sessão precisa fechar.
7. **Idempotência.** Duplo clique e retry acontecem com rede boa; cobrar duas
   vezes pelo mesmo buy-in é o erro mais caro que o caixa comete.
8. **Estorno é lógico e guardado pelo EFEITO.** Um estorno interrompido no meio
   precisa ser retomável, senão vira permanente: a segunda tentativa veria "já
   cancelada" e responderia sucesso com o caixa inflado.
"""
import pytest

from app.models.cash_game import CashRebuy, SitPlayer, StandPlayer
from app.services import cash_day_service as dia_mod
from app.services import cash_table_service as mesa_mod
from app.services import cash_transaction_service as tx_mod
from app.services import cashbox_service as caixa_mod
from app.services.cash_transaction_service import CashTransactionService as CTS
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
AUTH = "88888888-8888-8888-8888-888888888888"
STAFF = "99999999-9999-9999-9999-999999999999"
DIA = "d1111111-1111-1111-1111-111111111111"
MESA = "1a111111-1111-1111-1111-111111111111"
CAIXA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1"
JOGADOR = "44444444-4444-4444-4444-444444444444"
OUTRO = "44444444-4444-4444-4444-444444444445"


def recusa(exc):
    return exc.value.como_http().detail


def _mesa(status="open", **extra):
    linha = {
        "id": MESA, "organization_id": ORG, "cash_day_id": DIA,
        "game_type_id": "tipo", "table_number": 1, "seats": 9,
        "game_variant": "nlh", "small_blind": 1, "big_blind": 2, "ante": 0,
        "min_buy_in": 100, "max_buy_in": 400, "rake_percent": 5,
        "rake_cap": 10, "jackpot_per_pot": 1, "status": status,
        "opened_at": "2026-09-10T21:00:00Z",
    }
    linha.update(extra)
    return linha


def _assentos(ocupado=None):
    return [
        {"id": f"a{n}", "organization_id": ORG, "table_id": MESA, "seat_number": n,
         "status": "occupied" if n == ocupado else "free",
         "player_session_id": None, "reserved_for": None, "reserved_until": None,
         "updated_at": "2026-09-10T21:00:00Z"}
        for n in range(1, 10)
    ]


def _sessao(id_="s1", jogador=JOGADOR, status="active", assento=3, **extra):
    linha = {
        "id": id_, "organization_id": ORG, "cash_day_id": DIA, "table_id": MESA,
        "player_id": jogador, "seat_number": assento, "status": status,
        "started_at": "2026-09-10T21:30:00Z", "total_buy_in": 200,
        "total_cash_out": 0, "result": 0,
    }
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
        "cash_rake_entries": [],
        "cash_game_types": [],
        "players": [{"id": JOGADOR, "name": "Ana", "nickname": None},
                    {"id": OUTRO, "name": "Bruno", "nickname": None}],
        # A gaveta do operador é POR DIA no cash — a mesma máquina de
        # cashbox_sessions do torneio, noutra âncora.
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
    for mod in (tx_mod, mesa_mod, dia_mod, caixa_mod):
        monkeypatch.setattr(mod, "supabase", fake)
    return fake


# ══════════════════════════════════════════════════════════════════════
# Sentar
# ══════════════════════════════════════════════════════════════════════

def test_senta_e_vende_as_fichas_num_passo(monkeypatch):
    fake = _banco(monkeypatch)
    r = CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)

    assert r.player_session.seat_number == 3
    assert r.transaction.type == "buy_in"
    assert r.transaction.amount == 200
    assento = next(a for a in fake.store["cash_seats"] if a["seat_number"] == 3)
    assert assento["status"] == "occupied"
    assert assento["player_session_id"] == r.player_session.id


def test_recusa_assento_ja_ocupado(monkeypatch):
    _banco(monkeypatch, cash_seats=_assentos(ocupado=3))
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)
    d = recusa(exc)
    assert d["code"] == "assento_ocupado"
    assert d["seat_number"] == 3
    assert exc.value.status == 409


def test_perder_a_corrida_pelo_assento_nao_deixa_lixo(monkeypatch):
    """A tomada é compare-and-set. Quem perde não pode ter criado sessão nem
    venda — senão sobraria um jogador 'sentado' que ninguém vê na mesa."""
    fake = _banco(monkeypatch)
    # Simula a outra requisição chegando entre a leitura e a escrita.
    original = tx_mod.CashTransactionService._assento

    def _assento_que_some(table_id, seat_number):
        linha = original(table_id, seat_number)
        for a in fake.store["cash_seats"]:
            if a["seat_number"] == seat_number:
                a["status"] = "occupied"
        return dict(linha, status="free")

    monkeypatch.setattr(tx_mod.CashTransactionService, "_assento",
                        staticmethod(_assento_que_some))

    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)
    assert recusa(exc)["code"] == "assento_ocupado"
    assert fake.store["cash_player_sessions"] == []
    assert fake.store["cash_transactions"] == []


def test_recusa_assento_inexistente(monkeypatch):
    _banco(monkeypatch)
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 42, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)
    assert recusa(exc)["code"] == "assento_invalido"


def test_recusa_jogador_ja_sentado(monkeypatch):
    _banco(monkeypatch, cash_player_sessions=[_sessao()])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 5, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)
    d = recusa(exc)
    assert d["code"] == "jogador_ja_sentado"
    assert d["player_session_id"] == "s1"


def test_jogador_que_ja_levantou_pode_voltar(monkeypatch):
    _banco(monkeypatch, cash_player_sessions=[_sessao(status="left")])
    r = CTS.sit(MESA, 5, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)
    assert r.player_session.status == "active"


def test_buy_in_abaixo_do_minimo(monkeypatch):
    _banco(monkeypatch)
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=50), AUTH, ORG)
    d = recusa(exc)
    assert d["code"] == "buy_in_abaixo_do_minimo"
    # Os números vão nomeados: a tela remonta a frase no idioma dela e o
    # operador vê quanto falta sem abrir a configuração.
    assert d["minimo"] == 100 and d["solicitado"] == 50


def test_buy_in_acima_do_maximo(monkeypatch):
    _banco(monkeypatch)
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=900), AUTH, ORG)
    d = recusa(exc)
    assert d["code"] == "buy_in_acima_do_maximo"
    assert d["maximo"] == 400 and d["solicitado"] == 900


def test_mesa_sem_teto_aceita_qualquer_valor(monkeypatch):
    _banco(monkeypatch, cash_tables=[_mesa(max_buy_in=None)])
    r = CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=5000), AUTH, ORG)
    assert r.transaction.amount == 5000


def test_nao_senta_com_o_caixa_fechado(monkeypatch):
    """A venda não pode existir sem gaveta aberta: o dinheiro entraria no
    sistema sem entrar em conferência nenhuma."""
    _banco(monkeypatch, cashboxes=[{"id": CAIXA, "staff_id": STAFF, "cash_day_id": DIA,
                                    "stage_id": None, "status": "closed",
                                    "current_balance": 0,
                                    "created_at": "2026-09-10T21:00:00Z"}])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)
    assert recusa(exc)["code"] == "caixa_fechado"


def test_nao_senta_em_mesa_fechada(monkeypatch):
    _banco(monkeypatch, cash_tables=[_mesa(status="closed")])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)
    assert recusa(exc)["code"] == "mesa_ja_fechada"


# ══════════════════════════════════════════════════════════════════════
# Idempotência
# ══════════════════════════════════════════════════════════════════════

def test_duplo_clique_nao_cobra_duas_vezes(monkeypatch):
    fake = _banco(monkeypatch)
    dados = SitPlayer(player_id=JOGADOR, buy_in_amount=200, client_mutation_id="m-1")
    primeira = CTS.sit(MESA, 3, dados, AUTH, ORG)
    segunda = CTS.sit(MESA, 3, dados, AUTH, ORG)

    assert primeira.transaction.id == segunda.transaction.id
    assert len(fake.store["cash_transactions"]) == 1
    assert len(fake.store["cash_player_sessions"]) == 1


def test_recompra_repetida_nao_duplica(monkeypatch):
    fake = _banco(monkeypatch, cash_player_sessions=[_sessao()])
    dados = CashRebuy(amount=100, client_mutation_id="m-2")
    a = CTS.rebuy("s1", dados, AUTH, ORG)
    b = CTS.rebuy("s1", dados, AUTH, ORG)
    assert a.id == b.id
    assert len(fake.store["cash_transactions"]) == 1


# ══════════════════════════════════════════════════════════════════════
# Recompra
# ══════════════════════════════════════════════════════════════════════

def test_recompra_gera_lancamento(monkeypatch):
    _banco(monkeypatch, cash_player_sessions=[_sessao()])
    tx = CTS.rebuy("s1", CashRebuy(amount=100), AUTH, ORG)
    assert tx.type == "rebuy"
    assert tx.amount == 100
    assert tx.player_id == JOGADOR


def test_recompra_ignora_o_teto_da_mesa(monkeypatch):
    """O teto limita quanto o jogador põe na mesa ao SENTAR. A recompra repõe
    fichas perdidas — validar aqui o impediria de voltar ao teto."""
    _banco(monkeypatch, cash_player_sessions=[_sessao()])
    tx = CTS.rebuy("s1", CashRebuy(amount=400), AUTH, ORG)
    assert tx.amount == 400


def test_nao_recompra_para_quem_ja_levantou(monkeypatch):
    _banco(monkeypatch, cash_player_sessions=[_sessao(status="left")])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.rebuy("s1", CashRebuy(amount=100), AUTH, ORG)
    d = recusa(exc)
    assert d["code"] == "sessao_de_jogador_encerrada"
    assert d["status_atual"] == "left"


# ══════════════════════════════════════════════════════════════════════
# Levantar
# ══════════════════════════════════════════════════════════════════════

def test_levanta_paga_e_libera_a_cadeira(monkeypatch):
    fake = _banco(monkeypatch)
    r = CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)
    sessao = CTS.stand(r.player_session.id, StandPlayer(cash_out_amount=250), AUTH, ORG)

    assert sessao.status == "left"
    assert sessao.ended_at is not None
    assento = next(a for a in fake.store["cash_seats"] if a["seat_number"] == 3)
    assert assento["status"] == "free"
    assert assento["player_session_id"] is None
    saidas = [t for t in fake.store["cash_transactions"] if t["type"] == "cash_out"]
    assert len(saidas) == 1 and saidas[0]["amount"] == 250


def test_levantar_sem_nada_e_valido(monkeypatch):
    """Quem perdeu tudo levanta do mesmo jeito — e sem gerar um lançamento de
    valor zero, que o banco recusa e que não significaria nada."""
    fake = _banco(monkeypatch)
    r = CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)
    sessao = CTS.stand(r.player_session.id, StandPlayer(cash_out_amount=0), AUTH, ORG)

    assert sessao.status == "left"
    assert [t for t in fake.store["cash_transactions"] if t["type"] == "cash_out"] == []
    assento = next(a for a in fake.store["cash_seats"] if a["seat_number"] == 3)
    assert assento["status"] == "free"


def test_nao_levanta_duas_vezes(monkeypatch):
    _banco(monkeypatch, cash_player_sessions=[_sessao(status="left")])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.stand("s1", StandPlayer(cash_out_amount=100), AUTH, ORG)
    assert recusa(exc)["code"] == "sessao_de_jogador_encerrada"


def test_cash_out_acima_do_saldo_da_gaveta_e_recusado(monkeypatch):
    """A gaveta paga em dinheiro vivo: não sai mais do que tem. Nada é gravado
    e o jogador continua sentado — o caixa precisa reforçar antes."""
    fake = _banco(monkeypatch, cash_player_sessions=[_sessao()])
    with pytest.raises(ErroDeNegocio) as exc:
        CTS.stand("s1", StandPlayer(cash_out_amount=500.01), AUTH, ORG)
    d = recusa(exc)
    assert d["code"] == "saldo_insuficiente_no_caixa"
    assert d["disponivel"] == 500 and d["solicitado"] == 500.01
    assert fake.store["cash_transactions"] == []
    assert fake.store["cash_player_sessions"][0]["status"] == "active"


def test_cash_out_igual_ao_saldo_passa(monkeypatch):
    fake = _banco(monkeypatch, cash_player_sessions=[_sessao()])
    CTS.stand("s1", StandPlayer(cash_out_amount=500), AUTH, ORG)
    assert [t["amount"] for t in fake.store["cash_transactions"]] == [500]


def test_recusa_do_trigger_da_gaveta_vira_erro_com_nome():
    """Dois levantes simultâneos: o segundo passa na checagem do serviço e é
    barrado pelo FOR UPDATE no banco — a tela recebe a mesma recusa."""
    erro = Exception(
        "{'message': 'REGRA_CAIXA:saldo_insuficiente_no_caixa "
        "disponivel=120.00 solicitado=300.00', 'code': 'P0001'}"
    )
    with pytest.raises(ErroDeNegocio) as exc:
        tx_mod._traduzir_erro_do_banco(erro)
    d = recusa(exc)
    assert d["code"] == "saldo_insuficiente_no_caixa"
    assert d["disponivel"] == 120.0 and d["solicitado"] == 300.0


def test_outro_erro_do_banco_sobe_como_veio():
    erro = RuntimeError("connection reset")
    with pytest.raises(RuntimeError):
        tx_mod._traduzir_erro_do_banco(erro)


# ══════════════════════════════════════════════════════════════════════
# Estorno
# ══════════════════════════════════════════════════════════════════════

def test_estorno_devolve_o_dinheiro_na_gaveta(monkeypatch):
    fake = _banco(monkeypatch)
    r = CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)

    tx = CTS.cancel(r.transaction.id, "valor digitado errado", AUTH)
    assert tx.status == "cancelled"
    assert tx.cancel_reason == "valor digitado errado"

    estornos = [t for t in fake.store["cashbox_transactions"] if t["type"] == "refund"]
    assert len(estornos) == 1
    # Sinal negativo: o dinheiro SAI da gaveta e volta para o jogador.
    assert estornos[0]["signed_amount"] == -200
    assert estornos[0]["cash_transaction_id"] == r.transaction.id


def test_estorno_e_retomavel_sem_duplicar(monkeypatch):
    """A guarda é o EFEITO (o recibo existe no banco?), não um marcador. Repetir
    o cancelamento não pode lançar um segundo estorno."""
    fake = _banco(monkeypatch)
    r = CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)

    CTS.cancel(r.transaction.id, "motivo", AUTH)
    CTS.cancel(r.transaction.id, "motivo", AUTH)

    estornos = [t for t in fake.store["cashbox_transactions"] if t["type"] == "refund"]
    assert len(estornos) == 1


def test_estorno_interrompido_retoma_o_que_faltou(monkeypatch):
    """Sem a retomada, um estorno pela metade viraria permanente: a segunda
    tentativa veria 'já cancelada' e responderia sucesso com o caixa inflado."""
    fake = _banco(monkeypatch)
    r = CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)

    # Estado de um cancelamento que morreu antes de lançar o estorno.
    for t in fake.store["cash_transactions"]:
        if t["id"] == r.transaction.id:
            t["status"] = "cancelling"
            t["cancel_steps"] = []

    CTS.cancel(r.transaction.id, "retomada", AUTH)
    estornos = [t for t in fake.store["cashbox_transactions"] if t["type"] == "refund"]
    assert len(estornos) == 1


def test_cash_out_nao_e_estornavel(monkeypatch):
    """Desfazer uma SAÍDA exigiria o dinheiro de volta na gaveta — e isso é uma
    entrada de verdade, que alguém precisa contar. Corrige-se com lançamento
    novo, não com estorno."""
    fake = _banco(monkeypatch)
    r = CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)
    CTS.stand(r.player_session.id, StandPlayer(cash_out_amount=250), AUTH, ORG)
    saida = next(t for t in fake.store["cash_transactions"] if t["type"] == "cash_out")

    with pytest.raises(ErroDeNegocio) as exc:
        CTS.cancel(saida["id"], "errei", AUTH)
    d = recusa(exc)
    assert d["code"] == "cash_out_nao_cancelavel"
    assert d["tipo"] == "cash_out"


def test_estorno_de_venda_ja_cancelada_e_inofensivo(monkeypatch):
    fake = _banco(monkeypatch)
    r = CTS.sit(MESA, 3, SitPlayer(player_id=JOGADOR, buy_in_amount=200), AUTH, ORG)
    CTS.cancel(r.transaction.id, "motivo", AUTH)
    tx = CTS.cancel(r.transaction.id, "de novo", AUTH)
    assert tx.status == "cancelled"
    assert len([t for t in fake.store["cashbox_transactions"] if t["type"] == "refund"]) == 1
