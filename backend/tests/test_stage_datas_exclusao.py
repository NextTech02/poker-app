"""Datas da etapa e exclusão de etapa — achados do teste de aceitação.

Três dores reais de operação estão cobertas aqui:

- **Etapa que termina antes de começar** (10/08 → 02/08 foi aceito). Some do
  relatório por período (nenhum dia cai no intervalo) e nunca aparece como
  "em andamento".
- **Etapa sem data de início**. O dono do produto decidiu: início
  OBRIGATÓRIO, fim OPCIONAL (o circuito pode ficar em aberto). Mas já existem
  etapas sem data na base: elas continuam sendo lidas, listadas e operadas —
  a data é PEDIDA na hora de editar, não cobrada de quem só está consultando.
- **Exclusão de etapa**. As FKs para `stages` são ON DELETE CASCADE: apagar a
  etapa apaga sangrias, despesas, outras receitas, pagamentos de
  funcionário, caixas, tipos de buy e consignações de ficha. Dinheiro apagado
  não volta e não há desfazer, então o serviço RECUSA e oferece arquivar.
"""
import pytest

from app.models.stage import (
    MSG_FIM_ANTES_DO_INICIO,
    MSG_INICIO_OBRIGATORIO,
    Stage,
    StageCreate,
    StageUpdate,
)
from app.services.stage_service import StageService as SS
from tests.conftest import FakeSupabase


ETAPA = "11111111-1111-1111-1111-111111111111"


def _base(**extra):
    """Uma etapa gravada, com as colunas que o modelo Stage exige."""
    linha = {
        "id": ETAPA, "name": "Etapa Rio", "location": "Rio",
        "start_date": "2026-08-02", "end_date": "2026-08-10",
        "status": "upcoming", "created_at": "2026-06-08T00:00:00Z",
    }
    linha.update(extra)
    return linha


@pytest.fixture
def banco(monkeypatch):
    """FakeSupabase plugado no service (e só nele)."""
    def _montar(tabelas):
        fake = FakeSupabase(tabelas)
        monkeypatch.setattr("app.services.stage_service.supabase", fake)
        return fake
    return _montar


# ─────────────────────────────────────────────────────────────────────────────
# ACHADO 1 e 2 — as datas
# ─────────────────────────────────────────────────────────────────────────────

class TestDatasNaCriacao:
    """A regra é cobrada no SERVICE, não num model_validator do Pydantic.

    Se ela morasse no modelo, o FastAPI responderia 422 com `detail` em lista
    antes de entrar no endpoint, e a tela de Etapas — que mostra
    `response.data.detail` como texto — não teria a frase para exibir.
    """

    def test_fim_antes_do_inicio_e_recusado(self, banco):
        # O caso literal do dono: 10/08 até 02/08.
        banco({"stages": []})
        # O StageCreate é montado FORA do bloco: dentro do `raises` fica só a
        # chamada sob teste, senão um ValidationError do Pydantic (que também é
        # ValueError) deixaria o teste verde sem o service ter recusado nada.
        dados = StageCreate(name="Etapa", location="Rio",
                            start_date="2026-08-10", end_date="2026-08-02")
        with pytest.raises(ValueError, match="anterior"):
            SS.create_stage(dados)

    def test_mesmo_dia_vale(self, banco):
        # Etapa de um dia só é rotina (satélite de uma noite).
        banco({"stages": []})
        etapa = SS.create_stage(StageCreate(name="Etapa", location="Rio",
                                            start_date="2026-08-10", end_date="2026-08-10"))
        assert etapa.end_date == etapa.start_date

    def test_sem_data_de_inicio_e_recusado(self, banco):
        banco({"stages": []})
        dados = StageCreate(name="Etapa", location="Rio")
        with pytest.raises(ValueError, match="data de início"):
            SS.create_stage(dados)

    def test_etapa_invalida_nao_chega_a_ser_gravada(self, banco):
        # A recusa não pode ser só cosmética: nada pode entrar na tabela.
        fake = banco({"stages": []})
        dados = StageCreate(name="Etapa", location="Rio",
                            start_date="2026-08-10", end_date="2026-08-02")
        with pytest.raises(ValueError, match="anterior"):
            SS.create_stage(dados)
        assert fake.store["stages"] == []

    def test_sem_data_de_fim_e_aceito(self, banco):
        # Circuito em aberto: o fim ainda não foi decidido.
        banco({"stages": []})
        etapa = SS.create_stage(StageCreate(name="Etapa", location="Rio",
                                            start_date="2026-08-10"))
        assert etapa.end_date is None


