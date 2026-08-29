"""As recusas de CONTAS E PESSOAS chegam com código, não só com a frase.

O sistema atende clubes no Brasil, no Peru e na Colômbia. Enquanto o `detail`
era uma frase pronta em português, o operador de Medellín lia "Funcionário tem
caixa aberto" no meio do expediente e a tela não tinha como traduzir — não havia
o que traduzir POR, só texto.

O que se testa aqui, e em nenhum outro lugar:

1. **O código existe e é estável.** Ele é contrato com a tela e com a fila
   offline gravada nos aparelhos; renomear um código já usado quebra a tradução
   de quem não atualizou. Estes testes são o que trava um rename por descuido.
2. **O dado interpolado vai TAMBÉM separado** (saldo, limite, e-mail). A tela
   remonta a frase no idioma dela; se o número só existisse dentro da frase em
   português, a versão traduzida perderia justo a parte que resolve a dúvida.
3. **O status virou o certo.** Antes tudo o que o serviço recusava saía como
   400 — inclusive "não existe" e "já existe". A tela e a fila offline decidem
   por status se vale a pena repetir a chamada.
4. **Texto de terceiro não vaza.** Erro do Supabase e do Postgres vem em inglês,
   cita nome de constraint e às vezes o e-mail de outra pessoa. Vai para o log.
"""
import pytest

from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
AUTH = "88888888-8888-8888-8888-888888888888"
STAFF = "99999999-9999-9999-9999-999999999999"
JOGADOR = "44444444-4444-4444-4444-444444444444"


def _detalhe(exc):
    """O `detail` de uma HTTPException levantada por um atalho de erros.py."""
    return exc.value.detail


# ─────────────────────────── perfil e organização ───────────────────────────

class TestRecusasDePerfil:
    """As duas recusas mais vistas do sistema: falta de permissão e conta sem
    organização. Sendo as mais vistas, eram as que mais chegavam em português
    a quem não lê português."""

    def _perfil(self, monkeypatch, permissoes, admin=False):
        from app.models.staff import MyPermissions
        from app.services.staff_service import StaffService

        monkeypatch.setattr(
            StaffService, "get_my_permissions",
            staticmethod(lambda uid: MyPermissions(
                is_admin=admin, permissions=list(permissoes)
            )),
        )

    def test_sem_a_permissao_exigida_da_403_com_codigo(self, monkeypatch):
        from fastapi import HTTPException
        from app.auth.permissions import require_permission

        self._perfil(monkeypatch, ["players"])
        with pytest.raises(HTTPException) as exc:
            require_permission("employees")({"sub": AUTH})
        assert exc.value.status_code == 403
        assert _detalhe(exc)["code"] == "sem_permissao"
        # A frase em português continua ali: é a RESERVA para o cliente da API
        # que não conhece o código e para o log.
        assert "permissão" in _detalhe(exc)["message"]

    def test_perfil_restrito_da_403_com_codigo_proprio(self, monkeypatch):
        """`sangi` bloqueado no caixa não é a mesma recusa de quem só não tem a
        permissão: a tela diz coisas diferentes, então o código é outro."""
        from fastapi import HTTPException
        from app.auth.permissions import forbid_permission

        self._perfil(monkeypatch, ["sangi"])
        with pytest.raises(HTTPException) as exc:
            forbid_permission("sangi")({"sub": AUTH})
        assert exc.value.status_code == 403
        assert _detalhe(exc)["code"] == "perfil_sem_acesso"

    def test_quem_tem_a_permissao_passa(self, monkeypatch):
        from app.auth.permissions import require_permission

        self._perfil(monkeypatch, ["employees"])
        assert require_permission("employees")({"sub": AUTH})["sub"] == AUTH

    def test_conta_sem_organizacao_da_403_com_codigo(self):
        from fastapi import HTTPException
        from app.dependencies import get_org_id

        with pytest.raises(HTTPException) as exc:
            get_org_id({"sub": AUTH})
        assert exc.value.status_code == 403
        assert _detalhe(exc)["code"] == "conta_sem_organizacao"


# ─────────────────────────────── funcionários ───────────────────────────────

