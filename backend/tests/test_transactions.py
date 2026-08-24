"""Testes das transacoes: criacao e consultas.

Toda entrada de dinheiro no torneio passa por aqui. O ponto sensivel e o
vinculo com o `tournament_player`: sem ele o lancamento existe mas nao se
liga ao jogador, e o total gasto dele fica errado.
"""
import pytest

from app.services import transaction_service
from app.services import sales_block_service
from app.services.transaction_service import TransactionService
from app.services.cashbox_service import CashboxService
from app.models.transaction import TransactionCreate

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
PLAYER = "44444444-4444-4444-4444-444444444444"
STAGE = "11111111-1111-1111-1111-111111111111"


def _monta(monkeypatch, tabelas=None, caixa_aberto=True):
    base = {
        "transactions": [],
        "tournament_players": [],
        "tournaments": [{"id": TOUR, "name": "Torneio A", "stage_id": STAGE}],
        "players": [{"id": PLAYER, "name": "Fulano", "nickname": "fu"}],
    }
    base.update(tabelas or {})
    fake = FakeSupabase(base)
    monkeypatch.setattr(transaction_service, "supabase", fake)
    # O bloqueio de vendas le do MESMO banco falso (senao iria ao Supabase real).
    monkeypatch.setattr(sales_block_service, "supabase", fake)
    # A exigencia de caixa aberto e testada em test_cashbox; aqui ela so nao
    # pode atrapalhar o que esta sendo medido.
    monkeypatch.setattr(
        CashboxService, "require_open_cashbox_for_tournament",
        staticmethod(lambda user_id, tournament_id: None if caixa_aberto else (_ for _ in ()).throw(ValueError("caixa fechado"))),
    )
    return fake


def _nova(tipo="buy_in", valor=100):
    return TransactionCreate(
        tournament_id=TOUR, player_id=PLAYER, type=tipo, amount=valor,
        payment_method="cash",
    )


class TestCriacao:
    def test_grava_a_transacao_com_o_autor(self, monkeypatch):
        fake = _monta(monkeypatch)
        t = TransactionService.create_transaction(_nova(), user_id="operador-1")

        assert t.amount == 100
        assert t.tournament_name == "Torneio A"
        assert t.player_name == "Fulano"
        assert fake.store["transactions"][0]["created_by"] == "operador-1"

    def test_liga_ao_jogador_do_torneio_quando_ele_existe(self, monkeypatch):
        """Sem esse vinculo o lancamento fica solto e o total gasto do jogador
        nao fecha."""
        fake = _monta(monkeypatch, {
            "tournament_players": [
                {"id": "tp-9", "tournament_id": TOUR, "player_id": PLAYER},
            ],
        })
        TransactionService.create_transaction(_nova(), user_id="u1")
        assert fake.store["transactions"][0]["tournament_player_id"] == "tp-9"

    def test_escolhe_a_mesma_inscricao_que_a_trava_de_vendas_confere(self, monkeypatch):
        """O jogador inscrito no 1A e no 1B do mesmo torneio tem DUAS linhas
        aqui. Sem ordenacao, o Postgres entrega qualquer uma (um UPDATE em
        tournament_players reescreve a tupla no fim do heap), e a trava
        conferia um dia enquanto a venda era gravada no OUTRO: o dia encerrado
        pelo diretor continuava vendendo por fora."""
        fake = _monta(monkeypatch, {"tournament_players": [
            {"id": "tp-1b", "tournament_id": TOUR, "player_id": PLAYER,
             "tournament_day_id": "dia-1b", "registered_at": "2026-06-09T00:00:00Z"},
            {"id": "tp-1a", "tournament_id": TOUR, "player_id": PLAYER,
             "tournament_day_id": "dia-1a", "registered_at": "2026-06-08T00:00:00Z"},
        ]})
        TransactionService.create_transaction(_nova(), user_id="u1")

        gravado = fake.store["transactions"][0]["tournament_player_id"]
        assert gravado == "tp-1a"
        # E o MESMO dia que a trava de vendas foi conferir.
        conferido = sales_block_service.SalesBlockService.dia_da_venda(TOUR, PLAYER)
        assert conferido == "dia-1a"

    def test_sem_inscricao_nao_inventa_vinculo(self, monkeypatch):
        fake = _monta(monkeypatch)   # nenhum tournament_player
        TransactionService.create_transaction(_nova(), user_id="u1")
        assert fake.store["transactions"][0].get("tournament_player_id") is None

    def test_caixa_fechado_impede_o_lancamento(self, monkeypatch):
        _monta(monkeypatch, caixa_aberto=False)
        arg = _nova()
        with pytest.raises(ValueError, match="caixa fechado"):
            TransactionService.create_transaction(arg, user_id="u1")

    def test_torneio_ou_jogador_ausente_nao_quebra(self, monkeypatch):
        """Dado incompleto nao pode derrubar o caixa no meio do evento."""
        _monta(monkeypatch, {"tournaments": [], "players": []})
        t = TransactionService.create_transaction(_nova(), user_id="u1")
        assert t.tournament_name == ""
        assert t.player_name == ""

    @pytest.mark.parametrize("tipo", ["buy_in", "rebuy", "addon"])
    def test_aceita_os_tipos_de_entrada(self, monkeypatch, tipo):
        _monta(monkeypatch)
        t = TransactionService.create_transaction(_nova(tipo=tipo), user_id="u1")
        assert t.type == tipo


class TestConsultas:
    def _com_transacoes(self, monkeypatch):
        return _monta(monkeypatch, {
            "transactions": [
                {"id": "x1", "tournament_id": TOUR, "player_id": PLAYER,
                 "type": "buy_in", "amount": 100, "created_at": "2026-06-08T00:00:00Z",
                 "tournaments": {"name": "Torneio A"}, "players": {"name": "Fulano", "nickname": "fu"}},
                {"id": "x2", "tournament_id": TOUR, "player_id": PLAYER,
                 "type": "rebuy", "amount": 50, "created_at": "2026-06-08T01:00:00Z",
                 "tournaments": {"name": "Torneio A"}, "players": {"name": "Fulano", "nickname": "fu"}},
            ],
        })

    def test_lista_todas(self, monkeypatch):
        self._com_transacoes(monkeypatch)
        assert len(TransactionService.get_transactions()) == 2

    def test_lista_por_torneio(self, monkeypatch):
        self._com_transacoes(monkeypatch)
        r = TransactionService.get_transactions_by_tournament(TOUR)
        assert len(r) == 2
        # Esta consulta nao traz o nome do torneio de proposito: quem chamou ja
        # sabe qual e. O que precisa vir preenchido e o jogador.
        assert all(t.player_name == "Fulano" for t in r)
        assert all(t.tournament_name == "" for t in r)

    def test_lista_por_jogador(self, monkeypatch):
        self._com_transacoes(monkeypatch)
        r = TransactionService.get_transactions_by_player(PLAYER)
        assert len(r) == 2

    def test_torneio_sem_movimento_devolve_vazio(self, monkeypatch):
        self._com_transacoes(monkeypatch)
        assert TransactionService.get_transactions_by_tournament("outro-torneio") == []


# ---------------------------------------------------------------------------
# Cancelamento de venda (estorno logico)
# ---------------------------------------------------------------------------
# Mexer em dinheiro JA registrado e a operacao mais perigosa da tela. Os tres
# gatilhos do banco que movem dinheiro na INSERCAO (caixa da etapa, caixa do
# operador e pontos de fidelidade) sao todos INSERT-only: nenhum desfaz nada.
# Por isso cada teste aqui confere o AGREGADO, nao so o status da linha.

TP_ID = "55555555-5555-5555-5555-555555555555"
DIA = "77777777-7777-7777-7777-777777777777"
CAIXA = "99999999-9999-9999-9999-999999999999"
ORG = "33333333-3333-3333-3333-333333333333"


def _venda(tipo="buy_in", valor=100, **extra):
    linha = {
        "id": "tx-1", "tournament_id": TOUR, "player_id": PLAYER,
        "tournament_player_id": TP_ID, "type": tipo, "amount": valor,
        "rake_amount": 20, "rake_percentage": 20, "payment_method": "cash",
        "payment_source": "cash", "status": "active", "cashbox_id": CAIXA,
        "organization_id": ORG, "created_by": "operador-1",
        "created_at": "2026-06-08T00:00:00Z",
    }
    linha.update(extra)
    return linha