class TestLeituraTolerante:
    def test_etapa_antiga_sem_data_continua_sendo_lida(self, banco):
        # Regra nova NÃO pode derrubar o que já está gravado: quem só está
        # consultando/operando a etapa antiga não é interrompido.
        banco({"stages": [_base(start_date=None, end_date=None)]})
        etapa = SS.get_stage(ETAPA)
        assert etapa is not None
        assert etapa.start_date is None

    def test_etapa_antiga_com_datas_invertidas_continua_sendo_lida(self, banco):
        banco({"stages": [_base(start_date="2026-08-10", end_date="2026-08-02")]})
        assert SS.get_stage(ETAPA) is not None


class TestDatasNaEdicao:
    def test_apagar_a_data_de_inicio_e_recusado(self, banco):
        banco({"stages": [_base()]})
        dados = StageUpdate(start_date=None, name="X")
        with pytest.raises(ValueError, match="data de início"):
            SS.update_stage(ETAPA, dados)

    def test_inverter_as_duas_datas_de_uma_vez_e_recusado(self, banco):
        banco({"stages": [_base()]})
        dados = StageUpdate(start_date="2026-08-10", end_date="2026-08-02")
        with pytest.raises(ValueError, match="anterior"):
            SS.update_stage(ETAPA, dados)

    def test_fim_sozinho_e_comparado_com_o_inicio_gravado(self, banco):
        # O PATCH manda só `end_date`; a comparação depende da linha no banco.
        banco({"stages": [_base(start_date="2026-08-10", end_date="2026-08-20")]})
        dados = StageUpdate(end_date="2026-08-02")
        with pytest.raises(ValueError, match="anterior"):
            SS.update_stage(ETAPA, dados)

    def test_inicio_sozinho_e_comparado_com_o_fim_gravado(self, banco):
        banco({"stages": [_base(start_date="2026-08-02", end_date="2026-08-10")]})
        dados = StageUpdate(start_date="2026-08-20")
        with pytest.raises(ValueError, match="anterior"):
            SS.update_stage(ETAPA, dados)

    def test_edicao_valida_grava(self, banco):
        banco({"stages": [_base()]})
        etapa = SS.update_stage(ETAPA, StageUpdate(end_date="2026-08-15"))
        assert str(etapa.end_date) == "2026-08-15"

    def test_editar_etapa_antiga_sem_data_pede_a_data(self, banco):
        # É o momento certo de cobrar o que faltou: ele já está no cadastro.
        banco({"stages": [_base(start_date=None, end_date=None)]})
        dados = StageUpdate(name="Etapa Rio 2026")
        with pytest.raises(ValueError, match="data de início"):
            SS.update_stage(ETAPA, dados)

    def test_editar_etapa_antiga_informando_a_data_resolve(self, banco):
        banco({"stages": [_base(start_date=None, end_date=None)]})
        etapa = SS.update_stage(ETAPA, StageUpdate(start_date="2026-08-02"))
        assert str(etapa.start_date) == "2026-08-02"

    def test_arquivar_etapa_antiga_nao_exige_data(self, banco):
        # Arquivar é a saída para tirar da frente uma etapa que não se pode
        # apagar; exigir data aqui obrigaria alguém a INVENTAR uma.
        banco({"stages": [_base(start_date=None, end_date=None)]})
        assert SS.archive_stage(ETAPA).status == "cancelled"


