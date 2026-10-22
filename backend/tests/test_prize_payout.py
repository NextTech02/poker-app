"""Testes do pagamento de premio — a saida de dinheiro do caixa geral.

Ha varios portoes antes do dinheiro sair, e cada um existe por um motivo:
premio ja pago (pagar duas vezes), nao liberado (pagar antes de conferir),
tipo 'vaga' (nao e dinheiro), saldo insuficiente e documento divergente
(pagar para a pessoa errada).
"""
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.services import prize_allocation_service
from app.services.prize_allocation_service import PrizeAllocationService
from app.services.cash_register_service import CashRegisterService
from app.models.prize_allocation import PrizePayoutRequest

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
ALLOC = "55555555-5555-5555-5555-555555555555"
PLAYER = "44444444-4444-4444-4444-444444444444"
DIA_ALVO = "77777777-7777-7777-7777-777777777777"


class _Caixa:
    def __init__(self, saldo):
        from decimal import Decimal
        self.current_balance = Decimal(str(saldo))
        self.id = "gc1"
        self.total_received = Decimal("0")


def _alocacao(paid=False, released=True, tipo="dinheiro", valor=500):
    return {
        "id": ALLOC, "tournament_id": TOUR, "position": 1,
        "prize_amount": valor, "percentage": 50, "paid": paid,
        "released": released, "prize_type": tipo, "player_id": PLAYER,
        "created_at": "2026-06-08T00:00:00Z", "updated_at": "2026-06-08T00:00:00Z",
    }


def _monta(monkeypatch, alocacao=None, saldo=10000, documento="123456", tabelas=None):
    base = {
        "prize_allocations": [alocacao if alocacao is not None else _alocacao()],
        "players": [{"id": PLAYER, "name": "Fulano",
                     "document_type": "national_id", "document_number": documento}],
        # Ha um portao a mais: o premio nao pode exceder o prize pool. Sem
        # entradas o pool e zero e QUALQUER pagamento seria recusado, entao o
        # cenario precisa de dinheiro entrando no torneio.
        "transactions": [
            {"id": "tx1", "tournament_id": TOUR, "type": "buy_in",
             "amount": 2000, "rake_amount": 0, "created_at": "2026-06-08T00:00:00Z"},
        ],
        "tournament_days": [{"id": "d1", "tournament_id": TOUR,
                             "rake_percentage": 0, "day_type": "regular"}],
        "tournaments": [{"id": TOUR, "guaranteed_prize": 0, "name": "Torneio",
                         "reserved_prize_percentage": 0, "reserved_purpose": None}],
        "general_cash_register": [{"id": "gc1", "current_balance": saldo,
                                   "total_received": 0, "total_withdrawals": 0}],
    }
    base.update(tabelas or {})
    fake = FakeSupabase(base)
    # O débito do caixa geral é a RPC atômica (só com saldo; NULL quando não
    # há): o fake guarda o saldo para os testes conferirem quanto saiu.
    fake.caixa_geral = Decimal(str(saldo))

    def debitar(params):
        valor = Decimal(str(params["p_amount"]))
        if fake.caixa_geral < valor:
            return None
        fake.caixa_geral -= valor
        return float(fake.caixa_geral)

    def creditar(params):
        fake.caixa_geral += Decimal(str(params["p_amount"]))
        return float(fake.caixa_geral)

    fake.rpcs["debit_general_cash_register"] = debitar
    fake.rpcs["credit_general_cash_register"] = creditar
    monkeypatch.setattr(prize_allocation_service, "supabase", fake)
    monkeypatch.setattr(CashRegisterService, "get_general_cash",
                        staticmethod(lambda: _Caixa(saldo)))
    return fake


def _pedido(documento="123456"):
    return PrizePayoutRequest(
        player_id=PLAYER, document_type="national_id",
        document_number=documento, paid_by="Caixa",
    )