def _cenario(monkeypatch, venda=None, jogador=None, tabelas=None):
    tp = {
        "id": TP_ID, "tournament_id": TOUR, "tournament_day_id": DIA,
        "player_id": PLAYER, "status": "active",
        "rebuy_count": 1, "addon_count": 1, "total_chips": 30000,
        "total_buy_in_amount": 100, "total_rebuy_amount": 100, "total_addon_amount": 100,
        "total_spent": 300,
        "created_at": "2026-06-08T00:00:00Z", "registered_at": "2026-06-08T00:00:00Z",
    }
    tp.update(jogador or {})
    base = {
        "transactions": [venda or _venda()],
        "tournament_players": [tp],
        "tournament_days": [{"id": DIA, "tournament_id": TOUR, "registered_players": 10,
                             "rebuy_chips": 10000, "addon_chips": 10000}],
        "tournaments": [{"id": TOUR, "name": "Torneio A", "stage_id": STAGE}],
        "players": [{"id": PLAYER, "name": "Fulano", "nickname": "fu"}],
        "stage_cash_register": [{"id": "sc1", "stage_id": STAGE,
                                 "current_balance": 1000, "total_received": 1000,
                                 "total_sangrias": 0}],
        "cashboxes": [{"id": CAIXA, "current_session_id": "sess-1", "current_balance": 500}],
        "cashbox_transactions": [],
        "loyalty_accounts": [],
        "loyalty_ledger": [],
        "seat_allocations": [],
    }
    base.update(tabelas or {})
    return _monta(monkeypatch, base)


class TestCancelamento:
    def test_marca_cancelada_com_quem_quando_e_por_que(self, monkeypatch):
        """Sem essa auditoria ninguem consegue explicar a diferenca no
        fechamento do caixa no fim da noite."""
        fake = _cenario(monkeypatch)
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "cobrei em duplicidade")

        assert r.status.value == "cancelled"
        linha = fake.store["transactions"][0]
        assert linha["cancelled_by"] == "admin-9"
        assert linha["cancel_reason"] == "cobrei em duplicidade"
        assert linha["cancelled_at"]
        # A linha CONTINUA na base: estorno logico, nunca DELETE.
        assert len(fake.store["transactions"]) == 1

    def test_devolve_o_dinheiro_ao_caixa_da_etapa(self, monkeypatch):
        # O gatilho que soma no caixa da etapa e AFTER INSERT apenas; sem este
        # desconto o caixa fica inflado para sempre.
        fake = _cenario(monkeypatch)
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        caixa = fake.store["stage_cash_register"][0]
        assert float(caixa["current_balance"]) == 900.0
        assert float(caixa["total_received"]) == 900.0

    def test_lanca_estorno_no_caixa_do_operador(self, monkeypatch):
        # O ledger do caixa modular e append-only (e o que da auditoria ao
        # fechamento), entao o estorno entra como movimento NEGATIVO.
        fake = _cenario(monkeypatch)
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        estorno = fake.store["cashbox_transactions"][0]
        assert float(estorno["signed_amount"]) == -100.0
        assert estorno["transaction_id"] == "tx-1"
        assert estorno["cashbox_id"] == CAIXA
        assert estorno["session_id"] == "sess-1"
        assert estorno["organization_id"] == ORG

    def test_estorno_nao_usa_o_tipo_do_ajuste_de_fechamento(self, monkeypatch):
        """'adjustment' e a diferenca de CONTAGEM do fechamento, e por isso o
        relatorio de sessao a exclui do saldo esperado. Lancar o estorno com
        esse tipo fazia o relatorio acusar o operador de faltar o dinheiro que o
        admin devolveu ao jogador."""
        fake = _cenario(monkeypatch)
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert fake.store["cashbox_transactions"][0]["type"] == "refund"

    def test_sem_o_tipo_refund_no_banco_o_estorno_ainda_entra(self, monkeypatch):
        """Dia do deploy: backend novo, migracao ainda nao aplicada. O estorno
        cai no tipo antigo MAS sempre com transaction_id — e por ele que o
        relatorio reconhece o estorno em vez do ajuste de fechamento."""
        fake = _cenario(monkeypatch)
        original = fake.table

        def _recusa_refund(nome):
            q = original(nome)
            if nome != "cashbox_transactions":
                return q
            inserir = q.insert

            def _insert(payload):
                if (payload or {}).get("type") == "refund":
                    raise RuntimeError("violates check constraint")
                return inserir(payload)

            q.insert = _insert
            return q

        monkeypatch.setattr(fake, "table", _recusa_refund)
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        estorno = fake.store["cashbox_transactions"][0]
        assert estorno["type"] == "adjustment"
        assert estorno["transaction_id"] == "tx-1"
        assert float(estorno["signed_amount"]) == -100.0

    def test_cancelar_rebuy_devolve_contador_valor_e_fichas(self, monkeypatch):
        fake = _cenario(monkeypatch, venda=_venda(tipo="rebuy"))
        TransactionService.cancel_transaction("tx-1", "admin-9", "recompra indevida")
        tp = fake.store["tournament_players"][0]
        assert tp["rebuy_count"] == 0
        assert float(tp["total_rebuy_amount"]) == 0.0
        assert tp["total_chips"] == 20000
        # total_spent = buy_in + rebuy + addon
        assert float(tp["total_spent"]) == 200.0
        # rebuy nao mexe na contagem de inscritos do dia
        assert fake.store["tournament_days"][0]["registered_players"] == 10

    def test_cancelar_addon_devolve_contador_valor_e_fichas(self, monkeypatch):
        fake = _cenario(monkeypatch, venda=_venda(tipo="addon"))
        TransactionService.cancel_transaction("tx-1", "admin-9", "add-on indevido")
        tp = fake.store["tournament_players"][0]
        assert tp["addon_count"] == 0
        assert float(tp["total_addon_amount"]) == 0.0
        assert tp["total_chips"] == 20000
        assert float(tp["total_spent"]) == 200.0

    def test_cancelar_buy_in_desfaz_a_inscricao_e_libera_a_vaga(self, monkeypatch):
        """O gatilho de contagem so dispara em INSERT/DELETE da linha; aqui e
        UPDATE, entao o inscrito precisa ser descontado na mao - senao o dia
        parece cheio e o Caixa recusa o proximo jogador."""
        fake = _cenario(monkeypatch, tabelas={
            "seat_allocations": [{"id": "sa1", "tournament_id": TOUR, "player_id": PLAYER,
                                  "tournament_day_id": DIA, "seat_number": 3}],
        })
        TransactionService.cancel_transaction("tx-1", "admin-9", "desistiu")
        tp = fake.store["tournament_players"][0]
        assert tp["status"] == "cancelled"
        assert float(tp["total_buy_in_amount"]) == 0.0
        assert tp["total_chips"] == 0
        assert fake.store["tournament_days"][0]["registered_players"] == 9
        # O assento volta para o pool de lugares livres.
        assert fake.store["seat_allocations"] == []

    def test_cancelar_buy_in_zera_a_contagem_de_entradas(self, monkeypatch):
        """buy_in_count e o numero que TODO agregado de entradas conta (total do
        dia na tela e no telao, relatorio do dia, perfil do jogador). Sem zerar,
        o dia mostra 78 entradas com receita de 77 e o diretor confere a
        premiacao por um numero que nao bate com o dinheiro."""
        fake = _cenario(monkeypatch, jogador={"buy_in_count": 1})
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert fake.store["tournament_players"][0]["buy_in_count"] == 0

    def test_nao_libera_o_assento_que_o_jogador_ocupa_em_outro_dia(self, monkeypatch):
        """As mesas sao por DIA. Cancelar o buy-in do 1A nao pode tirar da
        cadeira o mesmo jogador no 1B, que esta jogando agora."""
        fake = _cenario(monkeypatch, tabelas={
            "seat_allocations": [
                {"id": "sa-1a", "tournament_id": TOUR, "player_id": PLAYER,
                 "tournament_day_id": DIA, "seat_number": 3},
                {"id": "sa-1b", "tournament_id": TOUR, "player_id": PLAYER,
                 "tournament_day_id": "outro-dia", "seat_number": 7},
            ],
        })
        TransactionService.cancel_transaction("tx-1", "admin-9", "desistiu")
        restantes = [s["id"] for s in fake.store["seat_allocations"]]
        assert restantes == ["sa-1b"]

    def test_estorna_os_pontos_de_fidelidade(self, monkeypatch):
        """trg_loyalty_earn tambem e INSERT-only: sem isto o jogador ficaria com
        pontos (e nivel VIP) comprados por uma venda que nao existe mais."""
        fake = _cenario(monkeypatch, tabelas={
            "loyalty_accounts": [{"player_id": PLAYER, "organization_id": ORG,
                                  "points_balance": 500, "lifetime_points": 800}],
            "loyalty_ledger": [{"id": "l1", "transaction_id": "tx-1", "player_id": PLAYER,
                                "delta": 100, "balance_after": 500, "reason": "earn_buy_in"}],
        })
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        conta = fake.store["loyalty_accounts"][0]
        assert float(conta["points_balance"]) == 400.0
        assert float(conta["lifetime_points"]) == 700.0
        estorno = [l for l in fake.store["loyalty_ledger"] if float(l["delta"]) < 0]
        assert len(estorno) == 1
        assert float(estorno[0]["delta"]) == -100.0
        assert estorno[0]["transaction_id"] == "tx-1"

    def test_sem_fidelidade_o_cancelamento_segue(self, monkeypatch):
        # Fidelidade e best-effort: nao pode travar o estorno do DINHEIRO.
        fake = _cenario(monkeypatch)
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert fake.store["transactions"][0]["status"] == "cancelled"
        assert fake.store["loyalty_ledger"] == []

    def test_cancelar_duas_vezes_nao_debita_o_caixa_de_novo(self, monkeypatch):
        """Clique duplo do admin nao pode estornar o mesmo dinheiro duas vezes."""
        fake = _cenario(monkeypatch)
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 900.0
        assert len(fake.store["cashbox_transactions"]) == 1

    def test_premio_nao_pode_ser_cancelado_por_aqui(self, monkeypatch):
        # Premio pago e SAIDA de caixa e tem fluxo proprio; desfaze-lo aqui
        # devolveria fichas a quem ja recebeu o dinheiro.
        fake = _cenario(monkeypatch, venda=_venda(tipo="prize"))
        with pytest.raises(ValueError, match="Apenas entradas"):
            TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert fake.store["transactions"][0]["status"] == "active"

    @pytest.mark.parametrize("origem", ["credit", "mixed", "ticket"])
    def test_venda_paga_com_credito_ou_ticket_fica_bloqueada(self, monkeypatch, origem):
        """Nao existe inversa de use_credit nem des-resgate de ticket:
        cancelar sem devolver confiscaria o saldo do jogador."""
        fake = _cenario(monkeypatch, venda=_venda(payment_source=origem))
        with pytest.raises(ValueError, match="crédito ou ticket"):
            TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert fake.store["transactions"][0]["status"] == "active"
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 1000.0

    def test_transacao_inexistente_avisa(self, monkeypatch):
        _cenario(monkeypatch)
        with pytest.raises(ValueError, match="não encontrada"):
            TransactionService.cancel_transaction("nao-existe", "admin-9", "erro")

    def test_venda_sem_caixa_do_operador_nao_gera_ajuste(self, monkeypatch):
        # Venda legada (anterior ao caixa modular): nao ha ledger para estornar.
        fake = _cenario(monkeypatch, venda=_venda(cashbox_id=None))
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert fake.store["cashbox_transactions"] == []
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 900.0


