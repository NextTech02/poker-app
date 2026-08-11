"""Testes da camada HTTP de despesas/receitas (DRE) e fidelidade.

O fio comum: **toda** rota destas duas famílias passa a organização do
CLAIM para o service. Se alguma esquecer, o service consulta sem filtro de
org e um clube enxerga (ou apaga) a despesa de outro. Por isso vários
testes aqui capturam o argumento `org` em vez de só conferir o status.

Do lado da fidelidade, o outro ponto é 400 vs 500: "pontos insuficientes"
e "cupom já usado" são respostas ao jogador no balcão, não defeitos.
"""
import pytest

from app.services.expense_service import ExpenseService as ES
from app.services.loyalty_service import LoyaltyService as LS


ORG = "33333333-3333-3333-3333-333333333333"
ETAPA = "11111111-1111-1111-1111-111111111111"
JOGADOR = "44444444-4444-4444-4444-444444444444"


@pytest.fixture
def espiao():
    """Guarda os argumentos com que o service foi chamado."""
    return {}


class TestCategoriasDeDespesa:
    def test_lista_com_a_organizacao_do_claim(self, client, stub, espiao):
        def _lista(org, active_only=False):
            espiao["org"] = org
            return []
        stub(ES, get_categories=_lista)
        assert client.get("/expenses/categories").status_code == 200
        assert espiao["org"] == ORG

    def test_filtra_so_as_ativas(self, client, stub, espiao):
        def _lista(org, active_only=False):
            espiao["ativas"] = active_only
            return []
        stub(ES, get_categories=_lista)
        client.get("/expenses/categories?active=true")
        assert espiao["ativas"] is True

    def test_cria(self, client, stub):
        stub(ES, create_category=lambda org, d: {"id": "c1", **d})
        r = client.post("/expenses/categories", json={"name": "Aluguel"})
        assert r.json()["name"] == "Aluguel"

    def test_atualiza(self, client, stub):
        stub(ES, update_category=lambda org, cid, d: {"id": cid, **d})
        r = client.patch("/expenses/categories/c1", json={"name": "Novo"})
        assert r.json()["name"] == "Novo"

    def test_categoria_de_outra_org_da_404(self, client, stub):
        """O service filtra por org; não encontrar é o mesmo que não existir —
        e é assim que se evita confirmar a existência de dado alheio."""
        stub(ES, update_category=lambda org, cid, d: None)
        assert client.patch("/expenses/categories/c1", json={"name": "X"}).status_code == 404

    def test_apaga(self, client, stub):
        stub(ES, delete_category=lambda org, cid: True)
        assert client.delete("/expenses/categories/c1").json() == {"deleted": True}

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(ES, delete_category=lambda org, cid: False)
        assert client.delete("/expenses/categories/c1").status_code == 404

    def test_a_rota_categories_nao_e_lida_como_um_id(self, client, stub, espiao):
        """`/expenses/categories` é declarada ANTES de `/expenses/{id}`; se a
        ordem inverter, "categories" vira o id de uma despesa."""
        def _lista(org, active_only=False):
            espiao["chamou"] = "categorias"
            return []
        stub(ES, get_categories=_lista)
        client.get("/expenses/categories")
        assert espiao["chamou"] == "categorias"


class TestModelosRecorrentes:
    def test_lista(self, client, stub):
        stub(ES, get_templates=lambda org: [{"id": "t1"}])
        assert len(client.get("/expenses/templates").json()) == 1

    def test_cria(self, client, stub):
        stub(ES, create_template=lambda org, d: {"id": "t1", **d})
        r = client.post("/expenses/templates", json={
            "name": "Aluguel", "description": "Aluguel do salão", "amount": 5000})
        assert r.status_code == 200

    def test_apaga(self, client, stub):
        stub(ES, delete_template=lambda org, tid: True)
        assert client.delete("/expenses/templates/t1").json() == {"deleted": True}

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(ES, delete_template=lambda org, tid: False)
        assert client.delete("/expenses/templates/t1").status_code == 404


