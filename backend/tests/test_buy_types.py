"""Testes dos meios de entrada por TORNEIO (`buy_types.tournament_id`).

Aqui mora a decisao mais perigosa da tela de configuracao: o que fazer com um
meio de entrada que o operador tirou da lista. Apagar um que ja foi vendido
apagaria o rotulo do recibo (`transactions.buy_type_id` e ON DELETE SET NULL) —
ninguem mais saberia o que aquela pessoa comprou. Por isso o teste confere o
EFEITO no banco, e nao so o retorno da funcao.
"""
import pytest

from app.services import buy_type_service as mod
from app.services.buy_type_service import BuyTypeService as S

from tests.conftest import FakeSupabase


TORNEIO = "22222222-2222-2222-2222-222222222222"
OUTRO_TORNEIO = "22222222-2222-2222-2222-222222222223"
ORG = "33333333-3333-3333-3333-333333333333"


def _tipo(id_, name="Buy-in", category="buy_in", amount=100, chips=10000,
          active=True, sort_order=0, torneio=TORNEIO):
    return {"id": id_, "tournament_id": torneio, "name": name,
            "category": category, "amount": amount, "rake_percentage": 20,
            "chips": chips, "active": active, "sort_order": sort_order,
            "organization_id": ORG}


def _item(id_=None, name="Buy-in", category="buy_in", amount=100, chips=10000,
          active=True, sort_order=0, rake=20):
    return {"id": id_, "name": name, "category": category, "amount": amount,
            "rake_percentage": rake, "chips": chips, "active": active,
            "sort_order": sort_order}


def _dia(id_, day_type="regular", torneio=TORNEIO):
    return {"id": id_, "tournament_id": torneio, "day_type": day_type,
            "buy_in": 1, "starting_chips": 1, "rebuy_amount": 1, "rebuy_chips": 1,
            "addon_amount": 1, "addon_chips": 1}


def _monta(monkeypatch, tipos=None, transacoes=None, dias=None):
    fake = FakeSupabase({
        "buy_types": tipos or [],
        "transactions": transacoes or [],
        "tournaments": [{"id": TORNEIO, "organization_id": ORG}],
        "tournament_days": dias or [],
    })
    monkeypatch.setattr(mod, "supabase", fake)
    return fake


class TestListagem:
    def test_lista_na_ordem_de_exibicao(self, monkeypatch):
        """A ordem e a do balcao: o operador clica por posicao, nao por leitura."""
        _monta(monkeypatch, tipos=[
            _tipo("b", name="Rebuy", category="rebuy", sort_order=2),
            _tipo("a", name="Buy-in", sort_order=1),
        ])
        assert [t["name"] for t in S.listar(TORNEIO)] == ["Buy-in", "Rebuy"]

    def test_nao_mistura_com_os_meios_de_outro_torneio(self, monkeypatch):
        """Cada torneio tem a sua configuracao — e o motivo inteiro da mudanca."""
        _monta(monkeypatch, tipos=[_tipo("a"), _tipo("z", torneio=OUTRO_TORNEIO)])
        assert [t["id"] for t in S.listar(TORNEIO)] == ["a"]