class TestBuyInComRecompras:
    """Cancelar o buy-in tira o jogador do dia e zera as fichas dele. Se os
    rebuys continuarem ativos, o clube fica com o dinheiro de quem nao esta mais
    na mesa e a bolsa de premios segue premiando com ele."""

    def _com_rebuy_ativo(self, monkeypatch, status_do_rebuy="active"):
        return _cenario(monkeypatch, tabelas={
            "transactions": [
                _venda(),
                _venda(tipo="rebuy", valor=100, id="tx-2", status=status_do_rebuy),
            ],
        })

    def test_buy_in_com_rebuy_ativo_nao_pode_ser_cancelado(self, monkeypatch):
        fake = self._com_rebuy_ativo(monkeypatch)
        with pytest.raises(ValueError, match="Cancele primeiro as recompras"):
            TransactionService.cancel_transaction("tx-1", "admin-9", "desistiu")
        # Nada foi movido: a venda continua ativa e o caixa intacto.
        assert fake.store["transactions"][0]["status"] == "active"
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 1000.0

    def test_depois_de_cancelar_a_recompra_o_buy_in_libera(self, monkeypatch):
        fake = self._com_rebuy_ativo(monkeypatch, status_do_rebuy="cancelled")
        TransactionService.cancel_transaction("tx-1", "admin-9", "desistiu")
        assert fake.store["transactions"][0]["status"] == "cancelled"

    def test_cancelar_a_propria_recompra_continua_livre(self, monkeypatch):
        """A guarda vale so para o buy-in: o rebuy se cancela sozinho."""
        fake = self._com_rebuy_ativo(monkeypatch)
        TransactionService.cancel_transaction("tx-2", "admin-9", "recompra indevida")
        assert fake.store["transactions"][1]["status"] == "cancelled"


class TestEstornoRetomavel:
    """O estorno mexe em QUATRO lugares e nao e uma transacao de banco. Se um
    passo estoura no meio, a venda fica em 'cancelling' e a retentativa retoma
    so o que faltou — antes ela via 'ja cancelada', respondia sucesso e o caixa
    ficava inflado para sempre."""

    def _quebra_o_caixa_do_operador(self, monkeypatch):
        original = TransactionService._desfazer_caixa_do_operador
        estado = {"falhar": True}

        def _passo(tx, valor, user_id, reason):
            if estado["falhar"]:
                raise RuntimeError("timeout no ledger do caixa")
            return original(tx, valor, user_id, reason)

        monkeypatch.setattr(
            TransactionService, "_desfazer_caixa_do_operador", staticmethod(_passo)
        )
        return estado

    def test_passo_que_falha_deixa_a_venda_em_cancelling(self, monkeypatch):
        fake = _cenario(monkeypatch)
        self._quebra_o_caixa_do_operador(monkeypatch)

        with pytest.raises(RuntimeError):
            TransactionService.cancel_transaction("tx-1", "admin-9", "erro")

        linha = fake.store["transactions"][0]
        assert linha["status"] == "cancelling"
        # Os passos que deram certo ficam registrados para a retentativa.
        assert set(linha["cancel_steps"]) == {"contadores", "caixa_etapa"}

    def test_retentativa_conclui_sem_debitar_o_caixa_de_novo(self, monkeypatch):
        fake = _cenario(monkeypatch)
        estado = self._quebra_o_caixa_do_operador(monkeypatch)

        with pytest.raises(RuntimeError):
            TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        # O admin clica de novo depois que o problema passou.
        estado["falhar"] = False
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")

        assert r.status.value == "cancelled"
        # O caixa da etapa foi debitado UMA vez so (900, nao 800).
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 900.0
        # E o passo que faltava rodou.
        assert len(fake.store["cashbox_transactions"]) == 1
        assert fake.store["transactions"][0]["cancel_steps"] == [
            "caixa_etapa", "caixa_operador", "contadores", "fidelidade"
        ]

    def test_venda_em_cancelling_ja_saiu_das_somas(self, monkeypatch):
        """Enquanto o estorno nao termina, a venda NAO pode voltar a contar: uma
        sangria nesse meio-tempo extrairia rake de dinheiro que ja voltou."""
        from app.services.transaction_filters import esta_cancelada
        assert esta_cancelada({"status": "cancelling"}) is True
        assert esta_cancelada({"status": "active"}) is False
        assert esta_cancelada({}) is False

    def test_a_leitura_do_banco_tambem_ignora_o_estorno_em_andamento(self):
        from app.services.transaction_filters import ler_transacoes_ativas
        fake = FakeSupabase({"transactions": [
            {"id": "a", "status": "active"},
            {"id": "b", "status": "cancelling"},
            {"id": "c", "status": "cancelled"},
            {"id": "d"},   # schema anterior a migracao: conta como ativa
        ]})
        linhas = ler_transacoes_ativas(
            lambda cols: fake.table("transactions").select(cols), "*"
        )
        assert [l["id"] for l in linhas] == ["a", "d"]

    def test_estorno_em_andamento_nao_e_estornado_por_outro_pedido(self, monkeypatch):
        """Segundo pedido concorrente nao pode repetir os debitos."""
        fake = _cenario(monkeypatch, venda=_venda(status="cancelling", cancel_steps=[]))
        # Chega como se a linha ja estivesse em 'cancelling' com os passos
        # concluidos: a retomada nao pode debitar nada de novo.
        fake.store["transactions"][0]["cancel_steps"] = [
            "caixa_etapa", "caixa_operador", "contadores", "fidelidade"
        ]
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert r.status.value == "cancelled"
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 1000.0
        assert fake.store["cashbox_transactions"] == []


