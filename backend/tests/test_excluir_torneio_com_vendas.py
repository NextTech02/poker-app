"""Excluir o torneio criado por engano JUNTO com as compras.

Pedido do NSOP: apagar o torneio errado sem estornar venda por venda no Caixa.
Não existe atalho de dinheiro: cada venda passa pelo MESMO estorno do Caixa
(`TransactionService.cancel_transaction`, testado em test_transactions), que
devolve gaveta, caixa da etapa, contadores e fidelidade. Aqui fica travada a
ORQUESTRAÇÃO:

1. **Ordem**: estorno parado no meio primeiro, depois reentradas e add-ons, e
   só então os buy-ins (o buy-in recusa enquanto houver recompra viva).
2. **Rodadas**: com o tempo estourado a rodada para e devolve `remaining`;
   sempre avança pelo menos uma venda.
3. **Só apaga sem venda viva**, pela exclusão de sempre (que reconfere a guarda).
4. **Recusa SEM estornar nada** quando sobra o que o estorno não desfaz: prêmio
   pago, venda com crédito/ticket, satélite, crédito de patrocinador, inscrito
   pago sem venda — e quando o nome digitado não confere.
5. **Erro no meio**: o que já foi estornado fica; a recusa diz quantas foram.
6. **HTTP**: só admin de caixa.
"""
from types import SimpleNamespace

import pytest

from app.services import tournament_service as mod_torneio
from app.services.cashbox_service import CashboxService
from app.services.tournament_service import (
    MovimentoFinanceiroImpedeExclusao,
    TournamentService as TS,
    fila_do_estorno,
)
from app.services.transaction_service import TransactionService
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


TOUR = "22222222-2222-2222-2222-222222222222"
DIA = "77777777-7777-7777-7777-777777777771"
TP_A = "55555555-5555-5555-5555-55555555555a"
TP_B = "55555555-5555-5555-5555-55555555555b"


def _venda(id_, tipo="buy_in", valor=100.0, tp=TP_A, status="active", quando="2026-10-16T20:00:00Z", **kw):
    linha = {
        "id": id_, "tournament_id": TOUR, "player_id": "p1", "tournament_player_id": tp,
        "type": tipo, "amount": valor, "status": status, "payment_source": "cash",
        "created_at": quando,
    }
    linha.update(kw)
    return linha


def _inscricao(id_, gasto):
    return {"id": id_, "tournament_id": TOUR, "tournament_day_id": DIA,
            "player_id": "p1", "status": "active", "total_spent": gasto}


