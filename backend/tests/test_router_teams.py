"""Rotas do torneio por equipes: casca fina — chamam o serviço certo e
traduzem a recusa com código. As rotas fixas (/teams/final, /teams/stage1…)
não podem ser engolidas pelas que têm {team_id}."""
from app.services.team_charge_service import TeamChargeService
from app.services.team_service import TeamService
from app.utils.erros import ErroDeNegocio

TOUR = "t1"


def test_rotas_fixas_antes_das_de_equipe(client, stub):
    chamadas = []
    stub(TeamService,
         desfazer_final=lambda tid: chamadas.append(("desfazer_final", tid)) or {"ok": 1},
         desoficializar=lambda tid: chamadas.append(("desoficializar", tid)) or {"ok": 1},
         excluir=lambda tid, team: chamadas.append(("excluir", team)) or {"ok": 1})
    assert client.delete(f"/tournaments/{TOUR}/teams/final").status_code == 200
    assert client.delete(f"/tournaments/{TOUR}/teams/stage1/official").status_code == 200
    assert client.delete(f"/tournaments/{TOUR}/teams/team-9").status_code == 200
    assert chamadas == [("desfazer_final", TOUR), ("desoficializar", TOUR), ("excluir", "team-9")]


def test_recusa_vai_com_codigo(client, stub):
    def recusar(*a, **k):
        raise ErroDeNegocio("mesa_com_companheiro", "x", status=409, companheiro="Ana", mesa=3)
    stub(TeamService, sortear_mesas=recusar)
    resp = client.post(f"/tournaments/{TOUR}/teams/seating", json={})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "mesa_com_companheiro"
    assert resp.json()["detail"]["mesa"] == 3


def test_criar_e_cobrar(client, stub):
    recebido = {}
    stub(TeamService, criar=lambda tid, nome, cap, ids: recebido.update(nome=nome, cap=cap, ids=ids) or {"teams": []})
    stub(TeamChargeService, cobrar=lambda tid, team, bt, metodo, cmid, user: {"charged": 4, "bt": bt, "cmid": cmid})
    resp = client.post(f"/tournaments/{TOUR}/teams",
                       json={"name": "Ases", "captain_player_id": "p1", "player_ids": ["p1", "p2", "p3", "p4"]})
    assert resp.status_code == 201 and recebido["ids"] == ["p1", "p2", "p3", "p4"]
    resp = client.post(f"/tournaments/{TOUR}/teams/team-1/charge", json={"buy_type_id": "bt", "client_mutation_id": "c1"})
    assert resp.json() == {"charged": 4, "bt": "bt", "cmid": "c1"}


def test_equipe_com_mais_de_4_e_recusada_na_entrada(client):
    resp = client.post(f"/tournaments/{TOUR}/teams",
                       json={"name": "X", "captain_player_id": "p1", "player_ids": ["p1", "p2", "p3", "p4", "p5"]})
    assert resp.status_code == 422
