"""Tests for prize features: reserved pool math, release gate, and 'vaga' type."""
import pytest
from fastapi import HTTPException

from app.services import prize_allocation_service
from app.services.prize_allocation_service import PrizeAllocationService
from app.models.prize_allocation import PrizePayoutRequest

from tests.conftest import FakeSupabase

PLAYER_UUID = "00000000-0000-0000-0000-000000000001"
# O modelo PrizeSummary exige UUID. Os ids curtos que estavam aqui ("t1"/"d1")
# passaram a quebrar a validacao quando o campo foi tipado, e o teste ficou
# vermelho sem ninguem notar.
TOURNAMENT_UUID = "00000000-0000-0000-0000-0000000000a1"
DAY_UUID = "00000000-0000-0000-0000-0000000000b1"
# O PrizeAllocationResponse tipa o id como UUID; um "a1" quebra a validação.
ALLOC_UUID = "00000000-0000-0000-0000-0000000000c1"
ALLOC2_UUID = "00000000-0000-0000-0000-0000000000c2"


def _payout():
    return PrizePayoutRequest(
        player_id=PLAYER_UUID,
        document_type="national_id",
        document_number="123",
        paid_by="Caixa",
    )


class TestReservedPool:
    def test_summary_discounts_reserved(self, monkeypatch):
        tables = {
            "tournaments": [{
                "id": TOURNAMENT_UUID, "guaranteed_prize": 0,
                "reserved_prize_percentage": 10, "reserved_purpose": "ranking",
            }],
            "tournament_days": [{"id": DAY_UUID, "tournament_id": TOURNAMENT_UUID, "rake_percentage": 0, "day_type": "regular"}],
            "tournament_players": [{
                "tournament_day_id": DAY_UUID,
                "total_buy_in_amount": 1000, "total_rebuy_amount": 0, "total_addon_amount": 0,
            }],
            "transactions": [{"tournament_id": TOURNAMENT_UUID, "amount": 1000, "type": "buy_in"}],
            "prize_allocations": [],
        }
        monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(tables))
        s = PrizeAllocationService.get_prize_summary(TOURNAMENT_UUID)
        assert float(s.available_prize_pool) == 1000
        assert float(s.reserved_amount) == 100      # 10% blocked
        assert float(s.payable_pool) == 900
        assert float(s.remaining_balance) == 900    # nothing allocated yet


class TestReleaseGate:
    def test_pay_blocked_when_not_released(self, monkeypatch):
        tables = {"prize_allocations": [{
            "id": "a1", "tournament_id": TOURNAMENT_UUID, "paid": False, "released": False,
            "prize_type": "cash", "prize_amount": 100,
        }]}
        monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(tables))
        arg = _payout()
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.pay_prize(TOURNAMENT_UUID, "a1", arg, user_id=None)
        assert exc.value.status_code == 400
        assert "liberada" in exc.value.detail["message"].lower()

    def test_pay_blocked_for_vaga(self, monkeypatch):
        tables = {"prize_allocations": [{
            "id": "a1", "tournament_id": TOURNAMENT_UUID, "paid": False, "released": True,
            "prize_type": "vaga", "prize_amount": 100,
        }]}
        monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(tables))
        arg = _payout()
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.pay_prize(TOURNAMENT_UUID, "a1", arg, user_id=None)
        assert exc.value.status_code == 400
        assert "vaga" in exc.value.detail["message"].lower()


class TestVagaRelease:
    def test_release_vaga_requires_player(self, monkeypatch):
        tables = {"prize_allocations": [{
            "id": ALLOC_UUID, "tournament_id": TOURNAMENT_UUID, "paid": False, "released": False,
            "prize_type": "vaga", "player_id": None, "generated_ticket_id": None,
            "vaga_target_day_id": DAY_UUID, "vaga_target_tournament_id": TOURNAMENT_UUID,
            "position": 1,
        }]}
        monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(tables))
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.set_released(TOURNAMENT_UUID, ALLOC_UUID, released=True, user_id="u")
        assert exc.value.status_code == 400
        assert "jogador" in exc.value.detail["message"].lower()