class TestCaixaDaEtapaNoEstorno:
    def test_debita_por_update_relativo_no_banco(self, monkeypatch):
        """Ler o saldo no Python e gravar o total calculado perde um dos debitos
        quando dois cancelamentos caem juntos (ou um cancelamento junto com a
        venda seguinte, que o gatilho soma): o caixa fecharia com sobra.

        A venda vai junto no RPC porque e ela que identifica o recibo — e o
        recibo e o que impede a retentativa de debitar de novo."""
        fake = _cenario(monkeypatch)
        fake.rpcs["debit_stage_cash_register_once"] = lambda p: 900.0

        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")

        chamadas = [c for c in fake.rpc_calls if c[0].startswith("debit_stage")]
        assert chamadas == [("debit_stage_cash_register_once",
                             {"p_stage_id": STAGE, "p_amount": 100.0,
                              "p_transaction_id": "tx-1"})]
        # O caminho antigo (read-modify-write) nao rodou junto.
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 1000.0

    def test_sem_o_rpc_novo_o_estorno_usa_o_anterior(self, monkeypatch):
        """Dia do deploy ao contrario: backend novo, migracao ainda nao
        aplicada. O RPC anterior continua devolvendo o dinheiro."""
        fake = _cenario(monkeypatch)
        fake.rpcs["debit_stage_cash_register"] = lambda p: 900.0

        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")

        chamadas = [c[0] for c in fake.rpc_calls if c[0].startswith("debit_stage")]
        assert chamadas == ["debit_stage_cash_register_once", "debit_stage_cash_register"]
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 1000.0

    def test_sem_o_rpc_o_estorno_ainda_devolve_o_dinheiro(self, monkeypatch):
        """Migracao ainda nao aplicada: melhor a corrida rara do que deixar o
        caixa da etapa inflado com certeza."""
        fake = _cenario(monkeypatch)   # nenhum RPC registrado => o fake estoura
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 900.0

    def test_avisa_quando_o_dinheiro_ja_tinha_sido_sangrado(self, monkeypatch):
        """A sangria ja mandou esse dinheiro para o caixa geral e para o rake, e
        o estorno nao corrige nenhum dos dois. Sem aviso, o DRE fecha para mais e
        a proxima sangria e recusada por 'saldo insuficiente' sem explicacao."""
        fake = _cenario(monkeypatch, tabelas={
            "stage_cash_register": [{"id": "sc1", "stage_id": STAGE,
                                     "current_balance": 50, "total_received": 1000,
                                     "total_sangrias": 950}],
        })
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")

        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == -50.0
        assert any("negativo" in a and "R$ 50.00" in a for a in r.cancel_warnings)
        assert any("caixa geral" in a for a in r.cancel_warnings)

    def test_avisa_o_rake_quando_a_etapa_ja_teve_sangria(self, monkeypatch):
        fake = _cenario(monkeypatch, tabelas={
            "stage_cash_register": [{"id": "sc1", "stage_id": STAGE,
                                     "current_balance": 1000, "total_received": 2000,
                                     "total_sangrias": 500}],
        })
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 900.0
        assert any("rake" in a for a in r.cancel_warnings)

    def test_etapa_sem_sangria_nao_gera_aviso(self, monkeypatch):
        _cenario(monkeypatch)
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert r.cancel_warnings == []


class TestFidelidadeNoEstorno:
    """O motor de ganho credita DUAS coisas: pontos (com linha no extrato) e
    cashback (so o saldo, sem linha nenhuma). O cashback vira credito gastavel no
    Caixa — deixa-lo com o jogador e o clube pagando duas vezes pela venda."""

    def _com_fidelidade(self, monkeypatch, conta=None, tiers=None, recibo=None):
        base = {"player_id": PLAYER, "organization_id": ORG,
                "points_balance": 500, "lifetime_points": 800,
                "cashback_balance": 30}
        base.update(conta or {})
        extrato = {"id": "l1", "transaction_id": "tx-1", "player_id": PLAYER,
                   "delta": 100, "balance_after": 500, "reason": "earn_buy_in"}
        if recibo is not None:
            extrato["cashback_delta"] = recibo
        return _cenario(monkeypatch, tabelas={
            "loyalty_accounts": [base],
            "loyalty_ledger": [extrato],
            "loyalty_settings": [{"organization_id": ORG, "cashback_percent": 5}],
            "loyalty_tiers": tiers or [],
        })

    def test_estorna_o_cashback_que_a_venda_registrou(self, monkeypatch):
        # Com recibo na linha do extrato, o valor e o EXATO da compra: R$ 5 que
        # o jogador nao pode ficar tendo.
        fake = self._com_fidelidade(monkeypatch, recibo=5)
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 25.0

    def test_o_percentual_do_nivel_vence_o_padrao_da_org_na_estimativa(self, monkeypatch):
        """Mesma regra do gatilho de ganho: o perk do tier manda. Sem recibo o
        numero so aparece no AVISO — ninguem perde saldo por estimativa."""
        fake = self._com_fidelidade(
            monkeypatch,
            conta={"tier_id": "tier-ouro"},
            tiers=[{"id": "tier-ouro", "organization_id": ORG, "min_points": 500,
                    "cashback_percent": 10}],
        )
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 30.0
        assert any("R$ 10.00" in a for a in r.cancel_warnings)

    def test_avisa_quando_o_cashback_ja_virou_credito(self, monkeypatch):
        """loyalty_convert_cashback ja transformou o saldo em credito gastavel:
        nao da para tirar de volta sem mexer no credito do jogador."""
        fake = self._com_fidelidade(monkeypatch, conta={"cashback_balance": 2}, recibo=5)
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 0.0
        assert any("cashback" in a and "credito" in a.lower().replace("é", "e")
                   for a in r.cancel_warnings)

    def test_rebaixa_o_nivel_junto_com_os_pontos(self, monkeypatch):
        """Sem recalcular o tier, o jogador fica VIP para sempre por uma compra
        que nao existiu — com multiplicador de pontos e cashback maiores em
        TODAS as compras seguintes."""
        fake = self._com_fidelidade(
            monkeypatch,
            conta={"tier_id": "tier-ouro", "lifetime_points": 750},
            tiers=[
                {"id": "tier-bronze", "organization_id": ORG, "min_points": 0},
                {"id": "tier-ouro", "organization_id": ORG, "min_points": 700},
            ],
        )
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        conta = fake.store["loyalty_accounts"][0]
        assert float(conta["lifetime_points"]) == 650.0
        assert conta["tier_id"] == "tier-bronze"

    def test_nao_estorna_a_fidelidade_duas_vezes_na_retomada(self, monkeypatch):
        fake = self._com_fidelidade(monkeypatch, recibo=5)
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        # Simula a retomada de um estorno interrompido depois da fidelidade.
        TransactionService._desfazer_fidelidade(fake.store["transactions"][0], 100.0)
        conta = fake.store["loyalty_accounts"][0]
        assert float(conta["points_balance"]) == 400.0
        assert float(conta["cashback_balance"]) == 25.0

    def test_falha_na_fidelidade_vira_log_e_aviso(self, monkeypatch, caplog):
        """Antes isso era um `except: pass`: o jogador ficava com os pontos de
        uma venda estornada e ninguem descobria."""
        fake = self._com_fidelidade(monkeypatch)

        def _explode(tx, conta, org, valor, extrato):
            raise RuntimeError("RLS em loyalty_accounts")

        monkeypatch.setattr(
            TransactionService, "_cashback_da_venda", staticmethod(_explode)
        )
        with caplog.at_level("ERROR"):
            r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")

        # O dinheiro foi estornado assim mesmo — fidelidade nao trava o caixa.
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 900.0
        assert any("fidelidade" in a for a in r.cancel_warnings)
        assert "Falha ao estornar a fidelidade" in caplog.text


class TestTrocaDeFormaDePagamento:
    def test_troca_so_o_rotulo_e_nao_mexe_em_dinheiro(self, monkeypatch):
        """Corrigir 'recebi no PIX, marquei dinheiro' nao pode mover caixa,
        bolsa de premios nem fidelidade."""
        fake = _cenario(monkeypatch)
        r = TransactionService.update_payment_method("tx-1", "pix")

        assert r.payment_method == "pix"
        linha = fake.store["transactions"][0]
        assert float(linha["amount"]) == 100.0
        assert float(linha["rake_amount"]) == 20.0
        assert linha["type"] == "buy_in"
        assert linha["payment_source"] == "cash"
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 1000.0

    def test_observacao_e_opcional(self, monkeypatch):
        fake = _cenario(monkeypatch)
        TransactionService.update_payment_method("tx-1", "pix", "cliente pagou depois")
        assert fake.store["transactions"][0]["notes"] == "cliente pagou depois"

    def test_venda_cancelada_nao_aceita_troca(self, monkeypatch):
        _cenario(monkeypatch, venda=_venda(status="cancelled"))
        with pytest.raises(ValueError, match="cancelada"):
            TransactionService.update_payment_method("tx-1", "pix")

    def test_transacao_inexistente_avisa(self, monkeypatch):
        _cenario(monkeypatch)
        with pytest.raises(ValueError, match="não encontrada"):
            TransactionService.update_payment_method("nao-existe", "pix")