def _banco(monkeypatch, vendas, inscricoes=None, **tabelas):
    base = {
        "tournaments": [{"id": TOUR, "name": "HIGH ROLLER", "stage_id": "e1"}],
        "tournament_days": [{"id": DIA, "tournament_id": TOUR}],
        "tournament_players": inscricoes if inscricoes is not None else [
            _inscricao(TP_A, 1100.0), _inscricao(TP_B, 1000.0),
        ],
        "transactions": vendas,
        "satellite_tickets": [],
        "prize_allocations": [],
        "credit_transactions": [],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    monkeypatch.setattr(mod_torneio, "supabase", fake)
    return fake


def _estorno_falso(monkeypatch, fake, avisos=None, falha_em=None):
    """O estorno de verdade é testado em test_transactions; aqui ele só
    precisa deixar no banco o que o de verdade deixa: venda 'cancelled' e, no
    buy-in, a inscrição estornada com gasto zerado."""
    chamadas = []

    def cancelar(tx_id, user_id, reason):
        chamadas.append((tx_id, user_id, reason))
        if falha_em and tx_id == falha_em[0]:
            raise falha_em[1]
        venda = next(v for v in fake.store["transactions"] if v["id"] == tx_id)
        venda["status"] = "cancelled"
        if venda["type"] == "buy_in":
            for i in fake.store["tournament_players"]:
                if i["id"] == venda["tournament_player_id"]:
                    i.update(status="cancelled", total_spent=0)
        return SimpleNamespace(cancel_warnings=list((avisos or {}).get(tx_id, [])))

    monkeypatch.setattr(TransactionService, "cancel_transaction", staticmethod(cancelar))
    return chamadas


def _venda_do_high_roller():
    return [
        _venda("bi-a", "buy_in", 1000.0, TP_A, quando="2026-10-16T20:39:21Z"),
        _venda("ad-a", "addon", 100.0, TP_A, quando="2026-10-16T20:39:23Z"),
        _venda("bi-b", "buy_in", 1000.0, TP_B, quando="2026-10-16T21:00:00Z"),
    ]


# ══════════════════════════════════════════════════════════════════════
# Ordem
# ══════════════════════════════════════════════════════════════════════

def test_fila_estorno_parado_primeiro_depois_recompras_e_por_fim_buy_ins():
    vendas = [
        _venda("bi-velho", "buy_in", quando="2026-10-16T18:00:00Z"),
        _venda("rb", "rebuy", quando="2026-10-16T19:00:00Z"),
        _venda("bi-novo", "buy_in", quando="2026-10-16T20:00:00Z"),
        _venda("ad", "addon", quando="2026-10-16T21:00:00Z"),
        _venda("parado", "buy_in", status="cancelling", quando="2026-10-16T17:00:00Z"),
        _venda("ja", "buy_in", status="cancelled"),
        _venda("premio", "prize", tipo_prize=True),
    ]
    assert [v["id"] for v in fila_do_estorno(vendas)] == ["parado", "ad", "rb", "bi-novo", "bi-velho"]


# ══════════════════════════════════════════════════════════════════════
# Estorno e exclusão
# ══════════════════════════════════════════════════════════════════════

def test_estorna_tudo_na_ordem_e_exclui(monkeypatch):
    fake = _banco(monkeypatch, _venda_do_high_roller())
    chamadas = _estorno_falso(monkeypatch, fake)

    r = TS.cancel_sales_and_delete(TOUR, "admin-1", "Torneio criado por engano", "high roller")

    assert [c[0] for c in chamadas] == ["ad-a", "bi-b", "bi-a"]
    assert all(c[1:] == ("admin-1", "Torneio criado por engano") for c in chamadas)
    assert r.deleted is True and r.cancelled == 3 and r.remaining == 0
    assert r.refunded_amount == 2100.0
    assert fake.store["tournaments"] == []


def test_avisos_do_estorno_chegam_sem_repeticao(monkeypatch):
    fake = _banco(monkeypatch, _venda_do_high_roller())
    sangria = "Esta etapa já teve sangria."
    _estorno_falso(monkeypatch, fake, avisos={"ad-a": [sangria], "bi-a": [sangria, "Caixa fechado."]})
    r = TS.cancel_sales_and_delete(TOUR, "admin-1", "engano", "HIGH ROLLER")
    assert r.warnings == [sangria, "Caixa fechado."]


def test_rodada_para_no_tempo_e_a_seguinte_termina(monkeypatch):
    fake = _banco(monkeypatch, _venda_do_high_roller())
    chamadas = _estorno_falso(monkeypatch, fake)

    # Orçamento zero: cada rodada estorna UMA venda (sempre avança).
    r1 = TS.cancel_sales_and_delete(TOUR, "admin-1", "engano", "HIGH ROLLER", orcamento_segundos=0)
    assert (r1.deleted, r1.cancelled, r1.remaining) == (False, 1, 2)
    assert fake.store["tournaments"]  # ainda não apagou

    r2 = TS.cancel_sales_and_delete(TOUR, "admin-1", "engano", "HIGH ROLLER", orcamento_segundos=0)
    r3 = TS.cancel_sales_and_delete(TOUR, "admin-1", "engano", "HIGH ROLLER", orcamento_segundos=0)
    assert (r2.remaining, r3.deleted) == (1, True)
    # Nenhuma venda estornada duas vezes.
    assert sorted(c[0] for c in chamadas) == ["ad-a", "bi-a", "bi-b"]


def test_torneio_ja_sem_venda_viva_so_exclui(monkeypatch):
    fake = _banco(monkeypatch, [_venda("x", status="cancelled")],
                  inscricoes=[dict(_inscricao(TP_A, 0), status="cancelled")])
    chamadas = _estorno_falso(monkeypatch, fake)
    r = TS.cancel_sales_and_delete(TOUR, "admin-1", "engano", "HIGH ROLLER")
    assert r.deleted is True and r.cancelled == 0 and chamadas == []


def test_nome_que_nao_confere_recusa_sem_estornar(monkeypatch):
    fake = _banco(monkeypatch, _venda_do_high_roller())
    chamadas = _estorno_falso(monkeypatch, fake)
    with pytest.raises(ErroDeNegocio) as e:
        TS.cancel_sales_and_delete(TOUR, "admin-1", "engano", "LOW ROLLER")
    assert e.value.code == "nome_do_torneio_nao_confere"
    assert chamadas == [] and fake.store["tournaments"]


def test_nome_ignora_maiusculas_e_espacos(monkeypatch):
    fake = _banco(monkeypatch, _venda_do_high_roller())
    _estorno_falso(monkeypatch, fake)
    assert TS.cancel_sales_and_delete(TOUR, "admin-1", "engano", "  high   ROLLER ").deleted is True


def test_torneio_inexistente(monkeypatch):
    _banco(monkeypatch, [])
    assert TS.cancel_sales_and_delete("fantasma", "admin-1", "engano", "x") is None


# ══════════════════════════════════════════════════════════════════════
# O que o estorno não desfaz: recusa sem tocar em nada
# ══════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("extra,campo", [
    ([_venda("pr", "prize", 900.0)], "prizes"),
    ([_venda("cr", "buy_in", 500.0, TP_B, payment_source="credit")], "non_cash_entries"),
    ([_venda("tk", "buy_in", 0.0, TP_B, payment_source="ticket")], "non_cash_entries"),
])
def test_premio_credito_ou_ticket_recusam_sem_estornar(monkeypatch, extra, campo):
    fake = _banco(monkeypatch, _venda_do_high_roller() + extra)
    chamadas = _estorno_falso(monkeypatch, fake)
    with pytest.raises(MovimentoFinanceiroImpedeExclusao) as e:
        TS.cancel_sales_and_delete(TOUR, "admin-1", "engano", "HIGH ROLLER")
    assert getattr(e.value.impacto, campo)
    assert e.value.impacto.can_cancel_and_delete is False
    assert chamadas == [] and fake.store["tournaments"]


