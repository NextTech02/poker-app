"""Testes de crédito de patrocinador e de ticket de satélite.

Complementa `test_credits_tickets.py` (consumo e resgate) com a criação, o
acerto com o patrocinador e o extrato do jogador.

O crédito de patrocinador tem três valores que precisam fechar entre si:

    original = restante + usado
    usado    = descontado_da_premiacao + o_que_o_patrocinador_deve

Se `sponsor_owes` sair de sincronia, o clube cobra do patrocinador um
dinheiro que já saiu do prêmio do jogador — ou deixa de cobrar. Por isso
quase todo teste aqui confere a linha do razão (`credit_transactions`)
junto com o saldo: o razão é o que explica cada centavo depois.

No ticket, o risco é o mesmo do crédito: entrar duas vezes de graça. E há
uma camada extra de tolerância a banco não migrado (`won_at`/`funded_by`
guardados dentro de `notes`), que precisa continuar devolvendo os campos
certos nas duas situações.
"""
import pytest
from pydantic import ValidationError

from app.models.player_credit import PlayerCreditCreate, CreditSettlementRequest
from app.models.satellite_ticket import TicketBulkCreate, TicketCreate, TicketTransfer
from app.models.tournament_player import TournamentPlayerDetail
from app.services import player_credit_service as credmod
from app.services import satellite_ticket_service as tickmod
from app.services.player_credit_service import PlayerCreditService as C
from app.services.satellite_ticket_service import SatelliteTicketService as T

from tests.conftest import FakeSupabase


JOGADOR = "44444444-4444-4444-4444-444444444444"
PATRO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"
ETAPA = "11111111-1111-1111-1111-111111111111"
TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777777"
AUTOR = "88888888-8888-8888-8888-888888888888"


def _credito(id_="c1", original=500.0, restante=500.0, usado=0.0,
             descontado=0.0, deve=0.0, status="active", criado="2026-06-08T00:00:00Z"):
    return {"id": id_, "player_id": JOGADOR, "sponsor_id": PATRO, "stage_id": ETAPA,
            "original_amount": original, "remaining_amount": restante,
            "used_amount": usado, "prize_deduction_amount": descontado,
            "sponsor_owes": deve, "status": status, "notes": None,
            "created_at": criado,
            "players": {"name": "Fulano", "nickname": "fu"},
            "sponsors": {"name": "Casa de Apostas"}}