def _funcionario(id_=STAFF, ativo=True, status="accepted", org=ORG):
    return {
        "id": id_, "auth_user_id": AUTH, "name": "Fulano",
        "email": "fulano@clube.com", "permission_group_id": None,
        "active": ativo, "invite_status": status, "organization_id": org,
        "created_at": "2026-06-08T00:00:00Z", "updated_at": "2026-06-08T00:00:00Z",
    }


def _monta_staff(monkeypatch, tabelas=None, rpcs=None):
    from app.services import staff_service

    base = {
        "staff": [], "permission_groups": [], "cashboxes": [],
        "cashbox_sessions": [], "cashbox_transactions": [],
        "organizations": [{"id": ORG, "name": "NextHub", "status": "active"}],
    }
    base.update(tabelas or {})
    fake = FakeSupabase(base)
    fake.rpcs = rpcs or {}
    monkeypatch.setattr(staff_service, "supabase", fake)
    monkeypatch.setattr(staff_service, "supabase_admin", fake)
    return fake


class TestRecusasDoFuncionario:
    def test_caixa_aberto_manda_o_saldo_separado_da_frase(self, monkeypatch):
        """O saldo é o número que o admin precisa ver para saber o tamanho do
        acerto. Dentro da frase em português ele sumiria na tradução — e o "R$"
        da reserva não serve nem para o clube peruano nem para o colombiano."""
        from app.services.staff_service import StaffService

        _monta_staff(monkeypatch, {"cashboxes": [{
            "id": "cb1", "staff_id": STAFF, "stage_id": "e1",
            "status": "open", "current_balance": 1234.5,
        }]})
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService._guard_no_open_cashbox(STAFF)
        assert exc.value.code == "funcionario_com_caixa_aberto"
        assert exc.value.status == 409
        assert exc.value.dados["saldo"] == 1234.5

    def test_erro_de_negocio_continua_sendo_value_error(self, monkeypatch):
        """A conversão foi feita serviço a serviço; todo `except ValueError`
        que ainda não foi tocado precisa continuar pegando estas recusas."""
        from app.services.staff_service import StaffService

        _monta_staff(monkeypatch, {"cashboxes": [{
            "id": "cb1", "staff_id": STAFF, "stage_id": "e1",
            "status": "open", "current_balance": 10,
        }]})
        with pytest.raises(ValueError):
            StaffService._guard_no_open_cashbox(STAFF)

    def test_funcionario_inexistente_e_404_e_nao_400(self, monkeypatch):
        from app.services.staff_service import StaffService

        _monta_staff(monkeypatch)
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService.cancel_invite("nao-existe", ORG)
        assert exc.value.code == "funcionario_nao_encontrado"
        assert exc.value.status == 404

    def test_funcionario_de_outra_org_da_a_MESMA_recusa(self, monkeypatch):
        """Distinguir "não existe" de "existe, mas é de outro clube" entregaria
        a existência de um funcionário de outro cliente do SaaS."""
        from app.services.staff_service import StaffService

        _monta_staff(monkeypatch, {"staff": [
            _funcionario(status="pending", ativo=False, org="outra")
        ]})
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService.cancel_invite(STAFF, ORG)
        assert exc.value.code == "funcionario_nao_encontrado"
        assert exc.value.status == 404

    def test_membro_efetivo_nao_tem_convite_a_cancelar(self, monkeypatch):
        from app.services.staff_service import StaffService

        _monta_staff(monkeypatch, {"staff": [_funcionario(status="accepted")]})
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService.cancel_invite(STAFF, ORG)
        assert exc.value.code == "sem_convite_a_cancelar"
        assert exc.value.status == 409

    def test_efetivar_quem_ja_e_membro_da_409(self, monkeypatch):
        from app.services.staff_service import StaffService

        _monta_staff(monkeypatch, {"staff": [_funcionario(status="accepted")]})
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService.confirm_invite(STAFF, ORG)
        assert exc.value.code == "ja_e_membro_do_clube"
        assert exc.value.status == 409
        assert exc.value.dados["nome"] == "Fulano"

    def test_efetivar_quem_nao_definiu_senha_tem_codigo_proprio(self, monkeypatch):
        """A saída é REENVIAR o convite, não insistir em efetivar — por isso a
        tela precisa distinguir este caso do "já é membro"."""
        from app.services.staff_service import StaffService

        _monta_staff(monkeypatch, {"staff": [
            _funcionario(status="awaiting_signup", ativo=True)
        ]})
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService.confirm_invite(STAFF, ORG)
        assert exc.value.code == "convite_aguardando_cadastro"
        assert exc.value.status == 409

    def test_reenvio_para_quem_ja_concluiu_da_409(self, monkeypatch):
        from app.services.staff_service import StaffService

        _monta_staff(monkeypatch, {"staff": [_funcionario(status="accepted")]})
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService.resend_invite(STAFF, ORG)
        assert exc.value.code == "cadastro_ja_concluido"
        assert exc.value.status == 409

    def test_remover_sem_organizacao_e_403(self, monkeypatch):
        from app.services.staff_service import StaffService

        _monta_staff(monkeypatch)
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService.remove_from_org(STAFF, None)
        assert exc.value.code == "conta_sem_organizacao"
        assert exc.value.status == 403

    def test_limite_do_plano_manda_limite_e_uso_separados(self, monkeypatch):
        """"O plano não permite mais usuários" sem os números não diz ao dono
        se falta liberar uma vaga ou dez."""
        from app.models.staff import StaffCreate
        from app.services.staff_service import StaffService

        # Um funcionário ativo e um plano de um usuário: a vaga já está tomada.
        # (O fake aplica o `limit(1)` antes de contar, então a contagem que
        # chega aqui é 1 — o que importa no teste é o par limite/atual sair
        # como DADO, não dentro da frase.)
        _monta_staff(
            monkeypatch,
            {"staff": [_funcionario()]},
            rpcs={"org_limit": 1},
        )
        dados = StaffCreate(email="novo@clube.com")
        with pytest.raises(ErroDeNegocio) as exc:
            StaffService.create_staff(dados, created_by=AUTH, organization_id=ORG)
        assert exc.value.code == "limite_de_usuarios_do_plano"
        assert exc.value.status == 409
        assert exc.value.dados == {"limite": 1, "atual": 1}


