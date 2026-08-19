"""Exclusão de torneio e de dia: o que a cascata destrói e quando ela é recusada.

O cliente relatou "o torneio excluiu normalmente, mas não tinha entradas" — e o
perigo está no caso que ele NÃO testou. Todas as FKs que apontam para
`tournaments` (e para `tournament_days`) são ON DELETE CASCADE: apagar leva
junto `transactions`, `tournament_players`, `prize_allocations`, dias, blinds e
assentos. Some a venda, o dinheiro recebido e o registro de quem pagou.

E o caixa da etapa NÃO acompanha: os gatilhos de caixa são só de INSERT. O
saldo continua apontando dinheiro cuja origem foi apagada — a etapa deixa de
fechar e ninguém descobre por quê.

Por isso duas coisas são testadas aqui:

- **A medição do estrago** (`get_delete_impact`), que é o que a confirmação
  mostra ao operador ANTES do clique: quantas entradas, quantos jogadores,
  quanto em dinheiro.
- **A RECUSA no servidor.** Ela vive no service, não na tela: quem chama a API
  direto (curl, script, integração) precisa esbarrar na mesma regra. O caminho
  para apagar um torneio criado por engano continua sendo cancelar as vendas no
  Caixa — o estorno devolve o dinheiro e acerta o caixa — e só então excluir.
"""
import pytest

from app.services import tournament_service as mod_torneio
from app.services import tournament_day_service as mod_dia
from app.services.tournament_service import (
    MovimentoFinanceiroImpedeExclusao,
    TournamentService as TS,
)
from app.services.tournament_day_service import TournamentDayService as TDS

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777771"
OUTRO_DIA = "77777777-7777-7777-7777-777777777772"
TP = "55555555-5555-5555-5555-555555555555"


def _venda(tipo="buy_in", valor=100.0, status="active", tp=TP, **kw):
    linha = {
        "id": f"tx-{tipo}-{status}-{valor}-{tp}", "tournament_id": TOUR,
        "player_id": "p1", "tournament_player_id": tp,
        "type": tipo, "amount": valor, "status": status,
    }
    linha.update(kw)
    return linha


def _dia(id_=DIA, nome="Dia 1", numero=1):
    """Linha completa: o router lê o dia como modelo antes de apagar."""
    return {
        "id": id_, "tournament_id": TOUR, "day_name": nome, "day_number": numero,
        "buy_in": 100, "max_players": 200, "status": "pending",
        "starting_chips": 10000, "registered_players": 0, "total_entries": 0,
        "prize_pool": 0, "day_type": "regular",
        "created_at": "2026-06-08T00:00:00Z",
    }


def _inscricao(id_=TP, dia=DIA, gasto=100.0, status="active"):
    return {
        "id": id_, "tournament_id": TOUR, "tournament_day_id": dia,
        "player_id": "p1", "status": status, "total_spent": gasto,
    }


def _banco(monkeypatch, dias=None, inscricoes=None, vendas=None):
    """Mesmo fake para os dois serviços — a cascata é a mesma base."""
    fake = FakeSupabase({
        "tournaments": [{"id": TOUR, "name": "Main Event", "stage_id": "e1"}],
        "tournament_days": dias if dias is not None else [_dia()],
        "tournament_players": inscricoes or [],
        "transactions": vendas or [],
    })
    monkeypatch.setattr(mod_torneio, "supabase", fake)
    monkeypatch.setattr(mod_dia, "supabase", fake)
    return fake


# ---------------------------------------------------------------------------
# O tamanho do estrago, em números
# ---------------------------------------------------------------------------

