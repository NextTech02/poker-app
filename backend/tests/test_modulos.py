"""MÓDULOS contratados: torneio × cash game × bar.

O sistema nasceu só com torneio. Agora o clube contrata um módulo, o outro ou
os dois — e essa escolha decide quais rotas respondem e qual menu a tela monta.

O que estes testes travam, e que uma refatoração distraída desfaz:

1. **O piso `['tournament']`.** Lista vazia não é "nenhum módulo": é a sidebar
   em branco e o clube inteiro parado. Toda organização que existia antes da
   migração fazia torneio, então é esse o único padrão que não muda o mundo de
   ninguém. Vale para org sem linha na tabela E para falha de consulta.
2. **A leitura é fail-SAFE; a guarda é fail-CLOSED.** Um timeout de banco não
   pode apagar o menu de quem está operando (item 1) — mas também não pode
   liberar um módulo não contratado. São dois caminhos diferentes de propósito.
3. **O código `modulo_nao_contratado` com o extra `modulo`.** É contrato com a
   tela: sem o dado nomeado, a tela não consegue dizer QUAL módulo falta nem
   oferecer a contratação, e cai numa frase genérica em português.
4. **Módulo desabilitado some da lista.** Desligar o cash é operação de
   cobrança, não exclusão: as linhas ficam (com `activated_at` como histórico),
   mas não valem acesso.
5. **A ORDEM é canônica (torneio, cash, bar), nunca alfabética.** O frontend
   abre o PRIMEIRO da lista para quem nunca escolheu módulo — e quem só tinha
   um nunca escolheu. Com `sorted()`, 'bar' vinha na frente: o caixa de torneio
   caía na home do bar sem permissão, e o guard de rota o devolvia para a
   mesma home, em laço.
"""
import pytest

from app.auth import modules as modules_mod
from app.services import module_service as module_mod
from app.services.module_service import ModuleService, DEFAULT_MODULES

from tests.conftest import FakeSupabase

# A fixture `client` troca `list_for_org` por um stub, para as rotas de cash
# game não irem ao banco de verdade. Os dois testes de contrato com a tela
# precisam da implementação REAL — sem isso mediriam o stub, não o código.
LISTAGEM_REAL = ModuleService.__dict__["list_for_org"]


ORG = "33333333-3333-3333-3333-333333333333"
OUTRA_ORG = "44444444-4444-4444-4444-444444444444"


def _linha(modulo, org=ORG, enabled=True):
    return {"id": f"mod-{org[:4]}-{modulo}", "organization_id": org,
            "module": modulo, "enabled": enabled}


def _banco(monkeypatch, linhas):
    fake = FakeSupabase({"org_modules": list(linhas)})
    monkeypatch.setattr(module_mod, "supabase", fake)
    return fake


def recusa(excecao):
    """O `detail` estruturado, como a tela recebe."""
    return excecao.detail


# ══════════════════════════════════════════════════════════════════════
# Leitura dos módulos
# ══════════════════════════════════════════════════════════════════════

def test_lista_os_modulos_habilitados(monkeypatch):
    _banco(monkeypatch, [_linha("tournament"), _linha("cash")])
    assert ModuleService.list_for_org(ORG) == ["tournament", "cash"]


def test_ordem_e_canonica_e_nao_alfabetica(monkeypatch):
    """'bar' < 'cash' < 'tournament' no alfabeto. Se o torneio não vier
    PRIMEIRO, quem nunca escolheu módulo abre o bar sem permissão e entra em
    laço de redirect (ver docstring do módulo, item 5)."""
    _banco(monkeypatch, [_linha("bar"), _linha("cash"), _linha("tournament")])
    assert ModuleService.list_for_org(ORG) == ["tournament", "cash", "bar"]


def test_modulo_que_o_backend_nao_conhece_vai_para_o_fim(monkeypatch):
    """Esconder um módulo novo seria pior do que exibi-lo fora de ordem."""
    _banco(monkeypatch, [_linha("zzz-futuro"), _linha("bar"), _linha("tournament")])
    assert ModuleService.list_for_org(ORG) == ["tournament", "bar", "zzz-futuro"]


def test_modulo_desabilitado_nao_da_acesso(monkeypatch):
    """Desligar o cash é cobrança, não exclusão: a linha fica, o acesso não."""
    _banco(monkeypatch, [_linha("tournament"), _linha("cash", enabled=False)])
    assert ModuleService.list_for_org(ORG) == ["tournament"]
    assert ModuleService.has_module(ORG, "cash") is False


def test_nao_enxerga_o_modulo_de_outro_clube(monkeypatch):
    _banco(monkeypatch, [_linha("cash", org=OUTRA_ORG)])
    assert ModuleService.list_for_org(ORG) == DEFAULT_MODULES
    assert ModuleService.has_module(ORG, "cash") is False