class TestPortoesDoPagamento:
    def test_alocacao_inexistente_da_404(self, monkeypatch):
        _monta(monkeypatch, tabelas={"prize_allocations": []})
        arg = _pedido()
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.pay_prize(TOUR, ALLOC, arg, user_id=None)
        assert e.value.status_code == 404

    def test_premio_ja_pago_nao_paga_de_novo(self, monkeypatch):
        _monta(monkeypatch, alocacao=_alocacao(paid=True))
        arg = _pedido()
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.pay_prize(TOUR, ALLOC, arg, user_id=None)
        assert e.value.status_code == 400
        assert "already been paid" in e.value.detail["message"]

    def test_premio_nao_liberado_e_bloqueado(self, monkeypatch):
        _monta(monkeypatch, alocacao=_alocacao(released=False))
        arg = _pedido()
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.pay_prize(TOUR, ALLOC, arg, user_id=None)
        assert "não liberada" in e.value.detail["message"]

    def test_premio_do_tipo_vaga_nao_sai_em_dinheiro(self, monkeypatch):
        _monta(monkeypatch, alocacao=_alocacao(tipo="vaga"))
        arg = _pedido()
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.pay_prize(TOUR, ALLOC, arg, user_id=None)
        assert "Vaga" in e.value.detail["message"]

    def test_saldo_insuficiente_no_caixa_geral(self, monkeypatch):
        _monta(monkeypatch, alocacao=_alocacao(valor=5000), saldo=100)
        arg = _pedido()
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.pay_prize(TOUR, ALLOC, arg, user_id=None)
        assert e.value.status_code == 400

    def test_documento_divergente_bloqueia(self, monkeypatch):
        """Confere o documento apresentado contra o cadastrado: e o que evita
        pagar o premio para a pessoa errada."""
        _monta(monkeypatch, documento="999999")
        arg = _pedido("123456")
        with pytest.raises(HTTPException):
            PrizeAllocationService.pay_prize(TOUR, ALLOC, arg, user_id=None)

    def test_documento_com_pontuacao_diferente_e_aceito(self, monkeypatch):
        """'123.456-78' e '12345678' sao o mesmo documento; recusar seria
        travar o pagamento por formatacao."""
        _monta(monkeypatch, documento="123.456-78")
        r = PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido("12345678"), user_id=None)
        assert r.paid is True


class TestPagamentoEfetivo:
    def test_marca_como_pago_e_registra_o_documento(self, monkeypatch):
        fake = _monta(monkeypatch)
        r = PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)

        assert r.paid is True
        linha = fake.store["prize_allocations"][0]
        assert linha["paid"] is True
        assert linha["document_number"] == "123456"

    def test_gera_transacao_de_premio_para_rastreio(self, monkeypatch):
        """A transacao 'prize' e o que faz o premio aparecer como deducao no
        DRE; sem ela o resultado da etapa ficaria inflado."""
        fake = _monta(monkeypatch)
        PrizeAllocationService.pay_prize(TOUR, ALLOC, _pedido(), user_id=None)

        prizes = [t for t in fake.store["transactions"] if t.get("type") == "prize"]
        assert len(prizes) == 1
        assert float(prizes[0]["amount"]) == 500.0


from app.models.prize_allocation import PrizeAllocationCreate


class TestCriacaoDeAlocacao:
    def test_posicao_duplicada_e_recusada(self, monkeypatch):
        """Duas alocacoes na mesma posicao dividiriam o premio de forma
        ambigua na hora de pagar."""
        _monta(monkeypatch)
        arg = PrizeAllocationCreate(position=1, prize_amount=100)
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.create_allocation(
                TOUR, arg
            )
        assert "already has a prize allocation" in e.value.detail["message"]

    def test_cria_em_posicao_livre(self, monkeypatch):
        fake = _monta(monkeypatch)
        r = PrizeAllocationService.create_allocation(
            TOUR, PrizeAllocationCreate(position=2, prize_amount=250)
        )
        assert r.position == 2
        assert len(fake.store["prize_allocations"]) == 2

    def test_torneio_inexistente_e_recusado(self, monkeypatch):
        _monta(monkeypatch, tabelas={"tournaments": []})
        arg = PrizeAllocationCreate(position=3, prize_amount=100)
        with pytest.raises(HTTPException):
            PrizeAllocationService.create_allocation(
                TOUR, arg
            )


