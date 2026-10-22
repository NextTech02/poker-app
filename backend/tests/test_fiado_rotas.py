"""As ROTAS do fiado: quem pode o quê.

A gestão (habilitar, limite, baixa, estorno de recebimento, devedores,
configuração) é do gerente — `fiado.manage`. O banco também recusa essas
escritas vindas do usuário, mas a recusa com nome é aqui. Receber é de quem
opera uma gaveta de cash ou de bar.
"""
from app.models.house_credit import HouseCreditAccount, HouseCreditDebtors
from app.models.staff import MyPermissions
from app.services.house_credit_service import HouseCreditService
from app.services.staff_service import StaffService

JOGADOR = "44444444-4444-4444-4444-444444444444"


def _com(monkeypatch, *perms):
    monkeypatch.setattr(
        StaffService, "get_my_permissions",
        staticmethod(lambda uid: MyPermissions(is_admin=False, permissions=list(perms))),
    )


def test_operador_nao_habilita_nem_da_baixa(client, monkeypatch, stub):
    _com(monkeypatch, "cash.operate")
    chamadas = []
    stub(HouseCreditService,
         upsert_account=lambda *a, **k: chamadas.append("upsert"),
         write_off=lambda *a, **k: chamadas.append("baixa"),
         reverse_payment=lambda *a, **k: chamadas.append("estorno"),
         debtors=lambda *a, **k: chamadas.append("devedores"))
    assert client.put(f"/house-credit/players/{JOGADOR}", json={"enabled": True, "credit_limit": 500}).status_code == 403
    assert client.post(f"/house-credit/players/{JOGADOR}/write-offs", json={"amount": 10, "reason": "amigo"}).status_code == 403
    assert client.post("/house-credit/entries/e1/reverse", json={"reason": "errei"}).status_code == 403
    assert client.get("/house-credit/debtors").status_code == 403
    assert client.put("/house-credit/settings", json={"due_days": 30, "block_overdue": True}).status_code == 403
    assert chamadas == []


def test_gerente_habilita(client, monkeypatch, stub):
    _com(monkeypatch, "fiado.manage")
    stub(HouseCreditService, upsert_account=lambda pid, data, uid, org: HouseCreditAccount(
        player_id=pid, exists=True, enabled=data.enabled, credit_limit=data.credit_limit,
        available=data.credit_limit))
    r = client.put(f"/house-credit/players/{JOGADOR}", json={"enabled": True, "credit_limit": 500})
    assert r.status_code == 200
    assert r.json()["available"] == 500


def test_gerente_ve_devedores(client, monkeypatch, stub):
    _com(monkeypatch, "fiado.manage")
    stub(HouseCreditService, debtors=lambda org=None: HouseCreditDebtors(rows=[], total_open=0))
    assert client.get("/house-credit/debtors").status_code == 200


def test_recebe_quem_opera_caixa_de_cash_ou_de_bar(client, monkeypatch, stub):
    recebidos = []

    def receber(pid, data, uid, org):
        recebidos.append(data.amount)
        raise ValueError("parou aqui")   # só a fiação importa neste teste
    stub(HouseCreditService, receive_payment=receber)
    for perm in ("cash.operate", "bar.operate"):
        _com(monkeypatch, perm)
        r = client.post(f"/house-credit/players/{JOGADOR}/payments",
                        json={"amount": 50, "cash_day_id": "d1"})
        assert r.status_code == 400
    _com(monkeypatch, "players")
    r = client.post(f"/house-credit/players/{JOGADOR}/payments", json={"amount": 50, "cash_day_id": "d1"})
    assert r.status_code == 403
    assert recebidos == [50, 50]


def test_recebimento_sem_ancora_e_recusado_na_entrada(client, monkeypatch):
    _com(monkeypatch, "cash.operate")
    r = client.post(f"/house-credit/players/{JOGADOR}/payments", json={"amount": 50})
    assert r.status_code == 422


def test_conta_de_jogador_sem_fiado_responde_zerada(client):
    r = client.get(f"/house-credit/players/{JOGADOR}")
    assert r.status_code == 200
    corpo = r.json()
    assert corpo["exists"] is False and corpo["balance"] == 0 and corpo["available"] == 0