def test_org_sem_linha_nenhuma_cai_no_torneio(monkeypatch):
    """Org anterior ao backfill (ou trigger de seed que falhou) sempre fez
    torneio. Devolver [] apagaria a sidebar dela inteira."""
    _banco(monkeypatch, [])
    assert ModuleService.list_for_org(ORG) == ["tournament"]


def test_sem_organizacao_cai_no_torneio(monkeypatch):
    _banco(monkeypatch, [_linha("cash")])
    assert ModuleService.list_for_org(None) == ["tournament"]


def test_falha_de_consulta_nao_apaga_o_menu(monkeypatch):
    """Fail-SAFE na leitura: um timeout de banco não pode deixar quem está
    operando sem um único item de menu."""
    class BancoQueEstoura:
        def table(self, _nome):
            raise RuntimeError("connection reset")

    monkeypatch.setattr(module_mod, "supabase", BancoQueEstoura())
    assert ModuleService.list_for_org(ORG) == ["tournament"]


# ══════════════════════════════════════════════════════════════════════
# Guarda de rota
# ══════════════════════════════════════════════════════════════════════

def _guarda(modulo, org=ORG):
    return modules_mod.require_module(modulo)({"organization_id": org})


def test_guarda_libera_o_modulo_contratado(monkeypatch):
    _banco(monkeypatch, [_linha("tournament"), _linha("cash")])
    assert _guarda("cash")["organization_id"] == ORG


def test_guarda_do_bar_segue_a_mesma_regra(monkeypatch):
    _banco(monkeypatch, [_linha("tournament"), _linha("bar")])
    assert _guarda("bar")["organization_id"] == ORG
    with pytest.raises(Exception) as exc:
        _guarda("cash")
    assert recusa(exc.value)["modulo"] == "cash"


def test_guarda_recusa_o_bar_nao_contratado(monkeypatch):
    _banco(monkeypatch, [_linha("tournament"), _linha("cash")])
    with pytest.raises(Exception) as exc:
        _guarda("bar")
    detalhe = recusa(exc.value)
    assert exc.value.status_code == 403
    assert detalhe["code"] == "modulo_nao_contratado"
    assert detalhe["modulo"] == "bar"


def test_guarda_recusa_o_modulo_nao_contratado(monkeypatch):
    _banco(monkeypatch, [_linha("tournament")])
    with pytest.raises(Exception) as exc:
        _guarda("cash")
    detalhe = recusa(exc.value)
    assert exc.value.status_code == 403
    assert detalhe["code"] == "modulo_nao_contratado"
    # O dado nomeado é o que deixa a tela dizer QUAL módulo falta.
    assert detalhe["modulo"] == "cash"
    assert detalhe["message"]


def test_guarda_e_fail_closed_quando_o_banco_estoura(monkeypatch):
    """Espelho do fail-safe da leitura: lá o menu sobrevive; aqui o acesso NÃO
    é concedido — a lista de reserva não contém 'cash'."""
    class BancoQueEstoura:
        def table(self, _nome):
            raise RuntimeError("connection reset")

    monkeypatch.setattr(module_mod, "supabase", BancoQueEstoura())
    with pytest.raises(Exception) as exc:
        _guarda("cash")
    assert recusa(exc.value)["code"] == "modulo_nao_contratado"


def test_guarda_recusa_conta_sem_organizacao(monkeypatch):
    _banco(monkeypatch, [_linha("cash")])
    with pytest.raises(Exception) as exc:
        modules_mod.require_module("cash")({})
    detalhe = recusa(exc.value)
    assert exc.value.status_code == 403
    assert detalhe["code"] == "conta_sem_organizacao"


# ══════════════════════════════════════════════════════════════════════
# Contrato com a tela
# ══════════════════════════════════════════════════════════════════════

def test_permissoes_do_usuario_trazem_os_modulos(client, monkeypatch):
    """A tela monta a sidebar com esta resposta. Um request extra só para saber
    o módulo atrasaria o primeiro paint de toda sessão."""
    _banco(monkeypatch, [_linha("tournament"), _linha("cash")])
    monkeypatch.setattr(ModuleService, "list_for_org", LISTAGEM_REAL)
    resp = client.get("/staff/me/permissions")
    assert resp.status_code == 200
    assert resp.json()["modules"] == ["tournament", "cash"]


def test_permissoes_caem_no_torneio_quando_nao_ha_modulo(client, monkeypatch):
    _banco(monkeypatch, [])
    monkeypatch.setattr(ModuleService, "list_for_org", LISTAGEM_REAL)
    resp = client.get("/staff/me/permissions")
    assert resp.status_code == 200
    assert resp.json()["modules"] == ["tournament"]
