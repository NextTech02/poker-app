"""Testes de despesas e outras receitas — o que completa o DRE da etapa.

O ponto sensivel nao e o CRUD: e a relacao com o caixa geral. Uma despesa so
debita o caixa via RPC (atomico e idempotente), e apagar uma despesa PAGA
precisa devolver o dinheiro — senao o saldo fica debitado para sempre por um
lancamento que nao existe mais.
"""
import pytest

from app.services import expense_service
from app.services.expense_service import ExpenseService

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
STAGE = "11111111-1111-1111-1111-111111111111"


def _monta(monkeypatch, tabelas=None, rpcs=None):
    base = {
        "expenses": [],
        "expense_categories": [],
        "expense_templates": [],
        "expense_attachments": [],
        "other_revenues": [],
        "staff_payments": [],
        "staff": [],
    }
    base.update(tabelas or {})
    fake = FakeSupabase(base)
    fake.rpcs = rpcs or {}
    monkeypatch.setattr(expense_service, "supabase", fake)
    # O expurgo de anexos fala com o Storage; aqui interessa a regra, nao o I/O.
    monkeypatch.setattr(ExpenseService, "_purge_attachment_files",
                        staticmethod(lambda org_id, expense_id: None))
    return fake


def _despesa(id_="e1", valor=100, status="pendente", categoria=None, stage=STAGE):
    return {
        "id": id_, "organization_id": ORG, "stage_id": stage,
        "description": "Dealers", "amount": valor, "status": status,
        "category_id": categoria, "created_at": "2026-06-08T00:00:00Z",
    }


class TestCriacao:
    def test_nasce_sempre_pendente(self, monkeypatch):
        """Gravar 'pago' direto criaria uma despesa paga que nunca saiu do
        caixa. A transicao e do RPC, que e quem debita."""
        fake = _monta(monkeypatch)
        ExpenseService.create_expense(ORG, {"description": "Aluguel", "amount": 500}, "u1")
        assert fake.store["expenses"][0]["status"] == "pendente"

    def test_marcada_como_paga_passa_pelo_rpc(self, monkeypatch):
        fake = _monta(monkeypatch, rpcs={"expense_set_status": {"ok": True}})
        ExpenseService.create_expense(
            ORG, {"description": "Dealers", "amount": 800, "status": "pago"}, "u1"
        )
        chamados = [c[0] for c in fake.rpc_calls]
        assert "expense_set_status" in chamados
        # e o status pedido foi "pago"
        params = dict(fake.rpc_calls[0][1])
        assert params["p_status"] == "pago"

    def test_guarda_autor_e_organizacao(self, monkeypatch):
        fake = _monta(monkeypatch)
        ExpenseService.create_expense(ORG, {"description": "X", "amount": 10}, "operador")
        linha = fake.store["expenses"][0]
        assert linha["organization_id"] == ORG
        assert linha["created_by"] == "operador"


class TestExclusao:
    def test_apagar_despesa_paga_estorna_o_caixa(self, monkeypatch):
        """Sem o estorno o saldo fica debitado por um lancamento inexistente."""
        fake = _monta(monkeypatch,
                      {"expenses": [_despesa(status="pago")]},
                      rpcs={"expense_set_status": {"ok": True}})

        assert ExpenseService.delete_expense(ORG, "e1") is True

        chamados = [(c[0], c[1].get("p_status")) for c in fake.rpc_calls]
        assert ("expense_set_status", "pendente") in chamados
        assert fake.store["expenses"] == []

    def test_apagar_despesa_pendente_nao_mexe_no_caixa(self, monkeypatch):
        fake = _monta(monkeypatch, {"expenses": [_despesa(status="pendente")]})
        ExpenseService.delete_expense(ORG, "e1")
        assert fake.rpc_calls == []

    def test_sem_caixa_configurado_a_exclusao_continua(self, monkeypatch):
        """Se o estorno falhar, a despesa ainda tem que sair — senao fica
        impossivel apagar."""
        fake = _monta(monkeypatch, {"expenses": [_despesa(status="pago")]})
        # nenhum rpc registrado => o fake estoura => o servico engole e segue
        assert ExpenseService.delete_expense(ORG, "e1") is True
        assert fake.store["expenses"] == []

    def test_despesa_de_outra_organizacao_nao_e_apagada(self, monkeypatch):
        outra = _despesa()
        outra["organization_id"] = "outra-org"
        fake = _monta(monkeypatch, {"expenses": [outra]})
        assert ExpenseService.delete_expense(ORG, "e1") is False
        assert len(fake.store["expenses"]) == 1