class TestDatasNaRota:
    """O backend é quem vale: a tela avisa antes, mas não é ela que decide."""

    def test_criar_com_fim_antes_do_inicio_da_400_com_o_motivo(self, client, banco):
        # 400 com `detail` em TEXTO (não a lista do 422 do Pydantic): é o que a
        # tela de Etapas mostra no toast sem quebrar.
        banco({"stages": []})
        r = client.post("/stages", json={
            "name": "Etapa", "location": "Rio",
            "start_date": "2026-08-10", "end_date": "2026-08-02",
        })
        assert r.status_code == 400
        assert r.json()["detail"]["message"] == MSG_FIM_ANTES_DO_INICIO
        assert r.json()["detail"]["code"] == "etapa_fim_antes_do_inicio"

    def test_criar_sem_inicio_da_400_com_o_motivo(self, client, banco):
        banco({"stages": []})
        r = client.post("/stages", json={"name": "Etapa", "location": "Rio"})
        assert r.status_code == 400
        assert r.json()["detail"]["message"] == MSG_INICIO_OBRIGATORIO
        assert r.json()["detail"]["code"] == "etapa_sem_data_de_inicio"

    def test_criacao_valida_passa(self, client, banco):
        banco({"stages": []})
        r = client.post("/stages", json={
            "name": "Etapa", "location": "Rio", "start_date": "2026-08-02",
        })
        assert r.status_code == 201

    @pytest.mark.parametrize("corpo", [
        {"end_date": "2026-08-02"},
        {"start_date": None},
    ])
    def test_editar_com_data_incoerente_da_400_em_texto(self, client, banco, corpo):
        # O par da criação: os DOIS caminhos respondem igual (400 + string).
        banco({"stages": [_base(start_date="2026-08-10", end_date="2026-08-20")]})
        r = client.patch(f"/stages/{ETAPA}", json=corpo)
        assert r.status_code == 400
        assert isinstance(r.json()["detail"]["message"], str)

    def test_editar_com_data_incoerente_da_400_com_o_motivo(self, client, stub):
        def _explode(sid, dados):
            raise ValueError("A data final da etapa não pode ser anterior à data de início")

        stub(SS, update_stage=_explode)
        r = client.patch(f"/stages/{ETAPA}", json={"end_date": "2026-08-02"})
        assert r.status_code == 400
        assert "anterior" in r.json()["detail"]["message"]

    def test_arquivar_devolve_a_etapa_cancelada(self, client, stub):
        stub(SS, archive_stage=lambda sid: Stage(
            id=ETAPA, name="Etapa", location="Rio", status="cancelled",
            created_at="2026-06-08T00:00:00Z"))
        r = client.post(f"/stages/{ETAPA}/archive")
        assert r.status_code == 200
        assert r.json()["status"] == "cancelled"

    def test_arquivar_inexistente_da_404(self, client, stub):
        stub(SS, archive_stage=lambda sid: None)
        assert client.post(f"/stages/{ETAPA}/archive").status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# ACHADO 3 — a exclusão em cascata
# ─────────────────────────────────────────────────────────────────────────────

