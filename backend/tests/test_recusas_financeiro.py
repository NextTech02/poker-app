"""As recusas da ÁREA FINANCEIRA chegam com CÓDIGO, não só com a frase.

O sistema atende clubes no Brasil, no Peru e na Colômbia. Enquanto o `detail`
era uma string, o operador colombiano lia "Caixa fechado" no meio da operação:
não havia como a tela traduzir sem comparar frase, que quebra ao primeiro
ajuste de texto. Agora o `detail` é `{code, message, ...dados}` e a TELA escolhe
a frase pelo `code` (ver `app/utils/erros.py`).

O que estes testes travam, e que uma refatoração distraída desfaz:

1. **O `code`**, que é contrato com a tela e com a fila offline já gravada nos
   aparelhos. Renomear um código publicado deixa o operador sem tradução.
2. **A `message` em português**, que é a RESERVA — vale para outros clientes da
   API e para o código que a tela ainda não conhece. Perdê-la troca uma frase
   útil por "erro desconhecido".
3. **Os DADOS nomeados** (saldo disponível, quantidade de recompras, origem do
   pagamento). A tela remonta a frase no idioma dela: o que só existe interpolado
   no texto em português some da versão traduzida — e é justamente o número que o
   operador precisa para resolver o caso no balcão.
4. **O status**: 404 não existe, 409 briga com o que já está lá, 403 perfil sem
   acesso, 400 regra de negócio. O `da_excecao` do router respeita o status que a
   REGRA escolheu; antes tudo virava 400 na saída.
"""
import io

import pytest

from app.services import cashbox_service as cashbox_mod
from app.services import chip_consignment_service as consignacao_mod
from app.services import transaction_service as transacao_mod
from app.services.cashbox_service import CashboxService as CS
from app.services.cash_register_service import CashRegisterService as CRS
from app.services.chip_consignment_service import ChipConsignmentService as CCS
from app.services.expense_service import ExpenseService as ES
from app.services.transaction_service import TransactionService as TrS
from app.services.tournament_service import TournamentService as TS
from app.models.chip_consignment import ConsignmentRelease, SaleCreate
from app.models.tournament import Tournament
from app.utils.erros import ErroDeNegocio

from tests.conftest import FakeSupabase


AUTH = "88888888-8888-8888-8888-888888888888"
STAFF = "99999999-9999-9999-9999-999999999999"
OUTRO_STAFF = "99999999-9999-9999-9999-999999999998"
ETAPA = "11111111-1111-1111-1111-111111111111"
OUTRA_ETAPA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
CAIXA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1"
SESSAO = "cccccccc-cccc-cccc-cccc-ccccccccccc1"
TOUR = "22222222-2222-2222-2222-222222222222"
JOGADOR = "44444444-4444-4444-4444-444444444444"
TP = "55555555-5555-5555-5555-555555555555"


def recusa(excecao):
    """O `detail` estruturado de um `ErroDeNegocio`, como a tela recebe."""
    return excecao.como_http().detail


# ══════════════════════════════════════════════════════════════════════
# Caixa do operador (serviço)
# ══════════════════════════════════════════════════════════════════════

def _staff(id_=STAFF, auth=AUTH, permissoes=("cashbox.operate",)):
    return {"id": id_, "auth_user_id": auth, "name": "Fulano", "active": True,
            "permission_groups": {"permissions": list(permissoes)}}


def _caixa(status="closed", saldo=0.0, sessao=None, staff=STAFF):
    return {"id": CAIXA, "staff_id": staff, "stage_id": ETAPA, "status": status,
            "current_balance": saldo, "current_session_id": sessao,
            "created_at": "2026-06-08T00:00:00Z"}


