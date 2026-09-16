"""Testes da camada HTTP de funcionários e caixas por funcionário.

Duas fronteiras de autorização diferentes convivem aqui:

- **Funcionários**: as MUTAÇÕES exigem a permissão `employees`. Sem essa
  porta, qualquer conta autenticada criaria um grupo com todas as
  permissões e se colocaria nele — auto-escalonamento para super-admin.
- **Caixas**: leitura é livre (cada um vê o próprio), mas criar caixa e
  ver os relatórios consolidados exige admin, porque expõem o dinheiro de
  todos os operadores.
"""
import pytest

from app.models.staff import PermissionGroupResponse, StaffResponse, MyPermissions
from app.models.cashbox import (
    CashboxResponse, CashboxSessionResponse, CashboxTransactionResponse,
    CashboxSummary, CashboxAggregatedSummary, CashboxDemonstrativo,
)
from app.services.staff_service import StaffService as SS
from app.services.cashbox_service import CashboxService as CS


STAFF = "99999999-9999-9999-9999-999999999999"
GRUPO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"
ETAPA = "11111111-1111-1111-1111-111111111111"
CAIXA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1"


def _grupo(nome="Caixa"):
    return PermissionGroupResponse(id=GRUPO, name=nome, description="",
                                   permissions=["cashier"],
                                   created_at="2026-06-08T00:00:00Z")


def _funcionario(nome="Fulano", status="accepted", ativo=True):
    return StaffResponse(id=STAFF, auth_user_id="auth-1", name=nome,
                         email="fulano@clube.com", active=ativo,
                         invite_status=status,
                         created_at="2026-06-08T00:00:00Z")


def _caixa(saldo=500.0, status="open"):
    return CashboxResponse(id=CAIXA, staff_id=STAFF, stage_id=ETAPA,
                           status=status, current_balance=saldo,
                           created_at="2026-06-08T00:00:00Z")


def _sessao():
    return CashboxSessionResponse(id="sess-1", cashbox_id=CAIXA,
                                  opened_at="2026-06-08T10:00:00Z",
                                  initial_balance=200.0,
                                  created_at="2026-06-08T10:00:00Z")


def _movimento(tipo="supply", valor=100.0):
    return CashboxTransactionResponse(id="mov-1", cashbox_id=CAIXA, type=tipo,
                                      amount=valor, signed_amount=valor,
                                      created_at="2026-06-08T11:00:00Z")


class TestMinhasPermissoes:
    def test_devolve_as_permissoes_do_vinculo(self, client, stub):
        stub(SS, get_my_permissions=lambda uid: MyPermissions(
            is_admin=False, permissions=["cashier"], group_name="Caixa"))
        r = client.get("/staff/me/permissions")
        assert r.json()["permissions"] == ["cashier"]

    def test_platform_admin_vem_do_CLAIM_e_nao_do_banco(self, client, stub):
        """Se viesse do banco, um clube conseguiria se promover a admin da
        plataforma editando a própria linha de staff."""
        stub(SS, get_my_permissions=lambda uid: MyPermissions(
            is_admin=False, permissions=[], is_platform_admin=True))
        client.usuario["platform_admin"] = False
        assert client.get("/staff/me/permissions").json()["is_platform_admin"] is False