class TestSubstituicao:
    def test_cria_o_que_veio_sem_id(self, monkeypatch):
        fake = _monta(monkeypatch)
        final = S.substituir(TORNEIO, [_item(name="Buy-in duplo", amount=250, chips=30000)])
        assert len(final) == 1
        criado = fake.store["buy_types"][0]
        assert criado["tournament_id"] == TORNEIO
        # O dia nao e mais dono de nada: a linha nova nasce sem ele.
        assert "tournament_day_id" not in criado
        assert criado["chips"] == 30000
        # Sem a organizacao a linha ficaria orfa do multi-tenant: o backend usa
        # a chave de servico e o RLS nao preencheria isso sozinho.
        assert criado["organization_id"] == ORG

    def test_atualiza_o_que_veio_com_id(self, monkeypatch):
        fake = _monta(monkeypatch, tipos=[_tipo("a", amount=100, chips=10000)])
        S.substituir(TORNEIO, [_item(id_="a", name="Buy-in", amount=150, chips=12000)])
        assert len(fake.store["buy_types"]) == 1
        assert float(fake.store["buy_types"][0]["amount"]) == 150.0
        assert fake.store["buy_types"][0]["chips"] == 12000

    def test_o_que_sumiu_da_lista_e_apagado_quando_nunca_foi_vendido(self, monkeypatch):
        fake = _monta(monkeypatch, tipos=[_tipo("a"), _tipo("b", name="Rebuy",
                                                            category="rebuy")])
        S.substituir(TORNEIO, [_item(id_="a")])
        assert [t["id"] for t in fake.store["buy_types"]] == ["a"]

    def test_o_que_sumiu_mas_ja_foi_vendido_so_e_desativado(self, monkeypatch):
        """Apagar tiraria do recibo o que a pessoa comprou: a FK e ON DELETE SET
        NULL, entao a venda ficaria sem rotulo e o relatorio de rake por meio de
        entrada perderia o agrupamento."""
        fake = _monta(monkeypatch,
                      tipos=[_tipo("a"), _tipo("b", name="Rebuy", category="rebuy")],
                      transacoes=[{"id": "tx1", "buy_type_id": "b"}])
        S.substituir(TORNEIO, [_item(id_="a")])
        vendido = [t for t in fake.store["buy_types"] if t["id"] == "b"][0]
        assert vendido["active"] is False

    def test_erro_ao_conferir_as_vendas_nao_apaga_nada(self, monkeypatch):
        """Sem saber se houve venda, o caminho seguro e NAO apagar: uma linha
        desativada a mais o operador resolve; um recibo sem rotulo, nao."""
        fake = _monta(monkeypatch, tipos=[_tipo("a"), _tipo("b", name="Rebuy",
                                                            category="rebuy")])
        original = fake.table

        def _sem_transactions(nome):
            if nome == "transactions":
                raise RuntimeError("coluna buy_type_id nao existe")
            return original(nome)

        monkeypatch.setattr(fake, "table", _sem_transactions)
        S.substituir(TORNEIO, [_item(id_="a")])
        assert {t["id"] for t in fake.store["buy_types"]} == {"a", "b"}

    def test_recusa_lista_sem_buy_in_ativo(self, monkeypatch):
        """Sem meio de entrada de buy-in o Caixa abre sem nenhuma opcao de venda
        e o torneio fica parado."""
        _monta(monkeypatch, tipos=[_tipo("a")])
        with pytest.raises(ValueError, match="buy-in"):
            S.substituir(TORNEIO, [_item(id_="a", name="Rebuy", category="rebuy")])

    def test_buy_in_apenas_desativado_nao_conta(self, monkeypatch):
        """Desativado nao aparece no Caixa — e o mesmo torneio parado."""
        _monta(monkeypatch, tipos=[_tipo("a")])
        with pytest.raises(ValueError, match="buy-in"):
            S.substituir(TORNEIO, [_item(id_="a", active=False)])

    def test_lista_vazia_e_recusada(self, monkeypatch):
        _monta(monkeypatch, tipos=[_tipo("a")])
        with pytest.raises(ValueError, match="buy-in"):
            S.substituir(TORNEIO, [])

    def test_id_de_outro_torneio_e_recusado(self, monkeypatch):
        """Aceitar faria o upsert ROUBAR a linha do outro torneio, que perderia
        o meio de entrada dele no meio do evento."""
        fake = _monta(monkeypatch, tipos=[_tipo("a"), _tipo("z", torneio=OUTRO_TORNEIO)])
        with pytest.raises(ValueError, match="não pertence a este torneio"):
            S.substituir(TORNEIO, [_item(id_="a"), _item(id_="z")])
        # Nada pode ter sido gravado antes da recusa.
        assert len(fake.store["buy_types"]) == 2

    def test_devolve_a_lista_final_ja_ordenada(self, monkeypatch):
        _monta(monkeypatch, tipos=[_tipo("a")])
        final = S.substituir(TORNEIO, [
            _item(id_="a", sort_order=1),
            _item(name="Rebuy duplo", category="rebuy", amount=180, chips=25000,
                  sort_order=2),
        ])
        assert [t["name"] for t in final] == ["Buy-in", "Rebuy duplo"]

    def test_cria_edita_e_remove_numa_escrita_por_operacao(self, monkeypatch):
        """Uma ida ao banco por linha editada seria uma rajada de ~270ms cada
        nesta instalacao — o mesmo N+1 que ja derrubou o desempenho antes."""
        fake = _monta(monkeypatch, tipos=[_tipo("a"), _tipo("b", name="Rebuy",
                                                            category="rebuy")])
        original, escritas = fake.table, []

        def _contando(nome):
            escritas.append(nome)
            return original(nome)

        monkeypatch.setattr(fake, "table", _contando)
        S.substituir(TORNEIO, [
            _item(id_="a", amount=150),
            _item(name="Add-on", category="addon", amount=50, chips=5000),
        ])
        # buy_types: listar, insert, upsert, delete, listar de novo = 5.
        assert escritas.count("buy_types") == 5
        assert escritas.count("transactions") == 1
        # As colunas antigas dos dias seguem a lista numa unica escrita.
        assert escritas.count("tournament_days") == 1

    def test_torneio_sem_organizacao_legivel_nao_impede_o_cadastro(self, monkeypatch):
        """Banco sem a coluna de organizacao (instalacao anterior ao multi-tenant):
        deixar de gravar o meio de entrada travaria o torneio inteiro por causa
        de um campo que ninguem le ali."""
        fake = _monta(monkeypatch)
        original = fake.table

        def _sem_org(nome):
            if nome == "tournaments":
                raise RuntimeError("column organization_id does not exist")
            return original(nome)

        monkeypatch.setattr(fake, "table", _sem_org)
        S.substituir(TORNEIO, [_item(name="Buy-in")])
        assert fake.store["buy_types"][0]["organization_id"] is None