def _banco_do_caixa(monkeypatch, **tabelas):
    base = {
        "staff": [_staff()],
        "cashboxes": [_caixa()],
        "cashbox_sessions": [],
        "cashbox_transactions": [],
        "stages": [{"id": ETAPA, "name": "Etapa 1"}],
        "tournaments": [{"id": TOUR, "stage_id": ETAPA}],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    monkeypatch.setattr(cashbox_mod, "supabase", fake)
    return fake


class TestRecusasDoCaixaDoOperador:
    def test_caixa_inexistente_e_404_e_nao_400(self, monkeypatch):
        """Pedir para abrir um caixa que não existe não é regra violada: é
        recurso ausente. O status errado fazia a tela oferecer 'corrija e tente
        de novo' para algo que nenhuma correção resolve."""
        _banco_do_caixa(monkeypatch, cashboxes=[])
        with pytest.raises(ErroDeNegocio) as e:
            CS.open_session(CAIXA, AUTH, 0, None)
        assert e.value.status == 404
        assert recusa(e.value)["code"] == "caixa_nao_encontrado"

    def test_caixa_ja_aberto_e_409(self, monkeypatch):
        """409 e não 400: o pedido está correto, o que ele quer JÁ EXISTE. É o
        que permite à tela mandar o operador continuar na sessão aberta."""
        _banco_do_caixa(monkeypatch, cashboxes=[_caixa(status="open")])
        with pytest.raises(ErroDeNegocio) as e:
            CS.open_session(CAIXA, AUTH, 0, None)
        assert e.value.status == 409
        assert recusa(e.value)["code"] == "caixa_ja_aberto"

    def test_caixa_arquivado_e_regra_de_negocio(self, monkeypatch):
        _banco_do_caixa(monkeypatch, cashboxes=[_caixa(status="archived")])
        with pytest.raises(ErroDeNegocio) as e:
            CS.open_session(CAIXA, AUTH, 0, None)
        assert (e.value.status, recusa(e.value)["code"]) == (400, "caixa_arquivado")

    def test_abrir_o_caixa_de_outro_e_403(self, monkeypatch):
        """Perfil sem acesso é 403; como 400 a tela pedia ao operador que
        corrigisse um pedido que estava certo — faltava permissão, não dado."""
        _banco_do_caixa(monkeypatch, cashboxes=[_caixa(staff=OUTRO_STAFF)])
        with pytest.raises(ErroDeNegocio) as e:
            CS.open_session(CAIXA, AUTH, 0, None)
        assert e.value.status == 403
        assert recusa(e.value)["code"] == "sem_permissao_abrir_caixa"

    def test_fechar_o_que_nao_esta_aberto(self, monkeypatch):
        _banco_do_caixa(monkeypatch)
        with pytest.raises(ErroDeNegocio) as e:
            CS.close_session(CAIXA, AUTH, 0, None)
        assert recusa(e.value)["code"] == "caixa_nao_esta_aberto"

    def test_fechar_o_caixa_de_outro_e_403(self, monkeypatch):
        _banco_do_caixa(monkeypatch,
                        cashboxes=[_caixa(status="open", sessao=SESSAO,
                                          staff=OUTRO_STAFF)])
        with pytest.raises(ErroDeNegocio) as e:
            CS.close_session(CAIXA, AUTH, 0, None)
        assert e.value.status == 403
        assert recusa(e.value)["code"] == "sem_permissao_fechar_caixa"

    def test_caixa_aberto_sem_sessao(self, monkeypatch):
        """Estado inconsistente que só o admin conserta — a frase precisa
        chegar inteira, e o código diz à tela para mandar chamá-lo."""
        _banco_do_caixa(monkeypatch, cashboxes=[_caixa(status="open")])
        with pytest.raises(ErroDeNegocio) as e:
            CS.close_session(CAIXA, AUTH, 0, None)
        assert recusa(e.value)["code"] == "caixa_aberto_sem_sessao"
        assert "contate o admin" in recusa(e.value)["message"]

    def test_movimentar_sem_ser_admin_e_403(self, monkeypatch):
        _banco_do_caixa(monkeypatch, cashboxes=[_caixa(status="open", sessao=SESSAO)])
        with pytest.raises(ErroDeNegocio) as e:
            CS.register_supply(CAIXA, AUTH, 100.0, None)
        assert e.value.status == 403
        assert recusa(e.value)["code"] == "sem_permissao_movimentar_caixa"

    def test_movimento_em_caixa_fechado(self, monkeypatch):
        _banco_do_caixa(monkeypatch, staff=[_staff(permissoes=("cashbox.admin",))])
        with pytest.raises(ErroDeNegocio) as e:
            CS.register_supply(CAIXA, AUTH, 100.0, None)
        assert recusa(e.value)["code"] == "caixa_precisa_estar_aberto"

    def test_sangria_maior_que_o_saldo_manda_os_numeros(self, monkeypatch):
        """O 'R$ 150,00' da frase chega errado no Peru e na Colômbia. Os valores
        vão como NÚMERO para a tela formatar na moeda do clube — e para ela
        conseguir oferecer o máximo possível em vez de só recusar."""
        _banco_do_caixa(monkeypatch,
                        staff=[_staff(permissoes=("cashbox.admin",))],
                        cashboxes=[_caixa(status="open", saldo=150.0, sessao=SESSAO)])
        with pytest.raises(ErroDeNegocio) as e:
            CS.register_sangria(CAIXA, AUTH, 200.0, None)
        detalhe = recusa(e.value)
        assert detalhe["code"] == "saldo_insuficiente_no_caixa"
        assert detalhe["disponivel"] == 150.0
        assert detalhe["solicitado"] == 200.0
        assert "Saldo insuficiente" in detalhe["message"]

    def test_vender_com_o_caixa_fechado(self, monkeypatch):
        """A recusa mais frequente da noite: sem código, ela era a que mais
        aparecia em português para quem opera em espanhol."""
        _banco_do_caixa(monkeypatch)
        with pytest.raises(ErroDeNegocio) as e:
            CS.require_open_cashbox(AUTH, ETAPA)
        assert recusa(e.value)["code"] == "caixa_fechado"

    def test_resumo_de_caixa_inexistente(self, monkeypatch):
        _banco_do_caixa(monkeypatch, cashboxes=[])
        with pytest.raises(ErroDeNegocio) as e:
            CS.get_summary(CAIXA)
        assert (e.value.status, recusa(e.value)["code"]) == (404, "caixa_nao_encontrado")


# ══════════════════════════════════════════════════════════════════════
# Caixa do operador (rota)
# ══════════════════════════════════════════════════════════════════════

class TestRotasDoCaixa:
    def test_o_status_da_regra_atravessa_a_rota(self, client, stub):
        """A rota mapeava TUDO para 400. Com `da_excecao`, o 409 escolhido pela
        regra chega à tela — que é o que distingue 'já está aberto, continue'
        de 'o pedido está errado'."""
        def _estoura(cid, uid, saldo, obs):
            raise ErroDeNegocio("caixa_ja_aberto", "Caixa já está aberto", status=409)

        stub(CS, open_session=_estoura)
        r = client.post(f"/cashboxes/{CAIXA}/open", json={"initial_balance": 0})
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "caixa_ja_aberto"

    def test_value_error_ainda_nao_convertido_continua_400(self, client, stub):
        """A conversão é gradual: um `ValueError` cru de outro ponto do sistema
        precisa continuar chegando como 400 com a frase inteira, agora dentro
        do mesmo formato — senão a tela teria dois jeitos de ler erro."""
        def _estoura(cid, uid, valor, obs):
            raise ValueError("Alguma regra ainda não convertida")

        stub(CS, register_supply=_estoura)
        r = client.post(f"/cashboxes/{CAIXA}/supply", json={"amount": 1})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "regra_de_negocio"
        assert r.json()["detail"]["message"] == "Alguma regra ainda não convertida"

    def test_criar_caixa_sem_ser_admin(self, client, stub):
        stub(CS, can_admin=lambda uid: False)
        r = client.post("/cashboxes", json={"staff_id": STAFF})
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "sem_permissao_criar_caixa"

    def test_consolidado_e_demonstrativo_tem_codigos_proprios(self, client, stub):
        """Códigos distintos por tela: quem vê o consolidado não é
        necessariamente quem vê o demonstrativo, e a tela precisa saber qual
        das duas portas foi fechada."""
        stub(CS, can_admin=lambda uid: False)
        assert client.get("/cashboxes/aggregated").json()["detail"]["code"] == \
            "sem_permissao_ver_consolidado"
        assert client.get("/cashboxes/demonstrativo").json()["detail"]["code"] == \
            "sem_permissao_ver_demonstrativo"

    def test_sem_etapa_selecionada(self, client):
        r = client.get("/cashboxes/me/current")
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "etapa_nao_selecionada"

    def test_caixa_inexistente_na_leitura(self, client, stub):
        stub(CS, get_cashbox=lambda cid: None)
        r = client.get(f"/cashboxes/{CAIXA}")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "caixa_nao_encontrado"

    def test_resumo_de_caixa_inexistente_continua_404(self, client, stub):
        def _estoura(cid, date_from=None, date_to=None):
            raise ValueError("Caixa não encontrado")

        stub(CS, get_summary=_estoura)
        r = client.get(f"/cashboxes/{CAIXA}/summary")
        assert r.status_code == 404
        assert r.json()["detail"]["message"] == "Caixa não encontrado"


# ══════════════════════════════════════════════════════════════════════
# Venda: cancelamento e troca de forma de pagamento (serviço)
# ══════════════════════════════════════════════════════════════════════

def _venda(**kw):
    base = {"id": "tx-1", "tournament_id": TOUR, "player_id": JOGADOR,
            "type": "buy_in", "amount": 100, "status": "active",
            "payment_source": "cash", "tournament_player_id": TP,
            "created_at": "2026-06-08T00:00:00Z"}
    base.update(kw)
    return base


def _banco_de_vendas(monkeypatch, transacoes):
    fake = FakeSupabase({"transactions": list(transacoes)})
    monkeypatch.setattr(transacao_mod, "supabase", fake)
    return fake


class TestRecusasDoCancelamento:
    def test_venda_inexistente_e_404(self, monkeypatch):
        _banco_de_vendas(monkeypatch, [])
        with pytest.raises(ErroDeNegocio) as e:
            TrS.cancel_transaction("tx-1", "admin", "erro")
        assert (e.value.status, recusa(e.value)["code"]) == (404, "transacao_nao_encontrada")

    def test_premio_nao_e_estornavel_e_o_tipo_vai_junto(self, monkeypatch):
        """O TIPO vai como dado para a tela dizer o que ela recusou ('prêmio
        não se cancela por aqui') sem depender da frase em português."""
        _banco_de_vendas(monkeypatch, [_venda(type="prize")])
        with pytest.raises(ErroDeNegocio) as e:
            TrS.cancel_transaction("tx-1", "admin", "erro")
        detalhe = recusa(e.value)
        assert detalhe["code"] == "venda_nao_estornavel"
        assert detalhe["tipo"] == "prize"

    def test_venda_paga_com_credito_diz_qual_foi_a_origem(self, monkeypatch):
        """Sem a origem, o admin não sabe se devolve saldo de crédito ou um
        ticket — e é ele quem faz esse acerto na mão."""
        _banco_de_vendas(monkeypatch, [_venda(payment_source="credit")])
        with pytest.raises(ErroDeNegocio) as e:
            TrS.cancel_transaction("tx-1", "admin", "erro")
        detalhe = recusa(e.value)
        assert detalhe["code"] == "venda_com_credito_nao_estornavel"
        assert detalhe["origem"] == "credit"

    def test_buy_in_com_recompras_ativas_manda_a_quantidade(self, monkeypatch):
        """O número é a informação útil da recusa: diz ao admin quantas vendas
        ele ainda precisa estornar antes desta. Interpolado só na frase em
        português, ele sumiria da versão em espanhol."""
        _banco_de_vendas(monkeypatch, [
            _venda(),
            _venda(id="tx-2", type="rebuy"),
            _venda(id="tx-3", type="addon"),
        ])
        with pytest.raises(ErroDeNegocio) as e:
            TrS.cancel_transaction("tx-1", "admin", "erro")
        detalhe = recusa(e.value)
        assert detalhe["code"] == "recompras_ativas_no_buy_in"
        assert detalhe["quantidade"] == 2

    def test_cancelamento_ja_em_curso_e_409(self, monkeypatch):
        """Outro pedido está estornando esta venda agora. 409 porque não há
        nada a corrigir no pedido — a tela recarrega e mostra o resultado."""
        fake = _banco_de_vendas(monkeypatch, [_venda(status="cancelling")])

        # O compare-and-swap não pega a linha (ela já está em 'cancelling'),
        # e o estado relido continua diferente de 'cancelled'.
        with pytest.raises(ErroDeNegocio) as e:
            TrS._marcar_em_cancelamento("tx-1", "admin", "erro")
        assert e.value.status == 409
        assert recusa(e.value)["code"] == "cancelamento_em_andamento"
        assert fake.store["transactions"][0]["status"] == "cancelling"

    def test_banco_sem_a_migracao_do_estorno(self, monkeypatch):
        """Sem a coluna `cancel_steps` a marcação falha. O admin precisa ler
        'falta a migração', e não um 500 — a diferença é entre chamar o suporte
        e achar que o sistema quebrou no meio do evento."""
        class BancoAntigo(FakeSupabase):
            def table(self, nome):
                consulta = super().table(nome)
                if nome == "transactions":
                    original = consulta.execute

                    def _execute():
                        if consulta._op == "update":
                            raise RuntimeError('column "cancel_steps" does not exist')
                        return original()

                    consulta.execute = _execute
                return consulta

        monkeypatch.setattr(transacao_mod, "supabase", BancoAntigo({"transactions": [_venda()]}))
        with pytest.raises(ErroDeNegocio) as e:
            TrS._marcar_em_cancelamento("tx-1", "admin", "erro")
        assert recusa(e.value)["code"] == "cancelamento_sem_migracao"

    def test_troca_de_forma_de_pagamento_em_venda_inexistente(self, monkeypatch):
        _banco_de_vendas(monkeypatch, [])
        with pytest.raises(ErroDeNegocio) as e:
            TrS.update_payment_method("tx-1", "pix")
        assert (e.value.status, recusa(e.value)["code"]) == (404, "transacao_nao_encontrada")

    def test_troca_de_forma_de_pagamento_em_venda_cancelada(self, monkeypatch):
        _banco_de_vendas(monkeypatch, [_venda(status="cancelled")])
        with pytest.raises(ErroDeNegocio) as e:
            TrS.update_payment_method("tx-1", "pix")
        assert recusa(e.value)["code"] == "venda_cancelada_nao_alteravel"


# ══════════════════════════════════════════════════════════════════════
# Venda (rota)
# ══════════════════════════════════════════════════════════════════════

def _tx_crua(**kw):
    base = {"id": "tx1", "tournament_id": TOUR, "player_id": JOGADOR,
            "type": "buy_in", "amount": 100, "created_by": AUTH,
            "status": "active", "created_at": "2026-06-08T00:00:00Z"}
    base.update(kw)
    return base


def _torneio(stage_id=ETAPA):
    return Tournament(id=TOUR, name="Torneio", stage_id=stage_id,
                      created_by=AUTH, created_at="2026-06-08T00:00:00Z")


class TestRotasDaVenda:
    def test_venda_inexistente(self, client, stub):
        stub(CS, can_admin=lambda uid: True)
        stub(TrS, get_raw_transaction=lambda tid: None)
        r = client.post("/transactions/tx1/cancel", json={"reason": "erro"})
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "transacao_nao_encontrada"

    def test_venda_de_outra_etapa(self, client, stub):
        """Sem esta trava, quem está com a etapa A aberta cancelaria a venda da
        etapa B pelo id — e o dinheiro sairia do caixa errado."""
        stub(CS, can_admin=lambda uid: True)
        stub(TrS, get_raw_transaction=lambda tid: _tx_crua())
        stub(TS, get_tournament=lambda tid: _torneio(stage_id=OUTRA_ETAPA))
        r = client.post("/transactions/tx1/cancel", json={"reason": "erro"},
                        headers={"X-Stage-ID": ETAPA})
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "transacao_de_outra_etapa"

    def test_cancelar_sem_ser_admin_de_caixa(self, client, stub):
        stub(CS, can_admin=lambda uid: False)
        r = client.post("/transactions/tx1/cancel", json={"reason": "erro"})
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "sem_permissao_cancelar_venda"

    def test_cancelamento_em_curso_chega_como_409(self, client, stub):
        def _estoura(tid, uid, reason):
            raise ErroDeNegocio("cancelamento_em_andamento", "Já em cancelamento",
                                status=409)

        stub(CS, can_admin=lambda uid: True)
        stub(TrS, get_raw_transaction=lambda tid: _tx_crua(), cancel_transaction=_estoura)
        r = client.post("/transactions/tx1/cancel", json={"reason": "erro"})
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "cancelamento_em_andamento"

    def test_trocar_a_forma_de_pagamento_de_venda_alheia(self, client, stub):
        """Só quem registrou (ou um admin) corrige o rótulo; a recusa precisa
        dizer isso à tela, que esconde o botão para os demais."""
        stub(CS, can_admin=lambda uid: False)
        stub(TrS, get_raw_transaction=lambda tid: _tx_crua(created_by="outro"))
        r = client.patch("/transactions/tx1/payment-method", json={"payment_method": "pix"})
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "sem_permissao_trocar_forma_pagamento"

    def test_venda_bloqueada_mantem_a_frase_e_o_motivo(self, client, stub):
        """A trava de vendas já era estruturada; o teste garante que a rota não
        volta a achatar o `detail` em texto ao converter o resto."""
        from app.services.sales_block_service import SalesBlockService as SBS

        def _barra(tournament_id, player_id, tipo, tournament_day_id=None):
            raise ErroDeNegocio("vendas_bloqueadas_dia",
                                "Vendas bloqueadas para este dia: registro encerrado",
                                motivo="registro encerrado")

        stub(SBS, assert_day_sales_allowed=_barra)
        r = client.post("/transactions", json={
            "tournament_id": TOUR, "player_id": JOGADOR, "type": "buy_in", "amount": 100})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "vendas_bloqueadas_dia"
        assert r.json()["detail"]["motivo"] == "registro encerrado"


# ══════════════════════════════════════════════════════════════════════
# Caixa da etapa e sangria (rota)
# ══════════════════════════════════════════════════════════════════════

class TestRotasDoCaixaDaEtapa:
    def test_etapa_sem_caixa_diz_qual_etapa(self, client, stub):
        """Com mais de uma etapa na noite, 'caixa não encontrado' sozinho não
        diz qual delas — a tela precisa do id para nomear a etapa."""
        stub(CRS, get_stage_cash=lambda sid: None)
        r = client.get(f"/cash/stage/{ETAPA}")
        assert r.status_code == 404
        detalhe = r.json()["detail"]
        assert detalhe["code"] == "caixa_da_etapa_nao_encontrado"
        assert detalhe["stage_id"] == ETAPA

    def test_sangria_recusada_mantem_a_frase_do_service(self, client, stub):
        """`CashRegisterService` ainda levanta `ValueError` cru; até ele ser
        convertido, o código genérico mantém UM formato só na tela e a frase
        continua chegando inteira."""
        def _estoura(sangria_data, user_id):
            raise ValueError("Insufficient balance. Available: 10, Requested: 50")

        stub(CRS, perform_sangria=_estoura)
        r = client.post("/cash/sangria", json={"stage_id": ETAPA, "amount": 50,
                                              "stage_name": "Etapa 1"})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "sangria_recusada"
        assert "Insufficient balance" in r.json()["detail"]["message"]


# ══════════════════════════════════════════════════════════════════════
# Despesas e receitas (rota)
# ══════════════════════════════════════════════════════════════════════

class TestRotasDeDespesas:
    def test_categoria_inexistente(self, client, stub):
        stub(ES, update_category=lambda org, cid, d: None)
        r = client.patch("/expenses/categories/c1", json={"name": "X"})
        assert r.json()["detail"]["code"] == "categoria_nao_encontrada"

    def test_modelo_inexistente(self, client, stub):
        stub(ES, delete_template=lambda org, tid: False)
        r = client.delete("/expenses/templates/t1")
        assert r.json()["detail"]["code"] == "modelo_de_despesa_nao_encontrado"

    def test_despesa_inexistente(self, client, stub):
        stub(ES, delete_expense=lambda org, eid: False)
        r = client.delete("/expenses/e1")
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "despesa_nao_encontrada"

    def test_saldo_insuficiente_no_caixa_geral(self, client, stub):
        """A frase vem do BANCO (o RPC do débito diz o motivo), então não há
        código específico a dar — mas ela precisa chegar inteira: é o que
        explica ao financeiro por que a despesa não entrou."""
        def _estoura(org, d, uid):
            raise ValueError("Saldo insuficiente no caixa geral")

        stub(ES, create_expense=_estoura)
        r = client.post("/expenses", json={"description": "Aluguel", "amount": 10,
                                           "stage_id": ETAPA})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "despesa_recusada"
        assert "Saldo insuficiente" in r.json()["detail"]["message"]

    def test_despesa_que_o_banco_nao_gravou(self, client, stub):
        stub(ES, create_expense=lambda org, d, uid: None)
        r = client.post("/expenses", json={"description": "Aluguel", "amount": 10,
                                           "stage_id": ETAPA})
        assert r.json()["detail"]["code"] == "despesa_nao_registrada"

    def test_comprovante_inexistente(self, client, stub):
        stub(ES, delete_attachment=lambda org, aid: False)
        r = client.delete("/expenses/e1/attachments/a1")
        assert r.json()["detail"]["code"] == "comprovante_nao_encontrado"

    def test_receita_inexistente(self, client, stub):
        stub(ES, delete_revenue=lambda org, rid: False)
        r = client.delete("/revenues/r1")
        assert r.json()["detail"]["code"] == "receita_nao_encontrada"

    def test_receita_recusada_pelo_banco(self, client, stub):
        def _estoura(org, d, uid):
            raise ValueError("RECEITA já recebida")

        stub(ES, create_revenue=_estoura)
        r = client.post("/revenues", json={"description": "Bar", "amount": 10,
                                           "stage_id": ETAPA})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "receita_recusada"


# ══════════════════════════════════════════════════════════════════════
# Consignação de fichas (sangeur)
# ══════════════════════════════════════════════════════════════════════

def _banco_da_consignacao(monkeypatch, **tabelas):
    base = {"staff": [], "chip_consignments": [], "chip_consignment_sales": [],
            "players": [{"id": JOGADOR, "name": "Fulano"}]}
    base.update(tabelas)
    fake = FakeSupabase(base)
    monkeypatch.setattr(consignacao_mod, "supabase", fake)
    return fake


def _sangeur(permissoes=("sangi",), ativo=True):
    return {"id": STAFF, "active": ativo,
            "permission_groups": {"permissions": list(permissoes)}}


def _consignacao(status="open", liberado=1000.0, vendido=0.0):
    return {"id": "cons-1", "sangi_staff_id": STAFF, "stage_id": ETAPA,
            "released_amount": liberado, "total_sold": vendido, "status": status,
            "opened_at": "2026-06-08T00:00:00Z", "created_at": "2026-06-08T00:00:00Z"}


class TestRecusasDaConsignacao:
    def _libera(self):
        return ConsignmentRelease(sangi_staff_id=STAFF, released_amount=1000)

    def test_sem_etapa_usa_o_mesmo_codigo_do_caixa(self, monkeypatch):
        """A saída para o operador é a mesma dos dois lados — escolher a etapa
        na barra do topo — então o código é o mesmo e a tela traduz uma vez só."""
        _banco_da_consignacao(monkeypatch)
        with pytest.raises(Exception) as e:
            CCS.release(self._libera(), stage_id=None, opened_by="u")
        assert e.value.detail["code"] == "etapa_nao_selecionada"

    def test_sangeur_inexistente_e_404(self, monkeypatch):
        _banco_da_consignacao(monkeypatch)
        with pytest.raises(Exception) as e:
            CCS.release(self._libera(), stage_id=ETAPA, opened_by="u")
        assert e.value.status_code == 404
        assert e.value.detail["code"] == "sangeur_nao_encontrado"

    def test_funcionario_inativo(self, monkeypatch):
        _banco_da_consignacao(monkeypatch, staff=[_sangeur(ativo=False)])
        with pytest.raises(Exception) as e:
            CCS.release(self._libera(), stage_id=ETAPA, opened_by="u")
        assert e.value.detail["code"] == "funcionario_inativo"

    def test_funcionario_sem_a_permissao_de_sangeur(self, monkeypatch):
        """Só quem tem a chave `sangi` recebe fichas em consignação; a trava
        vale também em chamada direta à API, não só na tela."""
        _banco_da_consignacao(monkeypatch, staff=[_sangeur(permissoes=("cashier",))])
        with pytest.raises(Exception) as e:
            CCS.release(self._libera(), stage_id=ETAPA, opened_by="u")
        assert e.value.detail["code"] == "funcionario_nao_e_sangeur"

    def test_consignacao_aberta_e_409_e_aponta_a_existente(self, monkeypatch):
        """409 porque o caminho é ABATER a consignação aberta, não corrigir
        este pedido — e o id dela vai junto para a tela levar o operador lá."""
        _banco_da_consignacao(monkeypatch, staff=[_sangeur()],
                              chip_consignments=[_consignacao()])
        with pytest.raises(Exception) as e:
            CCS.release(self._libera(), stage_id=ETAPA, opened_by="u")
        assert e.value.status_code == 409
        assert e.value.detail["code"] == "consignacao_aberta_existente"
        assert e.value.detail["consignment_id"] == "cons-1"

    def test_venda_acima_do_liberado_manda_os_numeros(self, monkeypatch):
        _banco_da_consignacao(monkeypatch,
                              chip_consignments=[_consignacao(liberado=1000, vendido=900)])
        with pytest.raises(Exception) as e:
            CCS.register_sale("cons-1", SaleCreate(amount=200, buyer_player_id=JOGADOR),
                              sold_by="u")
        detalhe = e.value.detail
        assert detalhe["code"] == "venda_excede_o_liberado"
        assert (detalhe["liberado"], detalhe["vendido"]) == (1000.0, 900.0)

    def test_venda_em_consignacao_ja_abatida_e_409(self, monkeypatch):
        _banco_da_consignacao(monkeypatch,
                              chip_consignments=[_consignacao(status="reconciled")])
        with pytest.raises(Exception) as e:
            CCS.register_sale("cons-1", SaleCreate(amount=10, buyer_player_id=JOGADOR),
                              sold_by="u")
        assert e.value.status_code == 409
        assert e.value.detail["code"] == "consignacao_ja_reconciliada"

    def test_comprador_inexistente(self, monkeypatch):
        _banco_da_consignacao(monkeypatch, players=[],
                              chip_consignments=[_consignacao()])
        with pytest.raises(Exception) as e:
            CCS.register_sale("cons-1", SaleCreate(amount=10, buyer_player_id=JOGADOR),
                              sold_by="u")
        assert e.value.status_code == 404
        assert e.value.detail["code"] == "comprador_nao_encontrado"

    def test_venda_em_consignacao_inexistente(self, monkeypatch):
        _banco_da_consignacao(monkeypatch)
        with pytest.raises(Exception) as e:
            CCS.register_sale("cons-1", SaleCreate(amount=10, buyer_player_id=JOGADOR),
                              sold_by="u")
        assert e.value.status_code == 404
        assert e.value.detail["code"] == "consignacao_nao_encontrada"

    def test_o_trigger_do_banco_perdendo_a_corrida_vira_recusa_limpa(self, monkeypatch):
        """A conferência no serviço é rápida mas NÃO é atômica: com dois
        pedidos ao mesmo tempo, quem perde a corrida é barrado pelo trigger. Sem
        traduzir isso, o sangeur recebia 500 — parece defeito, e é regra."""
        class BancoComTrigger(FakeSupabase):
            def table(self, nome):
                consulta = super().table(nome)
                if nome == "chip_consignment_sales":
                    def _execute():
                        raise RuntimeError("venda excede o valor liberado")
                    consulta.execute = _execute
                return consulta

        monkeypatch.setattr(consignacao_mod, "supabase", BancoComTrigger({
            "chip_consignments": [_consignacao()],
            "players": [{"id": JOGADOR, "name": "Fulano"}],
        }))
        with pytest.raises(Exception) as e:
            CCS.register_sale("cons-1", SaleCreate(amount=10, buyer_player_id=JOGADOR),
                              sold_by="u")
        assert e.value.status_code == 400
        assert e.value.detail["code"] == "venda_excede_o_liberado"

    def test_apagar_venda_de_consignacao_inexistente(self, monkeypatch):
        _banco_da_consignacao(monkeypatch)
        with pytest.raises(Exception) as e:
            CCS.delete_sale("cons-1", "venda-1")
        assert e.value.status_code == 404
        assert e.value.detail["code"] == "consignacao_nao_encontrada"

    def test_consignacao_inexistente(self, monkeypatch):
        _banco_da_consignacao(monkeypatch)
        with pytest.raises(Exception) as e:
            CCS.reconcile("cons-1", reconciled_by="u")
        assert e.value.status_code == 404
        assert e.value.detail["code"] == "consignacao_nao_encontrada"

    def test_apagar_venda_de_consignacao_abatida(self, monkeypatch):
        _banco_da_consignacao(monkeypatch,
                              chip_consignments=[_consignacao(status="reconciled")])
        with pytest.raises(Exception) as e:
            CCS.delete_sale("cons-1", "venda-1")
        assert e.value.detail["code"] == "consignacao_ja_reconciliada"


# ══════════════════════════════════════════════════════════════════════
# Guarda contra regressão
# ══════════════════════════════════════════════════════════════════════

ARQUIVOS_FINANCEIROS = [
    "app/routers/transactions.py",
    "app/routers/cash_register.py",
    "app/routers/expenses.py",
    "app/routers/cashboxes.py",
    "app/services/transaction_service.py",
    "app/services/cashbox_service.py",
    "app/services/chip_consignment_service.py",
]


class TestNenhumaRecusaSemCodigo:
    """Uma recusa nova escrita à moda antiga não aparece em teste nenhum — ela
    só some da tradução, e o operador em Lima recebe português. Esta varredura
    é o que impede a área financeira de voltar ao formato de string aos poucos.
    """

    @pytest.mark.parametrize("caminho", ARQUIVOS_FINANCEIROS)
    def test_nao_sobrou_value_error_cru(self, caminho):
        fonte = io.open(caminho, encoding="utf-8").read()
        assert "raise ValueError(" not in fonte

    # Quanto ainda pode sobrar de `HTTPException` crua em cada arquivo, e por
    # quê. O orçamento é ZERO em toda parte, menos:
    #
    # - `transactions.py`: 4 recusas em INGLÊS na validação de escopo de etapa
    #   ("Tournament not found", "...does not belong to the selected stage").
    #   São mensagens de desenvolvedor — a tela nunca manda um torneio de outra
    #   etapa — e ficaram de fora da conversão de propósito.
    # - `cash_register.py`: 3 respostas 500. Erro interno é defeito nosso, não
    #   texto para o operador traduzir.
    ORCAMENTO = {
        "app/routers/transactions.py": 4,
        "app/routers/cash_register.py": 3,
    }

    @pytest.mark.parametrize("caminho", ARQUIVOS_FINANCEIROS)
    def test_nao_sobrou_http_exception_com_frase(self, caminho):
        """`erro_http` e seus atalhos são o único caminho para uma recusa nova."""
        fonte = io.open(caminho, encoding="utf-8").read()
        cruas = fonte.count("HTTPException(")
        assert cruas <= self.ORCAMENTO.get(caminho, 0)


class TestSangriaPelaRota:
    """As duas últimas recusas em inglês do sistema — as da sangria.

    O router as achatava num `sangria_recusada` genérico porque o serviço ainda
    levantava `ValueError` cru. Agora elas têm código próprio, e o que este
    teste garante é que `da_excecao` PRESERVA esse código em vez de trocá-lo
    pelo padrão da rota.
    """

    def test_saldo_insuficiente_chega_com_codigo_e_valores(self, client, stub):
        from app.services.cash_register_service import CashRegisterService as CRS
        from app.utils.erros import ErroDeNegocio

        def _estoura(sangria_data, user_id):
            raise ErroDeNegocio(
                "saldo_insuficiente_na_etapa",
                "Saldo insuficiente no caixa da etapa: há 100 e foram pedidos 500.",
                disponivel=100, solicitado=500,
            )

        stub(CRS, perform_sangria=_estoura)
        r = client.post("/cash/sangria", json={
            "stage_id": "11111111-1111-1111-1111-111111111111",
            "stage_name": "Etapa 1", "amount": 500,
        })
        assert r.status_code == 400
        d = r.json()["detail"]
        assert d["code"] == "saldo_insuficiente_na_etapa"   # e NÃO "sangria_recusada"
        assert d["disponivel"] == 100 and d["solicitado"] == 500

    def test_etapa_sem_caixa_chega_como_404(self, client, stub):
        from app.services.cash_register_service import CashRegisterService as CRS
        from app.utils.erros import ErroDeNegocio

        def _estoura(sangria_data, user_id):
            raise ErroDeNegocio(
                "caixa_da_etapa_nao_encontrado",
                "Esta etapa ainda não tem caixa aberto.", status=404,
            )

        stub(CRS, perform_sangria=_estoura)
        r = client.post("/cash/sangria", json={
            "stage_id": "11111111-1111-1111-1111-111111111111",
            "stage_name": "Etapa 1", "amount": 10,
        })
        # O status do ErroDeNegocio vence o padrão 400 da rota.
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "caixa_da_etapa_nao_encontrado"