class TestGruposDePermissao:
    def test_cria(self, client, stub):
        stub(SS, create_group=lambda d: _grupo())
        r = client.post("/staff/groups", json={"name": "Caixa",
                                               "permissions": ["cashier"]})
        assert r.status_code == 200

    def test_falha_do_service_vira_400(self, client, stub):
        def _estoura(d):
            raise Exception("nome duplicado")
        stub(SS, create_group=_estoura)
        assert client.post("/staff/groups", json={"name": "X"}).status_code == 400

    def test_lista(self, client, stub):
        stub(SS, get_groups=lambda: [_grupo()])
        assert len(client.get("/staff/groups").json()) == 1

    def test_busca_um(self, client, stub):
        stub(SS, get_group=lambda gid: _grupo())
        assert client.get(f"/staff/groups/{GRUPO}").status_code == 200

    def test_inexistente_da_404(self, client, stub):
        stub(SS, get_group=lambda gid: None)
        assert client.get(f"/staff/groups/{GRUPO}").status_code == 404

    def test_atualiza(self, client, stub):
        stub(SS, update_group=lambda gid, d: _grupo(nome="Novo"))
        r = client.patch(f"/staff/groups/{GRUPO}", json={"name": "Novo"})
        assert r.json()["name"] == "Novo"

    def test_atualizar_inexistente_da_404(self, client, stub):
        stub(SS, update_group=lambda gid, d: None)
        assert client.patch(f"/staff/groups/{GRUPO}", json={"name": "X"}).status_code == 404

    def test_erro_de_regra_na_atualizacao_da_400(self, client, stub):
        def _estoura(gid, d):
            raise ValueError("permissão desconhecida")
        stub(SS, update_group=_estoura)
        assert client.patch(f"/staff/groups/{GRUPO}", json={"name": "X"}).status_code == 400

    def test_apaga(self, client, stub):
        stub(SS, delete_group=lambda gid: True)
        assert client.delete(f"/staff/groups/{GRUPO}").status_code == 200

    def test_apagar_inexistente_da_404(self, client, stub):
        stub(SS, delete_group=lambda gid: False)
        assert client.delete(f"/staff/groups/{GRUPO}").status_code == 404


