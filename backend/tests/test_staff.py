"""Testes de funcionarios: convite, remocao e permissoes.

Duas regras aqui foram escritas depois de problemas concretos: convite
pendente e apagado de verdade (desativar deixaria o convite aparecendo para
sempre e travaria a chave unica), e funcionario com HISTORICO nao pode ser
apagado -- os pagamentos dele entram no DRE e sumiriam junto.

O caso que gerou o bloco de convites: um funcionario ficou preso em "convite
pendente" e o admin nao tinha NENHUMA saida pela tela -- cancelar nao mudava
nada e o convite so viraria membro se a propria pessoa entrasse no sistema
para responder.
"""
import pytest

from app.services import staff_service
from app.services.staff_service import StaffService
from app.models.staff import StaffCreate, StaffUpdate, PermissionGroupCreate

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
AUTH = "88888888-8888-8888-8888-888888888888"
STAFF = "99999999-9999-9999-9999-999999999999"


def _funcionario(id_=STAFF, ativo=True, status="accepted", org=ORG, auth=AUTH):
    return {
        "id": id_, "auth_user_id": auth, "name": "Fulano",
        "email": "fulano@clube.com", "permission_group_id": None,
        "active": ativo, "invite_status": status, "organization_id": org,
        "created_at": "2026-06-08T00:00:00Z", "updated_at": "2026-06-08T00:00:00Z",
    }


def _monta(monkeypatch, tabelas=None, rpcs=None):
    base = {
        "staff": [],
        "permission_groups": [],
        "cashboxes": [],
        "cashbox_sessions": [],
        "cashbox_transactions": [],
        "organizations": [{"id": ORG, "name": "NextHub", "status": "active"}],
    }
    base.update(tabelas or {})
    fake = FakeSupabase(base)
    fake.rpcs = rpcs or {}
    monkeypatch.setattr(staff_service, "supabase", fake)
    monkeypatch.setattr(staff_service, "supabase_admin", fake)
    return fake


class TestGruposDePermissao:
    def test_cria_grupo(self, monkeypatch):
        fake = _monta(monkeypatch)
        StaffService.create_group(PermissionGroupCreate(
            name="Caixa", description="Opera o caixa", permissions=["cashier"]
        ))
        assert fake.store["permission_groups"][0]["name"] == "Caixa"

    def test_lista_grupos(self, monkeypatch):
        _monta(monkeypatch, {"permission_groups": [
            {"id": "g1", "name": "Caixa", "description": "", "permissions": ["cashier"],
             "created_at": "2026-06-08T00:00:00Z"},
        ]})
        assert len(StaffService.get_groups()) == 1

    def test_grupo_inexistente_devolve_none(self, monkeypatch):
        _monta(monkeypatch)
        assert StaffService.get_group("nao-existe") is None

    def test_apaga_grupo(self, monkeypatch):
        fake = _monta(monkeypatch, {"permission_groups": [
            {"id": "g1", "name": "X", "description": "", "permissions": [],
             "created_at": "2026-06-08T00:00:00Z"},
        ]})
        assert StaffService.delete_group("g1") is True
        assert fake.store["permission_groups"] == []


class TestRemocaoDoClube:
    def test_sem_organizacao_e_recusado(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="organização"):
            StaffService.remove_from_org(STAFF, None)

    def test_sem_historico_o_vinculo_e_removido(self, monkeypatch):
        fake = _monta(monkeypatch, {"staff": [_funcionario()]},
                      rpcs={"remove_staff_member": {
                          "acao": "removido", "nome": "Fulano",
                          "auth_user_id": AUTH, "ultima_organizacao": False,
                          "outras_organizacoes": 1,
                      }})
        r = StaffService.remove_from_org(STAFF, ORG)
        assert r["acao"] == "removido"
        # nao era a ultima organizacao => a conta de acesso permanece
        assert r["conta_removida"] is False

    def test_com_historico_apenas_desativa(self, monkeypatch):
        """Apagar reescreveria resultados financeiros ja apurados."""
        _monta(monkeypatch, {"staff": [_funcionario()]},
               rpcs={"remove_staff_member": {
                   "acao": "desativado", "nome": "Fulano",
                   "movimentos": 4, "pagamentos": 1, "consignacoes": 0,
               }})
        r = StaffService.remove_from_org(STAFF, ORG)
        assert r["acao"] == "desativado"
        assert r["conta_removida"] is False

    def test_funcionario_inexistente_da_erro_claro(self, monkeypatch):
        fake = _monta(monkeypatch)

        def _estoura(params):
            raise Exception("FUNCIONARIO_NAO_ENCONTRADO")

        fake.rpcs = {"remove_staff_member": _estoura}
        with pytest.raises(ValueError, match="não encontrado"):
            StaffService.remove_from_org(STAFF, ORG)

    def test_caixa_aberto_bloqueia_a_remocao(self, monkeypatch):
        """Ninguem sai do clube segurando dinheiro."""
        _monta(monkeypatch, {"staff": [_funcionario()]})
        monkeypatch.setattr(
            StaffService, "_guard_no_open_cashbox",
            staticmethod(lambda sid: (_ for _ in ()).throw(ValueError("caixa aberto"))),
        )
        with pytest.raises(ValueError, match="caixa aberto"):
            StaffService.remove_from_org(STAFF, ORG)