class TestDespesas:
    def _corpo(self, **kw):
        base = {"stage_id": ETAPA, "description": "Buffet", "amount": 1200}
        base.update(kw)
        return base

    def test_lista_repassa_todos_os_filtros(self, client, stub, espiao):
        def _lista(org, stage, tour, cat, status, ini, fim):
            espiao.update(org=org, stage=stage, cat=cat, status=status,
                          ini=ini, fim=fim)
            return []
        stub(ES, list_expenses=_lista)
        client.get(f"/expenses?stage_id={ETAPA}&category_id=c1&status=paid"
                   "&start=2026-06-01&end=2026-06-30")
        assert espiao["stage"] == ETAPA
        assert espiao["cat"] == "c1"
        assert espiao["status"] == "paid"
        assert espiao["ini"] == "2026-06-01"

    def test_cria(self, client, stub, espiao):
        def _cria(org, d, uid):
            espiao["autor"] = uid
            return {"id": "d1", **d}
        stub(ES, create_expense=_cria)
        r = client.post("/expenses", json=self._corpo())
        assert r.status_code == 200
        assert espiao["autor"] == client.usuario["sub"]

    def test_saldo_insuficiente_no_caixa_geral_da_400(self, client, stub):
        """A despesa debita o caixa geral de forma atômica; sem saldo, a
        recusa é regra de negócio e precisa dizer o motivo."""
        def _estoura(org, d, uid):
            raise ValueError("Saldo insuficiente no caixa geral")
        stub(ES, create_expense=_estoura)
        r = client.post("/expenses", json=self._corpo())
        assert r.status_code == 400
        assert "Saldo insuficiente" in r.json()["detail"]

    def test_insercao_sem_retorno_da_400(self, client, stub):
        stub(ES, create_expense=lambda org, d, uid: None)
        assert client.post("/expenses", json=self._corpo()).status_code == 400

    def test_despesa_sem_etapa_da_422(self, client):
        """Despesa fora de etapa não entra em DRE nenhum."""
        r = client.post("/expenses", json={"description": "X", "amount": 10})
        assert r.status_code == 422

    def test_atualiza(self, client, stub):
        stub(ES, update_expense=lambda org, eid, d: {"id": eid, **d})
        r = client.patch("/expenses/d1", json={"status": "pago"})
        assert r.json()["status"] == "pago"

    def test_status_fora_da_lista_da_422(self, client):
        """Só "pendente" e "pago" existem; um terceiro valor entraria no DRE
        sem cair em nenhum dos dois totais."""
        assert client.patch("/expenses/d1", json={"status": "paid"}).status_code == 422

    def test_atualizacao_invalida_da_400(self, client, stub):
        def _estoura(org, eid, d):
            raise ValueError("despesa já paga não pode voltar a pendente")
        stub(ES, update_expense=_estoura)
        assert client.patch("/expenses/d1", json={"status": "pendente"}).status_code == 400

    def test_atualizar_inexistente_da_404(self, client, stub):
        stub(ES, update_expense=lambda org, eid, d: None)
        assert client.patch("/expenses/d1", json={"amount": 1}).status_code == 404

    def test_apaga(self, client, stub):
        stub(ES, delete_expense=lambda org, eid: True)
        assert client.delete("/expenses/d1").json() == {"deleted": True}

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(ES, delete_expense=lambda org, eid: False)
        assert client.delete("/expenses/d1").status_code == 404

    def test_resumo_para_o_dre(self, client, stub):
        stub(ES, summarize=lambda org, stage, tour, ini, fim:
             {"total": 4300, "por_categoria": []})
        assert client.get(f"/expenses/summary?stage_id={ETAPA}").json()["total"] == 4300