class TestResumoParaDRE:
    def test_sem_despesa_devolve_zerado(self, monkeypatch):
        _monta(monkeypatch)
        r = ExpenseService.summarize(ORG, STAGE)
        assert r["total"] == 0.0
        assert r["by_category"] == []

    def test_separa_pago_de_pendente(self, monkeypatch):
        _monta(monkeypatch, {"expenses": [
            _despesa("e1", 300, "pago"),
            _despesa("e2", 200, "pendente"),
        ]})
        r = ExpenseService.summarize(ORG, STAGE)
        assert r["total"] == 500.0
        assert r["paid"] == 300.0
        assert r["pending"] == 200.0

    def test_agrupa_por_categoria(self, monkeypatch):
        d1 = _despesa("e1", 300, "pago"); d1["expense_categories"] = {"name": "Dealers", "kind": "variavel"}
        d2 = _despesa("e2", 100, "pago"); d2["expense_categories"] = {"name": "Dealers", "kind": "variavel"}
        d3 = _despesa("e3", 50, "pago");  d3["expense_categories"] = {"name": "Bar", "kind": "variavel"}
        _monta(monkeypatch, {"expenses": [d1, d2, d3]})

        r = ExpenseService.summarize(ORG, STAGE)
        por_cat = {c["category"]: c["amount"] for c in r["by_category"]}
        assert por_cat["Dealers"] == 400.0
        assert por_cat["Bar"] == 50.0
        # maior primeiro
        assert r["by_category"][0]["category"] == "Dealers"

    def test_sem_categoria_vira_rotulo_proprio(self, monkeypatch):
        _monta(monkeypatch, {"expenses": [_despesa("e1", 70, "pago")]})
        r = ExpenseService.summarize(ORG, STAGE)
        assert r["by_category"][0]["category"] == "Sem categoria"

    def test_pagamentos_de_equipe_entram_como_categoria_propria(self, monkeypatch):
        """Ja eram custo real (debitam o caixa) mas ficavam fora do DRE. A
        categoria e nomeada de forma distinta para nao duplicar com uma
        despesa manual 'Dealers'."""
        _monta(monkeypatch, {"expenses": [_despesa("e1", 100, "pago")]})
        monkeypatch.setattr(ExpenseService, "_staff_payments",
                            staticmethod(lambda *a, **k: (900.0, 900.0, 0.0)))
        r = ExpenseService.summarize(ORG, STAGE)
        assert r["total"] == 1000.0
        nomes = [c["category"] for c in r["by_category"]]
        assert "Equipe (pagamentos)" in nomes


class TestOutrasReceitas:
    def test_resumo_separa_recebido_de_pendente(self, monkeypatch):
        _monta(monkeypatch, {"other_revenues": [
            {"id": "r1", "organization_id": ORG, "stage_id": STAGE,
             "amount": 1500, "status": "recebido", "source": "Bar",
             "created_at": "2026-06-08T00:00:00Z"},
            {"id": "r2", "organization_id": ORG, "stage_id": STAGE,
             "amount": 500, "status": "pendente", "source": "Patrocinio",
             "created_at": "2026-06-08T00:00:00Z"},
        ]})
        r = ExpenseService.summarize_revenues(ORG, STAGE)
        assert r["total"] == 2000.0
        assert r["received"] == 1500.0
        assert r["pending"] == 500.0

    def test_agrupa_por_origem(self, monkeypatch):
        _monta(monkeypatch, {"other_revenues": [
            {"id": "r1", "organization_id": ORG, "stage_id": STAGE, "amount": 100,
             "status": "recebido", "source": "Bar", "created_at": "2026-06-08T00:00:00Z"},
            {"id": "r2", "organization_id": ORG, "stage_id": STAGE, "amount": 300,
             "status": "recebido", "source": "Bar", "created_at": "2026-06-08T00:00:00Z"},
        ]})
        r = ExpenseService.summarize_revenues(ORG, STAGE)
        assert r["by_source"][0]["category"] == "Bar"
        assert r["by_source"][0]["amount"] == 400.0

    def test_receita_nasce_pendente_e_o_rpc_credita(self, monkeypatch):
        fake = _monta(monkeypatch, rpcs={"revenue_set_status": {"ok": True}})
        ExpenseService.create_revenue(
            ORG, {"source": "Bar", "amount": 1500, "status": "recebido", "stage_id": STAGE}, "u1"
        )
        chamados = [(c[0], c[1].get("p_status")) for c in fake.rpc_calls]
        assert ("revenue_set_status", "recebido") in chamados