class TestExclusaoEDesativacao:
    def test_convite_pendente_e_apagado_de_verdade(self, monkeypatch):
        """Desativar deixaria o convite marcado como pendente aparecendo para
        a pessoa, e travaria a chave unica num futuro reconvite."""
        fake = _monta(monkeypatch, {"staff": [_funcionario(status="pending", ativo=False)]})
        assert StaffService.delete_staff(STAFF) is True
        assert fake.store["staff"] == []

    def test_membro_efetivo_e_apenas_desativado(self, monkeypatch):
        fake = _monta(monkeypatch, {"staff": [_funcionario(status="accepted")]})
        StaffService.delete_staff(STAFF)
        assert len(fake.store["staff"]) == 1
        assert fake.store["staff"][0]["active"] is False

    def test_atualiza_nome_e_grupo(self, monkeypatch):
        fake = _monta(monkeypatch, {"staff": [_funcionario()]})
        StaffService.update_staff(STAFF, StaffUpdate(name="Novo Nome"))
        assert fake.store["staff"][0]["name"] == "Novo Nome"

    def test_funcionario_inexistente_devolve_none(self, monkeypatch):
        _monta(monkeypatch)
        assert StaffService.update_staff("nao-existe", StaffUpdate(name="X")) is None


class TestCancelamentoDeConvite:
    """Cancelar precisa MUDAR o estado, nao so parecer que mudou.

    O bug: a tela chamava o DELETE do funcionario, que apenas DESATIVA. Como o
    convite ja nasce inativo, o clique nao alterava nada -- a pessoa seguia
    marcada como pendente para sempre e a chave unica (auth_user_id,
    organization_id) ainda travava um novo convite para o mesmo e-mail.
    """

    def test_convite_pendente_some_da_tabela(self, monkeypatch):
        fake = _monta(monkeypatch, {"staff": [_funcionario(status="pending", ativo=False)]})
        r = StaffService.cancel_invite(STAFF, ORG)
        assert r["cancelled"] is True
        assert fake.store["staff"] == []

    def test_o_email_volta_a_ser_convidavel(self, monkeypatch):
        """Sem a linha, o (auth_user_id, organization_id) fica livre -- e um
        novo convite para o mesmo e-mail passa a ser possivel."""
        fake = _monta(monkeypatch, {"staff": [_funcionario(status="pending", ativo=False)]})
        r = StaffService.cancel_invite(STAFF, ORG)
        assert r["email"] == "fulano@clube.com"
        assert not [s for s in fake.store["staff"] if s["auth_user_id"] == AUTH]

    def test_caixas_vazios_do_convite_saem_junto(self, monkeypatch):
        """`cashboxes.staff_id` e ON DELETE RESTRICT e o convite ja cria um
        caixa por etapa. Sem apagar antes, o banco RECUSA o cancelamento e a
        tela mostra um erro generico -- foi assim que o convite ficou preso."""
        fake = _monta(monkeypatch, {
            "staff": [_funcionario(status="pending", ativo=False)],
            "cashboxes": [{"id": "cb1", "staff_id": STAFF, "stage_id": "e1",
                           "status": "closed", "current_balance": 0}],
        })
        StaffService.cancel_invite(STAFF, ORG)
        assert fake.store["cashboxes"] == []
        assert fake.store["staff"] == []

    def test_caixa_com_movimento_nao_e_apagado_em_silencio(self, monkeypatch):
        """Se houve movimento, aquilo deixou de ser convite: apagar levaria o
        historico do caixa junto."""
        fake = _monta(monkeypatch, {
            "staff": [_funcionario(status="pending", ativo=False)],
            "cashboxes": [{"id": "cb1", "staff_id": STAFF, "stage_id": "e1",
                           "status": "closed", "current_balance": 0}],
            "cashbox_transactions": [{"id": "mv1", "cashbox_id": "cb1"}],
        })
        with pytest.raises(ValueError, match="Excluir"):
            StaffService.cancel_invite(STAFF, ORG)
        assert len(fake.store["staff"]) == 1

    def test_membro_efetivo_nao_e_desativado_por_engano(self, monkeypatch):
        """"Cancelar convite" em quem ja e da equipe nao pode virar uma
        desativacao silenciosa -- essa confusao entre os dois e a origem do
        problema."""
        fake = _monta(monkeypatch, {"staff": [_funcionario(status="accepted")]})
        with pytest.raises(ValueError, match="já faz parte"):
            StaffService.cancel_invite(STAFF, ORG)
        assert fake.store["staff"][0]["active"] is True

    def test_convite_de_outra_organizacao_nao_e_encontrado(self, monkeypatch):
        fake = _monta(monkeypatch, {"staff": [_funcionario(status="pending", ativo=False, org="outra")]})
        with pytest.raises(ValueError, match="não encontrado"):
            StaffService.cancel_invite(STAFF, ORG)
        assert len(fake.store["staff"]) == 1

    def test_inexistente_da_erro_claro(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="não encontrado"):
            StaffService.cancel_invite("nao-existe", ORG)

    def test_conta_nunca_cadastrada_perde_o_acesso_junto(self, monkeypatch):
        """'awaiting_signup' = conta criada pelo convite e sem senha. Deixa-la
        viva faria o proximo convite cair no fluxo de "aceitar", que exige
        entrar com uma senha que a pessoa nunca definiu."""
        import httpx

        apagados = []
        monkeypatch.setattr(httpx, "delete", lambda url, **k: (
            apagados.append(url), type("R", (), {"status_code": 200})()
        )[1])
        _monta(monkeypatch, {"staff": [_funcionario(status="awaiting_signup")]})
        r = StaffService.cancel_invite(STAFF, ORG)
        assert r["account_removed"] is True
        assert AUTH in apagados[0]

    def test_conta_de_quem_ja_trabalha_em_outro_clube_e_preservada(self, monkeypatch):
        """Convite 'pending' e de alguem que JA tem conta (e outro emprego):
        cancelar aqui nao pode derrubar o acesso dela la."""
        import httpx

        chamou = []
        monkeypatch.setattr(httpx, "delete", lambda url, **k: chamou.append(url))
        _monta(monkeypatch, {"staff": [_funcionario(status="pending", ativo=False)]})
        r = StaffService.cancel_invite(STAFF, ORG)
        assert r["account_removed"] is False
        assert chamou == []


