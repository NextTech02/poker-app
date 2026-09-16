"""As ROTAS do bar: fiação, guarda de módulo e tradução de recusa em status.

Os routers deste projeto são casca fina; a regra tem teste próprio no nível
do service (test_bar_turno / test_bar_produtos / test_bar_comandas /
test_bar_pagamentos). O que se testa aqui:

1. **`/shifts/current` antes de `/shifts/{id}`** — senão "current" vira id e a
   POS toma 404 no primeiro carregamento.
2. **Módulo não contratado → 403 `modulo_nao_contratado`** com `modulo='bar'`.
3. **O `detail` estruturado chega inteiro**, com os dados nomeados que a tela
   usa para escolher a frase.
4. **Cancelar item entregue passa o cargo para o serviço** (a mesma URL serve
   operador e gerente).
"""
import pytest

from app.models.bar import BarShiftResponse, BarTabDetail, BarTabResponse
from app.services.bar_shift_service import BarShiftService
from app.services.bar_tab_service import BarTabService
from app.services.module_service import ModuleService
from app.utils.erros import ErroDeNegocio


TURNO = "b1111111-1111-1111-1111-111111111111"
COMANDA = "c1111111-1111-1111-1111-111111111111"


def _turno_resposta(status="open"):
    return BarShiftResponse(
        id=TURNO, business_date="2026-09-16", status=status, opened_at="2026-09-16T19:00:00Z",
    )


def _comanda_resposta(**extra):
    base = dict(id=COMANDA, bar_shift_id=TURNO, player_id="j1", number=1, status="open",
                opened_at="2026-09-16T20:00:00Z")
    base.update(extra)
    return BarTabResponse(**base)


def test_turno_corrente_nao_e_lido_como_id(client, stub):
    stub(BarShiftService, get_current=lambda org=None: _turno_resposta())
    resp = client.get("/bar/shifts/current")
    assert resp.status_code == 200
    assert resp.json()["id"] == TURNO


def test_sem_turno_aberto_responde_nulo(client, stub):
    stub(BarShiftService, get_current=lambda org=None: None)
    resp = client.get("/bar/shifts/current")
    assert resp.status_code == 200 and resp.json() is None


def test_modulo_nao_contratado_da_403(client, stub, monkeypatch):
    monkeypatch.setattr(ModuleService, "list_for_org", staticmethod(lambda org: ["tournament"]))
    resp = client.get("/bar/shifts/current")
    assert resp.status_code == 403
    d = resp.json()["detail"]
    assert d["code"] == "modulo_nao_contratado" and d["modulo"] == "bar"


def test_fechar_turno_com_comanda_aberta_vira_409_com_a_lista(client, stub):
    def _recusa(bar_shift_id, auth=None, notes=None):
        raise ErroDeNegocio(
            "turno_com_comanda_aberta", "Há comandas abertas.", status=409,
            comandas=[{"id": COMANDA, "number": 4, "player_name": "Ana", "balance_due": 5.0}],
            quantidade=1,
        )
    stub(BarShiftService, close_shift=_recusa)
    resp = client.post(f"/bar/shifts/{TURNO}/close", json={})
    assert resp.status_code == 409
    d = resp.json()["detail"]
    assert d["code"] == "turno_com_comanda_aberta"
    assert d["comandas"][0]["number"] == 4 and d["quantidade"] == 1


def test_abrir_comanda_devolve_a_comanda(client, stub):
    stub(BarTabService, open_tab=lambda data, auth=None, org=None: _comanda_resposta())
    resp = client.post("/bar/tabs/open", json={"player_id": "j1"})
    assert resp.status_code == 200
    assert resp.json()["number"] == 1


def test_pagamento_acima_do_saldo_vira_400_com_os_numeros(client, stub):
    def _recusa(tab_id, data, auth=None, org=None):
        raise ErroDeNegocio("pagamento_acima_do_saldo", "Excede.", saldo=30.0, solicitado=60.0)
    stub(BarTabService, pay=_recusa)
    resp = client.post(f"/bar/tabs/{COMANDA}/payments",
                       json={"legs": [{"payment_method": "pix", "amount": 60}]})
    assert resp.status_code == 400
    d = resp.json()["detail"]
    assert d["code"] == "pagamento_acima_do_saldo" and d["saldo"] == 30 and d["solicitado"] == 60


def test_cancelar_item_passa_o_cargo_para_o_servico(client, stub):
    recebido = {}

    def _cancel(tab_id, item_id, reason, auth=None, pode_admin=False):
        recebido["pode_admin"] = pode_admin
        return BarTabDetail(tab=_comanda_resposta())

    stub(BarTabService, cancel_item=_cancel)
    resp = client.post(f"/bar/tabs/{COMANDA}/items/i1/cancel", json={"reason": "x"})
    assert resp.status_code == 200
    # A fixture `client` é admin: o serviço recebe True.
    assert recebido["pode_admin"] is True


def test_pedidos_pendentes_exigem_o_turno(client, stub):
    stub(BarTabService, pending_orders=lambda org, shift: [])
    assert client.get("/bar/orders").status_code == 422
    assert client.get(f"/bar/orders?bar_shift_id={TURNO}").status_code == 200


def test_comanda_inexistente_vira_404(client, stub):
    def _recusa(tab_id):
        raise ErroDeNegocio("comanda_nao_encontrada", "Não encontrada.", status=404)
    stub(BarTabService, detail=_recusa)
    resp = client.get(f"/bar/tabs/{COMANDA}")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "comanda_nao_encontrada"