def _monta_credito(monkeypatch, creditos=None, **tabelas):
    base = {
        "player_credits": creditos if creditos is not None else [_credito()],
        "credit_transactions": [],
        "players": [{"id": JOGADOR, "name": "Fulano", "nickname": "fu"}],
        "sponsors": [{"id": PATRO, "name": "Casa de Apostas"}],
        "tournaments": [{"id": TOUR, "name": "Torneio"}],
        "transactions": [],
        "tournament_days": [{"id": DIA, "tournament_id": TOUR, "day_name": "Dia 1",
                             "buy_in": 300}],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    monkeypatch.setattr(credmod, "supabase", fake)
    return fake


class TestConcessaoDeCredito:
    def test_credito_nasce_inteiro_e_com_lancamento_no_razao(self, monkeypatch):
        """Sem a linha no razão, o crédito aparece do nada no extrato do
        jogador e ninguém consegue reconstruir de onde veio."""
        fake = _monta_credito(monkeypatch, creditos=[])
        r = C.grant_credit(PlayerCreditCreate(
            player_id=JOGADOR, sponsor_id=PATRO, stage_id=ETAPA,
            amount=500, notes="acordo da etapa"), AUTOR)
        assert r.remaining_amount == 500
        assert r.used_amount == 0
        assert r.status == "active"
        razao = fake.store["credit_transactions"]
        assert len(razao) == 1
        assert razao[0]["type"] == "credit_granted"
        assert float(razao[0]["balance_after"]) == 500

    def test_traz_os_nomes_para_a_tela(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[])
        r = C.grant_credit(PlayerCreditCreate(
            player_id=JOGADOR, sponsor_id=PATRO, amount=100), AUTOR)
        assert r.player_name == "Fulano"
        assert r.sponsor_name == "Casa de Apostas"

    def test_jogador_inexistente(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[], players=[])
        arg = PlayerCreditCreate(
                player_id=JOGADOR, sponsor_id=PATRO, amount=100)
        with pytest.raises(ValueError, match="Jogador não encontrado"):
            C.grant_credit(arg, AUTOR)

    def test_patrocinador_inexistente(self, monkeypatch):
        """Crédito sem patrocinador não tem de quem cobrar depois."""
        _monta_credito(monkeypatch, creditos=[], sponsors=[])
        arg = PlayerCreditCreate(
                player_id=JOGADOR, sponsor_id=PATRO, amount=100)
        with pytest.raises(ValueError, match="Patrocinador não encontrado"):
            C.grant_credit(arg, AUTOR)


class TestConsultaDeCreditos:
    def test_lista_do_jogador(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[_credito("c1"), _credito("c2")])
        assert len(C.get_player_credits(JOGADOR)) == 2

    def test_filtra_por_status(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[
            _credito("c1"), _credito("c2", status="cancelled")])
        assert len(C.get_player_credits(JOGADOR, status="active")) == 1

    def test_busca_um(self, monkeypatch):
        _monta_credito(monkeypatch)
        assert C.get_credit("c1").id == "c1"

    def test_inexistente(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[])
        assert C.get_credit("c1") is None

    def test_visao_de_admin_filtra_por_patrocinador(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[
            _credito("c1"), dict(_credito("c2"), sponsor_id="outro")])
        assert len(C.get_all_credits(sponsor_id=PATRO)) == 1

    def test_visao_de_admin_filtra_por_status(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[
            _credito("c1"), _credito("c2", status="fully_used")])
        assert len(C.get_all_credits(status="fully_used")) == 1

    def test_razao_de_um_credito(self, monkeypatch):
        _monta_credito(monkeypatch, credit_transactions=[
            {"id": "t1", "credit_id": "c1", "player_id": JOGADOR,
             "tournament_id": TOUR, "type": "credit_used_buyin", "amount": 100,
             "balance_after": 400, "created_at": "2026-06-08T12:00:00Z"},
        ])
        r = C.get_credit_transactions("c1")
        assert len(r) == 1
        assert r[0].tournament_name == "Torneio"
        assert r[0].sponsor_name == "Casa de Apostas"

    def test_razao_vazio(self, monkeypatch):
        _monta_credito(monkeypatch)
        assert C.get_credit_transactions("c1") == []

    def test_razao_sem_torneio_nao_consulta_nomes(self, monkeypatch):
        _monta_credito(monkeypatch, credit_transactions=[
            {"id": "t1", "credit_id": "c1", "player_id": JOGADOR,
             "tournament_id": None, "type": "credit_granted", "amount": 500,
             "balance_after": 500, "created_at": "2026-06-08T00:00:00Z"},
        ])
        assert C.get_credit_transactions("c1")[0].tournament_name is None


class TestConsumoFIFO:
    """O crédito mais antigo sai primeiro. Sem ordem definida, o acerto com o
    patrocinador ficaria imprevisível: dois patrocinadores diferentes seriam
    debitados em ordem aleatória."""

    def test_consome_o_mais_antigo_primeiro(self, monkeypatch):
        fake = _monta_credito(monkeypatch, creditos=[
            _credito("novo", restante=500, criado="2026-06-10T00:00:00Z"),
            _credito("velho", restante=500, criado="2026-06-01T00:00:00Z"),
        ])
        C.use_credit(JOGADOR, 200, TOUR, DIA, "buy_in", AUTOR)
        por_id = {c["id"]: float(c["remaining_amount"]) for c in fake.store["player_credits"]}
        assert por_id == {"velho": 300.0, "novo": 500.0}

    def test_atravessa_mais_de_um_credito_quando_precisa(self, monkeypatch):
        fake = _monta_credito(monkeypatch, creditos=[
            _credito("c1", original=100, restante=100, criado="2026-06-01T00:00:00Z"),
            _credito("c2", original=500, restante=500, criado="2026-06-02T00:00:00Z"),
        ])
        r = C.use_credit(JOGADOR, 300, TOUR, DIA, "rebuy", AUTOR)
        assert r["credit_used"] == 300
        por_id = {c["id"]: float(c["remaining_amount"]) for c in fake.store["player_credits"]}
        assert por_id == {"c1": 0.0, "c2": 300.0}
        assert len(fake.store["credit_transactions"]) == 2

    @pytest.mark.parametrize("entrada,tipo", [
        ("buy_in", "credit_used_buyin"),
        ("rebuy", "credit_used_rebuy"),
        ("addon", "credit_used_addon"),
    ])
    def test_o_razao_diz_para_que_o_credito_foi_usado(self, monkeypatch, entrada, tipo):
        fake = _monta_credito(monkeypatch)
        C.use_credit(JOGADOR, 50, TOUR, DIA, entrada, AUTOR)
        assert fake.store["credit_transactions"][0]["type"] == tipo

    def test_tipo_desconhecido_cai_em_buy_in(self, monkeypatch):
        fake = _monta_credito(monkeypatch)
        C.use_credit(JOGADOR, 50, TOUR, DIA, "seja-la-o-que-for", AUTOR)
        assert fake.store["credit_transactions"][0]["type"] == "credit_used_buyin"

    def test_o_que_o_patrocinador_deve_cresce_com_o_uso(self, monkeypatch):
        """`sponsor_owes = usado − descontado_da_premiacao`. É o valor que o
        clube vai cobrar do patrocinador no fim da etapa."""
        fake = _monta_credito(monkeypatch)
        C.use_credit(JOGADOR, 200, TOUR, DIA, "buy_in", AUTOR)
        assert float(fake.store["player_credits"][0]["sponsor_owes"]) == 200.0

    def test_credito_ja_descontado_da_premiacao_nao_e_cobrado_de_novo(self, monkeypatch):
        """Se 80 já saíram do prêmio, usar mais 100 deixa o patrocinador
        devendo 20 — não 100."""
        fake = _monta_credito(monkeypatch, creditos=[
            _credito(restante=100, usado=80, descontado=80)])
        C.use_credit(JOGADOR, 100, TOUR, DIA, "buy_in", AUTOR)
        assert float(fake.store["player_credits"][0]["sponsor_owes"]) == 100.0
        assert float(fake.store["player_credits"][0]["used_amount"]) == 180.0

    def test_o_dia_fica_registrado_no_razao(self, monkeypatch):
        fake = _monta_credito(monkeypatch)
        C.use_credit(JOGADOR, 50, TOUR, DIA, "buy_in", AUTOR)
        assert fake.store["credit_transactions"][0]["tournament_day_id"] == DIA

    def test_saldo_disponivel_ignora_credito_cancelado(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[
            _credito("c1", restante=200),
            _credito("c2", restante=300, status="cancelled")])
        assert C.get_player_available_credit(JOGADOR) == 200.0


class TestDescontoNaPremiacao:
    """Quem jogou com crédito paga de volta com o próprio prêmio, antes de
    receber. É o que evita o patrocinador financiar e o jogador embolsar."""

    def test_desconta_o_que_foi_usado(self, monkeypatch):
        fake = _monta_credito(monkeypatch, creditos=[
            _credito(original=500, restante=0, usado=500, deve=500, status="fully_used")])
        r = C.deduct_from_prize(JOGADOR, 1200, TOUR, AUTOR)
        assert r == {"original_prize": 1200, "deducted_amount": 500,
                     "net_prize_payout": 700}
        linha = fake.store["player_credits"][0]
        assert float(linha["prize_deduction_amount"]) == 500.0
        assert float(linha["sponsor_owes"]) == 0.0

    def test_premio_menor_que_a_divida_desconta_so_o_que_da(self, monkeypatch):
        """O resto continua sendo do patrocinador — não vira dívida do
        jogador."""
        fake = _monta_credito(monkeypatch, creditos=[
            _credito(original=500, restante=0, usado=500, deve=500, status="fully_used")])
        r = C.deduct_from_prize(JOGADOR, 200, TOUR, AUTOR)
        assert r["deducted_amount"] == 200
        assert float(fake.store["player_credits"][0]["sponsor_owes"]) == 300.0

    def test_credito_quitado_pelo_premio_muda_de_status(self, monkeypatch):
        fake = _monta_credito(monkeypatch, creditos=[
            _credito(original=500, restante=0, usado=500, deve=500, status="fully_used")])
        C.deduct_from_prize(JOGADOR, 1000, TOUR, AUTOR)
        assert fake.store["player_credits"][0]["status"] == "settled_by_prize"

    def test_credito_com_saldo_sobrando_nao_e_quitado(self, monkeypatch):
        """Ainda há crédito para usar; encerrar agora tiraria do jogador um
        benefício que o patrocinador já pagou."""
        fake = _monta_credito(monkeypatch, creditos=[
            _credito(original=500, restante=300, usado=200, deve=200)])
        C.deduct_from_prize(JOGADOR, 1000, TOUR, AUTOR)
        assert fake.store["player_credits"][0]["status"] == "active"

    def test_atravessa_varios_creditos_do_mais_antigo_ao_mais_novo(self, monkeypatch):
        fake = _monta_credito(monkeypatch, creditos=[
            _credito("c1", original=100, restante=0, usado=100, deve=100,
                     status="fully_used", criado="2026-06-01T00:00:00Z"),
            _credito("c2", original=100, restante=0, usado=100, deve=100,
                     status="fully_used", criado="2026-06-02T00:00:00Z"),
        ])
        r = C.deduct_from_prize(JOGADOR, 150, TOUR, AUTOR)
        assert r["deducted_amount"] == 150
        por_id = {c["id"]: float(c["prize_deduction_amount"])
                  for c in fake.store["player_credits"]}
        assert por_id == {"c1": 100.0, "c2": 50.0}

    def test_sem_credito_usado_o_premio_sai_inteiro(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[])
        r = C.deduct_from_prize(JOGADOR, 800, TOUR, AUTOR)
        assert r["net_prize_payout"] == 800
        assert r["deducted_amount"] == 0

    def test_credito_ja_totalmente_descontado_e_pulado(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[
            _credito(original=500, restante=0, usado=500, descontado=500,
                     status="settled_by_prize")])
        assert C.deduct_from_prize(JOGADOR, 900, TOUR, AUTOR)["deducted_amount"] == 0

    def test_registra_cada_desconto_no_razao(self, monkeypatch):
        fake = _monta_credito(monkeypatch, creditos=[
            _credito(original=500, restante=0, usado=500, deve=500, status="fully_used")])
        C.deduct_from_prize(JOGADOR, 1000, TOUR, AUTOR)
        assert fake.store["credit_transactions"][0]["type"] == "prize_deduction"


class TestAcertoECancelamento:
    def test_patrocinador_paga_o_que_devia(self, monkeypatch):
        fake = _monta_credito(monkeypatch, creditos=[
            _credito(original=500, restante=0, usado=500, deve=500, status="fully_used")])
        r = C.settle_sponsor_payment("c1", CreditSettlementRequest(
            amount=500, notes="pix recebido"), AUTOR)
        assert r.status == "settled_by_sponsor"
        assert float(fake.store["player_credits"][0]["sponsor_owes"]) == 0.0
        assert fake.store["credit_transactions"][0]["type"] == "sponsor_payment"

    def test_pagamento_parcial_nao_deixa_saldo_negativo(self, monkeypatch):
        fake = _monta_credito(monkeypatch, creditos=[
            _credito(original=500, restante=0, usado=500, deve=100, status="fully_used")])
        C.settle_sponsor_payment("c1", CreditSettlementRequest(amount=300), AUTOR)
        assert float(fake.store["player_credits"][0]["sponsor_owes"]) == 0.0

    def test_acerto_de_credito_inexistente(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[])
        arg = CreditSettlementRequest(amount=1)
        with pytest.raises(ValueError, match="não encontrado"):
            C.settle_sponsor_payment("c1", arg, AUTOR)

    def test_cancela_credito_intocado(self, monkeypatch):
        fake = _monta_credito(monkeypatch)
        r = C.cancel_credit("c1", AUTOR)
        assert r.status == "cancelled"
        assert float(fake.store["player_credits"][0]["remaining_amount"]) == 0.0
        assert fake.store["credit_transactions"][0]["type"] == "credit_cancelled"

    def test_credito_ja_usado_nao_pode_ser_cancelado(self, monkeypatch):
        """Cancelar apagaria a dívida do patrocinador por um buy-in que já
        aconteceu e já entrou no caixa."""
        _monta_credito(monkeypatch, creditos=[_credito(restante=400, usado=100)])
        with pytest.raises(ValueError, match="já utilizado"):
            C.cancel_credit("c1", AUTOR)

    def test_cancelar_inexistente(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[])
        with pytest.raises(ValueError, match="não encontrado"):
            C.cancel_credit("c1", AUTOR)


class TestExtratoDoJogador:
    def _movimentos(self):
        return [
            {"id": "tx1", "player_id": JOGADOR, "tournament_id": TOUR,
             "type": "buy_in", "amount": 300, "payment_source": "cash",
             "notes": None, "created_at": "2026-06-08T10:00:00Z",
             "tournaments": {"name": "Torneio"}},
            {"id": "tx2", "player_id": JOGADOR, "tournament_id": TOUR,
             "type": "prize", "amount": 1200, "payment_source": "cash",
             "notes": None, "created_at": "2026-06-08T22:00:00Z",
             "tournaments": {"name": "Torneio"}},
        ]

    def _razao(self):
        return [
            {"id": "ct1", "credit_id": "c1", "player_id": JOGADOR,
             "tournament_id": TOUR, "tournament_day_id": DIA,
             "type": "credit_used_buyin", "amount": 100, "balance_after": 400,
             "notes": None, "created_at": "2026-06-08T11:00:00Z",
             "player_credits": {"sponsors": {"name": "Casa de Apostas"}},
             "tournaments": {"name": "Torneio"},
             "tournament_days": {"day_name": "Dia 1"}},
        ]

    def test_junta_dinheiro_e_credito_numa_linha_do_tempo_so(self, monkeypatch):
        """O jogador não distingue "transação" de "crédito": ele quer ver o
        que entrou e o que saiu, em ordem."""
        _monta_credito(monkeypatch, transactions=self._movimentos(),
                       credit_transactions=self._razao())
        r = C.get_player_statement(JOGADOR)
        assert len(r) == 3
        assert [e.date for e in r] == sorted([e.date for e in r], reverse=True)

    def test_filtra_so_o_dinheiro(self, monkeypatch):
        _monta_credito(monkeypatch, transactions=self._movimentos(),
                       credit_transactions=self._razao())
        r = C.get_player_statement(JOGADOR, category="transaction")
        assert {e.category for e in r} == {"transaction"}

    def test_filtra_so_o_credito(self, monkeypatch):
        _monta_credito(monkeypatch, transactions=self._movimentos(),
                       credit_transactions=self._razao())
        r = C.get_player_statement(JOGADOR, category="credit")
        assert {e.category for e in r} == {"credit"}
        assert r[0].sponsor_name == "Casa de Apostas"
        assert r[0].tournament_day_name == "Dia 1"

    def test_filtra_por_tipo_de_movimento(self, monkeypatch):
        _monta_credito(monkeypatch, transactions=self._movimentos(),
                       credit_transactions=[])
        r = C.get_player_statement(JOGADOR, type_filter="prize")
        assert [e.type for e in r] == ["prize"]

    def test_filtra_por_tipo_de_credito(self, monkeypatch):
        _monta_credito(monkeypatch, transactions=[],
                       credit_transactions=self._razao())
        assert len(C.get_player_statement(JOGADOR, type_filter="credit_used_buyin")) == 1

    def test_filtra_por_torneio(self, monkeypatch):
        _monta_credito(monkeypatch, transactions=self._movimentos(),
                       credit_transactions=self._razao())
        assert len(C.get_player_statement(JOGADOR, tournament_id=TOUR)) == 3

    def test_filtra_por_periodo(self, monkeypatch):
        _monta_credito(monkeypatch, transactions=self._movimentos(),
                       credit_transactions=[])
        r = C.get_player_statement(JOGADOR, date_from="2026-06-08T20:00:00Z",
                                   date_to="2026-06-09T00:00:00Z")
        assert [e.id for e in r] == ["tx2"]

    def test_jogador_sem_movimento(self, monkeypatch):
        _monta_credito(monkeypatch, transactions=[], credit_transactions=[])
        assert C.get_player_statement(JOGADOR) == []

    def test_resumo_de_saldo(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[
            _credito("c1", original=500, restante=200, usado=300,
                     descontado=100, deve=200),
            _credito("c2", original=100, restante=100),
        ])
        r = C.get_player_balance_summary(JOGADOR)
        assert r.player_name == "Fulano"
        assert r.total_credits_received == 600.0
        assert r.total_credits_used == 300.0
        assert r.total_credits_remaining == 300.0
        assert r.total_prize_deductions == 100.0
        assert r.total_sponsor_owes == 200.0

    def test_resumo_ignora_credito_cancelado(self, monkeypatch):
        """Crédito cancelado nunca existiu para efeito de conta."""
        _monta_credito(monkeypatch, creditos=[
            _credito("c1", original=500),
            _credito("c2", original=900, status="cancelled")])
        assert C.get_player_balance_summary(JOGADOR).total_credits_received == 500.0

    def test_jogador_inexistente_no_resumo(self, monkeypatch):
        _monta_credito(monkeypatch, creditos=[], players=[])
        assert C.get_player_balance_summary(JOGADOR).player_name is None


# ---------------------------------------------------------------------------
# Tickets de satélite
# ---------------------------------------------------------------------------

def _ticket(id_="t1", status="awarded", player=JOGADOR, dia=DIA,
            financiado="Casa de Apostas", notas=None):
    return {"id": id_, "player_id": player, "target_tournament_id": TOUR,
            "target_tournament_day_id": dia, "status": status,
            "ticket_value": 300.0, "stage_id": ETAPA, "satellite_name": "Satélite",
            "won_at": "2026-06-01", "funded_by": financiado, "notes": notas,
            "created_at": "2026-06-08T00:00:00Z",
            "players": {"name": "Fulano", "nickname": "fu"}}


def _monta_ticket(monkeypatch, tickets=None, **tabelas):
    base = {
        "satellite_tickets": tickets if tickets is not None else [_ticket()],
        "players": [{"id": JOGADOR, "name": "Fulano", "nickname": "fu"}],
        "tournaments": [{"id": TOUR, "name": "Torneio"}],
        "tournament_days": [{"id": DIA, "tournament_id": TOUR, "buy_in": 300,
                             "day_name": "Dia Final"}],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    monkeypatch.setattr(tickmod, "supabase", fake)
    return fake


def _corpo_ticket(**kw):
    base = {"player_id": JOGADOR, "target_tournament_id": TOUR,
            "target_tournament_day_id": DIA, "won_at": "2026-06-01",
            "funded_by": "Casa de Apostas", "stage_id": ETAPA}
    base.update(kw)
    return TicketCreate(**base)


class TestCriacaoDeTicket:
    def test_o_valor_vem_do_buy_in_do_DIA(self, monkeypatch):
        """Digitar o valor à mão deixaria o ticket valendo diferente da
        inscrição que ele paga."""
        _monta_ticket(monkeypatch, tickets=[])
        assert T.create_ticket(_corpo_ticket(), AUTOR).ticket_value == 300.0

    def test_monta_um_rotulo_com_torneio_e_dia(self, monkeypatch):
        fake = _monta_ticket(monkeypatch, tickets=[])
        T.create_ticket(_corpo_ticket(), AUTOR)
        assert fake.store["satellite_tickets"][0]["satellite_name"] == "Torneio — Dia Final"

    def test_torneio_alvo_inexistente(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[], tournaments=[])
        arg = _corpo_ticket()
        with pytest.raises(ValueError, match="Torneio alvo"):
            T.create_ticket(arg, AUTOR)

    def test_dia_alvo_inexistente(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[], tournament_days=[])
        arg = _corpo_ticket()
        with pytest.raises(ValueError, match="Dia do torneio"):
            T.create_ticket(arg, AUTOR)

    def test_dia_de_outro_torneio_e_recusado(self, monkeypatch):
        """O ticket daria entrada num torneio que não é o que ele diz pagar."""
        _monta_ticket(monkeypatch, tickets=[], tournament_days=[
            {"id": DIA, "tournament_id": "outro-torneio", "buy_in": 300,
             "day_name": "Dia Final"}])
        arg = _corpo_ticket()
        with pytest.raises(ValueError, match="não pertence ao torneio alvo"):
            T.create_ticket(arg, AUTOR)

    def test_jogador_inexistente(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[], players=[])
        arg = _corpo_ticket()
        with pytest.raises(ValueError, match="Jogador não encontrado"):
            T.create_ticket(arg, AUTOR)

    def test_banco_sem_as_colunas_novas_guarda_tudo_em_notas(self, monkeypatch):
        """Cliente que ainda não rodou a migração: em vez de falhar, o dado de
        auditoria vai para `notes` e volta nos campos certos na leitura."""
        fake = _monta_ticket(monkeypatch, tickets=[])
        original = fake.table
        tentativas = {"n": 0}

        def _table(nome):
            if nome == "satellite_tickets":
                tentativas["n"] += 1
                if tentativas["n"] == 1:
                    raise Exception('column "funded_by" does not exist')
            return original(nome)

        monkeypatch.setattr(fake, "table", _table)
        r = T.create_ticket(_corpo_ticket(), AUTOR)
        assert r.funded_by == "Casa de Apostas"
        assert "Financiado por" in fake.store["satellite_tickets"][0]["notes"]

    def test_erro_que_nao_e_de_coluna_sobe(self, monkeypatch):
        fake = _monta_ticket(monkeypatch, tickets=[])
        original = fake.table

        def _table(nome):
            if nome == "satellite_tickets":
                raise Exception("connection reset")
            return original(nome)

        monkeypatch.setattr(fake, "table", _table)
        arg = _corpo_ticket()
        with pytest.raises(Exception, match="connection reset"):
            T.create_ticket(arg, AUTOR)


class TestEmissaoEmLote:
    """Fechamento de satélite: todos os classificados recebem a vaga do mesmo
    dia de uma vez. Cada linha é uma entrada JÁ PAGA que entra no pool do
    torneio-destino — errar o lote é errar dinheiro vezes o número de
    jogadores."""

    def _corpo(self, **kw):
        base = {"player_ids": [JOGADOR], "target_tournament_id": TOUR,
                "target_tournament_day_id": DIA, "won_at": "Satélite de quarta",
                "funded_by": "Casa de Apostas"}
        base.update(kw)
        return TicketBulkCreate(**base)

    def _tres_jogadores(self):
        return [{"id": "p1", "name": "Ana", "nickname": "aninha"},
                {"id": "p2", "name": "Beto", "nickname": None},
                {"id": "p3", "name": "Caio", "nickname": None}]

    def test_tres_jogadores_viram_tres_tickets_com_o_buy_in_do_dia(self, monkeypatch):
        fake = _monta_ticket(monkeypatch, tickets=[], players=self._tres_jogadores())
        r = T.create_tickets_bulk(self._corpo(player_ids=["p1", "p2", "p3"]), AUTOR)
        assert len(r.created) == 3
        assert {t.player_id for t in r.created} == {"p1", "p2", "p3"}
        assert {t.ticket_value for t in r.created} == {300.0}
        assert {t.status for t in r.created} == {"awarded"}
        assert len(fake.store["satellite_tickets"]) == 3

    def test_o_total_do_lote_e_o_que_o_financiador_vai_bancar(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[], players=self._tres_jogadores())
        r = T.create_tickets_bulk(self._corpo(player_ids=["p1", "p2", "p3"]), AUTOR)
        assert r.total_value == 900.0

    def test_jogador_inexistente_nao_derruba_o_lote(self, monkeypatch):
        """O operador precisa saber QUEM ficou de fora, sem perder os demais."""
        fake = _monta_ticket(monkeypatch, tickets=[], players=self._tres_jogadores())
        r = T.create_tickets_bulk(self._corpo(player_ids=["p1", "fantasma", "p2"]), AUTOR)
        assert len(r.created) == 2
        assert [(s.player_id, s.reason) for s in r.skipped] == [("fantasma", "jogador_nao_encontrado")]
        assert len(fake.store["satellite_tickets"]) == 2

    def test_mesmo_jogador_repetido_gera_um_ticket_so(self, monkeypatch):
        """Selecionar duas vezes na tela é erro de dedo; emitir as duas vagas
        dobraria o dinheiro no pool sem ninguém ter pedido."""
        fake = _monta_ticket(monkeypatch, tickets=[], players=self._tres_jogadores())
        r = T.create_tickets_bulk(self._corpo(player_ids=["p1", "p1"]), AUTOR)
        assert len(r.created) == 1
        assert [s.reason for s in r.skipped] == ["duplicado_no_lote"]
        assert len(fake.store["satellite_tickets"]) == 1

    def test_dia_de_outro_torneio_nao_emite_nada(self, monkeypatch):
        fake = _monta_ticket(monkeypatch, tickets=[], players=self._tres_jogadores(),
                             tournament_days=[{"id": DIA, "tournament_id": "outro",
                                               "buy_in": 300, "day_name": "Dia Final"}])
        arg = self._corpo(player_ids=["p1", "p2"])
        with pytest.raises(ValueError, match="não pertence ao torneio alvo"):
            T.create_tickets_bulk(arg, AUTOR)
        assert fake.store["satellite_tickets"] == []

    def test_torneio_alvo_inexistente(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[], tournaments=[])
        arg = self._corpo()
        with pytest.raises(ValueError, match="Torneio alvo"):
            T.create_tickets_bulk(arg, AUTOR)

    def test_dia_alvo_inexistente(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[], tournament_days=[])
        arg = self._corpo()
        with pytest.raises(ValueError, match="Dia do torneio"):
            T.create_tickets_bulk(arg, AUTOR)

    def test_nenhum_jogador_valido_recusa_o_lote(self, monkeypatch):
        fake = _monta_ticket(monkeypatch, tickets=[], players=[])
        arg = self._corpo(player_ids=["x1", "x2"])
        with pytest.raises(ValueError, match="Nenhum jogador válido"):
            T.create_tickets_bulk(arg, AUTOR)
        assert fake.store["satellite_tickets"] == []

    @pytest.mark.parametrize("ids", [[], [f"p{i}" for i in range(101)]])
    def test_lote_vazio_ou_gigante_e_recusado_no_modelo(self, ids):
        """Sem teto, um payload gigante viraria centenas de entradas pagas num
        clique só."""
        with pytest.raises(ValidationError):
            TicketBulkCreate(player_ids=ids, target_tournament_id=TOUR,
                             target_tournament_day_id=DIA, won_at="x", funded_by="y")

    def test_banco_sem_as_colunas_novas_guarda_o_lote_inteiro_em_notas(self, monkeypatch):
        """Insert em lote é tudo-ou-nada: sem o fallback, a coluna faltando
        derrubaria as três linhas juntas num cliente pré-migração."""
        fake = _monta_ticket(monkeypatch, tickets=[], players=self._tres_jogadores())
        original = fake.table
        tentativas = {"n": 0}

        def _table(nome):
            if nome == "satellite_tickets":
                tentativas["n"] += 1
                if tentativas["n"] == 1:
                    raise Exception('column "funded_by" does not exist')
            return original(nome)

        monkeypatch.setattr(fake, "table", _table)
        r = T.create_tickets_bulk(self._corpo(player_ids=["p1", "p2", "p3"]), AUTOR)
        assert len(r.created) == 3
        assert all(t.funded_by == "Casa de Apostas" for t in r.created)
        assert all("Financiado por" in linha["notes"]
                   for linha in fake.store["satellite_tickets"])


class TestConsultaDeTickets:
    def test_busca_um_com_os_nomes(self, monkeypatch):
        _monta_ticket(monkeypatch)
        r = T.get_ticket("t1")
        assert r.player_name == "Fulano"
        assert r.target_tournament_name == "Torneio"
        assert r.target_day_name == "Dia Final"

    def test_inexistente(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[])
        assert T.get_ticket("t1") is None

    def test_filtra_por_status_e_torneio(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[
            _ticket("t1"), _ticket("t2", status="redeemed")])
        assert len(T.get_all_tickets(status="redeemed")) == 1
        assert len(T.get_all_tickets(target_tournament_id=TOUR)) == 2

    def test_disponiveis_cobrem_o_status_antigo(self, monkeypatch):
        """Tickets criados antes da renomeação ficaram como "available"; se a
        consulta só olhasse "awarded", eles sumiriam da tela."""
        _monta_ticket(monkeypatch, tickets=[
            _ticket("t1", status="awarded"),
            _ticket("t2", status="available"),
            _ticket("t3", status="redeemed"),
        ])
        assert len(T.get_available_tickets()) == 2

    def test_disponiveis_por_torneio(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[
            _ticket("t1"), dict(_ticket("t2"), target_tournament_id="outro")])
        assert len(T.get_available_tickets(target_tournament_id=TOUR)) == 1

    def test_resumo_conta_os_tres_baldes(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[
            _ticket("t1", status="awarded"), _ticket("t2", status="available"),
            _ticket("t3", status="redeemed"), _ticket("t4", status="cancelled"),
        ])
        r = T.get_summary()
        assert (r.total_available, r.total_redeemed, r.total_cancelled) == (2, 1, 1)

    def test_lista_vazia_nao_consulta_nomes(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[])
        assert T.get_all_tickets() == []

    def test_filtra_por_jogador(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[
            _ticket("t1", player=JOGADOR), _ticket("t2", player="outro-jogador")])
        r = T.get_all_tickets(player_id=JOGADOR)
        assert [t.id for t in r] == ["t1"]

    def test_perfil_do_jogador_enxerga_ticket_de_QUALQUER_etapa(self, monkeypatch):
        """O X-Stage-ID viaja em toda requisição. Se o recorte de etapa valesse
        aqui, a vaga ganhada na etapa anterior sumiria justo da tela onde o
        operador vai procurar por ela."""
        fake = _monta_ticket(monkeypatch, tickets=[
            dict(_ticket("t1"), stage_id="outra-etapa")])
        chamadas = {"or_": 0}
        original = fake.table

        def _table(nome):
            alvo = original(nome)
            if nome != "satellite_tickets":
                return alvo
            or_original = alvo.or_

            def _or(*a, **k):
                chamadas["or_"] += 1
                return or_original(*a, **k)

            alvo.or_ = _or
            return alvo

        monkeypatch.setattr(fake, "table", _table)
        r = T.get_all_tickets(stage_id=ETAPA, player_id=JOGADOR)
        assert [t.id for t in r] == ["t1"]
        assert chamadas["or_"] == 0

    def test_sem_jogador_o_recorte_por_etapa_continua_valendo(self, monkeypatch):
        fake = _monta_ticket(monkeypatch, tickets=[_ticket("t1")])
        chamadas = {"or_": 0}
        original = fake.table

        def _table(nome):
            alvo = original(nome)
            if nome != "satellite_tickets":
                return alvo
            or_original = alvo.or_

            def _or(*a, **k):
                chamadas["or_"] += 1
                return or_original(*a, **k)

            alvo.or_ = _or
            return alvo

        monkeypatch.setattr(fake, "table", _table)
        T.get_all_tickets(stage_id=ETAPA)
        assert chamadas["or_"] == 1


class TestResgateDeTicket:
    def _com_registro(self, monkeypatch):
        """O resgate delega a inscrição ao serviço de jogadores do torneio."""
        from app.services import tournament_player_service as tps

        def _registra(registro, uid):
            return TournamentPlayerDetail(
                id="tp-novo", tournament_id=registro.tournament_id,
                player_id=registro.player_id, total_spent=0.0, status="active",
                registered_at="2026-06-08T12:00:00Z",
                player_name="Fulano", tournament_name="Torneio")

        monkeypatch.setattr(tps.TournamentPlayerService, "register_player",
                            staticmethod(_registra))

    def test_resgata_e_marca_como_usado(self, monkeypatch):
        self._com_registro(monkeypatch)
        fake = _monta_ticket(monkeypatch)
        r = T.redeem_ticket("t1", None, AUTOR)
        assert r["tournament_player_id"] == "tp-novo"
        assert fake.store["satellite_tickets"][0]["status"] == "redeemed"
        assert fake.store["satellite_tickets"][0]["redeemed_tournament_player_id"] == "tp-novo"

    def test_o_financiador_vem_do_proprio_ticket(self, monkeypatch):
        """Quem financiou foi definido na criação; deixar o operador redigitar
        no resgate abriria espaço para atribuir a outro patrocinador."""
        self._com_registro(monkeypatch)
        _monta_ticket(monkeypatch, tickets=[_ticket(financiado="Patrocinador A")])
        assert T.redeem_ticket("t1", "Outro", AUTOR)["funded_by"] == "Patrocinador A"

    def test_ticket_antigo_recupera_o_financiador_das_notas(self, monkeypatch):
        self._com_registro(monkeypatch)
        _monta_ticket(monkeypatch, tickets=[
            _ticket(financiado="", notas="Financiado por: Patrocinador B")])
        assert T.redeem_ticket("t1", None, AUTOR)["funded_by"] == "Patrocinador B"

    def test_ticket_muito_antigo_aceita_o_financiador_informado(self, monkeypatch):
        self._com_registro(monkeypatch)
        _monta_ticket(monkeypatch, tickets=[_ticket(financiado="", notas=None)])
        assert T.redeem_ticket("t1", "Informado na hora", AUTOR)["funded_by"] == "Informado na hora"

    def test_sem_financiador_em_lugar_nenhum_e_recusado(self, monkeypatch):
        """O clube precisa saber de quem cobrar esse buy-in."""
        _monta_ticket(monkeypatch, tickets=[_ticket(financiado="", notas=None)])
        with pytest.raises(ValueError, match="Informe quem financiou"):
            T.redeem_ticket("t1", None, AUTOR)

    def test_banco_sem_a_coluna_guarda_o_financiador_nas_notas(self, monkeypatch):
        self._com_registro(monkeypatch)
        fake = _monta_ticket(monkeypatch)
        original = fake.table
        chamadas = {"update": 0}

        class _Espia:
            def __init__(self, alvo):
                self._alvo = alvo

            def update(self, payload):
                if "funded_by" in payload:
                    chamadas["update"] += 1
                    if chamadas["update"] == 1:
                        raise Exception('column "funded_by" does not exist')
                return self._alvo.update(payload)

            def __getattr__(self, nome):
                return getattr(self._alvo, nome)

        def _table(nome):
            alvo = original(nome)
            return _Espia(alvo) if nome == "satellite_tickets" else alvo

        monkeypatch.setattr(fake, "table", _table)
        T.redeem_ticket("t1", None, AUTOR)
        assert fake.store["satellite_tickets"][0]["notes"].startswith("Financiado por:")

    def test_ticket_inexistente(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[])
        with pytest.raises(ValueError, match="não encontrado"):
            T.redeem_ticket("t1", None, AUTOR)

    @pytest.mark.parametrize("status", ["redeemed", "cancelled"])
    def test_ticket_fora_do_estado_resgatavel(self, monkeypatch, status):
        _monta_ticket(monkeypatch, tickets=[_ticket(status=status)])
        with pytest.raises(ValueError, match="não pode ser resgatado"):
            T.redeem_ticket("t1", None, AUTOR)

    def test_ticket_sem_jogador(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[_ticket(player=None)])
        with pytest.raises(ValueError, match="jogador atribuído"):
            T.redeem_ticket("t1", None, AUTOR)

    def test_ticket_sem_dia_alvo(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[_ticket(dia=None)])
        with pytest.raises(ValueError, match="dia alvo"):
            T.redeem_ticket("t1", None, AUTOR)


class TestTransferenciaEVendaDeTicket:
    """O jogador ganha a vaga e não pode jogar: passa (ou vende) para outro.

    Duas coisas não podem se misturar aqui:
    - **Quem BANCA o buy-in não muda.** `funded_by` é de quem o clube cobra a
      entrada no torneio-destino; a venda é dinheiro pela vaga, outra conta.
    - **Venda sem lançamento no caixa é dinheiro sumido.** Por isso a receita
      entra pelo mesmo caminho das outras (other_revenues → caixa geral).
    """

    ORG = "33333333-3333-3333-3333-333333333333"
    NOVO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa9"

    def _monta(self, monkeypatch, tickets=None, transferencias=None, **tabelas):
        from app.services import expense_service as expmod

        base = {
            "satellite_tickets": tickets if tickets is not None else [_ticket()],
            "satellite_ticket_transfers": transferencias if transferencias is not None else [],
            "other_revenues": [],
            "general_cash_register": [{"id": "gc1", "organization_id": self.ORG,
                                       "current_balance": 0, "total_received": 0}],
            "players": [{"id": JOGADOR, "name": "Fulano", "nickname": "fu"},
                        {"id": self.NOVO, "name": "Sicrano", "nickname": None}],
            "tournaments": [{"id": TOUR, "name": "Torneio"}],
            "tournament_days": [{"id": DIA, "tournament_id": TOUR, "buy_in": 300,
                                 "day_name": "Dia Final"}],
        }
        base.update(tabelas)
        fake = FakeSupabase(base)
        fake.rpcs["revenue_set_status"] = {"changed": True}
        monkeypatch.setattr(tickmod, "supabase", fake)
        monkeypatch.setattr(expmod, "supabase", fake)
        return fake

    def _corpo(self, **kw):
        base = {"to_player_id": self.NOVO}
        base.update(kw)
        return TicketTransfer(**base)

    def test_transferencia_troca_o_dono_e_preserva_o_lastro(self, monkeypatch):
        fake = self._monta(monkeypatch)
        T.transfer_ticket("t1", self._corpo(), AUTOR, org_id=self.ORG, stage_id=ETAPA)
        linha = fake.store["satellite_tickets"][0]
        assert linha["player_id"] == self.NOVO
        assert float(linha["ticket_value"]) == 300.0
        assert linha["funded_by"] == "Casa de Apostas"
        assert linha["won_at"] == "2026-06-01"

    def test_transferencia_grava_o_historico(self, monkeypatch):
        """Sem o histórico, ninguém explica depois por que o ticket que a Ana
        ganhou apareceu no nome de outro jogador."""
        fake = self._monta(monkeypatch)
        T.transfer_ticket("t1", self._corpo(), AUTOR, org_id=self.ORG, stage_id=ETAPA)
        h = fake.store["satellite_ticket_transfers"]
        assert len(h) == 1
        assert h[0]["kind"] == "transfer"
        assert float(h[0]["amount"]) == 0
        assert h[0]["from_player_id"] == JOGADOR
        assert h[0]["to_player_id"] == self.NOVO
        assert h[0]["performed_by"] == AUTOR

    def test_transferencia_de_graca_nao_gera_receita(self, monkeypatch):
        fake = self._monta(monkeypatch)
        T.transfer_ticket("t1", self._corpo(), AUTOR, org_id=self.ORG, stage_id=ETAPA)
        assert fake.store["other_revenues"] == []

    def test_venda_lanca_a_receita_no_caixa_e_amarra_ao_historico(self, monkeypatch):
        fake = self._monta(monkeypatch)
        T.transfer_ticket("t1", self._corpo(amount=250, payment_method="pix"),
                          AUTOR, org_id=self.ORG, stage_id=ETAPA)
        receita = fake.store["other_revenues"][0]
        assert float(receita["amount"]) == 250.0
        assert receita["stage_id"] == ETAPA
        assert receita["payment_method"] == "pix"
        # É a transição pelo RPC que credita o caixa geral de verdade.
        assert [c[0] for c in fake.rpc_calls] == ["revenue_set_status"]
        assert fake.rpc_calls[0][1]["p_status"] == "recebido"
        h = fake.store["satellite_ticket_transfers"][0]
        assert h["kind"] == "sale"
        assert h["revenue_id"] == receita["id"]

    def test_venda_sem_lancar_no_caixa_so_registra_a_troca(self, monkeypatch):
        """O clube só anota que a vaga mudou de mão; o dinheiro ficou entre os
        jogadores."""
        fake = self._monta(monkeypatch)
        T.transfer_ticket("t1", self._corpo(amount=250, register_in_cash=False),
                          AUTOR, org_id=self.ORG, stage_id=ETAPA)
        assert fake.store["other_revenues"] == []
        assert fake.store["satellite_ticket_transfers"][0]["kind"] == "sale"

    def test_venda_sem_etapa_nao_grava_nada(self, monkeypatch):
        """A receita mora na etapa (other_revenues.stage_id é NOT NULL);
        gravar a troca sem o dinheiro deixaria a venda fora do DRE."""
        fake = self._monta(monkeypatch, tickets=[dict(_ticket(), stage_id=None)])
        arg = self._corpo(amount=250)
        with pytest.raises(ValueError, match="etapa"):
            T.transfer_ticket("t1", arg, AUTOR, org_id=self.ORG, stage_id=None)
        assert fake.store["satellite_ticket_transfers"] == []
        assert fake.store["satellite_tickets"][0]["player_id"] == JOGADOR

    def test_venda_usa_a_etapa_do_proprio_ticket_quando_nao_ha_header(self, monkeypatch):
        fake = self._monta(monkeypatch)
        T.transfer_ticket("t1", self._corpo(amount=100), AUTOR, org_id=self.ORG, stage_id=None)
        assert fake.store["other_revenues"][0]["stage_id"] == ETAPA

    @pytest.mark.parametrize("status", ["redeemed", "cancelled"])
    def test_ticket_fora_do_estado_transferivel(self, monkeypatch, status):
        """Resgatado já virou inscrição no dia: trocar o dono deixaria o
        jogador antigo sentado na mesa sem ticket."""
        fake = self._monta(monkeypatch, tickets=[_ticket(status=status)])
        arg = self._corpo()
        with pytest.raises(ValueError, match="não resgatados"):
            T.transfer_ticket("t1", arg, AUTOR, org_id=self.ORG, stage_id=ETAPA)
        assert fake.store["satellite_ticket_transfers"] == []

    def test_transferir_para_o_dono_atual_e_recusado(self, monkeypatch):
        self._monta(monkeypatch)
        arg = self._corpo(to_player_id=JOGADOR)
        with pytest.raises(ValueError, match="já pertence"):
            T.transfer_ticket("t1", arg, AUTOR, org_id=self.ORG, stage_id=ETAPA)

    def test_destino_inexistente_e_recusado(self, monkeypatch):
        self._monta(monkeypatch)
        arg = self._corpo(to_player_id="fantasma")
        with pytest.raises(ValueError, match="destino não encontrado"):
            T.transfer_ticket("t1", arg, AUTOR, org_id=self.ORG, stage_id=ETAPA)

    def test_ticket_inexistente(self, monkeypatch):
        self._monta(monkeypatch, tickets=[])
        arg = self._corpo()
        with pytest.raises(ValueError, match="não encontrado"):
            T.transfer_ticket("t1", arg, AUTOR, org_id=self.ORG, stage_id=ETAPA)

    def test_ticket_legado_sem_dono_e_atribuido(self, monkeypatch):
        """Ticket antigo sem jogador: é atribuição, não transferência — o
        histórico registra origem vazia."""
        fake = self._monta(monkeypatch, tickets=[_ticket(player=None)])
        T.transfer_ticket("t1", self._corpo(), AUTOR, org_id=self.ORG, stage_id=ETAPA)
        assert fake.store["satellite_ticket_transfers"][0]["from_player_id"] is None
        assert fake.store["satellite_tickets"][0]["player_id"] == self.NOVO

    def test_falha_ao_gravar_o_historico_estorna_a_receita(self, monkeypatch):
        """Receita sem histórico é caixa inflado por um lançamento que ninguém
        consegue explicar."""
        fake = self._monta(monkeypatch)
        original = fake.table

        def _table(nome):
            if nome == "satellite_ticket_transfers":
                raise Exception('relation "satellite_ticket_transfers" does not exist')
            return original(nome)

        monkeypatch.setattr(fake, "table", _table)
        arg = self._corpo(amount=250)
        with pytest.raises(ValueError, match="transferência"):
            T.transfer_ticket("t1", arg, AUTOR, org_id=self.ORG, stage_id=ETAPA)
        assert fake.store["other_revenues"] == []
        assert fake.store["satellite_tickets"][0]["player_id"] == JOGADOR

    def test_historico_vem_do_mais_recente_para_o_mais_antigo(self, monkeypatch):
        self._monta(monkeypatch, transferencias=[
            {"id": "h1", "ticket_id": "t1", "from_player_id": JOGADOR,
             "to_player_id": self.NOVO, "kind": "transfer", "amount": 0,
             "created_at": "2026-06-01T00:00:00Z"},
            {"id": "h2", "ticket_id": "t1", "from_player_id": self.NOVO,
             "to_player_id": JOGADOR, "kind": "sale", "amount": 150,
             "created_at": "2026-06-05T00:00:00Z"},
        ])
        r = T.list_transfers("t1")
        assert [h.id for h in r] == ["h2", "h1"]
        assert r[0].from_player_name == "Sicrano"
        assert r[0].to_player_name == "Fulano"

    def test_historico_de_banco_sem_a_tabela_volta_vazio(self, monkeypatch):
        """Cliente que ainda não rodou a migração não pode ver a tela de
        tickets quebrar."""
        fake = self._monta(monkeypatch)
        original = fake.table

        def _table(nome):
            if nome == "satellite_ticket_transfers":
                raise Exception('relation "satellite_ticket_transfers" does not exist')
            return original(nome)

        monkeypatch.setattr(fake, "table", _table)
        assert T.list_transfers("t1") == []


class TestCancelamentoDeTicket:
    def test_cancela(self, monkeypatch):
        fake = _monta_ticket(monkeypatch)
        assert T.cancel_ticket("t1", AUTOR).status == "cancelled"
        assert fake.store["satellite_tickets"][0]["status"] == "cancelled"

    def test_ticket_ja_resgatado_nao_cancela(self, monkeypatch):
        """A inscrição já existe; cancelar o ticket deixaria o jogador dentro
        do torneio sem nada que explique como entrou."""
        _monta_ticket(monkeypatch, tickets=[_ticket(status="redeemed")])
        with pytest.raises(ValueError, match="não resgatados"):
            T.cancel_ticket("t1", AUTOR)

    def test_inexistente(self, monkeypatch):
        _monta_ticket(monkeypatch, tickets=[])
        with pytest.raises(ValueError, match="não encontrado"):
            T.cancel_ticket("t1", AUTOR)

    def test_leitura_recupera_dados_guardados_nas_notas(self, monkeypatch):
        """Banco pré-migração: `notes` carrega os dois campos separados por
        "|"; a resposta precisa devolvê-los como campos."""
        _monta_ticket(monkeypatch, tickets=[_ticket(
            financiado=None, notas="Ganho em: 2026-05-30 | Financiado por: Patro X")])
        t = _ticket(financiado=None, notas="Ganho em: 2026-05-30 | Financiado por: Patro X")
        t["won_at"] = None
        r = T._enrich_ticket(dict(t))
        assert r.funded_by == "Patro X"
        assert r.won_at == "2026-05-30"
