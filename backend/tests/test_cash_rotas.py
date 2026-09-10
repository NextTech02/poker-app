"""As ROTAS de cash game: fiação e tradução de recusa em status HTTP.

Os routers deste projeto são casca fina — validam a entrada, chamam o service e
traduzem a recusa. A regra de negócio tem teste próprio no nível do service
(test_cash_dia / test_cash_mesas / test_cash_dinheiro). O que se testa aqui:

1. **Que a rota existe e chama o service certo.** Um prefixo trocado ou uma
   ordem de rota errada só aparece em produção.
2. **Que o `da_excecao` respeita o status que a REGRA escolheu.** 409 briga com
   o que já está lá, 404 não existe, 400 é regra de negócio — antes tudo virava
   400 na saída, e a tela não conseguia distinguir.
3. **Que o `detail` estruturado chega inteiro**, com os dados nomeados. É esse
   contrato que deixa a tela escolher a frase no idioma do clube.

ORDEM DE ROTA: `/days/current` precisa ser declarada ANTES de `/days/{id}`,
senão "current" é lido como um identificador e a tela do salão recebe 404 no
primeiro carregamento. O teste abaixo trava isso.
"""
import pytest

from app.services.cash_day_service import CashDayService
from app.services.cash_table_service import CashTableService
from app.services.cash_transaction_service import CashTransactionService
from app.models.cash_game import CashDayResponse
from app.utils.erros import ErroDeNegocio


DIA = "d1111111-1111-1111-1111-111111111111"
MESA = "1a111111-1111-1111-1111-111111111111"


def _dia_resposta(status="open"):
    return CashDayResponse(
        id=DIA, business_date="2026-09-10", status=status,
        opened_at="2026-09-10T21:00:00Z",
    )


# ══════════════════════════════════════════════════════════════════════
# Dia
# ══════════════════════════════════════════════════════════════════════

def test_dia_corrente_nao_e_lido_como_id(client, stub):
    """Se `/days/{id}` viesse antes na declaração, "current" viraria um
    identificador e a tela do salão tomaria 404 ao abrir."""
    stub(CashDayService, get_current=lambda org=None: _dia_resposta())
    resp = client.get("/cash-game/days/current")
    assert resp.status_code == 200
    assert resp.json()["id"] == DIA


def test_sem_dia_aberto_responde_nulo(client, stub):
    # Nulo, não 404: "não há operação agora" é uma resposta legítima, e a tela
    # usa ela para oferecer o botão de abrir o dia.
    stub(CashDayService, get_current=lambda org=None: None)
    resp = client.get("/cash-game/days/current")
    assert resp.status_code == 200
    assert resp.json() is None


def test_abrir_dia_repetido_vira_409(client, stub):
    def _recusa(data, auth=None, org=None):
        raise ErroDeNegocio(
            "dia_ja_aberto", "Já existe um dia aberto.", status=409,
            cash_day_id=DIA, business_date="2026-09-10",
        )

    stub(CashDayService, open_day=_recusa)
    resp = client.post("/cash-game/days", json={"business_date": "2026-09-11"})
    assert resp.status_code == 409
    d = resp.json()["detail"]
    assert d["code"] == "dia_ja_aberto"
    # Os dados nomeados sobrevivem à travessia: é com eles que a tela leva o
    # operador ao dia que precisa fechar.
    assert d["cash_day_id"] == DIA
    assert d["business_date"] == "2026-09-10"


def test_dia_inexistente_vira_404(client, stub):
    def _recusa(cash_day_id):
        raise ErroDeNegocio("dia_nao_encontrado", "Não encontrado.", status=404)

    stub(CashDayService, get_day=_recusa)
    resp = client.get(f"/cash-game/days/{DIA}")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "dia_nao_encontrado"


def test_fechar_dia_com_mesa_aberta_vira_409(client, stub):
    def _recusa(cash_day_id, auth=None, notes=None):
        raise ErroDeNegocio(
            "dia_com_mesa_aberta", "Feche as mesas.", status=409,
            mesas=[3, 5], quantidade=2,
        )

    stub(CashDayService, close_day=_recusa)
    resp = client.post(f"/cash-game/days/{DIA}/close", json={})
    assert resp.status_code == 409
    d = resp.json()["detail"]
    assert d["mesas"] == [3, 5] and d["quantidade"] == 2