class TestComprovantes:
    def test_lista(self, client, stub):
        stub(ES, list_attachments=lambda org, eid: [{"id": "a1"}])
        assert len(client.get("/expenses/d1/attachments").json()) == 1

    def test_registra(self, client, stub):
        stub(ES, add_attachment=lambda org, eid, d, uid: {"id": "a1", **d})
        r = client.post("/expenses/d1/attachments",
                        json={"path": "org/d1/nota.pdf", "file_name": "nota.pdf"})
        assert r.json()["file_name"] == "nota.pdf"

    def test_falha_ao_registrar_da_400(self, client, stub):
        stub(ES, add_attachment=lambda org, eid, d, uid: None)
        r = client.post("/expenses/d1/attachments",
                        json={"path": "x", "file_name": "y"})
        assert r.status_code == 400

    def test_apaga(self, client, stub):
        stub(ES, delete_attachment=lambda org, aid: True)
        assert client.delete("/expenses/d1/attachments/a1").json() == {"deleted": True}

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(ES, delete_attachment=lambda org, aid: False)
        assert client.delete("/expenses/d1/attachments/a1").status_code == 404


class TestReceitas:
    """Router separado de /expenses para não colidir com /expenses/{id}."""

    def _corpo(self, **kw):
        base = {"stage_id": ETAPA, "description": "Bar", "amount": 800}
        base.update(kw)
        return base

    def test_lista(self, client, stub):
        stub(ES, list_revenues=lambda org, stage, tour, status, ini, fim: [{"id": "r1"}])
        assert len(client.get("/revenues").json()) == 1

    def test_resumo(self, client, stub):
        stub(ES, summarize_revenues=lambda org, stage, tour, ini, fim: {"total": 800})
        assert client.get("/revenues/summary").json()["total"] == 800

    def test_cria(self, client, stub):
        stub(ES, create_revenue=lambda org, d, uid: {"id": "r1", **d})
        assert client.post("/revenues", json=self._corpo()).status_code == 200

    def test_valor_negativo_e_barrado_antes_do_service(self, client):
        """Receita negativa é despesa disfarçada: inverteria o sinal no DRE."""
        assert client.post("/revenues", json=self._corpo(amount=-5)).status_code == 422

    def test_erro_de_regra_da_400(self, client, stub):
        def _estoura(org, d, uid):
            raise ValueError("etapa já encerrada")
        stub(ES, create_revenue=_estoura)
        assert client.post("/revenues", json=self._corpo()).status_code == 400

    def test_insercao_sem_retorno_da_400(self, client, stub):
        stub(ES, create_revenue=lambda org, d, uid: None)
        assert client.post("/revenues", json=self._corpo()).status_code == 400

    def test_atualiza(self, client, stub):
        stub(ES, update_revenue=lambda org, rid, d: {"id": rid, **d})
        assert client.patch("/revenues/r1", json={"amount": 900}).json()["amount"] == 900

    def test_atualizacao_invalida_da_400(self, client, stub):
        def _estoura(org, rid, d):
            raise ValueError("nao")
        stub(ES, update_revenue=_estoura)
        assert client.patch("/revenues/r1", json={"amount": 1}).status_code == 400

    def test_atualizar_inexistente_da_404(self, client, stub):
        stub(ES, update_revenue=lambda org, rid, d: None)
        assert client.patch("/revenues/r1", json={"amount": 1}).status_code == 404

    def test_apaga(self, client, stub):
        stub(ES, delete_revenue=lambda org, rid: True)
        assert client.delete("/revenues/r1").json() == {"deleted": True}

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(ES, delete_revenue=lambda org, rid: False)
        assert client.delete("/revenues/r1").status_code == 404


class TestFidelidadeConfig:
    def test_le_a_configuracao(self, client, stub, espiao):
        def _config(org):
            espiao["org"] = org
            return {"enabled": True, "tiers": []}
        stub(LS, get_config=_config)
        assert client.get("/loyalty/config").status_code == 200
        assert espiao["org"] == ORG

    def test_atualiza(self, client, stub):
        stub(LS, update_settings=lambda org, d: {"enabled": False, **d})
        r = client.patch("/loyalty/config", json={"points_per_currency": 2})
        assert r.json()["points_per_currency"] == 2

    def test_org_sem_programa_da_404(self, client, stub):
        stub(LS, update_settings=lambda org, d: None)
        assert client.patch("/loyalty/config", json={}).status_code == 404

    def test_extrato_do_jogador(self, client, stub):
        stub(LS, get_player_loyalty=lambda org, pid: {"points": 350, "tier": "Prata"})
        assert client.get(f"/loyalty/players/{JOGADOR}").json()["points"] == 350