class TestEfetivacaoPeloAdmin:
    """Saida do admin quando o convidado nao responde.

    Antes, 'pending' so virava 'accepted' se a propria pessoa entrasse no
    sistema e clicasse no modal. Quem nunca entrava ficava presa nesse estado
    para sempre.
    """

    def test_convite_pendente_vira_membro_ativo(self, monkeypatch):
        fake = _monta(monkeypatch, {"staff": [_funcionario(status="pending", ativo=False)]})
        StaffService.confirm_invite(STAFF, ORG)
        linha = fake.store["staff"][0]
        assert linha["active"] is True
        assert linha["invite_status"] == "accepted"

    def test_quem_ja_e_da_equipe_nao_e_efetivado_de_novo(self, monkeypatch):
        _monta(monkeypatch, {"staff": [_funcionario(status="accepted")]})
        with pytest.raises(ValueError, match="já faz parte"):
            StaffService.confirm_invite(STAFF, ORG)

    def test_quem_ainda_nao_tem_senha_nao_pode_ser_efetivado(self, monkeypatch):
        """'awaiting_signup' e conta NOVA sem senha: marca-la como membro nao
        a faria entrar. O caminho la e reenviar o link de cadastro."""
        fake = _monta(monkeypatch, {"staff": [_funcionario(status="awaiting_signup")]})
        with pytest.raises(ValueError, match="Reenviar"):
            StaffService.confirm_invite(STAFF, ORG)
        assert fake.store["staff"][0]["invite_status"] == "awaiting_signup"

    def test_convite_de_outra_organizacao_nao_e_encontrado(self, monkeypatch):
        """Sem isso, o admin de um clube efetivaria vinculo no clube alheio."""
        _monta(monkeypatch, {"staff": [_funcionario(status="pending", ativo=False, org="outra")]})
        with pytest.raises(ValueError, match="não encontrado"):
            StaffService.confirm_invite(STAFF, ORG)

    def test_limite_do_plano_da_mensagem_acionavel(self, monkeypatch):
        """O gatilho do banco dispara na virada false -> true. A vaga e cobrada
        de quem de fato entrou, igual ao aceite pela propria pessoa."""
        fake = _monta(monkeypatch, {"staff": [_funcionario(status="pending", ativo=False)]})

        class _TabelaQueRecusa:
            def __init__(self, original):
                self._original = original

            def __call__(self, nome):
                q = self._original(nome)
                if nome == "staff":
                    original_update = q.update

                    def _update(payload):
                        if payload.get("active") is True:
                            raise Exception("PLANO_LIMITE_USUARIOS")
                        return original_update(payload)

                    q.update = _update
                return q

        fake.table = _TabelaQueRecusa(fake.table)
        with pytest.raises(ValueError, match="plano"):
            StaffService.confirm_invite(STAFF, ORG)