class TestStatusQueChegaNaRota:
    """O router agora delega o status ao serviço (`da_excecao`). Antes TUDO o
    que o serviço recusava virava 400, inclusive "não existe"."""

    def test_recusa_404_do_servico_sai_como_404(self, client, stub):
        from app.services.staff_service import StaffService

        def _estoura(sid, org):
            raise ErroDeNegocio(
                "funcionario_nao_encontrado", "Funcionário não encontrado.", status=404
            )

        stub(StaffService, cancel_invite=_estoura)
        r = client.delete(f"/staff/{STAFF}/invite")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "funcionario_nao_encontrado"

    def test_recusa_409_do_servico_sai_como_409(self, client, stub):
        from app.services.staff_service import StaffService

        def _estoura(sid, org):
            raise ErroDeNegocio(
                "ja_e_membro_do_clube", "Esta pessoa já faz parte da equipe deste clube.",
                status=409, nome="Fulano",
            )

        stub(StaffService, confirm_invite=_estoura)
        r = client.post(f"/staff/{STAFF}/confirm-invite")
        assert r.status_code == 409
        assert r.json()["detail"] == {
            "code": "ja_e_membro_do_clube",
            "message": "Esta pessoa já faz parte da equipe deste clube.",
            "nome": "Fulano",
        }

    def test_value_error_ainda_nao_convertido_continua_400(self, client, stub):
        """A conversão é feita aos poucos; quem ainda levanta ValueError puro
        não pode quebrar — só perde a tradução até ser convertido."""
        from app.services.staff_service import StaffService

        def _estoura(sid, org):
            raise ValueError("algo que ainda não tem código")

        stub(StaffService, resend_invite=_estoura)
        r = client.post(f"/staff/{STAFF}/resend-invite")
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "regra_de_negocio"

    def test_funcionario_inexistente_na_leitura_da_404_com_codigo(self, client, stub):
        from app.services.staff_service import StaffService

        stub(StaffService, get_staff=lambda sid: None)
        r = client.get(f"/staff/{STAFF}")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "funcionario_nao_encontrado"

    def test_grupo_inexistente_da_404_com_codigo(self, client, stub):
        from app.services.staff_service import StaffService

        stub(StaffService, get_group=lambda gid: None)
        r = client.get("/staff/groups/g1")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "grupo_nao_encontrado"