class TestRecompensas:
    def test_lista(self, client, stub):
        stub(LS, get_rewards=lambda org, active_only=False: [{"id": "r1"}])
        assert len(client.get("/loyalty/rewards").json()) == 1

    def test_lista_apenas_ativas(self, client, stub, espiao):
        def _lista(org, active_only=False):
            espiao["ativas"] = active_only
            return []
        stub(LS, get_rewards=_lista)
        client.get("/loyalty/rewards?active=true")
        assert espiao["ativas"] is True

    def test_cria(self, client, stub):
        stub(LS, create_reward=lambda org, d: {"id": "r1", **d})
        r = client.post("/loyalty/rewards", json={"name": "Buy-in grátis",
                                                  "cost_points": 500})
        assert r.json()["cost_points"] == 500

    def test_recompensa_sem_custo_em_pontos_da_422(self, client):
        assert client.post("/loyalty/rewards", json={"name": "X"}).status_code == 422

    def test_atualiza(self, client, stub):
        stub(LS, update_reward=lambda org, rid, d: {"id": rid, **d})
        assert client.patch("/loyalty/rewards/r1", json={"cost_points": 9}).status_code == 200

    def test_atualizar_inexistente_da_404(self, client, stub):
        stub(LS, update_reward=lambda org, rid, d: None)
        assert client.patch("/loyalty/rewards/r1", json={}).status_code == 404

    def test_apaga(self, client, stub):
        stub(LS, delete_reward=lambda org, rid: True)
        assert client.delete("/loyalty/rewards/r1").json() == {"deleted": True}

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(LS, delete_reward=lambda org, rid: False)
        assert client.delete("/loyalty/rewards/r1").status_code == 404


class TestResgates:
    def test_resgata_recompensa(self, client, stub):
        stub(LS, redeem_reward=lambda org, pid, rid: {"credit_id": "cr1"})
        r = client.post(f"/loyalty/players/{JOGADOR}/redeem", json={"reward_id": "r1"})
        assert r.json()["credit_id"] == "cr1"

    def test_pontos_insuficientes_da_400(self, client, stub):
        """Resposta que o operador lê para o jogador no balcão — não é falha."""
        def _estoura(org, pid, rid):
            raise ValueError("Pontos insuficientes")
        stub(LS, redeem_reward=_estoura)
        r = client.post(f"/loyalty/players/{JOGADOR}/redeem", json={"reward_id": "r1"})
        assert r.status_code == 400
        assert "insuficientes" in r.json()["detail"]

    def test_converte_cashback_em_credito(self, client, stub):
        stub(LS, convert_cashback=lambda org, pid: {"amount": 42.5})
        r = client.post(f"/loyalty/players/{JOGADOR}/convert-cashback")
        assert r.json()["amount"] == 42.5

    def test_cashback_zerado_da_400(self, client, stub):
        def _estoura(org, pid):
            raise ValueError("Sem cashback disponível")
        stub(LS, convert_cashback=_estoura)
        assert client.post(f"/loyalty/players/{JOGADOR}/convert-cashback").status_code == 400


