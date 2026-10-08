"""Premiação para o telão público.

A TV do salão abre pelo código, sem login. As rotas de prêmios normais exigem
usuário, então a TV nunca via a coluna de premiação e mostrava o prizepool
antigo do dia. A rota pública devolve só o que o público pode ver.
"""
from fastapi.testclient import TestClient

from app.main import app
from app.services import prize_allocation_service
from tests.conftest import FakeSupabase

TOURNAMENT_UUID = "00000000-0000-0000-0000-0000000000a1"
DAY_UUID = "00000000-0000-0000-0000-0000000000b1"
PLAYER_UUID = "00000000-0000-0000-0000-000000000001"


def _alloc(uid: str, position: int, amount: int, visible: bool = True) -> dict:
    return {
        "id": f"00000000-0000-0000-0000-0000000000c{uid}",
        "tournament_id": TOURNAMENT_UUID,
        "position": position,
        "prize_amount": amount,
        "visible": visible,
        "paid": True,
        "player_id": PLAYER_UUID,
        "paid_by": "Caixa",
        "document_number": "123",
        "players": {"name": "Fulano"},
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }


def _tabelas():
    return {
        "tournaments": [{
            "id": TOURNAMENT_UUID, "guaranteed_prize": 0,
            "reserved_prize_percentage": 0, "reserved_purpose": None,
        }],
        "tournament_days": [{
            "id": DAY_UUID, "tournament_id": TOURNAMENT_UUID,
            "rake_percentage": 0, "day_type": "regular",
        }],
        "tournament_players": [{
            "tournament_day_id": DAY_UUID,
            "total_buy_in_amount": 1000, "total_rebuy_amount": 0, "total_addon_amount": 0,
        }],
        "transactions": [{"tournament_id": TOURNAMENT_UUID, "amount": 1000, "type": "buy_in"}],
        "prize_allocations": [
            _alloc("1", 1, 600),
            _alloc("2", 2, 400, visible=False),
        ],
    }


def test_telao_recebe_prizepool_e_so_as_faixas_visiveis_sem_login(monkeypatch):
    monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(_tabelas()))
    client = TestClient(app)

    r = client.get(f"/public/broadcast/{TOURNAMENT_UUID}/prizes")

    assert r.status_code == 200
    corpo = r.json()
    assert float(corpo["prize_pool"]) == 1000
    # A faixa escondida (visible=false) não sai para o público.
    assert [p["position"] for p in corpo["prizes"]] == [1]
    assert float(corpo["prizes"][0]["prize_amount"]) == 600


def test_telao_nao_recebe_nada_alem_de_posicao_e_valor(monkeypatch):
    # Nome do ganhador, documento, quem pagou, rake e entradas brutas ficam
    # do lado de dentro: a tela não está logada.
    monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(_tabelas()))
    client = TestClient(app)

    corpo = client.get(f"/public/broadcast/{TOURNAMENT_UUID}/prizes").json()

    assert set(corpo.keys()) == {"prize_pool", "prizes"}
    assert set(corpo["prizes"][0].keys()) == {"position", "prize_amount"}


def test_id_que_nao_e_uuid_e_recusado():
    assert TestClient(app).get("/public/broadcast/abc/prizes").status_code == 422