# ══════════════════════════════════════════════════════════════════════
# Mesa
# ══════════════════════════════════════════════════════════════════════

def test_numero_de_mesa_repetido_vira_409(client, stub):
    def _recusa(data, auth=None, org=None):
        raise ErroDeNegocio(
            "numero_de_mesa_em_uso", "Já existe mesa com este número.",
            status=409, table_number=3,
        )

    stub(CashTableService, open_table=_recusa)
    resp = client.post("/cash-game/tables", json={
        "cash_day_id": DIA, "game_type_id": "t1", "table_number": 3,
    })
    assert resp.status_code == 409
    assert resp.json()["detail"]["table_number"] == 3


def test_fechar_mesa_exige_o_rake_contado(client):
    """`rake_amount` é obrigatório: fechar sem informar deixaria a receita da
    noite em zero e ninguém perceberia até o relatório do mês."""
    resp = client.post(f"/cash-game/tables/{MESA}/close", json={})
    assert resp.status_code == 422


def test_rake_negativo_e_recusado_na_entrada(client):
    resp = client.post(f"/cash-game/tables/{MESA}/close",
                       json={"rake_amount": -10})
    assert resp.status_code == 422


# ══════════════════════════════════════════════════════════════════════
# Dinheiro
# ══════════════════════════════════════════════════════════════════════

def test_assento_ocupado_vira_409(client, stub):
    def _recusa(table_id, seat_number, data, auth=None, org=None):
        raise ErroDeNegocio(
            "assento_ocupado", "Lugar ocupado.", status=409, seat_number=3
        )

    stub(CashTransactionService, sit=_recusa)
    resp = client.post(f"/cash-game/tables/{MESA}/seats/3/sit",
                       json={"player_id": "p1", "buy_in_amount": 200})
    assert resp.status_code == 409
    assert resp.json()["detail"]["seat_number"] == 3


def test_buy_in_fora_da_faixa_leva_os_numeros_ate_a_tela(client, stub):
    def _recusa(table_id, seat_number, data, auth=None, org=None):
        raise ErroDeNegocio(
            "buy_in_abaixo_do_minimo", "Abaixo do mínimo.",
            minimo=100, solicitado=50,
        )

    stub(CashTransactionService, sit=_recusa)
    resp = client.post(f"/cash-game/tables/{MESA}/seats/3/sit",
                       json={"player_id": "p1", "buy_in_amount": 50})
    assert resp.status_code == 400
    d = resp.json()["detail"]
    # Sem estes números a tela traduzida só diria "valor inválido", e o
    # operador teria que abrir a configuração da mesa para descobrir o mínimo.
    assert d["minimo"] == 100 and d["solicitado"] == 50


def test_buy_in_zero_e_recusado_na_entrada(client):
    resp = client.post(f"/cash-game/tables/{MESA}/seats/3/sit",
                       json={"player_id": "p1", "buy_in_amount": 0})
    assert resp.status_code == 422


def test_cash_out_zero_e_aceito(client, stub):
    """Quem perdeu tudo levanta do mesmo jeito — a validação de entrada não
    pode bloquear o caso mais comum da mesa."""
    from app.models.cash_game import CashPlayerSessionResponse

    stub(CashTransactionService, stand=lambda ps, data, auth=None, org=None:
         CashPlayerSessionResponse(
             id="s1", cash_day_id=DIA, table_id=MESA, player_id="p1",
             seat_number=3, status="left", started_at="2026-09-10T21:30:00Z",
         ))
    resp = client.post("/cash-game/player-sessions/s1/stand",
                       json={"cash_out_amount": 0})
    assert resp.status_code == 200
    assert resp.json()["status"] == "left"


def test_cancelamento_exige_motivo(client):
    """O motivo é o que explica a diferença no fechamento do caixa. Sem ele o
    conferente vê dinheiro a menos e nenhuma justificativa."""
    resp = client.post("/cash-game/transactions/t1/cancel", json={})
    assert resp.status_code == 422

    curto = client.post("/cash-game/transactions/t1/cancel", json={"reason": "x"})
    assert curto.status_code == 422