@pytest.mark.parametrize("tabela,linha,ligacao", [
    ("satellite_tickets", {"id": "t1", "target_tournament_id": TOUR}, "satellite_tickets"),
    ("satellite_tickets", {"id": "t2", "target_tournament_day_id": DIA}, "satellite_tickets"),
    ("satellite_tickets", {"id": "t3", "redeemed_tournament_player_id": TP_A}, "satellite_tickets"),
    ("prize_allocations", {"id": "v1", "vaga_target_tournament_id": TOUR}, "satellite_prizes"),
    ("credit_transactions", {"id": "c1", "tournament_id": TOUR}, "sponsor_credit"),
])
def test_ligacoes_que_o_banco_nao_apaga_recusam(monkeypatch, tabela, linha, ligacao):
    fake = _banco(monkeypatch, _venda_do_high_roller(), **{tabela: [linha]})
    chamadas = _estorno_falso(monkeypatch, fake)
    with pytest.raises(MovimentoFinanceiroImpedeExclusao) as e:
        TS.cancel_sales_and_delete(TOUR, "admin-1", "engano", "HIGH ROLLER")
    assert e.value.impacto.blocking_links == [ligacao]
    assert chamadas == []


def test_ligacao_trava_tambem_a_exclusao_comum(monkeypatch):
    """Antes o DELETE estourava no banco com erro de chave estrangeira."""
    _banco(monkeypatch, [], inscricoes=[],
           satellite_tickets=[{"id": "t1", "target_tournament_id": TOUR}])
    impacto = TS.get_delete_impact(TOUR)
    assert impacto.blocked is True and impacto.blocking_links == ["satellite_tickets"]
    with pytest.raises(MovimentoFinanceiroImpedeExclusao):
        TS.delete_tournament(TOUR)


def test_inscrito_pago_sem_venda_recusa(monkeypatch):
    """Importação ou ajuste: dinheiro gravado na inscrição que nenhum estorno zera."""
    fake = _banco(monkeypatch, _venda_do_high_roller(),
                  inscricoes=[_inscricao(TP_A, 1100.0), _inscricao(TP_B, 1000.0),
                              _inscricao("tp-importado", 300.0)])
    chamadas = _estorno_falso(monkeypatch, fake)
    with pytest.raises(MovimentoFinanceiroImpedeExclusao) as e:
        TS.cancel_sales_and_delete(TOUR, "admin-1", "engano", "HIGH ROLLER")
    assert e.value.impacto.paying_without_sale == 1
    assert chamadas == []


