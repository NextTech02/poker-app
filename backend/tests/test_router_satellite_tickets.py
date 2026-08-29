"""Camada HTTP dos tickets de satélite.

Dois assuntos aqui não são detalhe de rota, são dinheiro:

- **Autorização era só do lado do navegador.** O POST de ticket aceitava
  qualquer JWT válido: esconder o botão no frontend não impedia ninguém de
  emitir uma entrada JÁ PAGA chamando a API direto. Agora cada escrita exige
  permissão de caixa/tickets.
- **Emitir em LOTE é operação de dono.** Um lote errado multiplica o prejuízo
  pelo número de jogadores, e o operador de caixa não desfaz sozinho — daí a
  chave própria `cashier_tickets.master` (ou `employees`, que é o que o grupo
  'Admin' já tem hoje).
"""
import pytest

from app.models.staff import MyPermissions
from app.models.satellite_ticket import TicketBulkResult, TicketResponse
from app.services.satellite_ticket_service import SatelliteTicketService as T
from app.services.staff_service import StaffService


JOGADOR = "44444444-4444-4444-4444-444444444444"
TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"


def _ticket(id_="tk1", player=JOGADOR):
    return TicketResponse(
        id=id_, target_tournament_id=TOUR, target_tournament_day_id=DIA,
        player_id=player, ticket_value=300.0, status="awarded",
        created_at="2026-06-08T00:00:00Z",
        player_name="Fulano", target_tournament_name="Torneio",
        target_day_name="Dia Final",
    )


def _perfil(monkeypatch, *permissoes, admin=False):
    """Troca o RBAC do conftest (que libera tudo) por um perfil específico."""
    monkeypatch.setattr(
        StaffService, "get_my_permissions",
        staticmethod(lambda uid: MyPermissions(is_admin=admin, permissions=list(permissoes))),
    )


CORPO_LOTE = {
    "player_ids": ["p1", "p2"], "target_tournament_id": TOUR,
    "target_tournament_day_id": DIA, "won_at": "Satélite", "funded_by": "Clube",
}

CORPO_UNICO = {
    "player_id": JOGADOR, "target_tournament_id": TOUR,
    "target_tournament_day_id": DIA, "won_at": "Satélite", "funded_by": "Clube",
}


class TestQuemPodeEmitirEmLote:
    def test_caixa_comum_nao_emite_lote(self, client, monkeypatch, stub):
        stub(T, create_tickets_bulk=lambda d, u: TicketBulkResult())
        _perfil(monkeypatch, "cashier", "cashier_tickets")
        assert client.post("/satellite-tickets/bulk", json=CORPO_LOTE).status_code == 403

    def test_quem_administra_a_equipe_emite(self, client, monkeypatch, stub):
        stub(T, create_tickets_bulk=lambda d, u: TicketBulkResult(created=[_ticket()], total_value=300.0))
        _perfil(monkeypatch, "employees")
        r = client.post("/satellite-tickets/bulk", json=CORPO_LOTE)
        assert r.status_code == 200
        assert r.json()["total_value"] == 300.0

    def test_a_chave_nova_tambem_libera(self, client, monkeypatch, stub):
        stub(T, create_tickets_bulk=lambda d, u: TicketBulkResult())
        _perfil(monkeypatch, "cashier_tickets.master")
        assert client.post("/satellite-tickets/bulk", json=CORPO_LOTE).status_code == 200

    def test_super_admin_da_plataforma_passa(self, client, monkeypatch, stub):
        stub(T, create_tickets_bulk=lambda d, u: TicketBulkResult())
        _perfil(monkeypatch, admin=True)
        assert client.post("/satellite-tickets/bulk", json=CORPO_LOTE).status_code == 200

    def test_lote_vazio_e_recusado_antes_de_chegar_no_service(self, client):
        r = client.post("/satellite-tickets/bulk", json={**CORPO_LOTE, "player_ids": []})
        assert r.status_code == 422

    def test_lote_acima_do_teto_e_recusado(self, client):
        r = client.post("/satellite-tickets/bulk",
                        json={**CORPO_LOTE, "player_ids": [f"p{i}" for i in range(101)]})
        assert r.status_code == 422

    def test_erro_de_regra_vira_400(self, client, stub):
        def _estoura(d, u):
            raise ValueError("O dia selecionado não pertence ao torneio alvo")

        stub(T, create_tickets_bulk=_estoura)
        r = client.post("/satellite-tickets/bulk", json=CORPO_LOTE)
        assert r.status_code == 400
        assert "não pertence" in r.json()["detail"]["message"]