class TestCamposSerializados:
    def test_o_extrato_devolve_tipo_de_buy_rake_e_origem(self, monkeypatch):
        """Sem esses campos o Caixa nao consegue mostrar o TIPO vendido nem
        decidir se a venda pode ser cancelada."""
        _cenario(monkeypatch, venda=_venda(buy_type_id="bt-1"))
        r = TransactionService.get_transactions()
        assert r[0].buy_type_id == "bt-1"
        assert r[0].rake_amount == 20
        assert r[0].rake_percentage == 20
        assert r[0].payment_source == "cash"
        assert r[0].status.value == "active"

    def test_venda_antiga_sem_status_conta_como_ativa(self, monkeypatch):
        # Enquanto a migracao nao roda, a coluna nao vem do banco.
        linha = _venda()
        linha.pop("status")
        _cenario(monkeypatch, venda=linha)
        assert TransactionService.get_transactions()[0].status.value == "active"


# ---------------------------------------------------------------------------
# Estorno REPETIVEL: os passos precisam de guarda PROPRIA
# ---------------------------------------------------------------------------
# `cancel_steps` sozinho nao basta. Ele e gravado numa SEGUNDA chamada, depois
# do passo, e o service engole o erro dessa gravacao de proposito (perder o
# marcador e menos grave do que perder o estorno inteiro). Resultado: o passo
# pode ter rodado e o marcador nao existir. Se o passo nao for repetivel, o
# admin que clica "cancelar" de novo cobra o clube duas vezes pela mesma venda.

def _rpc_com_recibo(fake):
    """RPC do caixa da etapa como o banco passa a se comportar depois da
    migracao: grava o recibo da venda e so debita se ele for novo."""
    def _debita(p):
        recibos = fake.store.setdefault("stage_cash_refunds", [])
        caixa = fake.store["stage_cash_register"][0]
        if any(r["transaction_id"] == p["p_transaction_id"] for r in recibos):
            return float(caixa["current_balance"])
        recibos.append({"transaction_id": p["p_transaction_id"],
                        "stage_id": p["p_stage_id"], "amount": p["p_amount"]})
        caixa["current_balance"] = round(float(caixa["current_balance"]) - p["p_amount"], 2)
        caixa["total_received"] = round(float(caixa["total_received"]) - p["p_amount"], 2)
        return float(caixa["current_balance"])

    fake.rpcs["debit_stage_cash_register_once"] = _debita
    return fake


def _rpc_dos_contadores(fake):
    """RPC dos contadores como o banco passa a se comportar depois da migracao
    (undo_entry_counters_once): grava o recibo da venda e so mexe nos contadores
    se ele for novo. Decremento RELATIVO — uma recompra vendida no mesmo
    instante continua contando."""
    def _acerta(p):
        recibos = fake.store.setdefault("transaction_counter_refunds", [])
        tx = next((t for t in fake.store["transactions"]
                   if t["id"] == p["p_transaction_id"]), None)
        if not tx or not tx.get("tournament_player_id"):
            return False
        if any(r["transaction_id"] == p["p_transaction_id"] for r in recibos):
            return False   # ja acertada: nao mexe em nada
        recibos.append({"transaction_id": p["p_transaction_id"],
                        "tournament_player_id": tx["tournament_player_id"]})
        tp = next((r for r in fake.store["tournament_players"]
                   if r["id"] == tx["tournament_player_id"]), None)
        if tp is None:
            return False
        dia = next((d for d in fake.store.get("tournament_days", [])
                    if d["id"] == tp.get("tournament_day_id")), None) or {}
        valor = float(tx.get("amount") or 0)
        if tx["type"] in ("rebuy", "addon"):
            conta = "rebuy_count" if tx["type"] == "rebuy" else "addon_count"
            total = "total_rebuy_amount" if tx["type"] == "rebuy" else "total_addon_amount"
            fichas = int(dia.get("rebuy_chips" if tx["type"] == "rebuy" else "addon_chips") or 0)
            tp[conta] = max(int(tp.get(conta) or 0) - 1, 0)
            tp[total] = max(round(float(tp.get(total) or 0) - valor, 2), 0.0)
            tp["total_chips"] = max(int(tp.get("total_chips") or 0) - fichas, 0)
        else:
            tp.update({"status": "cancelled", "total_buy_in_amount": 0,
                       "buy_in_count": 0, "total_chips": 0})
            if dia:
                dia["registered_players"] = max(int(dia.get("registered_players") or 0) - 1, 0)
        tp["total_spent"] = round(
            float(tp.get("total_buy_in_amount") or 0)
            + float(tp.get("total_rebuy_amount") or 0)
            + float(tp.get("total_addon_amount") or 0), 2)
        return True

    fake.rpcs["undo_entry_counters_once"] = _acerta
    return fake


def _perde_o_marcador(monkeypatch):
    """`_registrar_passo` falha em silencio, como ele mesmo se permite fazer."""
    monkeypatch.setattr(
        TransactionService, "_registrar_passo",
        staticmethod(lambda transaction_id, feitos: None),
    )


def _quebra_o_passo_seguinte(monkeypatch):
    original = TransactionService._desfazer_caixa_do_operador
    estado = {"falhar": True}

    def _passo(tx, valor, user_id, reason):
        if estado["falhar"]:
            raise RuntimeError("timeout no ledger do caixa")
        return original(tx, valor, user_id, reason)

    monkeypatch.setattr(
        TransactionService, "_desfazer_caixa_do_operador", staticmethod(_passo)
    )
    return estado


class TestRetentativaComMarcadorPerdido:
    def _tenta_duas_vezes(self, monkeypatch, fake):
        _rpc_com_recibo(fake)
        _rpc_dos_contadores(fake)
        _perde_o_marcador(monkeypatch)
        estado = _quebra_o_passo_seguinte(monkeypatch)
        with pytest.raises(RuntimeError):
            TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        estado["falhar"] = False
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")

    def test_o_caixa_da_etapa_nao_e_debitado_duas_vezes(self, monkeypatch):
        """Sem recibo no banco, o segundo clique tirava outros R$ 100 do caixa
        da etapa por uma venda so - e a etapa fechava faltando um dinheiro que
        ninguem tirou da gaveta."""
        fake = _cenario(monkeypatch)
        self._tenta_duas_vezes(monkeypatch, fake)
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 900.0
        assert float(fake.store["stage_cash_register"][0]["total_received"]) == 900.0

    def test_o_dia_nao_perde_dois_inscritos_por_um_buy_in(self, monkeypatch):
        """Descontar o inscrito duas vezes faz o dia parecer mais vazio do que
        esta, e o Caixa passa a aceitar jogador acima do limite da sala."""
        fake = _cenario(monkeypatch)
        self._tenta_duas_vezes(monkeypatch, fake)
        assert fake.store["tournament_days"][0]["registered_players"] == 9

    def test_a_recompra_nao_e_descontada_duas_vezes(self, monkeypatch):
        """Quem barra a repeticao e o RECIBO do banco, gravado na mesma
        instrucao que desconta — nao um marcador escrito depois. Sem ele o
        jogador voltaria para a mesa com 10.000 fichas a menos do que comprou."""
        fake = _cenario(monkeypatch, venda=_venda(tipo="rebuy"))
        self._tenta_duas_vezes(monkeypatch, fake)
        tp = fake.store["tournament_players"][0]
        assert tp["rebuy_count"] == 0
        assert float(tp["total_rebuy_amount"]) == 0.0
        assert tp["total_chips"] == 20000

    def test_o_addon_nao_e_descontado_duas_vezes(self, monkeypatch):
        fake = _cenario(monkeypatch, venda=_venda(tipo="addon"))
        self._tenta_duas_vezes(monkeypatch, fake)
        tp = fake.store["tournament_players"][0]
        assert tp["addon_count"] == 0
        assert float(tp["total_addon_amount"]) == 0.0
        assert tp["total_chips"] == 20000

    def test_o_desconto_preserva_a_recompra_que_continua_valendo(self, monkeypatch):
        """Cancelar UMA das duas recompras nao pode zerar a outra: o jogador
        pagou por ela e as fichas estao na mesa."""
        fake = _cenario(
            monkeypatch,
            jogador={"rebuy_count": 2, "total_rebuy_amount": 200, "total_chips": 40000},
            tabelas={"transactions": [
                _venda(tipo="rebuy", id="tx-1"),
                _venda(tipo="rebuy", id="tx-2"),
            ]},
        )
        self._tenta_duas_vezes(monkeypatch, fake)
        tp = fake.store["tournament_players"][0]
        assert tp["rebuy_count"] == 1
        assert float(tp["total_rebuy_amount"]) == 100.0
        assert tp["total_chips"] == 30000