class TestCategoriasEModelos:
    def test_categoria_de_outra_organizacao_nao_e_alterada(self, monkeypatch):
        cat = {"id": "c1", "organization_id": "outra", "name": "X", "active": True}
        _monta(monkeypatch, {"expense_categories": [cat]})
        assert ExpenseService.update_category(ORG, "c1", {"name": "Y"}) is None

    def test_modelo_e_criado_e_apagado(self, monkeypatch):
        fake = _monta(monkeypatch)
        ExpenseService.create_template(ORG, {"name": "Dealers do sabado", "amount": 800})
        assert len(fake.store["expense_templates"]) == 1
        tid = fake.store["expense_templates"][0]["id"]
        assert ExpenseService.delete_template(ORG, tid) is True
        assert fake.store["expense_templates"] == []


class TestListagem:
    def _com_varias(self, monkeypatch):
        d1 = _despesa("e1", 100, "pago", categoria="c1")
        d1.update({"expense_categories": {"name": "Dealers", "kind": "variavel"},
                   "stages": {"name": "Etapa 1"}, "tournaments": {"name": "Torneio A"}})
        d2 = _despesa("e2", 200, "pendente", categoria="c2")
        d2["tournament_id"] = "t-outro"
        return _monta(monkeypatch, {"expenses": [d1, d2]})

    def test_sem_organizacao_devolve_vazio(self, monkeypatch):
        """Guarda de multi-tenant: sem organizacao nao ha o que listar."""
        _monta(monkeypatch, {"expenses": [_despesa()]})
        assert ExpenseService.list_expenses(None) == []

    def test_achata_os_nomes_relacionados(self, monkeypatch):
        """A tela mostra categoria/etapa/torneio como texto; sem isso viriam
        objetos aninhados e a listagem quebraria."""
        self._com_varias(monkeypatch)
        r = ExpenseService.list_expenses(ORG, stage_id=STAGE)
        alvo = next(x for x in r if x["id"] == "e1")
        assert alvo["category_name"] == "Dealers"
        assert alvo["stage_name"] == "Etapa 1"
        assert alvo["tournament_name"] == "Torneio A"
        assert "expense_categories" not in alvo

    def test_filtra_por_status(self, monkeypatch):
        self._com_varias(monkeypatch)
        r = ExpenseService.list_expenses(ORG, status="pago")
        assert [x["id"] for x in r] == ["e1"]

    def test_filtra_por_categoria(self, monkeypatch):
        self._com_varias(monkeypatch)
        r = ExpenseService.list_expenses(ORG, category_id="c2")
        assert [x["id"] for x in r] == ["e2"]

    def test_filtra_por_torneio(self, monkeypatch):
        self._com_varias(monkeypatch)
        r = ExpenseService.list_expenses(ORG, tournament_id="t-outro")
        assert [x["id"] for x in r] == ["e2"]

    def test_nao_vaza_despesa_de_outra_organizacao(self, monkeypatch):
        outra = _despesa("e9")
        outra["organization_id"] = "outra-org"
        _monta(monkeypatch, {"expenses": [_despesa("e1"), outra]})
        r = ExpenseService.list_expenses(ORG)
        assert [x["id"] for x in r] == ["e1"]