class TestEscritaExigePermissao:
    """Era o buraco: bastava um JWT válido para emitir/resgatar/cancelar."""

    def test_perfil_de_sangeur_nao_emite_ticket(self, client, monkeypatch, stub):
        stub(T, create_ticket=lambda d, u: _ticket())
        _perfil(monkeypatch, "sangi")
        assert client.post("/satellite-tickets", json=CORPO_UNICO).status_code == 403

    def test_caixa_emite_ticket(self, client, monkeypatch, stub):
        stub(T, create_ticket=lambda d, u: _ticket())
        _perfil(monkeypatch, "cashier_tickets")
        assert client.post("/satellite-tickets", json=CORPO_UNICO).status_code == 200

    def test_perfil_de_sangeur_nao_cancela(self, client, monkeypatch, stub):
        stub(T, cancel_ticket=lambda tid, u: _ticket())
        _perfil(monkeypatch, "sangi")
        assert client.post("/satellite-tickets/tk1/cancel").status_code == 403

    def test_perfil_de_sangeur_nao_resgata(self, client, monkeypatch, stub):
        stub(T, redeem_ticket=lambda tid, f, u: {"ok": True})
        _perfil(monkeypatch, "sangi")
        assert client.post("/satellite-tickets/tk1/redeem", json={}).status_code == 403

    def test_consulta_continua_aberta_a_quem_esta_autenticado(self, client, monkeypatch, stub):
        """A tela do jogador (permissão 'players') precisa ler os tickets dele."""
        stub(T, get_all_tickets=lambda **kw: [_ticket()])
        _perfil(monkeypatch, "players")
        assert client.get("/satellite-tickets").status_code == 200


class TestTransferencia:
    def test_transfere_e_devolve_o_ticket_atualizado(self, client, stub):
        recebido = {}

        def _transferir(ticket_id, data, user_id, org_id=None, stage_id=None):
            recebido.update({"ticket": ticket_id, "destino": data.to_player_id,
                             "valor": data.amount, "org": org_id, "etapa": stage_id})
            return _ticket(player=data.to_player_id)

        stub(T, transfer_ticket=_transferir)
        r = client.post("/satellite-tickets/tk1/transfer",
                        json={"to_player_id": "p9", "amount": 250, "payment_method": "pix"},
                        headers={"X-Stage-ID": "et1"})
        assert r.status_code == 200
        assert recebido["destino"] == "p9"
        assert recebido["valor"] == 250
        assert recebido["etapa"] == "et1"
        # A organização vem do CLAIM do JWT, nunca do corpo da requisição.
        assert recebido["org"] == client.usuario["organization_id"]

    def test_valor_negativo_e_recusado(self, client):
        r = client.post("/satellite-tickets/tk1/transfer",
                        json={"to_player_id": "p9", "amount": -10})
        assert r.status_code == 422

    def test_erro_de_regra_vira_400(self, client, stub):
        def _estoura(ticket_id, data, user_id, org_id=None, stage_id=None):
            raise ValueError("Selecione uma etapa para lançar a venda no caixa")

        stub(T, transfer_ticket=_estoura)
        r = client.post("/satellite-tickets/tk1/transfer",
                        json={"to_player_id": "p9", "amount": 250})
        assert r.status_code == 400
        assert "etapa" in r.json()["detail"]["message"]

    def test_perfil_de_sangeur_nao_transfere(self, client, monkeypatch, stub):
        stub(T, transfer_ticket=lambda *a, **k: _ticket())
        _perfil(monkeypatch, "sangi")
        r = client.post("/satellite-tickets/tk1/transfer", json={"to_player_id": "p9"})
        assert r.status_code == 403

    def test_historico_do_ticket(self, client, stub):
        stub(T, list_transfers=lambda tid: [{
            "id": "h1", "ticket_id": tid, "from_player_id": JOGADOR,
            "to_player_id": "p9", "kind": "sale", "amount": 250.0,
            "created_at": "2026-06-08T00:00:00Z",
        }])
        r = client.get("/satellite-tickets/tk1/transfers")
        assert r.status_code == 200
        assert r.json()[0]["kind"] == "sale"


class TestTicketsDoJogador:
    def test_perfil_lista_os_tickets_do_jogador(self, client, stub):
        recebido = {}

        def _listar(**kw):
            recebido.update(kw)
            return [_ticket()]

        stub(T, get_all_tickets=_listar)
        r = client.get(f"/players/{JOGADOR}/tickets", headers={"X-Stage-ID": "et1"})
        assert r.status_code == 200
        assert r.json()[0]["target_tournament_name"] == "Torneio"
        assert recebido == {"player_id": JOGADOR}

    def test_jogador_sem_ticket_devolve_lista_vazia(self, client, stub):
        stub(T, get_all_tickets=lambda **kw: [])
        assert client.get(f"/players/{JOGADOR}/tickets").json() == []