# ─────────────────────────────── jogadores ──────────────────────────────────

class TestRecusasDeJogador:
    def test_jogador_inexistente_deixou_de_responder_em_ingles(self, client, stub):
        """A frase era "Player not found" — inglês para um clube brasileiro,
        peruano ou colombiano. Agora vai código, e a reserva é em português."""
        from app.services.player_service import PlayerService

        stub(PlayerService, get_player=lambda pid: None)
        r = client.get(f"/players/{JOGADOR}")
        assert r.status_code == 404
        assert r.json()["detail"] == {
            "code": "jogador_nao_encontrado",
            "message": "Jogador não encontrado",
        }

    def test_exclusao_de_jogador_inexistente_usa_o_mesmo_codigo(self, client, stub):
        from app.services.player_service import PlayerService

        stub(PlayerService, delete_player=lambda pid: False)
        r = client.delete(f"/players/{JOGADOR}")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "jogador_nao_encontrado"

    def test_importacao_sem_organizacao_da_403_com_codigo(self, client):
        client.usuario["organization_id"] = None
        r = client.post("/players/import", json={"rows": []})
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "conta_sem_organizacao"

    def test_limite_de_clientes_manda_os_numeros_separados(self, client, stub):
        from app.services.player_import_service import PlayerImportService

        def _estoura(org, linhas):
            raise ValueError("PLANO_LIMITE_CLIENTES: o plano permite 100 jogador(es)")

        stub(PlayerImportService, importar=_estoura)
        r = client.post("/players/import", json={"rows": [{"name": "Zé"}]})
        assert r.status_code == 409
        corpo = r.json()["detail"]
        assert corpo["code"] == "limite_de_clientes_do_plano"
        assert corpo["detalhe"] == "o plano permite 100 jogador(es)"


# ──────────────────────────── créditos do jogador ───────────────────────────

def _monta_creditos(monkeypatch, tabelas=None):
    from app.services import player_credit_service

    base = {"players": [], "sponsors": [], "player_credits": [],
            "credit_transactions": []}
    base.update(tabelas or {})
    fake = FakeSupabase(base)
    monkeypatch.setattr(player_credit_service, "supabase", fake)
    return fake


class TestRecusasDeCredito:
    def _corpo(self):
        from app.models.player_credit import PlayerCreditCreate

        return PlayerCreditCreate(player_id=JOGADOR, sponsor_id="sp1", amount=100)

    def test_jogador_inexistente_e_404(self, monkeypatch):
        from app.services.player_credit_service import PlayerCreditService

        _monta_creditos(monkeypatch)
        with pytest.raises(ErroDeNegocio) as exc:
            PlayerCreditService.grant_credit(self._corpo(), AUTH)
        assert exc.value.code == "jogador_nao_encontrado"
        assert exc.value.status == 404

    def test_patrocinador_inexistente_tem_codigo_proprio(self, monkeypatch):
        """Quem lê precisa saber QUAL dos dois cadastros falta."""
        from app.services.player_credit_service import PlayerCreditService

        _monta_creditos(monkeypatch, {"players": [
            {"id": JOGADOR, "name": "Zé", "nickname": None}
        ]})
        with pytest.raises(ErroDeNegocio) as exc:
            PlayerCreditService.grant_credit(self._corpo(), AUTH)
        assert exc.value.code == "patrocinador_nao_encontrado"
        assert exc.value.status == 404

    def test_credito_ja_utilizado_e_409_e_nao_404(self, monkeypatch):
        """O crédito existe: o que impede o cancelamento é o estado dele."""
        from app.services.player_credit_service import PlayerCreditService

        _monta_creditos(monkeypatch, {"player_credits": [{
            "id": "cr1", "player_id": JOGADOR, "sponsor_id": "sp1",
            "original_amount": 100, "remaining_amount": 40, "used_amount": 60,
            "sponsor_owes": 0, "status": "active",
        }]})
        with pytest.raises(ErroDeNegocio) as exc:
            PlayerCreditService.cancel_credit("cr1", AUTH)
        assert exc.value.code == "credito_ja_utilizado"
        assert exc.value.status == 409

    def test_credito_inexistente_e_404(self, monkeypatch):
        from app.services.player_credit_service import PlayerCreditService

        _monta_creditos(monkeypatch)
        with pytest.raises(ErroDeNegocio) as exc:
            PlayerCreditService.cancel_credit("cr1", AUTH)
        assert exc.value.code == "credito_nao_encontrado"
        assert exc.value.status == 404

    def test_rota_de_credito_repassa_o_404_do_servico(self, client, stub):
        from app.services.player_credit_service import PlayerCreditService

        def _estoura(cid, uid):
            raise ErroDeNegocio(
                "credito_nao_encontrado", "Crédito não encontrado", status=404
            )

        stub(PlayerCreditService, cancel_credit=_estoura)
        r = client.post("/player-credits/cr1/cancel")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "credito_nao_encontrado"