class TestEdicao:
    def test_altera_campos_simples(self, monkeypatch):
        fake = _monta(monkeypatch, {"expenses": [_despesa()]})
        ExpenseService.update_expense(ORG, "e1", {"description": "Aluguel", "amount": 999})
        assert fake.store["expenses"][0]["description"] == "Aluguel"
        assert fake.store["expenses"][0]["amount"] == 999

    def test_troca_de_status_vai_pelo_rpc(self, monkeypatch):
        """Status mexe no caixa; nao pode ser UPDATE direto."""
        fake = _monta(monkeypatch, {"expenses": [_despesa()]},
                      rpcs={"expense_set_status": {"ok": True}})
        ExpenseService.update_expense(ORG, "e1", {"status": "pago"})
        assert [c[0] for c in fake.rpc_calls] == ["expense_set_status"]

    def test_paid_at_enviado_pelo_cliente_e_ignorado(self, monkeypatch):
        """Quem carimba a data do pagamento e o RPC; aceitar do cliente
        permitiria forjar quando o dinheiro saiu."""
        fake = _monta(monkeypatch, {"expenses": [_despesa()]})
        ExpenseService.update_expense(ORG, "e1", {"paid_at": "2020-01-01", "amount": 50})
        assert "paid_at" not in fake.store["expenses"][0]

    def test_despesa_inexistente_devolve_none(self, monkeypatch):
        _monta(monkeypatch)
        assert ExpenseService.update_expense(ORG, "nao-existe", {"amount": 10}) is None


class TestAnexos:
    def test_lista_anexos_da_despesa(self, monkeypatch):
        _monta(monkeypatch, {"expense_attachments": [
            {"id": "a1", "organization_id": ORG, "expense_id": "e1", "path": "x/y.png"},
        ]})
        assert len(ExpenseService.list_attachments(ORG, "e1")) == 1

    def test_registra_o_anexo_com_autor_e_organizacao(self, monkeypatch):
        fake = _monta(monkeypatch)
        ExpenseService.add_attachment(ORG, "e1", {"path": "x/y.png", "file_name": "y.png"}, "u1")
        linha = fake.store["expense_attachments"][0]
        assert linha["organization_id"] == ORG
        assert linha["expense_id"] == "e1"
        assert linha["uploaded_by"] == "u1"

    def test_anexo_inexistente_devolve_false(self, monkeypatch):
        _monta(monkeypatch)
        assert ExpenseService.delete_attachment(ORG, "nao-existe") is False


class TestReceitasCrud:
    def _receita(self, id_="r1", valor=100, status="pendente"):
        return {"id": id_, "organization_id": ORG, "stage_id": STAGE,
                "amount": valor, "status": status, "source": "Bar",
                "created_at": "2026-06-08T00:00:00Z"}

    def test_lista_filtrando_por_etapa(self, monkeypatch):
        outra = self._receita("r2"); outra["stage_id"] = "outra-etapa"
        _monta(monkeypatch, {"other_revenues": [self._receita(), outra]})
        r = ExpenseService.list_revenues(ORG, stage_id=STAGE)
        assert [x["id"] for x in r] == ["r1"]

    def test_sem_organizacao_devolve_vazio(self, monkeypatch):
        _monta(monkeypatch, {"other_revenues": [self._receita()]})
        assert ExpenseService.list_revenues(None) == []

    def test_apagar_receita_recebida_estorna(self, monkeypatch):
        """Espelha a despesa: sem o estorno o caixa fica creditado por uma
        receita que nao existe mais."""
        fake = _monta(monkeypatch, {"other_revenues": [self._receita(status="recebido")]},
                      rpcs={"revenue_set_status": {"ok": True}})
        assert ExpenseService.delete_revenue(ORG, "r1") is True
        assert ("revenue_set_status", "pendente") in [
            (c[0], c[1].get("p_status")) for c in fake.rpc_calls
        ]

    def test_edicao_de_receita_troca_status_pelo_rpc(self, monkeypatch):
        fake = _monta(monkeypatch, {"other_revenues": [self._receita()]},
                      rpcs={"revenue_set_status": {"ok": True}})
        ExpenseService.update_revenue(ORG, "r1", {"status": "recebido"})
        assert [c[0] for c in fake.rpc_calls] == ["revenue_set_status"]