class TestCupons:
    def test_lista(self, client, stub):
        stub(LS, get_coupons=lambda org: [{"code": "BEMVINDO"}])
        assert len(client.get("/loyalty/coupons").json()) == 1

    def test_cria(self, client, stub):
        stub(LS, create_coupon=lambda org, d: {"id": "cp1", **d})
        assert client.post("/loyalty/coupons", json={"code": "BEMVINDO"}).status_code == 200

    def test_apaga(self, client, stub):
        stub(LS, delete_coupon=lambda org, cid: True)
        assert client.delete("/loyalty/coupons/cp1").json() == {"deleted": True}

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(LS, delete_coupon=lambda org, cid: False)
        assert client.delete("/loyalty/coupons/cp1").status_code == 404

    def test_jogador_resgata_cupom(self, client, stub):
        stub(LS, redeem_coupon=lambda org, pid, code: {"points": 100})
        r = client.post(f"/loyalty/players/{JOGADOR}/coupon", json={"code": "BEMVINDO"})
        assert r.json()["points"] == 100

    def test_cupom_ja_usado_da_400(self, client, stub):
        """Cupom vale uma vez; usar de novo é tentativa, não erro do sistema."""
        def _estoura(org, pid, code):
            raise ValueError("Cupom já utilizado")
        stub(LS, redeem_coupon=_estoura)
        r = client.post(f"/loyalty/players/{JOGADOR}/coupon", json={"code": "X"})
        assert r.status_code == 400


class TestMetas:
    def test_lista_do_clube(self, client, stub, espiao):
        def _metas(org, pid):
            espiao["pid"] = pid
            return []
        stub(LS, get_goals=_metas)
        client.get("/loyalty/goals")
        assert espiao["pid"] is None      # sem jogador = catálogo do clube

    def test_lista_do_jogador(self, client, stub, espiao):
        def _metas(org, pid):
            espiao["pid"] = pid
            return [{"id": "m1", "progress": 3}]
        stub(LS, get_goals=_metas)
        client.get(f"/loyalty/players/{JOGADOR}/goals")
        assert espiao["pid"] == JOGADOR

    def test_cria(self, client, stub):
        stub(LS, create_goal=lambda org, d: {"id": "m1", **d})
        r = client.post("/loyalty/goals", json={"name": "5 torneios",
                                                "metric": "tournaments", "target": 5})
        assert r.status_code == 200

    def test_meta_sem_metrica_da_422(self, client):
        assert client.post("/loyalty/goals", json={"name": "X"}).status_code == 422

    def test_apaga(self, client, stub):
        stub(LS, delete_goal=lambda org, gid: True)
        assert client.delete("/loyalty/goals/m1").json() == {"deleted": True}

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(LS, delete_goal=lambda org, gid: False)
        assert client.delete("/loyalty/goals/m1").status_code == 404

    def test_reivindica_a_recompensa(self, client, stub):
        stub(LS, claim_goal=lambda org, pid, gid: {"claimed": True})
        r = client.post(f"/loyalty/players/{JOGADOR}/goals/m1/claim")
        assert r.json()["claimed"] is True

    def test_meta_nao_concluida_da_400(self, client, stub):
        def _estoura(org, pid, gid):
            raise ValueError("Meta ainda não concluída")
        stub(LS, claim_goal=_estoura)
        assert client.post(f"/loyalty/players/{JOGADOR}/goals/m1/claim").status_code == 400


class TestPresente:
    def test_presenteia_um_credito(self, client, stub):
        stub(LS, gift_credit=lambda org, cid, para: {"gifted": True})
        r = client.post(f"/loyalty/players/{JOGADOR}/gift",
                        json={"credit_id": "cr1", "to_player_id": "p2"})
        assert r.json()["gifted"] is True

    def test_credito_ja_usado_da_400(self, client, stub):
        """Presentear um crédito já consumido daria o mesmo benefício duas
        vezes — uma para quem usou, outra para quem recebeu."""
        def _estoura(org, cid, para):
            raise ValueError("Crédito já utilizado")
        stub(LS, gift_credit=_estoura)
        r = client.post(f"/loyalty/players/{JOGADOR}/gift",
                        json={"credit_id": "cr1", "to_player_id": "p2"})
        assert r.status_code == 400

    def test_sem_destinatario_da_422(self, client):
        r = client.post(f"/loyalty/players/{JOGADOR}/gift", json={"credit_id": "cr1"})
        assert r.status_code == 422
