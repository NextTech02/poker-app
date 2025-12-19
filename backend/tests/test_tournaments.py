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