class TestAtualizacaoDaFaixa:
    """Edição de uma faixa de prêmio já criada.

    Os campos de data são carimbados PELO SERVIÇO, não pelo cliente: `paid_at`
    quando a faixa vira paga, `released_at` quando vira liberada, e ambos
    voltam a nulo ao desfazer. Deixar o cliente mandar a data permitiria
    registrar um pagamento com hora inventada — e é essa hora que aparece no
    comprovante.
    """

    def _faixa(self, **kw):
        base = {
            "id": ALLOC_UUID, "tournament_id": TOURNAMENT_UUID, "position": 1,
            "prize_amount": 100, "prize_type": "cash", "paid": False,
            "released": False, "visible": True, "player_id": None,
            "created_at": "2026-06-08T00:00:00Z", "updated_at": "2026-06-08T00:00:00Z",
        }
        base.update(kw)
        return base

    def _monta(self, monkeypatch, **kw):
        fake = FakeSupabase({"prize_allocations": [self._faixa(**kw)]})
        monkeypatch.setattr(prize_allocation_service, "supabase", fake)
        return fake

    def _update(self, **kw):
        from app.models.prize_allocation import PrizeAllocationUpdate
        return PrizeAllocationUpdate(**kw)

    def test_faixa_inexistente_da_404(self, monkeypatch):
        self._monta(monkeypatch)
        arg = self._update(prize_amount=10)
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.update_allocation(
                TOURNAMENT_UUID, "00000000-0000-0000-0000-0000000000ff",
                arg)
        assert exc.value.status_code == 404

    def test_corpo_vazio_e_recusado(self, monkeypatch):
        """Sem campo nenhum, a gravação só carimbaria `updated_at` à toa."""
        self._monta(monkeypatch)
        arg = self._update()
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, arg)
        assert exc.value.status_code == 400
        assert "No fields" in exc.value.detail["message"]

    def test_posicao_ja_ocupada_e_recusada(self, monkeypatch):
        """Duas faixas na mesma posição tornariam ambígua a premiação."""
        fake = FakeSupabase({"prize_allocations": [
            self._faixa(), self._faixa(id=ALLOC2_UUID, position=2)]})
        monkeypatch.setattr(prize_allocation_service, "supabase", fake)
        arg = self._update(position=2)
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, arg)
        assert exc.value.status_code == 400
        assert "already has" in exc.value.detail["message"]

    def test_manter_a_propria_posicao_e_permitido(self, monkeypatch):
        """A checagem exclui a própria linha, senão salvar sem mexer na posição
        daria conflito consigo mesmo."""
        self._monta(monkeypatch)
        r = PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(position=1))
        assert r.position == 1

    def test_marcar_como_paga_carimba_a_hora(self, monkeypatch):
        fake = self._monta(monkeypatch)
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(paid=True))
        linha = fake.store["prize_allocations"][0]
        assert linha["paid"] is True
        assert linha["paid_at"]

    def test_desmarcar_pagamento_limpa_a_hora(self, monkeypatch):
        """Uma faixa "não paga" com data de pagamento seria contraditória."""
        fake = self._monta(monkeypatch, paid=True, paid_at="2026-06-08T01:00:00Z")
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(paid=False))
        linha = fake.store["prize_allocations"][0]
        assert linha["paid"] is False
        assert linha["paid_at"] is None

    def test_liberar_carimba_a_hora_da_liberacao(self, monkeypatch):
        fake = self._monta(monkeypatch)
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(released=True))
        linha = fake.store["prize_allocations"][0]
        assert linha["released"] is True
        assert linha["released_at"]

    def test_revogar_liberacao_limpa_hora_e_autor(self, monkeypatch):
        """Sem limpar o autor, o histórico diria que alguém liberou algo que
        não está liberado."""
        fake = self._monta(monkeypatch, released=True,
                           released_at="2026-06-08T01:00:00Z", released_by="u1")
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(released=False))
        linha = fake.store["prize_allocations"][0]
        assert linha["released"] is False
        assert linha["released_at"] is None
        assert linha["released_by"] is None

    def test_esconder_do_publico_nao_apaga_o_valor(self, monkeypatch):
        """É como o clube segura a premiação antes da hora, sem perder o dado."""
        fake = self._monta(monkeypatch)
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(visible=False))
        linha = fake.store["prize_allocations"][0]
        assert linha["visible"] is False
        assert float(linha["prize_amount"]) == 100

    def test_alterar_o_valor_grava_como_numero(self, monkeypatch):
        fake = self._monta(monkeypatch)
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID,
                                                 self._update(prize_amount="250.50"))
        assert fake.store["prize_allocations"][0]["prize_amount"] == 250.50

    def test_toda_alteracao_carimba_updated_at(self, monkeypatch):
        fake = self._monta(monkeypatch)
        PrizeAllocationService.update_allocation(TOURNAMENT_UUID, ALLOC_UUID, self._update(visible=False))
        assert fake.store["prize_allocations"][0]["updated_at"] != "2026-06-08T00:00:00Z"