class TestFuncionarios:
    def test_convida_por_email(self, client, stub):
        """Só o e-mail entra: nome e senha são definidos pela própria pessoa."""
        recebidos = {}

        def _cria(dados, uid, org):
            recebidos["email"] = dados.email
            recebidos["org"] = org
            return _funcionario(status="awaiting_signup", ativo=False)

        stub(SS, create_staff=_cria)
        r = client.post("/staff", json={"email": "novo@clube.com"})
        assert r.status_code == 200
        assert recebidos["email"] == "novo@clube.com"
        assert recebidos["org"] == client.usuario["organization_id"]

    def test_email_ja_usado_da_400(self, client, stub):
        def _estoura(d, uid, org):
            raise ValueError("Já existe funcionário com este e-mail")
        stub(SS, create_staff=_estoura)
        assert client.post("/staff", json={"email": "a@b.com"}).status_code == 400

    def test_email_invalido_da_422(self, client):
        assert client.post("/staff", json={"email": "sem-arroba"}).status_code == 422

    def test_lista(self, client, stub):
        stub(SS, get_staff_list=lambda: [_funcionario()])
        assert len(client.get("/staff").json()) == 1

    def test_busca_um(self, client, stub):
        stub(SS, get_staff=lambda sid: _funcionario())
        assert client.get(f"/staff/{STAFF}").status_code == 200

    def test_inexistente_da_404(self, client, stub):
        stub(SS, get_staff=lambda sid: None)
        assert client.get(f"/staff/{STAFF}").status_code == 404

    def test_atualiza(self, client, stub):
        stub(SS, update_staff=lambda sid, d: _funcionario(nome="Outro"))
        assert client.patch(f"/staff/{STAFF}", json={"name": "Outro"}).json()["name"] == "Outro"

    def test_atualizar_inexistente_da_404(self, client, stub):
        stub(SS, update_staff=lambda sid, d: None)
        assert client.patch(f"/staff/{STAFF}", json={"name": "X"}).status_code == 404

    def test_erro_de_regra_na_atualizacao_da_400(self, client, stub):
        def _estoura(sid, d):
            raise ValueError("grupo inexistente")
        stub(SS, update_staff=_estoura)
        assert client.patch(f"/staff/{STAFF}", json={"name": "X"}).status_code == 400

    def test_desativa(self, client, stub):
        stub(SS, delete_staff=lambda sid: True)
        assert client.delete(f"/staff/{STAFF}").status_code == 200

    def test_desativar_inexistente_da_404(self, client, stub):
        stub(SS, delete_staff=lambda sid: False)
        assert client.delete(f"/staff/{STAFF}").status_code == 404

    def test_desativar_com_caixa_aberto_da_400(self, client, stub):
        """Ninguém sai do clube segurando dinheiro."""
        def _estoura(sid):
            raise ValueError("funcionário tem caixa aberto")
        stub(SS, delete_staff=_estoura)
        assert client.delete(f"/staff/{STAFF}").status_code == 400

    def test_exclusao_do_clube_e_rota_separada_da_desativacao(self, client, stub):
        """São intenções diferentes: desativar preserva o histórico, excluir
        rompe o vínculo (e a conta, se não houver outro clube). O desfazer de
        uma não serve para a outra."""
        stub(SS, remove_from_org=lambda sid, org: {"acao": "removido", "nome": "Fulano"})
        r = client.delete(f"/staff/{STAFF}/remove")
        assert r.json()["acao"] == "removido"

    def test_exclusao_bloqueada_da_400(self, client, stub):
        def _estoura(sid, org):
            raise ValueError("possui histórico financeiro")
        stub(SS, remove_from_org=_estoura)
        assert client.delete(f"/staff/{STAFF}/remove").status_code == 400

    def test_reenvia_o_convite(self, client, stub):
        """Os links do e-mail expiram; sem reenvio, quem demorou para clicar
        ficava travado e só o suporte resolvia."""
        stub(SS, resend_invite=lambda sid, org: {"sent": True})
        assert client.post(f"/staff/{STAFF}/resend-invite").json()["sent"] is True

    def test_reenviar_para_quem_ja_concluiu_da_400(self, client, stub):
        def _estoura(sid, org):
            raise ValueError("já concluiu o cadastro")
        stub(SS, resend_invite=_estoura)
        assert client.post(f"/staff/{STAFF}/resend-invite").status_code == 400

    def test_cancelar_convite_e_rota_propria_da_desativacao(self, client, stub):
        """A tela chamava o DELETE /{id}, que apenas DESATIVA. Como o convite já
        nasce inativo, o clique não mudava nada e a pessoa ficava presa em
        "convite pendente" para sempre."""
        chamou = {}

        def _cancela(sid, org):
            chamou["org"] = org
            return {"cancelled": True, "email": "fulano@clube.com"}

        stub(SS, cancel_invite=_cancela,
             delete_staff=lambda sid: pytest.fail("cancelar convite não pode cair na desativação"))
        r = client.delete(f"/staff/{STAFF}/invite")
        assert r.json()["cancelled"] is True
        assert chamou["org"] == client.usuario["organization_id"]

    def test_cancelar_o_que_nao_e_convite_da_400(self, client, stub):
        def _estoura(sid, org):
            raise ValueError("já faz parte da equipe")
        stub(SS, cancel_invite=_estoura)
        assert client.delete(f"/staff/{STAFF}/invite").status_code == 400

    def test_efetiva_o_convite_pendente(self, client, stub):
        """Sem esta rota, um convite só virava membro se a própria pessoa
        entrasse no sistema para responder — e o admin ficava sem saída."""
        stub(SS, confirm_invite=lambda sid, org: _funcionario(status="accepted"))
        r = client.post(f"/staff/{STAFF}/confirm-invite")
        assert r.json()["invite_status"] == "accepted"

    def test_efetivar_recusado_pela_regra_da_400(self, client, stub):
        def _estoura(sid, org):
            raise ValueError("O plano atual não permite mais usuários ativos.")
        stub(SS, confirm_invite=_estoura)
        assert client.post(f"/staff/{STAFF}/confirm-invite").status_code == 400

    def test_efetivar_inexistente_da_404(self, client, stub):
        stub(SS, confirm_invite=lambda sid, org: None)
        assert client.post(f"/staff/{STAFF}/confirm-invite").status_code == 404