class TestLiberacao:
    def test_libera_para_pagamento(self, monkeypatch):
        fake = _monta(monkeypatch, alocacao=_alocacao(released=False))
        r = PrizeAllocationService.set_released(TOUR, ALLOC, released=True, user_id="u1")
        assert r.released is True
        assert fake.store["prize_allocations"][0]["released"] is True

    def test_nao_revoga_liberacao_de_premio_ja_pago(self, monkeypatch):
        """Revogar depois de pago deixaria o dinheiro fora do caixa sem um
        premio liberado que o justifique."""
        _monta(monkeypatch, alocacao=_alocacao(paid=True))
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.set_released(TOUR, ALLOC, released=False, user_id="u1")
        assert "já pago" in e.value.detail["message"]

    def test_alocacao_inexistente_da_404(self, monkeypatch):
        _monta(monkeypatch, tabelas={"prize_allocations": []})
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.set_released(TOUR, ALLOC, released=True, user_id="u1")
        assert e.value.status_code == 404


class TestExclusaoDeAlocacao:
    def test_premio_pago_nao_pode_ser_apagado(self, monkeypatch):
        """Apagar apagaria o registro de uma saida de caixa que aconteceu."""
        _monta(monkeypatch, alocacao=_alocacao(paid=True))
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.delete_allocation(TOUR, ALLOC)
        assert "Cannot delete a paid" in e.value.detail["message"]

    def test_premio_nao_pago_e_apagado(self, monkeypatch):
        fake = _monta(monkeypatch, alocacao=_alocacao(paid=False))
        PrizeAllocationService.delete_allocation(TOUR, ALLOC)
        assert fake.store["prize_allocations"] == []

    def test_inexistente_da_404(self, monkeypatch):
        _monta(monkeypatch, tabelas={"prize_allocations": []})
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.delete_allocation(TOUR, ALLOC)
        assert e.value.status_code == 404


class TestCriacaoEmLote:
    def test_substitui_a_tabela_de_premiacao(self, monkeypatch):
        """A tela envia a estrutura inteira; manter as antigas deixaria
        posicoes orfas de uma configuracao anterior."""
        fake = _monta(monkeypatch)
        r = PrizeAllocationService.bulk_create_allocations(TOUR, [
            PrizeAllocationCreate(position=1, prize_amount=500),
            PrizeAllocationCreate(position=2, prize_amount=300),
        ])
        assert len(r) == 2
        posicoes = sorted(a["position"] for a in fake.store["prize_allocations"])
        assert posicoes == [1, 2]

    def test_lista_vazia_apenas_limpa(self, monkeypatch):
        fake = _monta(monkeypatch)
        assert PrizeAllocationService.bulk_create_allocations(TOUR, []) == []
        assert fake.store["prize_allocations"] == []


class TestGarantia:
    def test_atualiza_o_valor_garantido(self, monkeypatch):
        from decimal import Decimal
        fake = _monta(monkeypatch)
        PrizeAllocationService.update_guaranteed_prize(TOUR, Decimal("5000"))
        assert float(fake.store["tournaments"][0]["guaranteed_prize"]) == 5000.0


from app.models.prize_allocation import PrizeAllocationUpdate


class TestEdicaoDeAlocacao:
    def test_altera_o_valor(self, monkeypatch):
        fake = _monta(monkeypatch)
        r = PrizeAllocationService.update_allocation(
            TOUR, ALLOC, PrizeAllocationUpdate(prize_amount=750)
        )
        assert float(r.prize_amount) == 750.0
        assert float(fake.store["prize_allocations"][0]["prize_amount"]) == 750.0

    def test_inexistente_da_404(self, monkeypatch):
        _monta(monkeypatch, tabelas={"prize_allocations": []})
        arg = PrizeAllocationUpdate(prize_amount=10)
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.update_allocation(
                TOUR, ALLOC, arg
            )
        assert e.value.status_code == 404