class TestBulkDaPremiacao:
    """Aplicação em LOTE da estrutura de premiação (o "calcular automaticamente").

    A operação é destrutiva: apaga TODAS as faixas do torneio e recria. Por ser
    atômica, é o único lugar em que faz sentido recusar o conjunto — no ajuste
    manual, faixa a faixa, o operador passa e volta de 100% naturalmente.
    """

    def _tabelas(self, reserved_pct=10, faixas=None):
        return {
            "tournaments": [{
                "id": TOURNAMENT_UUID, "guaranteed_prize": 0,
                "reserved_prize_percentage": reserved_pct, "reserved_purpose": "ranking",
            }],
            "tournament_days": [{
                "id": DAY_UUID, "tournament_id": TOURNAMENT_UUID, "day_type": "regular",
            }],
            # 1000 de entradas sem rake → pool bruto 1000, pagável 900 com 10%.
            "transactions": [{"tournament_id": TOURNAMENT_UUID, "amount": 1000, "type": "buy_in"}],
            "prize_allocations": faixas or [],
        }

    def _monta(self, monkeypatch, **kw):
        fake = FakeSupabase(self._tabelas(**kw))
        monkeypatch.setattr(prize_allocation_service, "supabase", fake)
        return fake

    def _lote(self, *valores):
        from app.models.prize_allocation import PrizeAllocationCreate
        return [
            PrizeAllocationCreate(position=i + 1, prize_amount=v)
            for i, v in enumerate(valores)
        ]

    def test_soma_acima_do_pool_pagavel_e_recusada(self, monkeypatch):
        fake = self._monta(monkeypatch)
        lote = self._lote(700, 400)   # preparo fora do raises: só o serviço sob teste dentro
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.bulk_create_allocations(TOURNAMENT_UUID, lote)
        assert exc.value.status_code == 400
        # A mensagem precisa dizer quanto cabe; só "recusado" não ajuda o caixa.
        assert "900.00" in exc.value.detail["message"]
        assert "1100.00" in exc.value.detail["message"]
        # E nada pode ter sido apagado antes da recusa.
        assert fake.store["prize_allocations"] == []

    def test_o_limite_e_o_pool_PAGAVEL_nao_o_bruto(self, monkeypatch):
        """950 cabe no pool bruto (1000) mas não no pagável (900).

        A premiação reservada é dinheiro que o clube já prometeu ao ranking/
        staff; distribuí-la nas posições faria o pagamento travar na última.
        """
        self._monta(monkeypatch)
        lote = self._lote(950)   # preparo fora do raises: só o serviço sob teste dentro
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.bulk_create_allocations(TOURNAMENT_UUID, lote)
        assert exc.value.status_code == 400
        assert "pagável" in exc.value.detail["message"]

    def test_soma_exata_do_pool_e_aceita(self, monkeypatch):
        fake = self._monta(monkeypatch)
        r = PrizeAllocationService.bulk_create_allocations(TOURNAMENT_UUID, self._lote(600, 300))
        assert len(r) == 2
        assert len(fake.store["prize_allocations"]) == 2

    def test_centavos_de_arredondamento_nao_derrubam(self, monkeypatch):
        """900.01 é a mesma premiação de 900 — só o arredondamento por posição."""
        self._monta(monkeypatch)
        r = PrizeAllocationService.bulk_create_allocations(TOURNAMENT_UUID, self._lote("900.01"))
        assert len(r) == 1

    def test_soma_abaixo_do_pool_e_aceita(self, monkeypatch):
        """Fechar 100% não é obrigatório: o clube pode pagar menos posições."""
        self._monta(monkeypatch)
        r = PrizeAllocationService.bulk_create_allocations(TOURNAMENT_UUID, self._lote(500, 100))
        assert len(r) == 2

    def test_torneio_sem_reserva_usa_o_pool_inteiro(self, monkeypatch):
        self._monta(monkeypatch, reserved_pct=0)
        r = PrizeAllocationService.bulk_create_allocations(TOURNAMENT_UUID, self._lote(1000))
        assert len(r) == 1

    def test_faixa_JA_PAGA_impede_o_recalculo(self, monkeypatch):
        """O bulk apagaria o registro do prêmio pago e o caixa não fecharia mais."""
        fake = self._monta(monkeypatch, faixas=[{
            "id": ALLOC_UUID, "tournament_id": TOURNAMENT_UUID, "position": 2,
            "prize_amount": 100, "paid": True,
        }])
        lote = self._lote(500)   # preparo fora do raises: só o serviço sob teste dentro
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.bulk_create_allocations(TOURNAMENT_UUID, lote)
        assert exc.value.status_code == 400
        assert "2º" in exc.value.detail["message"]
        assert len(fake.store["prize_allocations"]) == 1

    def test_faixa_paga_sem_posicao_ainda_recusa_com_400(self, monkeypatch):
        """Faixa paga com `position` nula (importação antiga, linha corrompida).

        Ordenar None junto com int estourava TypeError e o operador recebia um
        500 sem explicação — ele reclicava achando que foi instabilidade, em vez
        de ler que existe prêmio já pago e ajustar as faixas uma a uma.
        """
        fake = self._monta(monkeypatch, faixas=[
            {"id": ALLOC_UUID, "tournament_id": TOURNAMENT_UUID, "position": None,
             "prize_amount": 100, "paid": True},
            {"id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
             "tournament_id": TOURNAMENT_UUID, "position": 2,
             "prize_amount": 100, "paid": True},
        ])
        lote = self._lote(500)   # preparo fora do raises: só o serviço sob teste dentro
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.bulk_create_allocations(TOURNAMENT_UUID, lote)
        assert exc.value.status_code == 400
        assert "2º" in exc.value.detail["message"]
        # E nada foi apagado: as duas faixas pagas continuam lá.
        assert len(fake.store["prize_allocations"]) == 2

    def test_unica_faixa_paga_sem_posicao_continua_travando_o_lote(self, monkeypatch):
        """Só a posição some da mensagem; a trava não pode sumir junto, senão o
        bulk apaga o registro do prêmio que já saiu do caixa geral."""
        fake = self._monta(monkeypatch, faixas=[{
            "id": ALLOC_UUID, "tournament_id": TOURNAMENT_UUID, "position": None,
            "prize_amount": 100, "paid": True,
        }])
        lote = self._lote(500)   # preparo fora do raises: só o serviço sob teste dentro
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.bulk_create_allocations(TOURNAMENT_UUID, lote)
        assert exc.value.status_code == 400
        assert len(fake.store["prize_allocations"]) == 1

    def test_faixa_nao_paga_nao_impede(self, monkeypatch):
        fake = self._monta(monkeypatch, faixas=[{
            "id": ALLOC_UUID, "tournament_id": TOURNAMENT_UUID, "position": 2,
            "prize_amount": 100, "paid": False,
        }])
        PrizeAllocationService.bulk_create_allocations(TOURNAMENT_UUID, self._lote(500, 300))
        posicoes = sorted(r["position"] for r in fake.store["prize_allocations"])
        assert posicoes == [1, 2]   # a antiga foi substituída, não somada

    def test_lote_vazio_apenas_limpa(self, monkeypatch):
        fake = self._monta(monkeypatch, faixas=[{
            "id": ALLOC_UUID, "tournament_id": TOURNAMENT_UUID, "position": 1,
            "prize_amount": 100, "paid": False,
        }])
        assert PrizeAllocationService.bulk_create_allocations(TOURNAMENT_UUID, []) == []
        assert fake.store["prize_allocations"] == []