class TestImpactoDaExclusao:
    def test_etapa_vazia_nao_bloqueia_e_apaga(self, banco):
        fake = banco({"stages": [_base()]})
        assert SS.get_delete_impact(ETAPA).blocked is False
        assert SS.delete_stage(ETAPA) is True
        assert fake.store["stages"] == []

    def test_conta_sangrias_despesas_e_saldo_com_os_valores(self, banco):
        banco({
            "stages": [_base()],
            "sangria_transactions": [
                {"id": "s1", "stage_id": ETAPA, "amount": 1000},
                {"id": "s2", "stage_id": ETAPA, "amount": 500},
                {"id": "s3", "stage_id": "outra", "amount": 999},
            ],
            "expenses": [{"id": "d1", "stage_id": ETAPA, "amount": 250.5}],
            "stage_cash_register": [
                {"id": "c1", "stage_id": ETAPA, "current_balance": 4500, "total_received": 9000}
            ],
        })
        impacto = SS.get_delete_impact(ETAPA)
        # É com estes números que a tela monta "2 sangrias, 1 despesa,
        # R$ 4.500 em caixa" antes de alguém confirmar.
        assert impacto.sangrias == 2
        assert impacto.sangrias_amount == 1500
        assert impacto.expenses == 1
        assert impacto.expenses_amount == 250.5
        assert impacto.cash_balance == 4500
        assert impacto.stage_name == "Etapa Rio"

    def test_torneios_entram_no_resumo(self, banco):
        # Torneio não é apagado (FK SET NULL), mas fica órfão de etapa.
        banco({"stages": [_base()],
               "tournaments": [{"id": "t1", "stage_id": ETAPA}]})
        assert SS.get_delete_impact(ETAPA).tournaments == 1

    def test_tabela_ausente_nao_derruba_o_resumo(self, banco, monkeypatch):
        # Instalação que ainda não rodou a migração de `other_revenues`: o
        # PostgREST devolve erro, e o aviso de exclusão não pode ser a coisa
        # que quebra a tela na hora de excluir.
        fake = banco({"stages": [_base()]})
        original = fake.table

        def _tabela(nome):
            if nome == "other_revenues":
                raise RuntimeError('relation "other_revenues" does not exist')
            return original(nome)

        monkeypatch.setattr(fake, "table", _tabela)
        impacto = SS.get_delete_impact(ETAPA)
        assert impacto.other_revenues == 0
        assert impacto.blocked is False

    def test_caixa_indisponivel_nao_derruba_o_resumo(self, banco, monkeypatch):
        fake = banco({"stages": [_base()]})
        original = fake.table

        def _tabela(nome):
            if nome == "stage_cash_register":
                raise RuntimeError('relation "stage_cash_register" does not exist')
            return original(nome)

        monkeypatch.setattr(fake, "table", _tabela)
        assert SS.get_delete_impact(ETAPA).cash_balance == 0

    def test_etapa_inexistente_nao_tem_impacto(self, banco):
        banco({"stages": []})
        assert SS.get_delete_impact("sumiu") is None

    @pytest.mark.parametrize("tabela", [
        "sangria_transactions", "expenses", "other_revenues",
        "staff_payments", "chip_consignments",
    ])
    def test_qualquer_movimento_financeiro_bloqueia(self, banco, tabela):
        banco({"stages": [_base()],
               tabela: [{"id": "x", "stage_id": ETAPA, "amount": 10}]})
        assert SS.get_delete_impact(ETAPA).blocked is True

    def test_venda_ja_registrada_bloqueia_mesmo_com_saldo_zerado(self, banco):
        # Depois da sangria o saldo volta a zero; o dinheiro passou por ali
        # do mesmo jeito e o histórico não pode sumir.
        banco({"stages": [_base()],
               "stage_cash_register": [
                   {"id": "c1", "stage_id": ETAPA, "current_balance": 0, "total_received": 9000}]})
        assert SS.get_delete_impact(ETAPA).blocked is True

    def test_so_configuracao_nao_bloqueia(self, banco):
        # Tipo de buy e caixa zerado são catálogo, recriáveis: contam no aviso
        # mas não impedem apagar uma etapa criada por engano.
        banco({"stages": [_base()],
               "buy_types": [{"id": "b1", "stage_id": ETAPA}],
               "cashboxes": [{"id": "cx1", "stage_id": ETAPA}]})
        impacto = SS.get_delete_impact(ETAPA)
        assert impacto.buy_types == 1
        assert impacto.cashboxes == 1
        assert impacto.blocked is False


class TestExclusaoBloqueada:
    def test_nao_apaga_etapa_com_movimento(self, banco):
        fake = banco({"stages": [_base()],
                      "expenses": [{"id": "d1", "stage_id": ETAPA, "amount": 100}]})
        with pytest.raises(ValueError):
            SS.delete_stage(ETAPA)
        # O que importa não é a exceção: é a etapa AINDA ESTAR LÁ.
        assert len(fake.store["stages"]) == 1

    def test_rota_de_exclusao_bloqueada_da_409_com_o_motivo(self, client, stub):
        def _recusa(sid):
            raise ValueError("Esta etapa tem movimento financeiro e não pode ser excluída")

        stub(SS, delete_stage=_recusa)
        r = client.delete(f"/stages/{ETAPA}")
        assert r.status_code == 409
        assert "movimento financeiro" in r.json()["detail"]["message"]

    def test_rota_de_impacto_devolve_os_numeros(self, client, stub):
        from app.models.stage import StageDeleteImpact

        stub(SS, get_delete_impact=lambda sid: StageDeleteImpact(
            stage_id=sid, stage_name="Etapa Rio", sangrias=3, expenses=12,
            cash_balance=4500, blocked=True))
        corpo = client.get(f"/stages/{ETAPA}/delete-impact").json()
        assert corpo["sangrias"] == 3
        assert corpo["expenses"] == 12
        assert corpo["cash_balance"] == 4500
        assert corpo["blocked"] is True

    def test_rota_de_impacto_de_etapa_inexistente_da_404(self, client, stub):
        stub(SS, get_delete_impact=lambda sid: None)
        assert client.get(f"/stages/{ETAPA}/delete-impact").status_code == 404