class TestImpactoDaExclusaoDeTorneio:
    def test_torneio_vazio_nao_tem_o_que_destruir(self, monkeypatch):
        """É o caso que o cliente testou: sem entrada nenhuma, a exclusão passa."""
        _banco(monkeypatch)
        impacto = TS.get_delete_impact(TOUR)
        assert (impacto.entries, impacto.players, impacto.entries_amount) == (0, 0, 0)
        assert impacto.blocked is False

    def test_conta_dias_inscricoes_entradas_e_dinheiro(self, monkeypatch):
        """São EXATAMENTE os números que a confirmação mostra: sem eles o
        operador não tem como medir o estrago antes de confirmar."""
        _banco(
            monkeypatch,
            dias=[_dia(), _dia(OUTRO_DIA, "Dia 2", 2)],
            inscricoes=[_inscricao(), _inscricao("tp2", gasto=250.0)],
            vendas=[
                _venda("buy_in", 100.0),
                _venda("rebuy", 50.0),
                _venda("addon", 30.0, tp="tp2"),
            ],
        )
        impacto = TS.get_delete_impact(TOUR)
        assert impacto.tournament_name == "Main Event"
        assert impacto.days == 2
        assert impacto.players == 2
        assert impacto.paying_players == 2
        assert impacto.entries == 3
        assert impacto.entries_amount == 180.0

    def test_premiacao_paga_entra_separada_do_que_entrou(self, monkeypatch):
        """Prêmio é dinheiro que SAIU: somá-lo às entradas inflaria o que o
        clube acha que recebeu."""
        _banco(monkeypatch, vendas=[_venda("buy_in", 100.0), _venda("prize", 400.0)])
        impacto = TS.get_delete_impact(TOUR)
        assert (impacto.entries, impacto.entries_amount) == (1, 100.0)
        assert (impacto.prizes, impacto.prizes_amount) == (1, 400.0)

    def test_venda_estornada_conta_como_historico_e_nao_como_dinheiro(self, monkeypatch):
        """O estorno já devolveu o dinheiro e acertou o caixa. O que sobra é
        histórico — aparece no aviso, mas não trava a exclusão."""
        _banco(monkeypatch, vendas=[_venda("buy_in", 100.0, status="cancelled")])
        impacto = TS.get_delete_impact(TOUR)
        assert (impacto.cancelled_entries, impacto.entries) == (1, 0)
        assert impacto.blocked is False

    def test_torneio_inexistente_nao_tem_impacto(self, monkeypatch):
        _banco(monkeypatch)
        assert TS.get_delete_impact("fantasma") is None

    def test_venda_de_base_antiga_sem_coluna_status_vale_como_viva(self, monkeypatch):
        """O deploy não é atômico: onde a migração de cancelamento ainda não
        rodou, a linha vem sem `status`. Tratar a ausência como 'cancelada'
        faria a guarda liberar justamente o banco mais desprotegido."""
        venda = _venda("buy_in", 100.0)
        del venda["status"]
        _banco(monkeypatch, vendas=[venda])
        assert TS.get_delete_impact(TOUR).blocked is True


# ---------------------------------------------------------------------------
# A recusa
# ---------------------------------------------------------------------------

class TestRecusaDeExcluirTorneio:
    def test_sem_movimento_apaga_de_verdade(self, monkeypatch):
        fake = _banco(monkeypatch)
        assert TS.delete_tournament(TOUR) is True
        assert fake.store["tournaments"] == []

    def test_com_entrada_vendida_recusa_e_nao_apaga_nada(self, monkeypatch):
        """O caso que o cliente NÃO testou. A recusa vem com os números para o
        router devolvê-los ao operador."""
        fake = _banco(
            monkeypatch,
            inscricoes=[_inscricao()],
            vendas=[_venda("buy_in", 100.0)],
        )
        with pytest.raises(MovimentoFinanceiroImpedeExclusao) as erro:
            TS.delete_tournament(TOUR)
        assert erro.value.impacto.entries == 1
        assert erro.value.impacto.entries_amount == 100.0
        # Nada foi tocado: o torneio, a inscrição e a venda continuam de pé.
        assert len(fake.store["tournaments"]) == 1
        assert len(fake.store["transactions"]) == 1
        assert len(fake.store["tournament_players"]) == 1

    def test_estorno_pela_metade_tambem_recusa(self, monkeypatch):
        """'cancelling' é um estorno que começou e não terminou. Apagar a venda
        no meio do caminho congela o caixa torto para sempre: some a linha que
        a retomada consulta para saber o que ainda falta desfazer."""
        _banco(monkeypatch, vendas=[_venda("buy_in", 100.0, status="cancelling")])
        with pytest.raises(MovimentoFinanceiroImpedeExclusao):
            TS.delete_tournament(TOUR)

    def test_premiacao_paga_recusa_para_sempre(self, monkeypatch):
        """Prêmio não é cancelável pelo estorno de venda (só buy-in/rebuy/add-on).
        Evento com prêmio pago é história fechada, não rascunho."""
        _banco(monkeypatch, vendas=[_venda("prize", 400.0)])
        with pytest.raises(MovimentoFinanceiroImpedeExclusao):
            TS.delete_tournament(TOUR)

    def test_jogador_pago_sem_transacao_recusa(self, monkeypatch):
        """Nem todo dinheiro deixa rastro em `transactions`: importação, ajuste
        manual e base antiga gravam o valor direto na inscrição."""
        _banco(monkeypatch, inscricoes=[_inscricao(gasto=250.0)])
        with pytest.raises(MovimentoFinanceiroImpedeExclusao):
            TS.delete_tournament(TOUR)

    def test_inscricao_estornada_com_valor_zerado_nao_trava(self, monkeypatch):
        """Depois do estorno a inscrição fica 'cancelled' com total zerado — é o
        estado que LIBERA a exclusão, senão o caminho de conserto não existiria."""
        _banco(
            monkeypatch,
            inscricoes=[_inscricao(gasto=0.0, status="cancelled")],
            vendas=[_venda("buy_in", 100.0, status="cancelled")],
        )
        assert TS.delete_tournament(TOUR) is True

    def test_torneio_inexistente_continua_devolvendo_falso(self, monkeypatch):
        """O router traduz isso em 404; a guarda não pode virar 409 aqui."""
        _banco(monkeypatch)
        assert TS.delete_tournament("fantasma") is False