class TestContadoresSaoDecrementados:
    """O contador do jogador e DECREMENTADO (menos uma recompra), nunca
    recontado pelas vendas que sobraram. `add_rebuy` grava rebuy_count e
    total_chips ANTES de inserir a linha em `transactions` e sem atomicidade:
    quando a insercao falha, o contador fica a frente das vendas. Recontar
    nesse estado faz UM cancelamento tirar DUAS recompras do stack de um
    jogador que esta na mesa com as fichas na frente dele."""

    def test_contador_a_frente_das_vendas_perde_so_uma_recompra(self, monkeypatch):
        """Tres recompras vendidas, a terceira insercao em `transactions` falhou:
        rebuy_count=3 com 2 linhas. Cancelar UMA tem de tirar UMA."""
        fake = _cenario(
            monkeypatch,
            venda=_venda(tipo="rebuy", id="tx-1"),
            jogador={"rebuy_count": 3, "total_rebuy_amount": 300, "total_chips": 50000},
            tabelas={"transactions": [
                _venda(tipo="rebuy", id="tx-1"),
                _venda(tipo="rebuy", id="tx-2"),
            ]},
        )
        TransactionService.cancel_transaction("tx-1", "admin-9", "recompra indevida")
        tp = fake.store["tournament_players"][0]
        assert tp["rebuy_count"] == 2
        assert float(tp["total_rebuy_amount"]) == 200.0
        assert tp["total_chips"] == 40000

    def test_com_o_recibo_do_banco_o_service_nao_regrava_contador_lido_antes(self, monkeypatch):
        """Depois da migracao quem mexe nos contadores e o BANCO, com update
        RELATIVO. O service nao pode regravar um total calculado da leitura que
        fez antes: a recompra vendida ao mesmo jogador nesse instante teria as
        fichas apagadas. Aqui o RPC nao faz nada de proposito — se o service
        insistir em calcular, o contador muda e o teste denuncia."""
        fake = _cenario(monkeypatch, venda=_venda(tipo="rebuy"))
        fake.rpcs["undo_entry_counters_once"] = lambda p: False

        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")

        tp = fake.store["tournament_players"][0]
        assert tp["rebuy_count"] == 1
        assert tp["total_chips"] == 30000
        assert [c[0] for c in fake.rpc_calls if c[0] == "undo_entry_counters_once"] == [
            "undo_entry_counters_once"
        ]

    def test_cancelar_a_ultima_recompra_devolve_a_eliminacao(self, monkeypatch):
        """Simetria com a venda: a recompra baixa o contador de eliminacoes
        (quem recompra volta a mesa), entao o estorno devolve.

        Sem isto o telao fica com um jogador ativo A MAIS para sempre, e ninguem
        percebe — o numero esta a um digito do certo.

        Este e o caminho ANTERIOR a migracao; onde o RPC existe, o mesmo acerto
        acontece dentro dele, na mesma transacao e com a mesma guarda de recibo.
        """
        fake = _cenario(
            monkeypatch,
            venda=_venda(tipo="rebuy"),
            jogador={"buy_in_count": 3, "rebuy_count": 1},
            tabelas={"tournament_days": [{
                "id": DIA, "tournament_id": TOUR, "registered_players": 10,
                "rebuy_chips": 10000, "addon_chips": 10000,
                "eliminations_count": 1,
            }]},
        )
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert fake.store["tournament_days"][0]["eliminations_count"] == 2

    def test_o_contador_devolvido_nao_passa_do_total_de_entradas(self, monkeypatch):
        """Mais eliminados que entradas deixaria "jogadores ativos" negativo na
        TV — o mesmo defeito que estamos consertando, pelo outro lado."""
        fake = _cenario(
            monkeypatch,
            venda=_venda(tipo="rebuy"),
            jogador={"buy_in_count": 1, "rebuy_count": 1},
            tabelas={"tournament_days": [{
                "id": DIA, "tournament_id": TOUR, "registered_players": 10,
                "rebuy_chips": 10000, "addon_chips": 10000,
                "eliminations_count": 1,
            }]},
        )
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert fake.store["tournament_days"][0]["eliminations_count"] == 1

    def test_cancelar_uma_de_varias_recompras_nao_devolve_nada(self, monkeypatch):
        """A venda desconta UMA eliminacao por VENDA, mesmo sendo cinco
        recompras de uma vez. Devolver uma por transacao cancelada faria sair 1
        e voltarem 5 — o jogador que continua com recompras nao voltou a estar
        fora da mesa."""
        fake = _cenario(
            monkeypatch,
            venda=_venda(tipo="rebuy"),
            jogador={"buy_in_count": 3, "rebuy_count": 5},
            tabelas={"tournament_days": [{
                "id": DIA, "tournament_id": TOUR, "registered_players": 10,
                "rebuy_chips": 10000, "addon_chips": 10000,
                "eliminations_count": 1,
            }]},
        )
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert fake.store["tournament_players"][0]["rebuy_count"] == 4
        assert fake.store["tournament_days"][0]["eliminations_count"] == 1

    def test_cancelar_add_on_nao_mexe_no_contador(self, monkeypatch):
        """Add-on nunca tirou ninguem da mesa: quem faz add-on ja esta jogando."""
        fake = _cenario(
            monkeypatch,
            venda=_venda(tipo="addon"),
            jogador={"buy_in_count": 3},
            tabelas={"tournament_days": [{
                "id": DIA, "tournament_id": TOUR, "registered_players": 10,
                "rebuy_chips": 10000, "addon_chips": 10000,
                "eliminations_count": 1,
            }]},
        )
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert fake.store["tournament_days"][0]["eliminations_count"] == 1

    def test_o_acerto_na_mao_tambem_deixa_recibo(self, monkeypatch):
        """Quando o acerto sai pelo caminho manual (o RPC existe mas falhou na
        hora), o recibo e gravado assim mesmo — senao a proxima tentativa
        chamaria o RPC e tiraria as fichas do jogador pela segunda vez."""
        fake = _cenario(monkeypatch, venda=_venda(tipo="rebuy"))
        _rpc_com_recibo(fake)
        _perde_o_marcador(monkeypatch)
        estado = _quebra_o_passo_seguinte(monkeypatch)

        with pytest.raises(RuntimeError):
            TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        # O RPC dos contadores passa a existir (foi um erro passageiro).
        _rpc_dos_contadores(fake)
        estado["falhar"] = False
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")

        tp = fake.store["tournament_players"][0]
        assert tp["rebuy_count"] == 0
        assert tp["total_chips"] == 20000

    def test_recibo_ja_gravado_nao_desconta_de_novo(self, monkeypatch):
        """Guarda PROPRIA do passo, independente de `cancel_steps`: existindo o
        recibo da venda, o acerto dos contadores nem e tentado."""
        fake = _cenario(monkeypatch, venda=_venda(tipo="rebuy"))
        fake.store["transaction_counter_refunds"] = [{"transaction_id": "tx-1"}]
        _rpc_dos_contadores(fake)

        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")

        tp = fake.store["tournament_players"][0]
        assert tp["rebuy_count"] == 1
        assert tp["total_chips"] == 30000
        assert [c for c in fake.rpc_calls if c[0] == "undo_entry_counters_once"] == []