# ───────────────────────────────── tickets ──────────────────────────────────

class TestRecusasDeTicket:
    def _monta(self, monkeypatch, tickets):
        from app.services import satellite_ticket_service

        fake = FakeSupabase({"satellite_tickets": tickets, "players": []})
        monkeypatch.setattr(satellite_ticket_service, "supabase", fake)
        return fake

    def test_ticket_inexistente_e_404(self, monkeypatch):
        from app.services.satellite_ticket_service import SatelliteTicketService

        self._monta(monkeypatch, [])
        with pytest.raises(ErroDeNegocio) as exc:
            SatelliteTicketService.cancel_ticket("tk1", AUTH)
        assert exc.value.code == "ticket_nao_encontrado"
        assert exc.value.status == 404

    def test_ticket_ja_resgatado_manda_o_status_atual(self, monkeypatch):
        """"Já resgatado" é a recusa que mais gera dúvida no balcão; o status
        atual vai separado para a tela mostrá-lo na frase traduzida."""
        from app.services.satellite_ticket_service import SatelliteTicketService

        self._monta(monkeypatch, [{
            "id": "tk1", "status": "redeemed", "player_id": JOGADOR,
            "players": {"name": "Zé", "nickname": None},
        }])
        with pytest.raises(ErroDeNegocio) as exc:
            SatelliteTicketService.cancel_ticket("tk1", AUTH)
        assert exc.value.code == "ticket_nao_cancelavel"
        assert exc.value.status == 409
        assert exc.value.dados["status_atual"] == "redeemed"

    def test_transferir_ticket_resgatado_tem_codigo_proprio(self, monkeypatch):
        """Cancelar e transferir são ações diferentes, com telas diferentes —
        um código só faria a tela dizer "não pode cancelar" em quem tentou
        transferir."""
        from app.models.satellite_ticket import TicketTransfer
        from app.services.satellite_ticket_service import SatelliteTicketService

        self._monta(monkeypatch, [{"id": "tk1", "status": "redeemed",
                                   "player_id": JOGADOR}])
        dados = TicketTransfer(to_player_id="p9", amount=0)
        with pytest.raises(ErroDeNegocio) as exc:
            SatelliteTicketService._conferir_troca_de_dono("tk1", dados)
        assert exc.value.code == "ticket_nao_transferivel"
        assert exc.value.status == 409

    def test_transferir_para_o_dono_atual_e_409(self, monkeypatch):
        from app.models.satellite_ticket import TicketTransfer
        from app.services.satellite_ticket_service import SatelliteTicketService

        self._monta(monkeypatch, [{"id": "tk1", "status": "available",
                                   "player_id": JOGADOR}])
        dados = TicketTransfer(to_player_id=JOGADOR, amount=0)
        with pytest.raises(ErroDeNegocio) as exc:
            SatelliteTicketService._conferir_troca_de_dono("tk1", dados)
        assert exc.value.code == "ticket_ja_e_do_jogador"
        assert exc.value.status == 409

    def test_jogador_de_destino_inexistente_e_404(self, monkeypatch):
        from app.models.satellite_ticket import TicketTransfer
        from app.services.satellite_ticket_service import SatelliteTicketService

        self._monta(monkeypatch, [{"id": "tk1", "status": "available",
                                   "player_id": JOGADOR}])
        dados = TicketTransfer(to_player_id="p9", amount=0)
        with pytest.raises(ErroDeNegocio) as exc:
            SatelliteTicketService._conferir_troca_de_dono("tk1", dados)
        assert exc.value.code == "jogador_de_destino_nao_encontrado"
        assert exc.value.status == 404

    def test_venda_sem_etapa_e_regra_e_nao_ausencia(self, monkeypatch):
        from app.models.satellite_ticket import TicketTransfer
        from app.services.satellite_ticket_service import SatelliteTicketService

        dados = TicketTransfer(to_player_id="p9", amount=250, register_in_cash=True)
        with pytest.raises(ErroDeNegocio) as exc:
            SatelliteTicketService._decidir_como_lancar_a_venda(
                dados, {"stage_id": None}, None, ORG
            )
        assert exc.value.code == "etapa_obrigatoria_para_venda"
        assert exc.value.status == 400

    def test_venda_sem_organizacao_e_403(self, monkeypatch):
        from app.models.satellite_ticket import TicketTransfer
        from app.services.satellite_ticket_service import SatelliteTicketService

        dados = TicketTransfer(to_player_id="p9", amount=250, register_in_cash=True)
        with pytest.raises(ErroDeNegocio) as exc:
            SatelliteTicketService._decidir_como_lancar_a_venda(
                dados, {"stage_id": "e1"}, "e1", None
            )
        assert exc.value.code == "conta_sem_organizacao"
        assert exc.value.status == 403

    def test_rota_do_ticket_repassa_o_409_do_servico(self, client, stub):
        from app.services.satellite_ticket_service import SatelliteTicketService

        def _estoura(tid, uid):
            raise ErroDeNegocio(
                "ticket_nao_cancelavel",
                "Apenas tickets ainda não resgatados podem ser cancelados",
                status=409, status_atual="redeemed",
            )

        stub(SatelliteTicketService, cancel_ticket=_estoura)
        r = client.post("/satellite-tickets/tk1/cancel")
        assert r.status_code == 409
        assert r.json()["detail"]["status_atual"] == "redeemed"