class TestCategorias:
    def test_lista_apenas_da_organizacao(self, monkeypatch):
        outra = {"id": "c9", "organization_id": "outra", "name": "X", "active": True}
        _monta(monkeypatch, {"expense_categories": [
            {"id": "c1", "organization_id": ORG, "name": "Dealers", "active": True}, outra,
        ]})
        r = ExpenseService.get_categories(ORG)
        assert [c["id"] for c in r] == ["c1"]

    def test_sem_organizacao_devolve_vazio(self, monkeypatch):
        _monta(monkeypatch, {"expense_categories": [
            {"id": "c1", "organization_id": ORG, "name": "X", "active": True},
        ]})
        assert ExpenseService.get_categories(None) == []

    def test_filtra_somente_ativas(self, monkeypatch):
        _monta(monkeypatch, {"expense_categories": [
            {"id": "c1", "organization_id": ORG, "name": "Ativa", "active": True},
            {"id": "c2", "organization_id": ORG, "name": "Inativa", "active": False},
        ]})
        r = ExpenseService.get_categories(ORG, active_only=True)
        assert [c["id"] for c in r] == ["c1"]

    def test_cria_na_organizacao_certa(self, monkeypatch):
        fake = _monta(monkeypatch)
        ExpenseService.create_category(ORG, {"name": "Nova", "kind": "fixo"})
        assert fake.store["expense_categories"][0]["organization_id"] == ORG

    def test_atualiza_a_propria_categoria(self, monkeypatch):
        fake = _monta(monkeypatch, {"expense_categories": [
            {"id": "c1", "organization_id": ORG, "name": "Antigo", "active": True},
        ]})
        ExpenseService.update_category(ORG, "c1", {"name": "Novo"})
        assert fake.store["expense_categories"][0]["name"] == "Novo"

    def test_apaga_a_propria_categoria(self, monkeypatch):
        fake = _monta(monkeypatch, {"expense_categories": [
            {"id": "c1", "organization_id": ORG, "name": "X", "active": True},
        ]})
        assert ExpenseService.delete_category(ORG, "c1") is True
        assert fake.store["expense_categories"] == []

    def test_nao_apaga_categoria_de_outra_organizacao(self, monkeypatch):
        fake = _monta(monkeypatch, {"expense_categories": [
            {"id": "c1", "organization_id": "outra", "name": "X", "active": True},
        ]})
        assert ExpenseService.delete_category(ORG, "c1") is False
        assert len(fake.store["expense_categories"]) == 1


class TestModelos:
    def test_lista_apenas_da_organizacao(self, monkeypatch):
        _monta(monkeypatch, {"expense_templates": [
            {"id": "m1", "organization_id": ORG, "name": "Dealers", "amount": 800},
            {"id": "m2", "organization_id": "outra", "name": "X", "amount": 1},
        ]})
        r = ExpenseService.get_templates(ORG)
        assert [m["id"] for m in r] == ["m1"]

    def test_sem_organizacao_devolve_vazio(self, monkeypatch):
        _monta(monkeypatch, {"expense_templates": [
            {"id": "m1", "organization_id": ORG, "name": "X", "amount": 1},
        ]})
        assert ExpenseService.get_templates(None) == []

    def test_nao_apaga_modelo_de_outra_organizacao(self, monkeypatch):
        fake = _monta(monkeypatch, {"expense_templates": [
            {"id": "m1", "organization_id": "outra", "name": "X", "amount": 1},
        ]})
        assert ExpenseService.delete_template(ORG, "m1") is False
        assert len(fake.store["expense_templates"]) == 1


class TestGarantiaInformativa:
    def test_soma_a_garantia_comprometida_da_etapa(self, monkeypatch):
        """A garantia NAO entra como despesa (pay_prize ja cria transacao
        'prize', entao contaria duas vezes). Aparece so como linha
        informativa."""
        _monta(monkeypatch, {"expenses": []})
        r = ExpenseService.guarantee_committed(ORG, STAGE)
        assert isinstance(r, (int, float))


class TestMensagemDeErro:
    """O RPC devolve o motivo no formato 'DESPESA: <texto>' misturado com o
    dump do erro. Sem extrair, o operador veria um blob de JSON na tela."""

    def test_extrai_o_motivo_do_erro_do_banco(self, monkeypatch):
        _monta(monkeypatch, {"expenses": [_despesa()]})
        erro = Exception("DESPESA: Caixa geral nao configurado.  {'code': 'P0001'}")
        monkeypatch.setattr(expense_service.supabase, "rpc",
                            lambda *a, **k: (_ for _ in ()).throw(erro))
        with pytest.raises(ValueError) as e:
            ExpenseService.set_status(ORG, "e1", "pago")
        assert "Caixa geral nao configurado." in str(e.value)
        assert "P0001" not in str(e.value)

    def test_erro_sem_marcador_vira_mensagem_generica(self, monkeypatch):
        _monta(monkeypatch, {"expenses": [_despesa()]})
        monkeypatch.setattr(expense_service.supabase, "rpc",
                            lambda *a, **k: (_ for _ in ()).throw(Exception("timeout")))
        with pytest.raises(ValueError) as e:
            ExpenseService.set_status(ORG, "e1", "pago")
        assert "Não foi possível atualizar a despesa." in str(e.value)