class TestEstadoDoConviteDependeDoVinculo:
    """Quem entra pendente e quem entra direto -- e por que.

    O BUG: o estado era decidido pela pergunta "existe conta no auth com este
    e-mail?". Qualquer conta antiga, sobrada de um cadastro que nunca virou
    vinculo, caia em "convite pendente" -- um pedido de consentimento sem
    ninguem para consentir. E como Excluir NAO apaga a conta do auth, recriar
    o funcionario reencontrava a mesma conta e devolvia o mesmo estado: um
    laco fechado, sem saida pela tela.

    A pergunta certa e sobre o VINCULO: "esta pessoa ja e membro de OUTRA
    organizacao?".
    """

    def _finge_auth(self, monkeypatch, paginas, criar=None):
        """Simula o Supabase Auth.

        Por padrao /invite recusa o e-mail existente (422) e a lista de contas
        vem PAGINADA. Com `criar`, /invite ACEITA e devolve a conta nova.
        """
        import httpx

        class _Resp:
            def __init__(self, status, corpo=None):
                self.status_code = status
                self._corpo = corpo or {}
                self.text = ""

            def json(self):
                return self._corpo

        if criar:
            monkeypatch.setattr(httpx, "post", lambda url, **k: _Resp(200, {"id": criar}))
        else:
            monkeypatch.setattr(httpx, "post", lambda url, **k: _Resp(422, {"msg": "já existe"}))

        def _get(url, **k):
            pagina = (k.get("params") or {}).get("page", 1)
            return _Resp(200, {"users": paginas[pagina - 1] if pagina <= len(paginas) else []})

        monkeypatch.setattr(httpx, "get", _get)

    def _convida(self, email="fulano@clube.com", org=ORG):
        return StaffService.create_staff(
            StaffCreate(email=email), created_by=AUTH, organization_id=org
        )

    # ── quem E de outro clube: consentimento ──

    def test_vinculo_ativo_em_outro_clube_entra_como_convite_pendente(self, monkeypatch):
        """Ela nao refaz cadastro, mas tambem nao e jogada dentro do clube sem
        saber: o vinculo nasce pendente e inativo, e ela aceita ou recusa."""
        self._finge_auth(monkeypatch, [[{"id": AUTH, "email": "fulano@clube.com"}]])
        fake = _monta(monkeypatch, {"staff": [
            _funcionario(id_="s-outro", org="outra-org", status="accepted", ativo=True),
        ]})
        self._convida()
        nova = [s for s in fake.store["staff"] if s["id"] != "s-outro"][0]
        assert nova["invite_status"] == "pending"
        assert nova["active"] is False

    def test_vinculo_inativo_em_outro_clube_tambem_pede_consentimento(self, monkeypatch):
        """Desativado la ainda e uma PESSOA de outro clube, nao uma conta orfa:
        a linha existe porque alguem a contratou, e desativacao costuma ser
        temporaria (a readmissao e um caminho previsto). Pedir consentimento a
        toa custa um clique; pular o consentimento coloca a pessoa dentro do
        clube sem desfazer."""
        self._finge_auth(monkeypatch, [[{"id": AUTH, "email": "fulano@clube.com"}]])
        fake = _monta(monkeypatch, {"staff": [
            _funcionario(id_="s-outro", org="outra-org", status="accepted", ativo=False),
        ]})
        self._convida()
        nova = [s for s in fake.store["staff"] if s["id"] != "s-outro"][0]
        assert nova["invite_status"] == "pending"
        assert nova["active"] is False

    def test_outro_clube_e_enxergado_mesmo_com_o_rls_do_usuario(self, monkeypatch):
        """O client padrao roda COMO O USUARIO e o RLS so mostra a propria
        organizacao. Perguntando por ele, "e de outro clube?" seria sempre
        "nao" -- e todo mundo entraria direto. A checagem precisa do client
        que ignora RLS."""
        self._finge_auth(monkeypatch, [[{"id": AUTH, "email": "fulano@clube.com"}]])
        # Duas visoes do mesmo banco: o usuario NAO ve a outra organizacao.
        do_usuario = FakeSupabase({"staff": [], "cashboxes": [],
                                   "cashbox_sessions": [], "cashbox_transactions": []})
        do_admin = FakeSupabase({
            "staff": [_funcionario(id_="s-outro", org="outra-org")],
            "organizations": [{"id": ORG, "name": "NextHub", "status": "active"}],
        })
        monkeypatch.setattr(staff_service, "supabase", do_usuario)
        monkeypatch.setattr(staff_service, "supabase_admin", do_admin)

        self._convida()
        assert do_usuario.store["staff"][0]["invite_status"] == "pending"

    # ── quem NAO e de clube nenhum: entra direto ──

    def test_conta_orfa_entra_direto_como_membro(self, monkeypatch):
        """A conta existe no auth mas nao serve a nenhuma organizacao: nao ha
        de quem pedir consentimento. Deixa-la "pendente" era pedir permissao a
        ninguem e travar a pessoa fora do clube -- o Auth Hook so emite o claim
        de organizacao com vinculo ATIVO."""
        self._finge_auth(monkeypatch, [[{"id": AUTH, "email": "orfa@nexthub.com"}]])
        fake = _monta(monkeypatch)
        criado = self._convida(email="orfa@nexthub.com")
        linha = fake.store["staff"][0]
        assert linha["invite_status"] == "accepted"
        assert linha["active"] is True
        assert criado.invite_status == "accepted"

    def test_convidar_de_novo_depois_de_excluir_nao_reabre_o_laco(self, monkeypatch):
        """O caso relatado, ponta a ponta: convidar -> excluir -> convidar de
        novo. Excluir NAO apaga a conta do auth, entao o segundo convite
        reencontra a mesma conta -- e precisa dar no mesmo resultado do
        primeiro, senao o usuario repete a acao para sempre."""
        self._finge_auth(monkeypatch, [[{"id": AUTH, "email": "orfa@nexthub.com"}]])
        fake = _monta(monkeypatch)

        primeiro = self._convida(email="orfa@nexthub.com")
        assert primeiro.invite_status == "accepted"

        # "Excluir": o vinculo sai da tabela; a conta do auth continua viva
        # (por isso o /invite segue respondendo 422 no proximo convite).
        fake.store["staff"].clear()

        segundo = self._convida(email="orfa@nexthub.com")
        assert segundo.invite_status == "accepted"
        assert segundo.active is True

    def test_conta_nova_nasce_ativa_aguardando_cadastro(self, monkeypatch):
        """Proposital: o Auth Hook exige vinculo ATIVO para emitir o claim de
        organizacao. Nascendo inativa, a pessoa nem concluiria o cadastro pelo
        link do e-mail. Quem a segura fora da equipe e o status."""
        self._finge_auth(monkeypatch, [[]], criar="conta-nova")
        fake = _monta(monkeypatch)
        self._convida(email="novo@clube.com")
        linha = fake.store["staff"][0]
        assert linha["invite_status"] == "awaiting_signup"
        assert linha["active"] is True

    # ── readmissao no PROPRIO clube ──

    def test_readmissao_de_desativado_do_proprio_clube_volta_como_membro(self, monkeypatch):
        """Quem foi desativado AQUI e reconvidado AQUI nao tem terceiro a
        consultar: o convite partiu do proprio clube."""
        self._finge_auth(monkeypatch, [[{"id": AUTH, "email": "fulano@clube.com"}]])
        fake = _monta(monkeypatch, {"staff": [_funcionario(ativo=False, status="accepted")]})
        self._convida()
        assert len(fake.store["staff"]) == 1  # reaproveita a linha, nao duplica
        assert fake.store["staff"][0]["active"] is True
        assert fake.store["staff"][0]["invite_status"] == "accepted"

    def test_readmissao_de_quem_trabalha_em_outro_clube_continua_pendente(self, monkeypatch):
        self._finge_auth(monkeypatch, [[{"id": AUTH, "email": "fulano@clube.com"}]])
        fake = _monta(monkeypatch, {"staff": [
            _funcionario(ativo=False, status="accepted"),
            _funcionario(id_="s-outro", org="outra-org", ativo=True),
        ]})
        self._convida()
        readmitido = [s for s in fake.store["staff"] if s["id"] == STAFF][0]
        assert readmitido["invite_status"] == "pending"
        assert readmitido["active"] is False

    def test_conta_fora_da_primeira_pagina_ainda_e_encontrada(self, monkeypatch):
        """A busca lia so a primeira pagina (200 contas). Passando disso,
        reconvidar alguem antigo morria em "Ja existe uma conta com este
        e-mail" -- sem saida nenhuma pela tela."""
        outros = [{"id": f"u{i}", "email": f"pessoa{i}@x.com"} for i in range(200)]
        self._finge_auth(monkeypatch, [outros, [{"id": AUTH, "email": "fulano@clube.com"}]])
        fake = _monta(monkeypatch)
        StaffService.create_staff(
            StaffCreate(email="fulano@clube.com"), created_by=AUTH, organization_id=ORG
        )
        assert fake.store["staff"][0]["auth_user_id"] == AUTH

    def test_quem_ja_esta_ativo_no_clube_nao_e_convidado_de_novo(self, monkeypatch):
        self._finge_auth(monkeypatch, [[{"id": AUTH, "email": "fulano@clube.com"}]])
        _monta(monkeypatch, {"staff": [_funcionario(status="accepted")]})
        # StaffCreate montado fora: dentro do `raises` só a chamada sob teste.
        dados = StaffCreate(email="fulano@clube.com")
        with pytest.raises(ValueError, match="já faz parte"):
            StaffService.create_staff(dados, created_by=AUTH, organization_id=ORG)