class TestPremioReservado:
    def test_configura_percentual_e_finalidade(self, monkeypatch):
        from decimal import Decimal
        fake = _monta(monkeypatch)
        PrizeAllocationService.update_reserved_config(TOUR, Decimal("10"), "ranking")
        t = fake.store["tournaments"][0]
        assert float(t["reserved_prize_percentage"]) == 10.0
        assert t["reserved_purpose"] == "ranking"

    def test_finalidade_invalida_e_recusada(self, monkeypatch):
        """So 'ranking' e 'staff' fazem sentido; outro valor viraria uma
        reserva sem destino definido."""
        from decimal import Decimal
        _monta(monkeypatch)
        arg = Decimal("10")
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.update_reserved_config(TOUR, arg, "qualquer")
        assert "reserved_purpose" in e.value.detail["message"]

    def test_finalidade_vazia_e_aceita(self, monkeypatch):
        from decimal import Decimal
        fake = _monta(monkeypatch)
        PrizeAllocationService.update_reserved_config(TOUR, Decimal("0"), "")
        assert fake.store["tournaments"][0]["reserved_purpose"] is None


class TestResumoDoPool:
    def test_reservado_sai_do_bolo_dos_jogadores(self, monkeypatch):
        """A reserva e % das entradas BRUTAS e sai do pool dos jogadores, nao
        do rake: 2000 de entradas com 10% reservados deixam 1800 pagaveis."""
        fake = _monta(monkeypatch)
        fake.store["tournaments"][0]["reserved_prize_percentage"] = 10
        fake.store["tournaments"][0]["reserved_purpose"] = "ranking"

        s = PrizeAllocationService.get_prize_summary(TOUR)
        assert float(s.total_entries) == 2000.0
        assert float(s.reserved_amount) == 200.0
        assert float(s.payable_pool) == 1800.0

    def test_garantia_soma_ao_pool(self, monkeypatch):
        """A garantia e valor ADICIONADO pela casa, nao piso: 2000 de entradas
        + 1000 garantidos = 3000 disponiveis."""
        fake = _monta(monkeypatch)
        fake.store["tournaments"][0]["guaranteed_prize"] = 1000
        s = PrizeAllocationService.get_prize_summary(TOUR)
        assert float(s.available_prize_pool) == 3000.0

    def test_saldo_desconta_o_que_ja_foi_alocado(self, monkeypatch):
        _monta(monkeypatch)   # ja ha uma alocacao de 500
        s = PrizeAllocationService.get_prize_summary(TOUR)
        assert float(s.total_allocated) == 500.0
        assert float(s.remaining_balance) == 1500.0


class TestEdicaoDetalhada:
    def test_mudar_para_posicao_ocupada_e_recusado(self, monkeypatch):
        """Trocar para uma posicao que ja tem premio criaria duas alocacoes
        na mesma colocacao."""
        outra = _alocacao(); outra["id"] = "outra"; outra["position"] = 2
        fake = _monta(monkeypatch)
        fake.store["prize_allocations"].append(outra)

        arg = PrizeAllocationUpdate(position=2)
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.update_allocation(
                TOUR, ALLOC, arg
            )
        assert "already has a prize allocation" in e.value.detail["message"]

    def test_manter_a_propria_posicao_e_permitido(self, monkeypatch):
        """A checagem de conflito ignora a propria linha; sem isso, salvar sem
        mudar a posicao daria erro."""
        _monta(monkeypatch)
        r = PrizeAllocationService.update_allocation(
            TOUR, ALLOC, PrizeAllocationUpdate(position=1, prize_amount=600)
        )
        assert r.position == 1
        assert float(r.prize_amount) == 600.0

    def test_associa_o_jogador_a_colocacao(self, monkeypatch):
        fake = _monta(monkeypatch)
        PrizeAllocationService.update_allocation(
            TOUR, ALLOC, PrizeAllocationUpdate(player_id=PLAYER)
        )
        assert fake.store["prize_allocations"][0]["player_id"] == PLAYER