class TestCaixasLeitura:
    def test_lista_os_caixas(self, client, stub):
        stub(CS, list_cashboxes=lambda uid, stage_id=None, status=None, **ancoras: [_caixa()])
        assert len(client.get("/cashboxes").json()) == 1

    def test_meu_caixa_atual(self, client, stub):
        stub(CS, get_my_current=lambda uid, stage_id=None, cash_day_id=None, bar_shift_id=None: _caixa())
        r = client.get("/cashboxes/me/current", headers={"X-Stage-ID": ETAPA})
        assert r.json()["id"] == CAIXA

    def test_meu_caixa_do_dia_de_cash(self, client, stub):
        """No cash game não há etapa: a âncora é o DIA e viaja na query.

        Sem este caminho o operador de um clube só-cash tomaria 400
        `etapa_nao_selecionada` no primeiro clique da noite."""
        vistos = {}

        def _atual(uid, stage_id=None, cash_day_id=None):
            vistos["stage_id"] = stage_id
            vistos["cash_day_id"] = cash_day_id
            return _caixa()

        stub(CS, get_my_current=_atual)
        r = client.get("/cashboxes/me/current", params={"cash_day_id": "dia-1"})
        assert r.status_code == 200
        assert r.json()["id"] == CAIXA
        assert vistos == {"stage_id": None, "cash_day_id": "dia-1"}

    def test_sem_etapa_e_sem_dia_recusa(self, client, stub):
        stub(CS, get_my_current=lambda uid, stage_id=None, cash_day_id=None, bar_shift_id=None: _caixa())
        r = client.get("/cashboxes/me/current")
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "etapa_nao_selecionada"

    def test_sem_etapa_selecionada_da_400(self, client):
        """O caixa é por etapa; sem etapa a pergunta não tem resposta."""
        r = client.get("/cashboxes/me/current")
        assert r.status_code == 400

    def test_busca_um(self, client, stub):
        stub(CS, get_cashbox=lambda cid: _caixa())
        assert client.get(f"/cashboxes/{CAIXA}").status_code == 200

    def test_inexistente_da_404(self, client, stub):
        stub(CS, get_cashbox=lambda cid: None)
        assert client.get(f"/cashboxes/{CAIXA}").status_code == 404

    def test_lista_sessoes(self, client, stub):
        stub(CS, list_sessions=lambda cid: [_sessao()])
        assert len(client.get(f"/cashboxes/{CAIXA}/sessions").json()) == 1

    def test_lista_movimentos(self, client, stub):
        stub(CS, list_transactions=lambda cid, session_id=None: [_movimento()])
        assert len(client.get(f"/cashboxes/{CAIXA}/transactions").json()) == 1

    def test_movimentos_de_uma_sessao(self, client, stub):
        recebidos = {}

        def _lista(cid, session_id=None):
            recebidos["sessao"] = session_id
            return []

        stub(CS, list_transactions=_lista)
        client.get(f"/cashboxes/{CAIXA}/transactions?session_id=sess-9")
        assert recebidos["sessao"] == "sess-9"

    def test_resumo(self, client, stub):
        stub(CS, get_summary=lambda cid, date_from=None, date_to=None:
             CashboxSummary(cashbox_id=cid, status="open"))
        assert client.get(f"/cashboxes/{CAIXA}/summary").status_code == 200

    def test_resumo_de_caixa_inexistente_da_404(self, client, stub):
        def _estoura(cid, date_from=None, date_to=None):
            raise ValueError("Caixa não encontrado")
        stub(CS, get_summary=_estoura)
        assert client.get(f"/cashboxes/{CAIXA}/summary").status_code == 404