class TestReenvioDeConvite:
    def test_quem_ja_concluiu_nao_recebe_reenvio(self, monkeypatch):
        _monta(monkeypatch, {"staff": [_funcionario(status="accepted")]})
        with pytest.raises(ValueError, match="já concluiu"):
            StaffService.resend_invite(STAFF, ORG)

    def test_funcionario_de_outra_organizacao_nao_e_encontrado(self, monkeypatch):
        _monta(monkeypatch, {"staff": [_funcionario(org="outra", status="awaiting_signup")]})
        with pytest.raises(ValueError, match="não encontrado"):
            StaffService.resend_invite(STAFF, ORG)

    def test_inexistente_da_erro(self, monkeypatch):
        _monta(monkeypatch)
        with pytest.raises(ValueError, match="não encontrado"):
            StaffService.resend_invite("nao-existe", ORG)


class TestPermissoes:
    def test_sem_vinculo_nao_recebe_acesso(self, monkeypatch):
        """FAIL-CLOSED: autenticado mas sem linha em staff e fora da allowlist
        => nenhum acesso. O comportamento antigo dava super-admin a qualquer
        conta sem vinculo; num SaaS isso faria o funcionario de um cliente
        virar dono de tudo."""
        _monta(monkeypatch)
        p = StaffService.get_my_permissions("usuario-sem-vinculo")
        assert p.is_admin is False
        assert p.permissions == []

    def test_desativado_perde_o_acesso(self, monkeypatch):
        _monta(monkeypatch, {"staff": [_funcionario(ativo=False)]})
        p = StaffService.get_my_permissions(AUTH)
        assert p.is_admin is False
        assert p.permissions == []

    def test_com_grupo_devolve_as_permissoes_do_grupo(self, monkeypatch):
        f = _funcionario()
        f["permission_group_id"] = "g1"
        f["permission_groups"] = {"name": "Caixa", "permissions": ["cashier", "reports"]}
        _monta(monkeypatch, {"staff": [f]})
        p = StaffService.get_my_permissions(AUTH)
        assert p.is_admin is False
        assert "cashier" in p.permissions

    def test_sem_grupo_nao_recebe_permissao_nenhuma(self, monkeypatch):
        _monta(monkeypatch, {"staff": [_funcionario()]})
        p = StaffService.get_my_permissions(AUTH)
        assert p.permissions == []