# ---------------------------------------------------------------------------
# O mesmo buraco uma camada abaixo: o DIA
# ---------------------------------------------------------------------------

class TestRecusaDeExcluirDia:
    def test_dia_sem_movimento_apaga(self, monkeypatch):
        fake = _banco(monkeypatch)
        assert TDS.delete_tournament_day(DIA) is True
        assert fake.store["tournament_days"] == []

    def test_dia_com_entrada_vendida_recusa(self, monkeypatch):
        """A tela só oferece o botão em dia 'pending', mas isso é conforto: a
        regra tem de valer para quem chama a API direto."""
        fake = _banco(
            monkeypatch,
            inscricoes=[_inscricao()],
            vendas=[_venda("buy_in", 100.0)],
        )
        with pytest.raises(MovimentoFinanceiroImpedeExclusao) as erro:
            TDS.delete_tournament_day(DIA)
        assert erro.value.impacto.entries == 1
        assert len(fake.store["tournament_days"]) == 1

    def test_venda_de_outro_dia_nao_trava_este(self, monkeypatch):
        """A venda aponta para a INSCRIÇÃO, e é ela que sabe o dia. Sem esse
        caminho, o Dia 2 vazio herdaria o bloqueio do Dia 1 cheio e ninguém
        conseguiria apagar um dia criado por engano."""
        _banco(
            monkeypatch,
            dias=[_dia(), _dia(OUTRO_DIA, "Dia 2", 2)],
            inscricoes=[_inscricao(dia=DIA)],
            vendas=[_venda("buy_in", 100.0)],
        )
        assert TDS.get_delete_impact(OUTRO_DIA).blocked is False
        assert TDS.delete_tournament_day(OUTRO_DIA) is True

    def test_impacto_do_dia_traz_nome_e_torneio(self, monkeypatch):
        _banco(monkeypatch, inscricoes=[_inscricao()], vendas=[_venda("rebuy", 50.0)])
        impacto = TDS.get_delete_impact(DIA)
        assert impacto.day_name == "Dia 1"
        assert impacto.tournament_id == TOUR
        assert (impacto.entries, impacto.entries_amount) == (1, 50.0)

    def test_dia_final_com_premio_pago_recusa_mesmo_parecendo_vazio(self, monkeypatch):
        """O buraco mais traiçoeiro: no dia final os classificados entram SEM
        pagar (total_spent zero) e o pagamento de prêmio não tem inscrição
        vinculada. Pelas contas do dia, ele parece vazio — mas é o dia que
        decidiu o torneio, e o prêmio já saiu do caixa geral."""
        _banco(
            monkeypatch,
            inscricoes=[_inscricao(gasto=0.0)],
            vendas=[_venda("prize", 4000.0, tp=None)],
        )
        impacto = TDS.get_delete_impact(DIA)
        assert impacto.prizes == 1
        assert impacto.blocked is True
        with pytest.raises(MovimentoFinanceiroImpedeExclusao):
            TDS.delete_tournament_day(DIA)

    def test_premio_do_dia_1_nao_trava_o_dia_2_vazio(self, monkeypatch):
        """O beco sem saída: pago um prêmio qualquer, medir a premiação pelo
        TORNEIO travava todos os dias — inclusive um Dia 2 criado por engano,
        sem uma inscrição sequer. A tela mandava cancelar vendas que esse dia
        não tem, e o operador ficava sem saída nenhuma."""
        _banco(
            monkeypatch,
            dias=[_dia(), _dia(OUTRO_DIA, "Dia 2", 2)],
            inscricoes=[_inscricao(gasto=0.0)],
            vendas=[_venda("prize", 4000.0, tp=None)],
        )
        assert TDS.get_delete_impact(DIA).blocked is True

        impacto = TDS.get_delete_impact(OUTRO_DIA)
        assert (impacto.prizes, impacto.prizes_amount) == (0, 0.0)
        assert impacto.blocked is False
        assert TDS.delete_tournament_day(OUTRO_DIA) is True

    def test_premio_de_outro_jogador_nao_trava_o_dia(self, monkeypatch):
        """Mesmo com inscrição, o dia só trava pelo prêmio de quem está NELE.
        O Dia 2 tem um inscrito que não pagou nada e não ganhou nada; o prêmio
        é do campeão do Dia 1, e apagar o Dia 2 não apaga o registro dele."""
        _banco(
            monkeypatch,
            dias=[_dia(), _dia(OUTRO_DIA, "Dia 2", 2)],
            inscricoes=[
                _inscricao(gasto=0.0),
                {**_inscricao(id_="tp-engano", dia=OUTRO_DIA, gasto=0.0),
                 "player_id": "p2"},
            ],
            vendas=[_venda("prize", 4000.0, tp=None)],
        )
        assert TDS.get_delete_impact(OUTRO_DIA).blocked is False

    def test_premio_trava_o_dia_em_que_o_ganhador_esta_inscrito(self, monkeypatch):
        """A guarda do dia final continua de pé depois do recorte por jogador:
        o classificado entra no Dia 2 sem pagar (total_spent zero) e o prêmio
        sai do caixa geral — é o Dia 2 que não pode ser apagado."""
        _banco(
            monkeypatch,
            dias=[_dia(), _dia(OUTRO_DIA, "Dia 2", 2)],
            inscricoes=[
                {**_inscricao(id_="tp-final", dia=OUTRO_DIA, gasto=0.0),
                 "player_id": "p9"},
            ],
            vendas=[_venda("prize", 4000.0, tp=None, player_id="p9")],
        )
        impacto = TDS.get_delete_impact(OUTRO_DIA)
        assert (impacto.prizes, impacto.prizes_amount) == (1, 4000.0)
        assert impacto.blocked is True
        with pytest.raises(MovimentoFinanceiroImpedeExclusao):
            TDS.delete_tournament_day(OUTRO_DIA)

    def test_dia_inexistente_devolve_falso(self, monkeypatch):
        _banco(monkeypatch)
        assert TDS.delete_tournament_day("fantasma") is False