# ─────────────────────────────── fidelidade ─────────────────────────────────

class TestRecusasDeFidelidade:
    def test_recompensa_inexistente_da_404_com_codigo(self, client, stub):
        from app.services.loyalty_service import LoyaltyService

        stub(LoyaltyService, delete_reward=lambda org, rid: False)
        r = client.delete("/loyalty/rewards/r1")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "recompensa_nao_encontrada"

    def test_cupom_inexistente_da_404_com_codigo(self, client, stub):
        from app.services.loyalty_service import LoyaltyService

        stub(LoyaltyService, delete_coupon=lambda org, cid: False)
        r = client.delete("/loyalty/coupons/c1")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "cupom_nao_encontrado"

    def test_meta_inexistente_da_404_com_codigo(self, client, stub):
        from app.services.loyalty_service import LoyaltyService

        stub(LoyaltyService, delete_goal=lambda org, gid: False)
        r = client.delete("/loyalty/goals/m1")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "meta_nao_encontrada"

    def test_config_inexistente_da_404_com_codigo(self, client, stub):
        from app.services.loyalty_service import LoyaltyService

        stub(LoyaltyService, update_settings=lambda org, d: None)
        r = client.patch("/loyalty/config", json={"enabled": True})
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "config_de_fidelidade_nao_encontrada"


# ────────────────────────────── organizações ────────────────────────────────

SEGREDO = 'duplicate key value violates unique constraint "organizations_pkey"'