class TestCaixasSoAdmin:
    """Criar caixa e ver o consolidado expõem o dinheiro de TODOS os
    operadores — por isso passam por `can_admin`, e não pela permissão de
    caixa que o próprio operador tem."""

    def test_cria_caixa(self, client, stub):
        stub(CS, can_admin=lambda uid: True,
             create_for_staff=lambda sid, stage, **ancoras: _caixa())
        r = client.post("/cashboxes", json={"staff_id": STAFF},
                        headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 200

    def test_nao_admin_recebe_403(self, client, stub):
        stub(CS, can_admin=lambda uid: False)
        assert client.post("/cashboxes", json={"staff_id": STAFF}).status_code == 403

    def test_funcionario_que_ja_tem_caixa_na_etapa_da_400(self, client, stub):
        def _estoura(sid, stage, **ancoras):
            raise ValueError("já possui caixa nesta etapa")
        stub(CS, can_admin=lambda uid: True, create_for_staff=_estoura)
        assert client.post("/cashboxes", json={"staff_id": STAFF}).status_code == 400

    def test_consolidado(self, client, stub):
        stub(CS, can_admin=lambda uid: True,
             get_aggregated_summary=lambda stage_id=None, date_from=None, date_to=None:
                 CashboxAggregatedSummary())
        assert client.get("/cashboxes/aggregated").status_code == 200

    def test_consolidado_sem_admin_da_403(self, client, stub):
        stub(CS, can_admin=lambda uid: False)
        assert client.get("/cashboxes/aggregated").status_code == 403

    def test_demonstrativo(self, client, stub):
        stub(CS, can_admin=lambda uid: True,
             get_demonstrativo=lambda stage_id=None, date_from=None, date_to=None, cash_day_id=None, bar_shift_id=None,
             staff_id=None: CashboxDemonstrativo())
        assert client.get("/cashboxes/demonstrativo").status_code == 200

    def test_demonstrativo_sem_admin_da_403(self, client, stub):
        stub(CS, can_admin=lambda uid: False)
        assert client.get("/cashboxes/demonstrativo").status_code == 403


class TestSessoesEMovimentos:
    def test_abre_o_caixa(self, client, stub):
        stub(CS, open_session=lambda cid, uid, saldo, obs: _sessao())
        r = client.post(f"/cashboxes/{CAIXA}/open", json={"initial_balance": 200})
        assert r.status_code == 200

    def test_abrir_duas_vezes_da_400(self, client, stub):
        """Duas sessões abertas no mesmo caixa tornam impossível dizer a qual
        delas cada movimento pertence."""
        def _estoura(cid, uid, saldo, obs):
            raise ValueError("Caixa já está aberto")
        stub(CS, open_session=_estoura)
        r = client.post(f"/cashboxes/{CAIXA}/open", json={"initial_balance": 0})
        assert r.status_code == 400

    def test_fecha_o_caixa(self, client, stub):
        stub(CS, close_session=lambda cid, uid, saldo, obs: _sessao())
        r = client.post(f"/cashboxes/{CAIXA}/close", json={"actual_final_balance": 850})
        assert r.status_code == 200

    def test_fechar_o_que_nao_esta_aberto_da_400(self, client, stub):
        def _estoura(cid, uid, saldo, obs):
            raise ValueError("Nenhuma sessão aberta")
        stub(CS, close_session=_estoura)
        r = client.post(f"/cashboxes/{CAIXA}/close", json={"actual_final_balance": 0})
        assert r.status_code == 400

    def test_fechar_sem_informar_o_saldo_conferido_da_422(self, client):
        """O saldo contado é o dado que gera a divergência; sem ele o
        fechamento não significa nada."""
        assert client.post(f"/cashboxes/{CAIXA}/close", json={}).status_code == 422

    def test_suprimento(self, client, stub):
        stub(CS, register_supply=lambda cid, uid, valor, obs: _movimento("supply", valor))
        r = client.post(f"/cashboxes/{CAIXA}/supply", json={"amount": 300})
        assert r.json()["amount"] == 300

    def test_suprimento_em_caixa_fechado_da_400(self, client, stub):
        def _estoura(cid, uid, valor, obs):
            raise ValueError("Caixa fechado")
        stub(CS, register_supply=_estoura)
        assert client.post(f"/cashboxes/{CAIXA}/supply", json={"amount": 1}).status_code == 400

    def test_sangria(self, client, stub):
        stub(CS, register_sangria=lambda cid, uid, valor, obs: _movimento("sangria", valor))
        r = client.post(f"/cashboxes/{CAIXA}/sangria", json={"amount": 500})
        assert r.json()["amount"] == 500

    def test_sangria_maior_que_o_saldo_da_400(self, client, stub):
        """Retirar mais do que existe deixaria o caixa negativo — sinal de
        erro de digitação, não de operação válida."""
        def _estoura(cid, uid, valor, obs):
            raise ValueError("Saldo insuficiente")
        stub(CS, register_sangria=_estoura)
        assert client.post(f"/cashboxes/{CAIXA}/sangria", json={"amount": 99999}).status_code == 400
