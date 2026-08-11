"""Testes do serviço de caixa por funcionário.

Complementa `test_cashbox.py` cobrindo permissão, abertura/fechamento e os
relatórios de conferência.

O que concentra o risco:

- **Fail-closed na permissão.** Não ter linha em `staff` já significou
  "super-admin"; num SaaS isso daria o caixa inteiro a qualquer conta
  autenticada de qualquer cliente. Hoje só quem está na allowlist passa.
- **O saldo de abertura entra duas vezes se ninguém cuidar.** Ele é
  gravado no caixa E lançado como um movimento de suprimento (para o
  extrato explicar de onde veio o dinheiro); o trigger de saldo somaria de
  novo, então o serviço reescreve o saldo depois.
- **A conferência de fechamento.** A diferença entre o contado e o
  esperado vira um movimento de ajuste ANTES de fechar — é o que faz o
  caixa terminar valendo exatamente o que foi contado, com o furo
  registrado em vez de escondido.
"""
import pytest

from app.services import cashbox_service as mod
from app.services.cashbox_service import CashboxService as S, _signed

from tests.conftest import FakeSupabase


AUTH = "88888888-8888-8888-8888-888888888888"
STAFF = "99999999-9999-9999-9999-999999999999"
OUTRO_STAFF = "99999999-9999-9999-9999-999999999998"
ETAPA = "11111111-1111-1111-1111-111111111111"
CAIXA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1"
SESSAO = "cccccccc-cccc-cccc-cccc-ccccccccccc1"
TOUR = "22222222-2222-2222-2222-222222222222"


def _staff(id_=STAFF, auth=AUTH, ativo=True, permissoes=("cashbox.operate",)):
    return {"id": id_, "auth_user_id": auth, "name": "Fulano",
            "email": "fulano@clube.com", "active": ativo,
            "permission_groups": {"permissions": list(permissoes)}}


def _caixa(id_=CAIXA, status="closed", saldo=0.0, sessao=None, staff=STAFF):
    return {"id": id_, "staff_id": staff, "stage_id": ETAPA, "status": status,
            "current_balance": saldo, "current_session_id": sessao,
            "created_at": "2026-06-08T00:00:00Z"}


def _sessao(id_=SESSAO, inicial=200.0, fechada=None, contado=None, diff=None):
    return {"id": id_, "cashbox_id": CAIXA, "opened_at": "2026-06-08T10:00:00Z",
            "opened_by": AUTH, "initial_balance": inicial, "closed_at": fechada,
            "actual_final_balance": contado, "difference": diff,
            "created_at": "2026-06-08T10:00:00Z"}


def _mov(tipo, valor, sinal=None, sessao=SESSAO):
    return {"id": f"mov-{tipo}-{valor}", "cashbox_id": CAIXA, "session_id": sessao,
            "type": tipo, "amount": valor,
            "signed_amount": sinal if sinal is not None else _signed(valor, tipo),
            "created_at": "2026-06-08T11:00:00Z"}