@pytest.fixture
def orgs(monkeypatch):
    from app.routers import organizations as mod

    fake = FakeSupabase({
        "organizations": [{"id": ORG, "name": "Clube A", "slug": "clube-a",
                           "status": "active", "plan_code": "free",
                           "max_users_override": None}],
        "plans": [], "staff": [], "players": [], "tournaments": [],
    })
    monkeypatch.setattr(mod, "supabase_admin", fake)
    return fake


@pytest.fixture
def admin(client):
    client.usuario["platform_admin"] = True
    return client


class TestRecusasDeOrganizacao:
    def test_usuario_comum_recebe_403_com_codigo(self, client, orgs):
        r = client.get("/organizations")
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "apenas_platform_admin"

    def test_organizacao_inexistente_da_404_com_codigo(self, admin, orgs):
        r = admin.get("/organizations/outra/staff")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "organizacao_nao_encontrada"

    def test_plano_invalido_manda_o_codigo_do_plano_separado(self, admin, orgs):
        r = admin.patch(f"/organizations/{ORG}/plan", json={"plan_code": "ouro"})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "plano_invalido"
        assert r.json()["detail"]["plan_code"] == "ouro"

    def test_texto_do_banco_nao_chega_a_tela_na_exclusao(self, admin, orgs, caplog):
        """A mensagem do Postgres vem em inglês e cita nome de constraint: não
        diz nada a quem lê e ainda expõe o esquema. Vai só para o log."""
        def _estoura(_):
            raise Exception(SEGREDO)

        orgs.rpcs["delete_organization"] = _estoura
        with caplog.at_level("ERROR"):
            r = admin.delete(f"/organizations/{ORG}")
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "falha_ao_excluir_organizacao"
        assert SEGREDO not in r.text
        assert SEGREDO in caplog.text

    def test_organizacao_ativa_pede_suspensao_antes(self, admin, orgs):
        def _estoura(_):
            raise Exception("Suspenda a organização antes")

        orgs.rpcs["delete_organization"] = _estoura
        r = admin.delete(f"/organizations/{ORG}")
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "organizacao_ativa_nao_pode_ser_excluida"

    def test_convite_ja_respondido_da_404_com_codigo(self, client, orgs):
        orgs.rpcs["decline_org_invite"] = None
        r = client.post("/organizations/invites/s9/decline")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "convite_ja_respondido"

    def test_limite_de_usuarios_do_plano_no_aceite_da_409(self, client, orgs):
        def _estoura(_):
            raise Exception("PLANO_LIMITE_USUARIOS")

        orgs.rpcs["accept_org_invite"] = _estoura
        r = client.post("/organizations/invites/s9/accept")
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "limite_de_usuarios_do_plano"

    def test_troca_de_org_distingue_admin_de_usuario_comum(self, client, orgs):
        """Dois códigos porque são duas situações: o platform admin pode entrar
        em qualquer org ativa (se falhou, a org é que não serve); o usuário
        comum é quem não tem vínculo."""
        def _estoura(_):
            raise Exception("sem vínculo")

        orgs.rpcs["set_active_organization"] = _estoura
        r = client.post("/organizations/switch", json={"organization_id": "outra"})
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "sem_vinculo_com_a_organizacao"

        client.usuario["platform_admin"] = True
        r = client.post("/organizations/switch", json={"organization_id": "outra"})
        assert r.json()["detail"]["code"] == "organizacao_inexistente_ou_inativa"

    def test_slug_repetido_manda_o_slug_separado(self, admin, orgs):
        r = admin.post("/organizations", json={
            "name": "Clube A", "admin_name": "Dono", "admin_email": "dono@a.com",
        })
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "slug_de_organizacao_em_uso"
        assert r.json()["detail"]["slug"] == "clube-a"

    def test_resposta_crua_do_servico_de_auth_nao_vaza(self, admin, orgs, monkeypatch, caplog):
        """O corpo do erro do Supabase Auth já trouxe o e-mail de outra conta.
        A tela recebe código + frase nossa; o corpo fica no log."""
        from app.routers import organizations as mod

        cru = '{"msg":"user outra.pessoa@x.com already registered"}'

        class _Resposta:
            status_code = 500
            text = cru

            def json(self):
                return {"msg": cru}

        monkeypatch.setattr(mod.httpx, "post", lambda *a, **k: _Resposta())
        with caplog.at_level("ERROR"):
            r = admin.post("/organizations", json={
                "name": "Clube Novo", "admin_name": "Dono",
                "admin_email": "dono@novo.com",
            })
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "falha_ao_convidar_administrador"
        assert "outra.pessoa@x.com" not in r.text
        assert "outra.pessoa@x.com" in caplog.text

    def test_servico_de_email_fora_do_ar_da_503_com_codigo(self, admin, orgs, monkeypatch):
        from app.routers import organizations as mod

        def _cai(*a, **k):
            raise RuntimeError("connect timeout to https://xyz.supabase.co")

        monkeypatch.setattr(mod.httpx, "post", _cai)
        r = admin.post("/organizations", json={
            "name": "Clube Novo", "admin_name": "Dono",
            "admin_email": "dono@novo.com",
        })
        assert r.status_code == 503
        assert r.json()["detail"]["code"] == "servico_de_email_indisponivel"
        assert "xyz.supabase.co" not in r.text


