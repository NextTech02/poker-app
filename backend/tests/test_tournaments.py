import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_health_check():
    """Test health check endpoint"""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


def test_root():
    """Test root endpoint"""
    response = client.get("/")
    assert response.status_code == 200
    assert "message" in response.json()
    assert "version" in response.json()


# Note: These tests require authentication setup
# Uncomment and modify when you have test authentication set up

# def test_create_tournament():
#     """Test tournament creation"""
#     tournament_data = {
#         "name": "Test Tournament",
#         "buy_in": 100.0,
#         "max_players": 50,
#         "blind_duration": 15,
#         "starting_chips": 10000
#     }
#     response = client.post("/tournaments", json=tournament_data)
#     assert response.status_code == 201
#     assert response.json()["name"] == "Test Tournament"

# def test_get_tournaments():
#     """Test getting all tournaments"""
#     response = client.get("/tournaments")
#     assert response.status_code == 200
#     assert isinstance(response.json(), list)


class TestBilheteDoTorneio:
    """Bilhete de inscrição: imagem, cidade e sede do torneio (nulo = clube)."""

    def _servico(self, monkeypatch, torneio):
        from app.services import tournament_service
        from tests.conftest import FakeSupabase
        fake = FakeSupabase({"tournaments": [torneio], "tournament_players": []})
        monkeypatch.setattr(tournament_service, "supabase", fake)
        return fake

    def _torneio(self, **extra):
        return {"id": "t1", "name": "X", "created_by": "u", "created_at": "2026-10-17T00:00:00Z",
                "elimination_mode": "bulk", "ko_format": "none", **extra}

    def test_texto_em_branco_volta_ao_padrao_do_clube(self, monkeypatch):
        from app.models.tournament import TournamentUpdate
        from app.services.tournament_service import TournamentService
        fake = self._servico(monkeypatch, self._torneio(ticket_city="Lima", ticket_venue=None, ticket_logo_path=None))
        TournamentService.update_tournament("t1", TournamentUpdate(ticket_city="  ", ticket_venue=" Salón NSOP "))
        linha = fake.store["tournaments"][0]
        assert linha["ticket_city"] is None and linha["ticket_venue"] == "Salón NSOP"

    def test_banco_sem_a_migracao_ignora_campos_vazios_e_recusa_preenchidos(self, monkeypatch):
        from app.models.tournament import TournamentUpdate
        from app.services.tournament_service import TournamentService
        from app.utils.erros import ErroDeNegocio
        fake = self._servico(monkeypatch, self._torneio())
        TournamentService.update_tournament("t1", TournamentUpdate(name="Y", ticket_city=None))
        assert fake.store["tournaments"][0]["name"] == "Y" and "ticket_city" not in fake.store["tournaments"][0]
        try:
            TournamentService.update_tournament("t1", TournamentUpdate(ticket_city="Chiclayo"))
            assert False, "devia recusar"
        except ErroDeNegocio as e:
            assert e.code == "bilhete_indisponivel"
