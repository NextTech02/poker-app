"""Testes de creditos de jogador e tickets de satelite.

Sao duas formas de o jogador entrar sem pagar em dinheiro na hora. O risco e
o mesmo nos dois: consumir duas vezes o mesmo beneficio.
"""
import pytest

from app.services import player_credit_service, satellite_ticket_service
from app.services.player_credit_service import PlayerCreditService
from app.services.satellite_ticket_service import SatelliteTicketService

from tests.conftest import FakeSupabase


PLAYER = "44444444-4444-4444-4444-444444444444"
STAGE = "11111111-1111-1111-1111-111111111111"
TOUR = "22222222-2222-2222-2222-222222222222"


def _credito(id_="c1", restante=500, usado=0, status="active"):
    return {
        "id": id_, "player_id": PLAYER, "stage_id": STAGE,
        "original_amount": 500, "remaining_amount": restante,
        "used_amount": usado, "prize_deduction_amount": 0,
        "sponsor_owes": 0, "status": status,
        "created_at": "2026-06-08T00:00:00Z",
    }


class TestUsoDeCredito:
    def _monta(self, monkeypatch, creditos=None):
        fake = FakeSupabase({
            "player_credits": creditos if creditos is not None else [_credito()],
            "credit_transactions": [],
            "players": [{"id": PLAYER, "name": "Fulano"}],
        })
        monkeypatch.setattr(player_credit_service, "supabase", fake)
        return fake

    def test_sem_credito_disponivel_e_recusado(self, monkeypatch):
        self._monta(monkeypatch, creditos=[])
        with pytest.raises(ValueError, match="crédito"):
            PlayerCreditService.use_credit(PLAYER, 100, "buy_in", TOUR, None, "u1")

    def test_credito_zerado_conta_como_indisponivel(self, monkeypatch):
        self._monta(monkeypatch, creditos=[_credito(restante=0)])
        with pytest.raises(ValueError, match="crédito"):
            PlayerCreditService.use_credit(PLAYER, 100, "buy_in", TOUR, None, "u1")

    def test_consome_apenas_o_necessario(self, monkeypatch):
        fake = self._monta(monkeypatch, creditos=[_credito(restante=500)])
        r = PlayerCreditService.use_credit(PLAYER, 100, "buy_in", TOUR, None, "u1")
        assert r["credit_used"] == 100
        assert r["cash_remaining"] == 0
        assert float(fake.store["player_credits"][0]["remaining_amount"]) == 400.0

    def test_credito_insuficiente_cobra_a_diferenca_em_dinheiro(self, monkeypatch):
        """Nao pode recusar a entrada: o jogador paga o que falta no caixa."""
        self._monta(monkeypatch, creditos=[_credito(restante=30)])
        r = PlayerCreditService.use_credit(PLAYER, 100, "buy_in", TOUR, None, "u1")
        assert r["credit_used"] == 30
        assert r["cash_remaining"] == 70

    def test_credito_totalmente_usado_muda_de_status(self, monkeypatch):
        fake = self._monta(monkeypatch, creditos=[_credito(restante=100)])
        PlayerCreditService.use_credit(PLAYER, 100, "buy_in", TOUR, None, "u1")
        assert fake.store["player_credits"][0]["status"] == "fully_used"

    def test_registra_o_movimento_para_auditoria(self, monkeypatch):
        fake = self._monta(monkeypatch)
        PlayerCreditService.use_credit(PLAYER, 50, "rebuy", TOUR, None, "u1")
        assert len(fake.store["credit_transactions"]) == 1
        assert float(fake.store["credit_transactions"][0]["amount"]) == 50.0

    def test_saldo_disponivel_soma_os_creditos_ativos(self, monkeypatch):
        self._monta(monkeypatch, creditos=[
            _credito("c1", restante=200), _credito("c2", restante=300),
        ])
        assert PlayerCreditService.get_player_available_credit(PLAYER) == 500.0

    def test_sem_credito_o_saldo_e_zero(self, monkeypatch):
        self._monta(monkeypatch, creditos=[])
        assert PlayerCreditService.get_player_available_credit(PLAYER) == 0.0


class TestTicketsSatelite:
    def _ticket(self, id_="t1", status="available", player=PLAYER, dia="d1"):
        return {"id": id_, "player_id": player, "target_day_id": dia,
                "status": status, "stage_id": STAGE, "value": 300,
                "target_tournament_id": TOUR, "ticket_value": 300,
                "created_at": "2026-06-08T00:00:00Z"}

    def _monta(self, monkeypatch, tickets=None):
        fake = FakeSupabase({
            "satellite_tickets": tickets if tickets is not None else [],
            "players": [{"id": PLAYER, "name": "Fulano"}],
            "tournament_days": [{"id": "d1", "tournament_id": TOUR, "buy_in": 300,
                                 "day_name": "Final"}],
            "tournaments": [{"id": TOUR, "name": "Torneio"}],
        })
        monkeypatch.setattr(satellite_ticket_service, "supabase", fake)
        return fake

    def test_ticket_inexistente_e_recusado(self, monkeypatch):
        self._monta(monkeypatch)
        with pytest.raises(ValueError, match="encontrado"):
            SatelliteTicketService.redeem_ticket("nao-existe", None, "u1")

    def test_ticket_ja_usado_nao_resgata_de_novo(self, monkeypatch):
        """O beneficio vale uma vez; resgatar duas vezes daria entrada dupla
        de graca."""
        self._monta(monkeypatch, tickets=[self._ticket(status="used")])
        with pytest.raises(ValueError, match="resgatado"):
            SatelliteTicketService.redeem_ticket("t1", None, "u1")

    def test_ticket_cancelado_nao_resgata(self, monkeypatch):
        self._monta(monkeypatch, tickets=[self._ticket(status="cancelled")])
        with pytest.raises(ValueError, match="resgatado"):
            SatelliteTicketService.redeem_ticket("t1", None, "u1")

    def test_ticket_sem_jogador_e_recusado(self, monkeypatch):
        self._monta(monkeypatch, tickets=[self._ticket(player=None)])
        with pytest.raises(ValueError, match="jogador"):
            SatelliteTicketService.redeem_ticket("t1", None, "u1")

    def test_ticket_sem_dia_alvo_e_recusado(self, monkeypatch):
        self._monta(monkeypatch, tickets=[self._ticket(dia=None)])
        with pytest.raises(ValueError, match="dia alvo"):
            SatelliteTicketService.redeem_ticket("t1", None, "u1")

    def test_cancelar_ticket(self, monkeypatch):
        fake = self._monta(monkeypatch, tickets=[self._ticket()])
        SatelliteTicketService.cancel_ticket("t1", "u1")
        assert fake.store["satellite_tickets"][0]["status"] == "cancelled"

    def test_lista_apenas_os_disponiveis(self, monkeypatch):
        self._monta(monkeypatch, tickets=[
            self._ticket("t1", status="available"),
            self._ticket("t2", status="used"),
        ])
        assert len(SatelliteTicketService.get_available_tickets()) == 1

    def test_sem_ticket_devolve_lista_vazia(self, monkeypatch):
        self._monta(monkeypatch)
        assert SatelliteTicketService.get_all_tickets() == []