class TestPagamentosDeEquipe:
    def test_separa_pago_de_a_pagar(self, monkeypatch):
        """A tela de Funcionarios grava 'paid'; qualquer outro estado conta
        como a pagar."""
        _monta(monkeypatch, {"staff_payments": [
            {"id": "p1", "organization_id": ORG, "stage_id": STAGE,
             "amount": 500, "status": "paid", "created_at": "2026-06-08T00:00:00Z"},
            {"id": "p2", "organization_id": ORG, "stage_id": STAGE,
             "amount": 300, "status": "pending", "created_at": "2026-06-08T00:00:00Z"},
        ]})
        total, pago, pendente = ExpenseService._staff_payments(ORG, STAGE, None, None, None)
        assert (total, pago, pendente) == (800.0, 500.0, 300.0)

    def test_sem_organizacao_devolve_zeros(self, monkeypatch):
        _monta(monkeypatch)
        assert ExpenseService._staff_payments(None, STAGE, None, None, None) == (0.0, 0.0, 0.0)

    def test_filtro_por_torneio_nao_traz_pagamento_de_equipe(self, monkeypatch):
        """Pagamento de equipe e por ETAPA; ao filtrar por torneio ele nao se
        aplica, senao seria rateado sem criterio."""
        _monta(monkeypatch, {"staff_payments": [
            {"id": "p1", "organization_id": ORG, "stage_id": STAGE,
             "amount": 500, "status": "paid", "created_at": "2026-06-08T00:00:00Z"},
        ]})
        assert ExpenseService._staff_payments(ORG, STAGE, "algum-torneio", None, None) == (0.0, 0.0, 0.0)


class TestMensagemDeErroReceita:
    def test_extrai_o_motivo_do_erro_de_receita(self, monkeypatch):
        _monta(monkeypatch, {"other_revenues": [
            {"id": "r1", "organization_id": ORG, "stage_id": STAGE, "amount": 10,
             "status": "pendente", "source": "Bar", "created_at": "2026-06-08T00:00:00Z"},
        ]})
        erro = Exception("RECEITA: Caixa geral nao configurado.  {'code': 'P0001'}")
        monkeypatch.setattr(expense_service.supabase, "rpc",
                            lambda *a, **k: (_ for _ in ()).throw(erro))
        with pytest.raises(ValueError) as e:
            ExpenseService.set_revenue_status(ORG, "r1", "recebido")
        assert "Caixa geral nao configurado." in str(e.value)

    def test_erro_sem_marcador_vira_generico(self, monkeypatch):
        _monta(monkeypatch)
        monkeypatch.setattr(expense_service.supabase, "rpc",
                            lambda *a, **k: (_ for _ in ()).throw(Exception("timeout")))
        with pytest.raises(ValueError) as e:
            ExpenseService.set_revenue_status(ORG, "r1", "recebido")
        assert "Não foi possível atualizar a receita." in str(e.value)


class TestEdicaoDeReceitaDetalhada:
    def test_altera_campos_simples(self, monkeypatch):
        fake = _monta(monkeypatch, {"other_revenues": [
            {"id": "r1", "organization_id": ORG, "stage_id": STAGE, "amount": 10,
             "status": "pendente", "source": "Bar", "created_at": "2026-06-08T00:00:00Z"},
        ]})
        ExpenseService.update_revenue(ORG, "r1", {"amount": 999, "source": "Cozinha"})
        assert fake.store["other_revenues"][0]["amount"] == 999
        assert fake.store["other_revenues"][0]["source"] == "Cozinha"

    def test_receita_inexistente_devolve_none(self, monkeypatch):
        _monta(monkeypatch)
        assert ExpenseService.update_revenue(ORG, "nao-existe", {"amount": 1}) is None

    def test_receita_de_outra_organizacao_nao_e_apagada(self, monkeypatch):
        fake = _monta(monkeypatch, {"other_revenues": [
            {"id": "r1", "organization_id": "outra", "stage_id": STAGE, "amount": 10,
             "status": "pendente", "source": "Bar", "created_at": "2026-06-08T00:00:00Z"},
        ]})
        assert ExpenseService.delete_revenue(ORG, "r1") is False
        assert len(fake.store["other_revenues"]) == 1