def test_impacto_libera_o_estorno_em_massa_so_com_vendas_em_dinheiro(monkeypatch):
    _banco(monkeypatch, _venda_do_high_roller())
    impacto = TS.get_delete_impact(TOUR)
    assert impacto.blocked is True
    assert impacto.can_cancel_and_delete is True
    assert (impacto.non_cash_entries, impacto.blocking_links, impacto.paying_without_sale) == (0, [], 0)


# ══════════════════════════════════════════════════════════════════════
# Erro no meio
# ══════════════════════════════════════════════════════════════════════

def test_ko_entregue_para_no_meio_e_diz_quantas_ja_foram(monkeypatch):
    fake = _banco(monkeypatch, _venda_do_high_roller())
    ko = ErroDeNegocio("venda_com_ko_entregue", "A parte KO desta venda já foi entregue.")
    chamadas = _estorno_falso(monkeypatch, fake, falha_em=("bi-b", ko))
    with pytest.raises(ErroDeNegocio) as e:
        TS.cancel_sales_and_delete(TOUR, "admin-1", "engano", "HIGH ROLLER")
    detalhe = e.value.como_http().detail
    assert detalhe["code"] == "estorno_em_massa_interrompido"
    assert detalhe["estornadas"] == 1 and detalhe["motivo_code"] == "venda_com_ko_entregue"
    assert e.value.status == 409
    # O add-on estornado continua estornado; o torneio continua lá.
    assert [c[0] for c in chamadas] == ["ad-a", "bi-b"]
    assert fake.store["tournaments"]


def test_falha_inesperada_vira_recusa_que_manda_tentar_de_novo(monkeypatch):
    fake = _banco(monkeypatch, _venda_do_high_roller())
    _estorno_falso(monkeypatch, fake, falha_em=("ad-a", RuntimeError("timeout")))
    with pytest.raises(ErroDeNegocio) as e:
        TS.cancel_sales_and_delete(TOUR, "admin-1", "engano", "HIGH ROLLER")
    assert e.value.code == "estorno_em_massa_interrompido"
    assert e.value.dados["estornadas"] == 0


# ══════════════════════════════════════════════════════════════════════
# HTTP
# ══════════════════════════════════════════════════════════════════════

class TestHTTP:
    URL = f"/tournaments/{TOUR}/cancel-sales-and-delete"

    def test_admin_de_caixa_estorna_e_exclui(self, client, monkeypatch):
        fake = _banco(monkeypatch, _venda_do_high_roller())
        _estorno_falso(monkeypatch, fake)
        monkeypatch.setattr(CashboxService, "can_admin", staticmethod(lambda uid: True))
        r = client.post(self.URL, json={"reason": "Torneio criado por engano", "confirm_name": "HIGH ROLLER"})
        assert r.status_code == 200
        assert r.json() == {"deleted": True, "cancelled": 3, "remaining": 0,
                            "refunded_amount": 2100.0, "warnings": []}

    def test_quem_nao_administra_o_caixa_nao_estorna(self, client, monkeypatch):
        fake = _banco(monkeypatch, _venda_do_high_roller())
        chamadas = _estorno_falso(monkeypatch, fake)
        monkeypatch.setattr(CashboxService, "can_admin", staticmethod(lambda uid: False))
        r = client.post(self.URL, json={"reason": "engano", "confirm_name": "HIGH ROLLER"})
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "sem_permissao_excluir_com_vendas"
        assert chamadas == []

    def test_premio_pago_da_409_com_o_impacto(self, client, monkeypatch):
        fake = _banco(monkeypatch, _venda_do_high_roller() + [_venda("pr", "prize", 900.0)])
        _estorno_falso(monkeypatch, fake)
        monkeypatch.setattr(CashboxService, "can_admin", staticmethod(lambda uid: True))
        r = client.post(self.URL, json={"reason": "engano", "confirm_name": "HIGH ROLLER"})
        assert r.status_code == 409
        detalhe = r.json()["detail"]
        assert detalhe["code"] == "torneio_nao_estornavel"
        assert detalhe["impact"]["prizes"] == 1

    def test_motivo_e_obrigatorio(self, client, monkeypatch):
        _banco(monkeypatch, _venda_do_high_roller())
        monkeypatch.setattr(CashboxService, "can_admin", staticmethod(lambda uid: True))
        r = client.post(self.URL, json={"reason": "", "confirm_name": "HIGH ROLLER"})
        assert r.status_code == 422