class TestListagemDeAlocacoes:
    def test_lista_do_torneio(self, monkeypatch):
        _monta(monkeypatch)
        r = PrizeAllocationService.get_allocations(TOUR)
        assert len(r) == 1
        assert r[0].position == 1

    def test_torneio_sem_premiacao_devolve_vazio(self, monkeypatch):
        _monta(monkeypatch, tabelas={"prize_allocations": []})
        assert PrizeAllocationService.get_allocations(TOUR) == []

    def test_pool_do_torneio(self, monkeypatch):
        _monta(monkeypatch)
        r = PrizeAllocationService.get_tournament_prize_pool(TOUR)
        assert isinstance(r, dict)


class TestPremioTipoVaga:
    """Uma 'vaga' vale o buy-in do dia alvo — nao um valor digitado. Assim a
    premiacao acompanha o preco do torneio para o qual a vaga da acesso."""

    def test_valor_vem_do_buy_in_do_dia_alvo(self, monkeypatch):
        fake = _monta(monkeypatch)
        fake.store["tournament_days"].append(
            {"id": DIA_ALVO, "tournament_id": TOUR, "buy_in": 350,
             "rake_percentage": 0, "day_type": "final"}
        )
        r = PrizeAllocationService.create_allocation(TOUR, PrizeAllocationCreate(
            position=5, prize_amount=0, prize_type="vaga", vaga_target_day_id=DIA_ALVO,
        ))
        assert float(r.prize_amount) == 350.0

    def test_vaga_sem_dia_alvo_e_recusada(self, monkeypatch):
        _monta(monkeypatch)
        arg = PrizeAllocationCreate(
                position=6, prize_amount=0, prize_type="vaga",
            )
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.create_allocation(TOUR, arg)
        assert "dia alvo" in e.value.detail["message"]

    def test_dia_alvo_inexistente_da_404(self, monkeypatch):
        _monta(monkeypatch)
        arg = PrizeAllocationCreate(
                position=7, prize_amount=0, prize_type="vaga",
                vaga_target_day_id="00000000-0000-0000-0000-0000000000ff",
            )
        with pytest.raises(HTTPException) as e:
            PrizeAllocationService.create_allocation(TOUR, arg)
        assert e.value.status_code == 404

class TestTiposDeDocumentoDoPais:
    """O pagamento aceita os mesmos tipos do cadastro de jogador.

    Era um Literal só com passaporte/identidade/habilitação: num torneio do
    Peru com os 8 jogadores cadastrados com DNI, NENHUM prêmio podia ser pago
    (422 antes de chegar ao caixa, mesmo com sangria feita).
    """

    @pytest.mark.parametrize("tipo", ["dni", "cedula", "cpf", "passport", "national_id", "driver_license"])
    def test_tipos_do_cadastro_sao_aceitos(self, tipo):
        pedido = PrizePayoutRequest(player_id=PLAYER, document_type=tipo, document_number="73579148")
        assert pedido.document_type == tipo

    def test_tipo_desconhecido_continua_recusado(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            PrizePayoutRequest(player_id=PLAYER, document_type="carteirinha", document_number="1")

    def test_jogador_com_dni_recebe_o_premio(self, monkeypatch):
        fake = _monta(monkeypatch, documento="73579148")
        fake.store["players"][0]["document_type"] = "dni"
        pedido = PrizePayoutRequest(player_id=PLAYER, document_type="dni",
                                    document_number="73579148", paid_by="Caixa")
        r = PrizeAllocationService.pay_prize(TOUR, ALLOC, pedido)
        assert r.paid is True
        assert r.document_type == "dni"

    def test_rota_aceita_dni(self, client, monkeypatch):
        recebido = {}

        def pagar(tid, aid, pedido, user_id=None):
            recebido["tipo"] = pedido.document_type
            raise HTTPException(status_code=409, detail={"code": "teste", "message": "parou aqui"})

        monkeypatch.setattr(PrizeAllocationService, "pay_prize", staticmethod(pagar))
        r = client.post(f"/tournaments/{TOUR}/prizes/{ALLOC}/pay",
                        json={"player_id": PLAYER, "document_type": "dni", "document_number": "73579148"})
        assert r.status_code != 422
        assert recebido == {"tipo": "dni"}