# ---------------------------------------------------------------------------
# Camada HTTP: é por aqui que a integração e o curl entram
# ---------------------------------------------------------------------------

class TestHTTP:
    def test_delete_impact_do_torneio_devolve_os_numeros(self, client, monkeypatch):
        _banco(
            monkeypatch,
            inscricoes=[_inscricao()],
            vendas=[_venda("buy_in", 100.0)],
        )
        corpo = client.get(f"/tournaments/{TOUR}/delete-impact").json()
        assert corpo["entries"] == 1
        assert corpo["entries_amount"] == 100.0
        assert corpo["tournament_name"] == "Main Event"
        assert corpo["blocked"] is True

    def test_delete_impact_de_torneio_inexistente_da_404(self, client, monkeypatch):
        _banco(monkeypatch)
        assert client.get("/tournaments/fantasma/delete-impact").status_code == 404

    def test_apagar_torneio_com_dinheiro_da_409_com_os_numeros(self, client, monkeypatch):
        """409 e não 403: não é falta de permissão, é conflito de estado. O
        corpo leva o impacto para a tela repetir os números na recusa."""
        _banco(
            monkeypatch,
            inscricoes=[_inscricao()],
            vendas=[_venda("buy_in", 100.0)],
        )
        r = client.delete(f"/tournaments/{TOUR}")
        assert r.status_code == 409
        detalhe = r.json()["detail"]
        assert "movimento financeiro" in detalhe["message"]
        assert detalhe["impact"]["entries"] == 1

    def test_apagar_torneio_vazio_pela_api_continua_dando_204(self, client, monkeypatch):
        _banco(monkeypatch)
        assert client.delete(f"/tournaments/{TOUR}").status_code == 204

    def test_apagar_dia_com_dinheiro_da_409(self, client, monkeypatch):
        _banco(
            monkeypatch,
            inscricoes=[_inscricao()],
            vendas=[_venda("buy_in", 100.0)],
        )
        r = client.delete(f"/tournament-days/{DIA}")
        assert r.status_code == 409
        assert r.json()["detail"]["impact"]["entries"] == 1

    def test_delete_impact_do_dia_devolve_os_numeros(self, client, monkeypatch):
        _banco(
            monkeypatch,
            inscricoes=[_inscricao()],
            vendas=[_venda("rebuy", 50.0)],
        )
        corpo = client.get(f"/tournament-days/{DIA}/delete-impact").json()
        assert corpo["day_name"] == "Dia 1"
        assert corpo["entries_amount"] == 50.0