class TestRetomadaDoBuyIn:
    """A primeira tentativa gravou o status da inscricao e estourou no update do
    dia (timeout/RLS). O passo 'contadores' NAO foi marcado e a venda ficou em
    'cancelling'. A retomada precisa terminar o servico: se ela sair pela guarda
    de status, o dia fica com um inscrito a mais PARA SEMPRE (o Caixa recusa o
    proximo jogador por max_players), a cadeira segue presa a quem nao esta no
    evento — e o cancelamento responde SUCESSO."""

    def _parou_depois_de_desfazer_a_inscricao(self, monkeypatch):
        return _cenario(
            monkeypatch,
            venda=_venda(status="cancelling", cancel_steps=[]),
            jogador={"status": "cancelled", "total_buy_in_amount": 0,
                     "buy_in_count": 0, "total_chips": 0},
            tabelas={"seat_allocations": [
                {"id": "sa1", "tournament_id": TOUR, "player_id": PLAYER,
                 "tournament_day_id": DIA, "seat_number": 3},
            ]},
        )

    def test_a_retomada_ainda_desconta_o_inscrito_do_dia(self, monkeypatch):
        fake = self._parou_depois_de_desfazer_a_inscricao(monkeypatch)
        TransactionService.cancel_transaction("tx-1", "admin-9", "desistiu")
        assert fake.store["tournament_days"][0]["registered_players"] == 9

    def test_a_retomada_ainda_libera_a_cadeira(self, monkeypatch):
        fake = self._parou_depois_de_desfazer_a_inscricao(monkeypatch)
        TransactionService.cancel_transaction("tx-1", "admin-9", "desistiu")
        assert fake.store["seat_allocations"] == []

    def test_com_o_banco_no_comando_a_retomada_tambem_termina(self, monkeypatch):
        """Mesmo cenario com a migracao aplicada: o recibo ainda nao existe
        (o passo nao chegou ao fim), entao o banco desconta o inscrito."""
        fake = self._parou_depois_de_desfazer_a_inscricao(monkeypatch)
        _rpc_dos_contadores(fake)
        TransactionService.cancel_transaction("tx-1", "admin-9", "desistiu")
        assert fake.store["tournament_days"][0]["registered_players"] == 9
        assert fake.store["seat_allocations"] == []

    def test_o_dia_nao_e_recontado_pelas_inscricoes(self, monkeypatch):
        """`registered_players` do dia FINAL tambem recebe os classificados que
        `_avancar_por_contador` soma sem criar linha em `tournament_players`.
        Recontar as inscricoes apagaria todos eles de uma vez — por isso o
        cancelamento tira UM, e so."""
        fake = _cenario(monkeypatch, tabelas={
            "tournament_days": [{"id": DIA, "tournament_id": TOUR,
                                 "registered_players": 40,
                                 "rebuy_chips": 10000, "addon_chips": 10000}],
        })
        TransactionService.cancel_transaction("tx-1", "admin-9", "desistiu")
        assert fake.store["tournament_days"][0]["registered_players"] == 39


class TestFallbackDoCaixaDaEtapa:
    """O RPC commita no servidor. Cair no caminho antigo depois disso debita o
    mesmo dinheiro de novo - e para isso nem e preciso haver excecao."""

    def test_rpc_que_responde_vazio_nao_debita_pelo_caminho_antigo(self, monkeypatch):
        """`current_balance` nulo (ou lista vazia) devolve None: e saldo
        DESCONHECIDO, nao 'nao debitei'."""
        fake = _cenario(monkeypatch)

        def _debita_sem_devolver_saldo(p):
            caixa = fake.store["stage_cash_register"][0]
            caixa["current_balance"] = round(float(caixa["current_balance"]) - p["p_amount"], 2)
            return []

        fake.rpcs["debit_stage_cash_register_once"] = _debita_sem_devolver_saldo
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 900.0

    def test_resposta_perdida_depois_do_commit_nao_debita_de_novo(self, monkeypatch):
        """A conexao cai DEPOIS do commit: o recibo ja esta gravado e e ele que
        impede o caminho antigo de tirar o dinheiro pela segunda vez."""
        fake = _cenario(monkeypatch)

        def _commita_e_perde_a_resposta(p):
            caixa = fake.store["stage_cash_register"][0]
            caixa["current_balance"] = round(float(caixa["current_balance"]) - p["p_amount"], 2)
            fake.store.setdefault("stage_cash_refunds", []).append(
                {"transaction_id": p["p_transaction_id"], "stage_id": p["p_stage_id"],
                 "amount": p["p_amount"]}
            )
            raise RuntimeError("connection reset by peer")

        fake.rpcs["debit_stage_cash_register_once"] = _commita_e_perde_a_resposta
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 900.0

    def test_recibo_ja_gravado_impede_chamar_o_debito_de_novo(self, monkeypatch):
        """Guarda PROPRIA do passo, independente de `cancel_steps`: existindo o
        recibo da venda, o estorno do caixa da etapa nem e tentado."""
        fake = _cenario(monkeypatch)
        fake.store["stage_cash_refunds"] = [
            {"transaction_id": "tx-1", "stage_id": STAGE, "amount": 100}
        ]
        # RPC "burro" de proposito: se for chamado, debita.
        fake.rpcs["debit_stage_cash_register_once"] = lambda p: 800.0
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert [c for c in fake.rpc_calls if c[0].startswith("debit_stage")] == []
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 1000.0

    def test_sem_a_migracao_o_estorno_ainda_devolve_o_dinheiro(self, monkeypatch):
        """Dia do deploy: nenhum dos dois RPCs existe. Melhor a corrida rara do
        que deixar o caixa da etapa inflado com certeza."""
        fake = _cenario(monkeypatch)
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["stage_cash_register"][0]["current_balance"]) == 900.0


class TestEstornoComCaixaDoOperadorFechado:
    """Caso mais comum de todos: o admin cancela no dia seguinte. Com
    `session_id` nulo o lancamento sumia do extrato (get_session_reports le por
    sessao) e o desconto no saldo era apagado na abertura seguinte, que regrava
    `current_balance = initial_balance`. Ficava o buy-in sem a devolucao."""

    def _caixa_fechado(self, monkeypatch, lancamentos=None, sessoes=None):
        return _cenario(monkeypatch, tabelas={
            "cashboxes": [{"id": CAIXA, "current_session_id": None,
                           "status": "closed", "current_balance": 0}],
            "cashbox_transactions": lancamentos if lancamentos is not None else [
                {"id": "ct-1", "cashbox_id": CAIXA, "session_id": "sess-7",
                 "type": "buy_in", "amount": 100, "signed_amount": 100,
                 "transaction_id": "tx-1"},
            ],
            "cashbox_sessions": sessoes if sessoes is not None else [
                {"id": "sess-7", "cashbox_id": CAIXA, "opened_at": "2026-06-07T20:00:00Z"},
            ],
        })

    def test_o_estorno_entra_na_sessao_que_registrou_a_venda(self, monkeypatch):
        fake = self._caixa_fechado(monkeypatch)
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        estorno = [l for l in fake.store["cashbox_transactions"] if l["type"] == "refund"][0]
        assert estorno["session_id"] == "sess-7"
        assert float(estorno["signed_amount"]) == -100.0

    def test_avisa_que_a_devolucao_cai_numa_sessao_ja_fechada(self, monkeypatch):
        """O dinheiro sai do caixa geral, nao da gaveta do operador - sem o
        aviso, a diferenca aparece no relatorio dele sem explicacao."""
        self._caixa_fechado(monkeypatch)
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert any("fechado" in a for a in r.cancel_warnings)

    def test_sem_lancamento_da_venda_cai_na_ultima_sessao_do_caixa(self, monkeypatch):
        """Venda anterior ao espelhamento no caixa modular: melhor no extrato da
        sessao mais recente do que fora do extrato."""
        fake = self._caixa_fechado(monkeypatch, lancamentos=[], sessoes=[
            {"id": "sess-antiga", "cashbox_id": CAIXA, "opened_at": "2026-06-01T20:00:00Z"},
            {"id": "sess-nova", "cashbox_id": CAIXA, "opened_at": "2026-06-07T20:00:00Z"},
        ])
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert fake.store["cashbox_transactions"][0]["session_id"] == "sess-nova"

    def test_caixa_aberto_continua_usando_a_sessao_do_momento(self, monkeypatch):
        """Cancelamento na hora: o dinheiro sai da gaveta que esta aberta, e nao
        ha aviso nenhum a dar."""
        fake = _cenario(monkeypatch)
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert fake.store["cashbox_transactions"][0]["session_id"] == "sess-1"
        assert r.cancel_warnings == []

    def test_avisa_quando_a_sessao_aberta_nao_e_a_da_venda(self, monkeypatch):
        """A venda foi ONTEM e o operador abriu o caixa HOJE. A devolucao cai na
        sessao de hoje (a unica em que ainda pode entrar) e o operador de hoje
        fecha a noite faltando um dinheiro que o ADMIN entregou ao jogador — que
        e exatamente o que este passo existe para evitar."""
        fake = _cenario(monkeypatch, tabelas={
            "cashboxes": [{"id": CAIXA, "current_session_id": "sess-hoje",
                           "current_balance": 500}],
            "cashbox_transactions": [
                {"id": "ct-1", "cashbox_id": CAIXA, "session_id": "sess-ontem",
                 "type": "buy_in", "amount": 100, "signed_amount": 100,
                 "transaction_id": "tx-1"},
            ],
        })
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")

        estorno = [l for l in fake.store["cashbox_transactions"] if l["type"] == "refund"][0]
        assert estorno["session_id"] == "sess-hoje"
        assert any("outra sessão" in a and "caixa geral" in a for a in r.cancel_warnings)