def _monta(monkeypatch, **tabelas):
    base = {
        "staff": [_staff()],
        "cashboxes": [_caixa()],
        "cashbox_sessions": [],
        "cashbox_transactions": [],
        "stages": [{"id": ETAPA, "name": "Etapa 1"}],
        "tournaments": [{"id": TOUR, "stage_id": ETAPA}],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    monkeypatch.setattr(mod, "supabase", fake)
    return fake


class TestSinalDoMovimento:
    """O sinal decide se o dinheiro entra ou sai. Um sinal trocado num
    `prize` faria o caixa crescer ao PAGAR prêmio."""

    @pytest.mark.parametrize("tipo", ["buy_in", "rebuy", "addon", "supply"])
    def test_entradas_sao_positivas(self, tipo):
        assert _signed(100, tipo) == 100
        assert _signed(-100, tipo) == 100      # valor absoluto: o tipo manda

    @pytest.mark.parametrize("tipo", ["prize", "sangria"])
    def test_saidas_sao_negativas(self, tipo):
        assert _signed(100, tipo) == -100
        assert _signed(-100, tipo) == -100

    def test_ajuste_respeita_o_sinal_informado(self):
        """Ajuste pode ser sobra ou falta; quem chama é que sabe."""
        assert _signed(-30, "adjustment") == -30
        assert _signed(30, "adjustment") == 30


class TestPermissao:
    def test_sem_vinculo_e_fora_da_allowlist_nao_tem_acesso(self, monkeypatch):
        """FAIL-CLOSED: o comportamento antigo dava o caixa inteiro a
        qualquer conta autenticada sem staff."""
        _monta(monkeypatch, staff=[])
        assert S.can_admin("estranho") is False
        assert S.can_operate("estranho") is False

    def test_id_na_allowlist_e_super_admin(self, monkeypatch):
        _monta(monkeypatch, staff=[])
        from app.config import get_settings
        monkeypatch.setattr(type(get_settings()), "super_admin_ids",
                            property(lambda self: {"dono"}))
        assert S.can_admin("dono") is True
        assert S.can_operate("dono") is True

    def test_funcionario_desativado_perde_o_acesso(self, monkeypatch):
        _monta(monkeypatch, staff=[_staff(ativo=False, permissoes=("cashbox.admin",))])
        assert S.can_admin(AUTH) is False

    def test_permissao_de_admin(self, monkeypatch):
        _monta(monkeypatch, staff=[_staff(permissoes=("cashbox.admin",))])
        assert S.can_admin(AUTH) is True
        assert S.can_operate(AUTH) is True      # admin também opera

    def test_operador_nao_e_admin(self, monkeypatch):
        _monta(monkeypatch)
        assert S.can_operate(AUTH) is True
        assert S.can_admin(AUTH) is False

    @pytest.mark.parametrize("legado", ["cashier", "cashier_players"])
    def test_permissoes_antigas_continuam_operando(self, monkeypatch, legado):
        """Grupos criados antes das chaves `cashbox.*` não podem perder acesso
        de um dia para o outro."""
        _monta(monkeypatch, staff=[_staff(permissoes=(legado,))])
        assert S.can_operate(AUTH) is True

    @pytest.mark.parametrize("legado", ["financial", "general_cash", "employees"])
    def test_permissoes_antigas_de_admin(self, monkeypatch, legado):
        _monta(monkeypatch, staff=[_staff(permissoes=(legado,))])
        assert S.can_admin(AUTH) is True

    def test_grupo_sem_permissoes(self, monkeypatch):
        _monta(monkeypatch, staff=[_staff(permissoes=())])
        assert S.can_operate(AUTH) is False


class TestCaixaAbertoObrigatorio:
    """Gancho usado pelos serviços que produzem transação: sem caixa aberto,
    o dinheiro entraria sem dono e não bateria com ninguém no fechamento."""

    def test_exige_caixa_aberto(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="Abra seu caixa"):
            S.require_open_cashbox(AUTH, ETAPA)

    def test_caixa_aberto_passa(self, monkeypatch):
        _monta(monkeypatch, cashboxes=[_caixa(status="open", saldo=500)])
        assert S.require_open_cashbox(AUTH, ETAPA)["id"] == CAIXA

    def test_sem_etapa_selecionada(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="Selecione uma etapa"):
            S.require_open_cashbox(AUTH, None)

    def test_usuario_sem_cadastro_de_funcionario(self, monkeypatch):
        _monta(monkeypatch, staff=[])
        with pytest.raises(ValueError, match="cadastro de funcionário"):
            S.require_open_cashbox("estranho", ETAPA)

    def test_super_admin_nao_precisa_de_caixa(self, monkeypatch):
        """Fluxo de teste/administração não fica travado."""
        _monta(monkeypatch, staff=[])
        from app.config import get_settings
        monkeypatch.setattr(type(get_settings()), "super_admin_ids",
                            property(lambda self: {"dono"}))
        assert S.require_open_cashbox("dono", ETAPA) is None

    def test_deriva_a_etapa_a_partir_do_torneio(self, monkeypatch):
        """Serviços de transação não enxergam o header X-Stage-ID."""
        _monta(monkeypatch, cashboxes=[_caixa(status="open")])
        assert S.require_open_cashbox_for_tournament(AUTH, TOUR)["id"] == CAIXA

    def test_torneio_inexistente(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="Torneio não encontrado"):
            S.require_open_cashbox_for_tournament(AUTH, "nao-existe")

    def test_super_admin_nao_consulta_o_torneio(self, monkeypatch):
        _monta(monkeypatch, staff=[])
        from app.config import get_settings
        monkeypatch.setattr(type(get_settings()), "super_admin_ids",
                            property(lambda self: {"dono"}))
        assert S.require_open_cashbox_for_tournament("dono", "nem-existe") is None


class TestCriacaoEListagem:
    def test_cria_o_caixa_do_funcionario_na_etapa(self, monkeypatch):
        fake = _monta(monkeypatch, cashboxes=[])
        r = S.create_for_staff(STAFF, ETAPA)
        assert r.status == "closed"
        assert len(fake.store["cashboxes"]) == 1

    def test_criar_duas_vezes_nao_duplica(self, monkeypatch):
        """Idempotente: dois caixas do mesmo operador na mesma etapa
        dividiriam o dinheiro dele entre duas linhas."""
        fake = _monta(monkeypatch)
        S.create_for_staff(STAFF, ETAPA)
        assert len(fake.store["cashboxes"]) == 1

    def test_sem_etapa_e_recusado(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="Selecione uma etapa"):
            S.create_for_staff(STAFF, None)

    def test_funcionario_inexistente(self, monkeypatch):
        _monta(monkeypatch, staff=[])
        with pytest.raises(ValueError, match="não encontrado"):
            S.create_for_staff("fantasma", ETAPA)

    def test_criacao_automatica_em_todas_as_etapas(self, monkeypatch):
        fake = _monta(monkeypatch, cashboxes=[], stages=[
            {"id": ETAPA, "name": "Etapa 1"}, {"id": "etapa-2", "name": "Etapa 2"}])
        r = S.auto_create_for_staff(STAFF)
        assert len(r) == 2
        assert len(fake.store["cashboxes"]) == 2

    def test_criacao_automatica_com_lista_explicita(self, monkeypatch):
        fake = _monta(monkeypatch, cashboxes=[])
        S.auto_create_for_staff(STAFF, [ETAPA])
        assert len(fake.store["cashboxes"]) == 1

    def test_operador_so_ve_o_proprio_caixa(self, monkeypatch):
        """Ver o caixa dos colegas expõe quanto cada um está segurando."""
        _monta(monkeypatch, cashboxes=[_caixa(), _caixa("cb2", staff=OUTRO_STAFF)])
        r = S.list_cashboxes(AUTH)
        assert [c.id for c in r] == [CAIXA]

    def test_admin_ve_todos(self, monkeypatch):
        _monta(monkeypatch, staff=[_staff(permissoes=("cashbox.admin",))],
               cashboxes=[_caixa(), _caixa("cb2", staff=OUTRO_STAFF)])
        assert len(S.list_cashboxes(AUTH)) == 2

    def test_usuario_sem_staff_nao_lista_nada(self, monkeypatch):
        _monta(monkeypatch, staff=[])
        assert S.list_cashboxes("estranho") == []

    def test_filtra_por_etapa_e_status(self, monkeypatch):
        _monta(monkeypatch, staff=[_staff(permissoes=("cashbox.admin",))],
               cashboxes=[_caixa(status="open"), _caixa("cb2", status="closed")])
        assert [c.id for c in S.list_cashboxes(AUTH, stage_id=ETAPA, status="open")] == [CAIXA]

    def test_lista_traz_o_nome_do_operador_e_da_etapa(self, monkeypatch):
        _monta(monkeypatch)
        c = S.list_cashboxes(AUTH)[0]
        assert c.staff_name == "Fulano"
        assert c.stage_name == "Etapa 1"

    def test_lista_vazia_nao_consulta_nomes(self, monkeypatch):
        _monta(monkeypatch, cashboxes=[])
        assert S.list_cashboxes(AUTH) == []

    def test_meu_caixa_atual(self, monkeypatch):
        _monta(monkeypatch)
        assert S.get_my_current(AUTH, ETAPA).id == CAIXA

    def test_meu_caixa_e_criado_sob_demanda(self, monkeypatch):
        """Funcionário que ganhou a permissão depois da migração não pode
        ficar sem caixa esperando um admin criar."""
        fake = _monta(monkeypatch, cashboxes=[])
        assert S.get_my_current(AUTH, ETAPA) is not None
        assert len(fake.store["cashboxes"]) == 1

    def test_usuario_sem_staff_nao_tem_caixa(self, monkeypatch):
        _monta(monkeypatch, staff=[])
        assert S.get_my_current("estranho", ETAPA) is None

    def test_busca_por_id(self, monkeypatch):
        _monta(monkeypatch)
        assert S.get_cashbox(CAIXA).id == CAIXA

    def test_caixa_inexistente(self, monkeypatch):
        _monta(monkeypatch, cashboxes=[])
        assert S.get_cashbox(CAIXA) is None

    def test_caixa_aberto_do_operador_na_etapa(self, monkeypatch):
        _monta(monkeypatch, cashboxes=[_caixa(status="open")])
        assert S.find_active_for_operator(AUTH, ETAPA)["id"] == CAIXA

    def test_sem_caixa_aberto_devolve_none(self, monkeypatch):
        _monta(monkeypatch)
        assert S.find_active_for_operator(AUTH, ETAPA) is None

    def test_usuario_sem_staff_nao_tem_caixa_ativo(self, monkeypatch):
        _monta(monkeypatch, staff=[])
        assert S.find_active_for_operator("estranho", ETAPA) is None


class TestAbertura:
    def test_abre_e_registra_o_saldo_inicial_no_extrato(self, monkeypatch):
        """O saldo de abertura vira um movimento de suprimento — sem isso o
        extrato começa com dinheiro sem origem."""
        fake = _monta(monkeypatch)
        r = S.open_session(CAIXA, AUTH, 200.0, "troco inicial")
        assert r.initial_balance == 200.0
        caixa = fake.store["cashboxes"][0]
        assert caixa["status"] == "open"
        assert caixa["current_session_id"] == r.id
        movimentos = fake.store["cashbox_transactions"]
        assert len(movimentos) == 1
        assert movimentos[0]["type"] == "supply"

    def test_o_saldo_inicial_nao_conta_duas_vezes(self, monkeypatch):
        """O saldo já foi gravado no caixa; o trigger somaria o suprimento de
        novo, então o serviço reescreve o valor."""
        fake = _monta(monkeypatch)
        S.open_session(CAIXA, AUTH, 200.0, None)
        assert float(fake.store["cashboxes"][0]["current_balance"]) == 200.0

    def test_abertura_zerada_nao_gera_movimento(self, monkeypatch):
        fake = _monta(monkeypatch)
        S.open_session(CAIXA, AUTH, 0.0, None)
        assert fake.store["cashbox_transactions"] == []

    def test_caixa_inexistente(self, monkeypatch):
        _monta(monkeypatch, cashboxes=[])
        with pytest.raises(ValueError, match="não encontrado"):
            S.open_session(CAIXA, AUTH, 0, None)

    def test_abrir_o_que_ja_esta_aberto(self, monkeypatch):
        """Duas sessões abertas tornariam impossível dizer a qual delas cada
        movimento pertence."""
        _monta(monkeypatch, cashboxes=[_caixa(status="open")])
        with pytest.raises(ValueError, match="já está aberto"):
            S.open_session(CAIXA, AUTH, 0, None)

    def test_caixa_arquivado_nao_reabre(self, monkeypatch):
        _monta(monkeypatch, cashboxes=[_caixa(status="archived")])
        with pytest.raises(ValueError, match="arquivado"):
            S.open_session(CAIXA, AUTH, 0, None)

    def test_operador_nao_abre_o_caixa_de_outro(self, monkeypatch):
        _monta(monkeypatch, cashboxes=[_caixa(staff=OUTRO_STAFF)])
        with pytest.raises(ValueError, match="Sem permissão"):
            S.open_session(CAIXA, AUTH, 0, None)

    def test_admin_abre_o_caixa_de_outro(self, monkeypatch):
        """Necessário quando o operador não chegou e o clube precisa abrir."""
        _monta(monkeypatch, staff=[_staff(permissoes=("cashbox.admin",))],
               cashboxes=[_caixa(staff=OUTRO_STAFF)])
        assert S.open_session(CAIXA, AUTH, 100.0, None) is not None


class TestFechamento:
    def _aberto(self, monkeypatch, saldo=500.0):
        return _monta(monkeypatch,
                      cashboxes=[_caixa(status="open", saldo=saldo, sessao=SESSAO)],
                      cashbox_sessions=[_sessao()])

    def test_fechamento_sem_diferenca(self, monkeypatch):
        fake = self._aberto(monkeypatch)
        r = S.close_session(CAIXA, AUTH, 500.0, None)
        assert r.difference == 0
        assert fake.store["cashboxes"][0]["status"] == "closed"
        assert fake.store["cashboxes"][0]["current_session_id"] is None
        # sem furo, sem lançamento de ajuste
        assert fake.store["cashbox_transactions"] == []

    def test_falta_de_caixa_vira_um_ajuste_registrado(self, monkeypatch):
        """O furo fica no extrato em vez de sumir: é o que permite cobrar ou
        investigar depois."""
        fake = self._aberto(monkeypatch)
        r = S.close_session(CAIXA, AUTH, 480.0, "faltou")
        assert r.difference == -20
        ajuste = fake.store["cashbox_transactions"][0]
        assert ajuste["type"] == "adjustment"
        assert ajuste["signed_amount"] == -20
        assert ajuste["amount"] == 20        # valor sempre positivo; o sinal é o que informa

    def test_sobra_tambem_e_registrada(self, monkeypatch):
        fake = self._aberto(monkeypatch)
        S.close_session(CAIXA, AUTH, 530.0, None)
        assert fake.store["cashbox_transactions"][0]["signed_amount"] == 30

    def test_guarda_esperado_e_contado_na_sessao(self, monkeypatch):
        fake = self._aberto(monkeypatch)
        S.close_session(CAIXA, AUTH, 470.0, "conferido a dois")
        sessao = fake.store["cashbox_sessions"][0]
        assert float(sessao["expected_final_balance"]) == 500.0
        assert float(sessao["actual_final_balance"]) == 470.0
        assert sessao["closed_at"] is not None

    def test_caixa_inexistente(self, monkeypatch):
        _monta(monkeypatch, cashboxes=[])
        with pytest.raises(ValueError, match="não encontrado"):
            S.close_session(CAIXA, AUTH, 0, None)

    def test_fechar_o_que_nao_esta_aberto(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="não está aberto"):
            S.close_session(CAIXA, AUTH, 0, None)

    def test_operador_nao_fecha_o_caixa_de_outro(self, monkeypatch):
        _monta(monkeypatch,
               cashboxes=[_caixa(status="open", sessao=SESSAO, staff=OUTRO_STAFF)],
               cashbox_sessions=[_sessao()])
        with pytest.raises(ValueError, match="Sem permissão"):
            S.close_session(CAIXA, AUTH, 0, None)

    def test_caixa_aberto_sem_sessao_pede_o_admin(self, monkeypatch):
        """Estado inconsistente: fechar assim perderia os movimentos."""
        _monta(monkeypatch, cashboxes=[_caixa(status="open", sessao=None)])
        with pytest.raises(ValueError, match="contate o admin"):
            S.close_session(CAIXA, AUTH, 0, None)


class TestMovimentosDeAdmin:
    def _aberto_como_admin(self, monkeypatch, saldo=500.0):
        return _monta(monkeypatch,
                      staff=[_staff(permissoes=("cashbox.admin",))],
                      cashboxes=[_caixa(status="open", saldo=saldo, sessao=SESSAO)],
                      cashbox_sessions=[_sessao()])

    def test_suprimento(self, monkeypatch):
        fake = self._aberto_como_admin(monkeypatch)
        r = S.register_supply(CAIXA, AUTH, 300.0, "reforço de troco")
        assert r.signed_amount == 300
        assert fake.store["cashbox_transactions"][0]["session_id"] == SESSAO

    def test_sangria(self, monkeypatch):
        self._aberto_como_admin(monkeypatch)
        assert S.register_sangria(CAIXA, AUTH, 200.0, None).signed_amount == -200

    def test_sangria_maior_que_o_saldo(self, monkeypatch):
        """Deixaria o caixa negativo — não existe operação assim, é digitação
        errada. A mensagem mostra o disponível para o operador conferir."""
        self._aberto_como_admin(monkeypatch, saldo=150.0)
        with pytest.raises(ValueError, match="Saldo insuficiente"):
            S.register_sangria(CAIXA, AUTH, 200.0, None)

    def test_sangria_exata_do_saldo_e_permitida(self, monkeypatch):
        self._aberto_como_admin(monkeypatch, saldo=200.0)
        assert S.register_sangria(CAIXA, AUTH, 200.0, None) is not None

    def test_operador_comum_nao_movimenta(self, monkeypatch):
        _monta(monkeypatch, cashboxes=[_caixa(status="open", sessao=SESSAO)])
        with pytest.raises(ValueError, match="Sem permissão"):
            S.register_supply(CAIXA, AUTH, 100.0, None)

    def test_caixa_inexistente(self, monkeypatch):
        _monta(monkeypatch, staff=[_staff(permissoes=("cashbox.admin",))],
               cashboxes=[])
        with pytest.raises(ValueError, match="não encontrado"):
            S.register_supply(CAIXA, AUTH, 100.0, None)

    def test_caixa_fechado_nao_recebe_movimento(self, monkeypatch):
        _monta(monkeypatch, staff=[_staff(permissoes=("cashbox.admin",))])
        with pytest.raises(ValueError, match="precisa estar aberto"):
            S.register_supply(CAIXA, AUTH, 100.0, None)


class TestHistorico:
    def test_lista_sessoes(self, monkeypatch):
        _monta(monkeypatch, cashbox_sessions=[_sessao(), _sessao("s2")])
        assert len(S.list_sessions(CAIXA)) == 2

    def test_lista_movimentos(self, monkeypatch):
        _monta(monkeypatch, cashbox_transactions=[
            _mov("buy_in", 100), _mov("prize", 500)])
        assert len(S.list_transactions(CAIXA)) == 2

    def test_filtra_movimentos_por_sessao(self, monkeypatch):
        _monta(monkeypatch, cashbox_transactions=[
            _mov("buy_in", 100, sessao=SESSAO), _mov("buy_in", 200, sessao="s2")])
        assert len(S.list_transactions(CAIXA, session_id=SESSAO)) == 1


class TestResumo:
    def _com_movimentos(self, monkeypatch):
        return _monta(monkeypatch,
                      cashboxes=[_caixa(status="open", saldo=730.0, sessao=SESSAO)],
                      cashbox_sessions=[_sessao(inicial=200.0)],
                      cashbox_transactions=[
                          _mov("supply", 200.0),        # abertura
                          _mov("buy_in", 300.0),
                          _mov("rebuy", 100.0),
                          _mov("addon", 50.0),
                          _mov("prize", 120.0),
                          _mov("sangria", 30.0),
                          _mov("adjustment", 30.0, sinal=30.0),
                      ])

    def test_soma_por_tipo_e_conta_as_operacoes(self, monkeypatch):
        self._com_movimentos(monkeypatch)
        r = S.get_summary(CAIXA)
        assert (r.total_supply, r.total_buy_ins, r.total_rebuys) == (200.0, 300.0, 100.0)
        assert (r.buy_in_count, r.rebuy_count, r.addon_count, r.prize_count) == (1, 1, 1, 1)
        assert r.total_prizes_paid == 120.0
        assert r.total_sangria == 30.0
        assert r.total_adjustments == 30.0

    def test_saldo_esperado_segue_a_formula_do_extrato(self, monkeypatch):
        """200 inicial + 200 suprimento − 30 sangria + 300 + 100 + 50 − 120
        + 30 de ajuste = 730."""
        self._com_movimentos(monkeypatch)
        assert S.get_summary(CAIXA).expected_balance == 730.0

    def test_periodo_filtrado_nao_usa_o_saldo_de_abertura(self, monkeypatch):
        """Num recorte de datas o saldo inicial do dia não se aplica — o
        relatório mostra só o movimento do período."""
        self._com_movimentos(monkeypatch)
        r = S.get_summary(CAIXA, date_from="2026-06-01", date_to="2026-06-30")
        assert r.initial_balance == 0.0

    def test_traz_os_nomes_do_operador_e_da_etapa(self, monkeypatch):
        self._com_movimentos(monkeypatch)
        r = S.get_summary(CAIXA)
        assert r.staff_name == "Fulano"
        assert r.stage_name == "Etapa 1"

    def test_caixa_inexistente(self, monkeypatch):
        _monta(monkeypatch, cashboxes=[])
        with pytest.raises(ValueError, match="não encontrado"):
            S.get_summary(CAIXA)

    def test_consolidado_soma_os_caixas_da_etapa(self, monkeypatch):
        _monta(monkeypatch,
               cashboxes=[_caixa(status="open", saldo=100.0),
                          _caixa("cb2", status="open", saldo=250.0, staff=OUTRO_STAFF)],
               cashbox_transactions=[_mov("buy_in", 300.0),
                                     _mov("prize", 50.0)])
        r = S.get_aggregated_summary(stage_id=ETAPA)
        assert len(r.cashboxes) == 2
        assert r.grand_total_balance == 350.0

    def test_consolidado_sem_caixas(self, monkeypatch):
        _monta(monkeypatch, cashboxes=[])
        assert S.get_aggregated_summary().cashboxes == []


class TestDemonstrativo:
    """Conferência por SESSÃO: cada ciclo abre→fecha bate sozinho. Somar o
    período inteiro esconderia um furo compensado por uma sobra."""

    def test_sessao_fechada_traz_o_contado_e_a_diferenca_da_propria_sessao(self, monkeypatch):
        _monta(monkeypatch,
               cashboxes=[_caixa(status="closed", saldo=0.0)],
               cashbox_sessions=[_sessao(inicial=200.0, fechada="2026-06-08T20:00:00Z",
                                         contado=480.0, diff=-20.0)],
               cashbox_transactions=[_mov("supply", 200.0), _mov("buy_in", 300.0),
                                     _mov("adjustment", 20.0, sinal=-20.0)])
        r = S.get_demonstrativo()
        s = r.sessions[0]
        assert s.is_open is False
        assert s.actual_balance == 480.0
        assert s.difference == -20.0
        assert s.expected_balance == 500.0      # ajuste fora da conta do esperado

    def test_suprimento_extra_desconta_o_saldo_de_abertura(self, monkeypatch):
        """A abertura aparece como `supply`; mostrá-la de novo como reforço
        contaria o mesmo dinheiro duas vezes na leitura do relatório."""
        _monta(monkeypatch,
               cashboxes=[_caixa(status="open", saldo=700.0, sessao=SESSAO)],
               cashbox_sessions=[_sessao(inicial=200.0)],
               cashbox_transactions=[_mov("supply", 200.0), _mov("supply", 500.0)])
        assert S.get_demonstrativo().sessions[0].total_supply == 500.0

    def test_suprimento_menor_que_a_abertura_nao_fica_negativo(self, monkeypatch):
        _monta(monkeypatch,
               cashboxes=[_caixa(status="open", saldo=0.0, sessao=SESSAO)],
               cashbox_sessions=[_sessao(inicial=200.0)],
               cashbox_transactions=[])
        assert S.get_demonstrativo().sessions[0].total_supply == 0.0

    def test_sessao_aberta_confere_contra_o_saldo_atual(self, monkeypatch):
        """Ainda não houve contagem; o "contado" é o que o sistema diz ter."""
        _monta(monkeypatch,
               cashboxes=[_caixa(status="open", saldo=520.0, sessao=SESSAO)],
               cashbox_sessions=[_sessao(inicial=200.0)],
               cashbox_transactions=[_mov("supply", 200.0), _mov("buy_in", 300.0)])
        s = S.get_demonstrativo().sessions[0]
        assert s.is_open is True
        assert s.actual_balance == 520.0
        assert s.difference == 20.0

    def test_conta_as_sessoes_abertas(self, monkeypatch):
        _monta(monkeypatch,
               cashboxes=[_caixa(status="open", saldo=0.0, sessao=SESSAO)],
               cashbox_sessions=[_sessao(), _sessao("s2", fechada="2026-06-08T20:00:00Z",
                                                    contado=0.0, diff=0.0)])
        assert S.get_demonstrativo().open_session_count == 1

    def test_filtra_por_funcionario(self, monkeypatch):
        _monta(monkeypatch,
               cashboxes=[_caixa(), _caixa("cb2", staff=OUTRO_STAFF)],
               cashbox_sessions=[_sessao()])
        r = S.get_demonstrativo(staff_id=OUTRO_STAFF)
        assert r.sessions == []      # a única sessão é do outro caixa

    def test_sem_caixa_no_escopo(self, monkeypatch):
        _monta(monkeypatch, cashboxes=[])
        assert S.get_demonstrativo(stage_id="etapa-vazia").sessions == []

    def test_sem_sessao_no_periodo(self, monkeypatch):
        _monta(monkeypatch, cashbox_sessions=[])
        assert S.get_demonstrativo().sessions == []

    def test_totais_gerais_sao_arredondados(self, monkeypatch):
        """Soma de float acumula resto (0.1+0.2); sem arredondar, o total do
        relatório aparece com 12 casas decimais."""
        _monta(monkeypatch,
               cashboxes=[_caixa(status="open", saldo=0.3, sessao=SESSAO)],
               cashbox_sessions=[_sessao(inicial=0.0)],
               cashbox_transactions=[_mov("buy_in", 0.1), _mov("buy_in", 0.2)])
        r = S.get_demonstrativo()
        assert r.grand_buy_ins == 0.3

    def test_traz_o_nome_do_operador_e_da_etapa(self, monkeypatch):
        _monta(monkeypatch,
               cashboxes=[_caixa(status="open", sessao=SESSAO)],
               cashbox_sessions=[_sessao()])
        s = S.get_demonstrativo().sessions[0]
        assert s.staff_name == "Fulano"
        assert s.stage_name == "Etapa 1"

    def test_relatorio_de_sessao_e_puro(self, monkeypatch):
        """`_compute_session_report` não toca no banco: é o que permite
        montar o demonstrativo inteiro com 5 consultas em vez de 5 por
        sessão."""
        r = S._compute_session_report(
            _sessao(inicial=100.0, fechada="2026-06-08T20:00:00Z",
                    contado=390.0, diff=-10.0),
            {"current_balance": 0},
            [_mov("supply", 100.0), _mov("buy_in", 300.0),
             _mov("adjustment", 10.0, sinal=-10.0)],
        )
        assert r.expected_balance == 400.0
        assert r.difference == -10.0
        assert r.total_adjustments == -10.0

    def test_sessao_fechada_sem_contagem_registrada(self, monkeypatch):
        """Dado antigo, anterior à conferência: não pode quebrar o relatório."""
        r = S._compute_session_report(
            _sessao(fechada="2026-06-08T20:00:00Z", contado=None, diff=None),
            {}, [])
        assert r.actual_balance is None
        assert r.difference is None