class TestEspelhoNosDias:
    """As colunas antigas do dia (buy_in, fichas...) continuam sendo lidas como
    reserva da venda e mostradas no detalhe do torneio. Se nao seguirem a lista,
    contam uma historia diferente da que o Caixa cobra."""

    def test_salvar_espelha_as_colunas_antigas_dos_dias_nao_finais(self, monkeypatch):
        fake = _monta(monkeypatch, dias=[_dia("d1"), _dia("d-final", day_type="final")])
        S.substituir(TORNEIO, [
            _item(name="Buy-in duplo", amount=250, chips=30000, sort_order=0),
            _item(name="Rebuy", category="rebuy", amount=100, chips=10000, sort_order=1),
        ])
        dia = [d for d in fake.store["tournament_days"] if d["id"] == "d1"][0]
        assert float(dia["buy_in"]) == 250.0
        assert dia["starting_chips"] == 30000
        assert float(dia["rebuy_amount"]) == 100.0
        assert dia["rebuy_chips"] == 10000
        # Sem add-on na lista: NULO (o CHECK da coluna e `> 0`), fichas zero.
        assert dia["addon_amount"] is None
        assert dia["addon_chips"] == 0
        # O dia final fica como estava: la nao se vende entrada.
        final = [d for d in fake.store["tournament_days"] if d["id"] == "d-final"][0]
        assert final["buy_in"] == 1

    def test_o_primeiro_meio_ativo_de_cada_categoria_e_que_manda(self, monkeypatch):
        """Um meio desativado (vendido e retirado) nao pode voltar a ditar o
        valor do dia; e entre dois ativos vale o primeiro da ordem da tela."""
        colunas = S.colunas_do_dia([
            _item(id_="x", name="Buy-in antigo", amount=80, chips=8000, active=False, sort_order=0),
            _item(id_="b", name="Buy-in turbo", amount=150, chips=15000, sort_order=2),
            _item(id_="a", name="Buy-in", amount=100, chips=10000, sort_order=1),
        ])
        assert colunas["buy_in"] == 100.0
        assert colunas["starting_chips"] == 10000

    def test_rebuy_zerado_vira_nulo(self, monkeypatch):
        """"Rebuy de R$ 0,00" diria que o rebuy e de graca; nulo diz que ele nao
        existe — e e o unico valor que o CHECK `> 0` da coluna aceita."""
        colunas = S.colunas_do_dia([
            _item(), _item(name="Rebuy", category="rebuy", amount=0, chips=5000),
        ])
        assert colunas["rebuy_amount"] is None
        assert colunas["rebuy_chips"] == 5000

    def test_espelho_falhando_nao_derruba_a_gravacao(self, monkeypatch):
        """A lista ja foi gravada quando o espelho roda; uma coluna de exibicao
        desatualizada nao pode fazer o operador achar que o cadastro falhou."""
        fake = _monta(monkeypatch, dias=[_dia("d1")])
        original = fake.table

        def _sem_dias(nome):
            if nome == "tournament_days":
                raise RuntimeError("timeout")
            return original(nome)

        monkeypatch.setattr(fake, "table", _sem_dias)
        final = S.substituir(TORNEIO, [_item(name="Buy-in", amount=250)])
        assert [t["name"] for t in final] == ["Buy-in"]
        assert float(fake.store["buy_types"][0]["amount"]) == 250.0