class TestConviteDeFuncionarioNaoVazaTextoDeTerceiro:
    """O convite passa pelo Supabase Auth. O que ele devolve quando recusa é
    inglês, JSON e — já aconteceu — o e-mail de outra conta. Isso vai para o
    log; a tela recebe código + frase nossa."""

    def _resposta(self, monkeypatch, status, corpo=None, texto=""):
        import httpx

        class _Resp:
            status_code = status
            text = texto

            def json(self):
                if corpo is None:
                    raise ValueError("sem corpo")
                return corpo

        monkeypatch.setattr(httpx, "post", lambda url, **k: _Resp())
        monkeypatch.setattr(
            httpx, "get", lambda url, **k: type(
                "R", (), {"status_code": 200, "json": lambda self: {"users": []}}
            )()
        )

    def _convida(self):
        from app.models.staff import StaffCreate
        from app.services.staff_service import StaffService

        return StaffService.create_staff(
            StaffCreate(email="novo@clube.com"), created_by=AUTH, organization_id=ORG
        )

    def test_servico_de_email_fora_do_ar(self, monkeypatch):
        import httpx

        _monta_staff(monkeypatch)

        def _cai(url, **k):
            raise RuntimeError("connect timeout to https://xyz.supabase.co")

        monkeypatch.setattr(httpx, "post", _cai)
        with pytest.raises(ErroDeNegocio) as exc:
            self._convida()
        assert exc.value.code == "servico_de_email_indisponivel"
        assert "xyz.supabase.co" not in exc.value.message

    def test_cota_de_email_estourada_tem_codigo_proprio(self, monkeypatch):
        """A saída é ESPERAR, não corrigir o e-mail — a tela precisa distinguir
        este caso da recusa comum."""
        _monta_staff(monkeypatch)
        self._resposta(monkeypatch, 429)
        with pytest.raises(ErroDeNegocio) as exc:
            self._convida()
        assert exc.value.code == "limite_de_envio_de_email"

    def test_conta_ja_existente_e_nao_localizada_da_409(self, monkeypatch):
        _monta_staff(monkeypatch)
        self._resposta(monkeypatch, 422, {"msg": "já existe"})
        with pytest.raises(ErroDeNegocio) as exc:
            self._convida()
        assert exc.value.code == "email_ja_tem_conta"
        assert exc.value.status == 409
        assert exc.value.dados["email"] == "novo@clube.com"

    def test_resposta_crua_do_auth_fica_no_log(self, monkeypatch, caplog):
        cru = '{"msg":"user outra.pessoa@x.com is already registered"}'
        _monta_staff(monkeypatch)
        self._resposta(monkeypatch, 500, {"msg": cru}, texto=cru)
        with caplog.at_level("ERROR"):
            with pytest.raises(ErroDeNegocio) as exc:
                self._convida()
        assert exc.value.code == "falha_ao_enviar_convite"
        assert "outra.pessoa@x.com" not in exc.value.message
        assert "outra.pessoa@x.com" in caplog.text