class TestRevogacaoDeLiberacao:
    def test_nao_da_para_revogar_liberacao_de_premio_JA_PAGO(self, monkeypatch):
        """O dinheiro já saiu; revogar deixaria o registro dizendo que o
        pagamento nunca foi autorizado."""
        tables = {"prize_allocations": [{
            "id": ALLOC_UUID, "tournament_id": TOURNAMENT_UUID, "paid": True,
            "released": True, "prize_type": "cash", "prize_amount": 100,
        }]}
        monkeypatch.setattr(prize_allocation_service, "supabase", FakeSupabase(tables))
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.set_released(TOURNAMENT_UUID, ALLOC_UUID, released=False)
        assert exc.value.status_code == 400
        assert "já pago" in exc.value.detail["message"].lower()

    def test_faixa_inexistente_da_404(self, monkeypatch):
        monkeypatch.setattr(prize_allocation_service, "supabase",
                            FakeSupabase({"prize_allocations": []}))
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.set_released(TOURNAMENT_UUID, ALLOC_UUID, released=True)
        assert exc.value.status_code == 404


class TestFaixaDePremiacao:
    """Faixa de colocações (ex.: 7–9) com o mesmo prêmio: uma linha por
    posição, numa inserção só. O pagamento continua por jogador; o telão
    agrupa de volta ("7º–9º Lugar")."""

    def _monta(self, monkeypatch, faixas=None):
        fake = FakeSupabase({
            "tournaments": [{"id": TOURNAMENT_UUID, "guaranteed_prize": 0}],
            "tournament_days": [{"id": DAY_UUID, "tournament_id": TOURNAMENT_UUID, "buy_in": 250}],
            "prize_allocations": faixas or [],
        })
        monkeypatch.setattr(prize_allocation_service, "supabase", fake)
        return fake

    def _faixa(self, **kw):
        from app.models.prize_allocation import PrizeRangeCreate
        base = {"position": 7, "position_end": 9, "prize_amount": 400}
        base.update(kw)
        return PrizeRangeCreate(**base)

    def test_cria_uma_linha_por_posicao_com_o_mesmo_valor(self, monkeypatch):
        fake = self._monta(monkeypatch)
        criadas = PrizeAllocationService.create_range(TOURNAMENT_UUID, self._faixa())
        assert [c.position for c in criadas] == [7, 8, 9]
        assert {float(c.prize_amount) for c in criadas} == {400.0}
        assert {c.prize_type for c in criadas} == {"cash"}
        assert len(fake.store["prize_allocations"]) == 3

    def test_posicao_unica_tambem_passa_pela_faixa(self, monkeypatch):
        self._monta(monkeypatch)
        criadas = PrizeAllocationService.create_range(
            TOURNAMENT_UUID, self._faixa(position=4, position_end=4))
        assert [c.position for c in criadas] == [4]

    def test_posicao_ja_ocupada_recusa_a_faixa_inteira_e_diz_quais(self, monkeypatch):
        fake = self._monta(monkeypatch, faixas=[
            {"id": ALLOC_UUID, "tournament_id": TOURNAMENT_UUID, "position": 8,
             "prize_amount": 100, "prize_type": "cash", "paid": False},
        ])
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.create_range(TOURNAMENT_UUID, self._faixa())
        assert exc.value.status_code == 400
        assert exc.value.detail["code"] == "posicao_de_premio_duplicada"
        assert exc.value.detail["posicoes"] == [8]
        assert exc.value.detail["position"] == 8
        assert len(fake.store["prize_allocations"]) == 1   # nada entrou

    def test_faixa_de_vagas_usa_o_buy_in_do_dia_alvo_em_cada_posicao(self, monkeypatch):
        self._monta(monkeypatch)
        criadas = PrizeAllocationService.create_range(TOURNAMENT_UUID, self._faixa(
            position=10, position_end=12, prize_type="vaga", vaga_target_day_id=DAY_UUID))
        assert [c.position for c in criadas] == [10, 11, 12]
        assert {float(c.prize_amount) for c in criadas} == {250.0}
        assert {str(c.vaga_target_day_id) for c in criadas} == {DAY_UUID}

    def test_torneio_inexistente_da_404(self, monkeypatch):
        fake = self._monta(monkeypatch)
        fake.store["tournaments"] = []
        with pytest.raises(HTTPException) as exc:
            PrizeAllocationService.create_range(TOURNAMENT_UUID, self._faixa())
        assert exc.value.status_code == 404

    def test_faixa_invertida_ou_gigante_nao_passa_no_modelo(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            self._faixa(position=9, position_end=7)
        with pytest.raises(ValidationError):
            self._faixa(position=1, position_end=500)