class TestCashbackSoQuandoAVendaGerou:
    """O motor de ganho (loyalty_earn_on_transaction) so credita quando as TRES
    condicoes valem: plano PRO/PREMIUM, programa habilitado e o tipo da venda
    dentro de `earn_on`. O estorno ignorava as tres e debitava sempre - tirando
    do jogador um cashback que ele ganhou em OUTRAS compras."""

    def _sem_extrato(self, monkeypatch, plano="pro", habilitado=True,
                     earn_on=("buy_in", "rebuy", "addon"), tipo="buy_in"):
        return _cenario(monkeypatch, venda=_venda(tipo=tipo), tabelas={
            "organizations": [{"id": ORG, "plan_code": plano}],
            "loyalty_accounts": [{"player_id": PLAYER, "organization_id": ORG,
                                  "points_balance": 0, "lifetime_points": 0,
                                  "cashback_balance": 30}],
            "loyalty_ledger": [],
            "loyalty_settings": [{"organization_id": ORG, "cashback_percent": 5,
                                  "enabled": habilitado, "earn_on": list(earn_on)}],
            "loyalty_tiers": [],
        })

    def test_org_fora_do_plano_nao_perde_cashback(self, monkeypatch):
        """org_has_loyalty() so vale para PRO/PREMIUM: nesta org o gatilho nunca
        creditou nada, entao nao ha nada a devolver."""
        fake = self._sem_extrato(monkeypatch, plano="standard")
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 30.0

    def test_programa_desligado_nao_perde_cashback(self, monkeypatch):
        fake = self._sem_extrato(monkeypatch, habilitado=False)
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 30.0

    def test_tipo_fora_do_earn_on_nao_perde_cashback(self, monkeypatch):
        """`earn_on` = {buy_in, rebuy}: o add-on nunca gerou cashback."""
        fake = self._sem_extrato(monkeypatch, earn_on=("buy_in", "rebuy"), tipo="addon")
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 30.0

    def test_venda_antiga_e_estimada_e_avisada_mas_nunca_debitada(self, monkeypatch):
        """Sem recibo da epoca, o percentual sairia do nivel de HOJE: quem
        comprou como Bronze (0%) e subiu para Prata (1%) teria estornado um
        cashback que aquela compra nunca creditou. Cashback e dinheiro do
        jogador e nao ha extrato dele para conferir — entao a estimativa vira
        AVISO, e o admin decide. Errar a favor do jogador custa centavos e se
        desfaz num clique; errar contra, nao."""
        fake = self._sem_extrato(monkeypatch)
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 30.0
        assert any("NADA foi debitado" in a and "R$ 5.00" in a
                   for a in r.cancel_warnings)

    def test_fidelidade_indisponivel_nao_tira_dinheiro_do_jogador(self, monkeypatch):
        """Sem conseguir conferir as condicoes, o estorno nao chuta: avisa."""
        fake = self._sem_extrato(monkeypatch)
        original = fake.table

        def _sem_organizations(nome):
            if nome == "organizations":
                raise RuntimeError("timeout")
            return original(nome)

        monkeypatch.setattr(fake, "table", _sem_organizations)
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 30.0
        assert any("cashback" in a for a in r.cancel_warnings)


class TestCashbackPeloReciboDoExtrato:
    """Recalcular `valor * %` usa o percentual do nivel de HOJE. Quem comprou
    como Bronze (0%) e depois subiu para Prata (1%) tinha a venda antiga
    estornada a 1% - dinheiro que aquela compra nunca creditou."""

    def _com_recibo(self, monkeypatch, cashback_delta):
        return _cenario(monkeypatch, tabelas={
            "organizations": [{"id": ORG, "plan_code": "pro"}],
            "loyalty_accounts": [{"player_id": PLAYER, "organization_id": ORG,
                                  "points_balance": 500, "lifetime_points": 800,
                                  "cashback_balance": 30, "tier_id": "tier-prata"}],
            "loyalty_ledger": [{"id": "l1", "transaction_id": "tx-1", "player_id": PLAYER,
                                "delta": 100, "balance_after": 500, "reason": "earn_buy_in",
                                "cashback_delta": cashback_delta}],
            "loyalty_settings": [{"organization_id": ORG, "cashback_percent": 0,
                                  "enabled": True, "earn_on": ["buy_in", "rebuy", "addon"]}],
            "loyalty_tiers": [{"id": "tier-prata", "organization_id": ORG,
                               "min_points": 500, "cashback_percent": 1}],
        })

    def test_devolve_o_que_a_venda_creditou_e_nao_o_do_nivel_atual(self, monkeypatch):
        """Comprou como Bronze (0%) e hoje e Prata (1%): o recibo diz zero, e
        zero e o que sai do saldo dele."""
        fake = self._com_recibo(monkeypatch, cashback_delta=0)
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 30.0
        assert r.cancel_warnings == []

    def test_com_recibo_nao_ha_estimativa_nem_aviso(self, monkeypatch):
        fake = self._com_recibo(monkeypatch, cashback_delta=2)
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 28.0
        assert r.cancel_warnings == []

    def test_o_estorno_grava_o_proprio_recibo_negativo(self, monkeypatch):
        """E o que faz a retomada saber que a fidelidade desta venda ja foi
        desfeita, mesmo quando ela so gerou cashback."""
        fake = self._com_recibo(monkeypatch, cashback_delta=2)
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        estorno = [l for l in fake.store["loyalty_ledger"]
                   if float(l.get("cashback_delta") or 0) < 0]
        assert len(estorno) == 1
        assert float(estorno[0]["cashback_delta"]) == -2.0

    def test_venda_que_gerou_so_cashback_nao_e_estornada_duas_vezes(self, monkeypatch):
        """Pontos arredondam para zero em valores baixos; sem recibo negativo a
        retomada tirava o cashback do jogador de novo."""
        fake = _cenario(monkeypatch, tabelas={
            "organizations": [{"id": ORG, "plan_code": "pro"}],
            "loyalty_accounts": [{"player_id": PLAYER, "organization_id": ORG,
                                  "points_balance": 0, "lifetime_points": 0,
                                  "cashback_balance": 30}],
            "loyalty_ledger": [{"id": "l1", "transaction_id": "tx-1", "player_id": PLAYER,
                                "delta": 0, "balance_after": 0, "reason": "earn_buy_in",
                                "cashback_delta": 5}],
            "loyalty_settings": [{"organization_id": ORG, "cashback_percent": 5,
                                  "enabled": True, "earn_on": ["buy_in"]}],
            "loyalty_tiers": [],
        })
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        TransactionService._desfazer_fidelidade(fake.store["transactions"][0], 100.0)
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 25.0

    def test_recibo_de_estorno_sem_a_coluna_ainda_barra_a_retomada(self, monkeypatch):
        """Venda de valor baixo: cashback sim, pontos zero. Cancelada durante a
        janela de deploy (banco ainda sem `cashback_delta`), o estorno gravou a
        linha SEM a coluna e com delta zero. Se a retomada so procurar numero
        NEGATIVO no extrato, ela nao ve essa linha e debita o cashback do
        jogador uma segunda vez. Quem prova o estorno e o MOTIVO da linha."""
        fake = _cenario(monkeypatch, tabelas={
            "organizations": [{"id": ORG, "plan_code": "pro"}],
            "loyalty_accounts": [{"player_id": PLAYER, "organization_id": ORG,
                                  "points_balance": 0, "lifetime_points": 0,
                                  "cashback_balance": 25}],
            "loyalty_ledger": [
                {"id": "l1", "transaction_id": "tx-1", "player_id": PLAYER,
                 "delta": 0, "balance_after": 0, "reason": "earn_buy_in",
                 "cashback_delta": 5},
                # Gravada na janela de deploy: sem cashback_delta, delta zero.
                {"id": "l2", "transaction_id": "tx-1", "player_id": PLAYER,
                 "delta": 0, "balance_after": 0, "reason": "cancel_buy_in",
                 "description": "Estorno de venda cancelada"},
            ],
            "loyalty_settings": [{"organization_id": ORG, "cashback_percent": 5,
                                  "enabled": True, "earn_on": ["buy_in"]}],
            "loyalty_tiers": [],
        })
        TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 25.0

    def test_nunca_debita_mais_do_que_o_saldo(self, monkeypatch):
        """Cashback ja convertido em credito: o saldo para em zero e o admin e
        avisado, em vez de o jogador ficar com saldo negativo."""
        fake = self._com_recibo(monkeypatch, cashback_delta=50)
        r = TransactionService.cancel_transaction("tx-1", "admin-9", "erro")
        assert float(fake.store["loyalty_accounts"][0]["cashback_balance"]) == 0.0
        assert any("virado credito" in a.replace("é", "e") for a in r.cancel_warnings)
