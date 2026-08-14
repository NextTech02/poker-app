"""Testes do replay da fila offline.

Quando a internet volta, a fila do dispositivo e reenviada. O risco aqui e
especifico: reenviar a MESMA operacao duas vezes duplica dinheiro (um rebuy
vira dois, uma sangria debita duas vezes). A protecao e o ledger de
client_mutation_id — e ele ja falhou em silencio uma vez, quando o INSERT
violava NOT NULL e o erro era engolido: o sync parecia funcionar e a
idempotencia nao existia.
"""
import pytest

from app.services import sync_service
from app.services.sync_service import SyncService
from app.services.tournament_player_service import TournamentPlayerService
from app.services.cash_register_service import CashRegisterService
from app.services.player_service import PlayerService

from tests.conftest import FakeSupabase


ORG = "33333333-3333-3333-3333-333333333333"
TP = "66666666-6666-6666-6666-666666666666"


def _monta(monkeypatch, ledger=None):
    fake = FakeSupabase({"sync_mutations": ledger or []})
    monkeypatch.setattr(sync_service, "supabase", fake)
    return fake


def _op(kind, cmid="cm-1", body=None):
    return {"kind": kind, "clientMutationId": cmid, "body": body or {}}


class TestIdempotencia:
    def test_operacao_ja_aplicada_e_pulada(self, monkeypatch):
        """Ledger com o cmid => nao reexecuta. E o que impede a fila de
        duplicar dinheiro quando o ack se perde e o dispositivo reenvia."""
        _monta(monkeypatch, ledger=[{"client_mutation_id": "cm-1", "kind": "rebuy"}])
        chamou = []
        monkeypatch.setattr(TournamentPlayerService, "add_rebuy",
                            staticmethod(lambda *a, **k: chamou.append(1)))

        r = SyncService.apply_op(_op("rebuy", "cm-1", {"tournament_player_id": TP}), "u1", ORG)

        assert r["status"] == "applied"
        assert chamou == []          # nao reexecutou

    def test_sucesso_registra_no_ledger(self, monkeypatch):
        fake = _monta(monkeypatch)
        monkeypatch.setattr(TournamentPlayerService, "add_rebuy", staticmethod(lambda *a, **k: None))

        SyncService.apply_op(_op("rebuy", "cm-9", {"tournament_player_id": TP}), "u1", ORG)

        gravado = fake.store["sync_mutations"]
        assert len(gravado) == 1
        assert gravado[0]["client_mutation_id"] == "cm-9"
        # a organizacao vai EXPLICITA: este service usa o client admin, que nao
        # carrega o claim do JWT — sem isso o INSERT violaria NOT NULL
        assert gravado[0]["organization_id"] == ORG

    def test_falha_nao_registra_no_ledger(self, monkeypatch):
        """Se registrasse, a operacao ficaria marcada como aplicada e seria
        pulada para sempre — perdendo o lancamento."""
        fake = _monta(monkeypatch)
        monkeypatch.setattr(
            TournamentPlayerService, "add_rebuy",
            staticmethod(lambda *a, **k: (_ for _ in ()).throw(ValueError("sem caixa"))),
        )

        r = SyncService.apply_op(_op("rebuy", "cm-x", {"tournament_player_id": TP}), "u1", ORG)

        assert r["status"] == "conflict"
        assert fake.store["sync_mutations"] == []

    def test_sem_cmid_nao_pula(self, monkeypatch):
        _monta(monkeypatch)
        chamou = []
        monkeypatch.setattr(TournamentPlayerService, "add_rebuy",
                            staticmethod(lambda *a, **k: chamou.append(1)))
        SyncService.apply_op(_op("rebuy", None, {"tournament_player_id": TP}), "u1", ORG)
        assert chamou == [1]


class TestClassificacaoDeErro:
    def test_regra_de_negocio_vira_conflito(self, monkeypatch):
        """`conflict` vai para a tela de revisao; `error` seria retentado. A
        distincao evita reenviar para sempre algo que nunca vai passar."""
        _monta(monkeypatch)
        monkeypatch.setattr(
            TournamentPlayerService, "eliminate_player",
            staticmethod(lambda *a, **k: (_ for _ in ()).throw(ValueError("ja eliminado"))),
        )
        r = SyncService.apply_op(_op("eliminate", "cm-2", {"tournament_player_id": TP}), "u1", ORG)
        assert r["status"] == "conflict"
        assert "ja eliminado" in r["error"]

    def test_falha_inesperada_vira_erro(self, monkeypatch):
        _monta(monkeypatch)
        monkeypatch.setattr(
            TournamentPlayerService, "eliminate_player",
            staticmethod(lambda *a, **k: (_ for _ in ()).throw(RuntimeError("rede caiu"))),
        )
        r = SyncService.apply_op(_op("eliminate", "cm-3", {"tournament_player_id": TP}), "u1", ORG)
        assert r["status"] == "error"

    def test_tipo_desconhecido_nao_derruba_o_lote(self, monkeypatch):
        _monta(monkeypatch)
        r = SyncService.apply_op(_op("kind-que-nao-existe", "cm-4"), "u1", ORG)
        assert r["status"] == "error"
        assert "desconhecido" in r["error"]


class TestLote:
    def test_processa_na_ordem_e_devolve_um_status_por_operacao(self, monkeypatch):
        _monta(monkeypatch)
        ordem = []
        monkeypatch.setattr(TournamentPlayerService, "add_rebuy",
                            staticmethod(lambda *a, **k: ordem.append("rebuy")))
        monkeypatch.setattr(TournamentPlayerService, "add_addon",
                            staticmethod(lambda *a, **k: ordem.append("addon")))

        r = SyncService.apply_batch([
            _op("rebuy", "cm-a", {"tournament_player_id": TP}),
            _op("addon", "cm-b", {"tournament_player_id": TP}),
        ], "u1", ORG)

        assert [x["status"] for x in r] == ["applied", "applied"]
        assert ordem == ["rebuy", "addon"]

    def test_uma_falha_no_meio_nao_impede_as_demais(self, monkeypatch):
        """Perder o resto da fila por causa de uma operacao ruim seria pior que
        o proprio conflito."""
        _monta(monkeypatch)
        monkeypatch.setattr(
            TournamentPlayerService, "add_rebuy",
            staticmethod(lambda *a, **k: (_ for _ in ()).throw(ValueError("conflito"))),
        )
        monkeypatch.setattr(TournamentPlayerService, "add_addon", staticmethod(lambda *a, **k: None))

        r = SyncService.apply_batch([
            _op("rebuy", "cm-a", {"tournament_player_id": TP}),
            _op("addon", "cm-b", {"tournament_player_id": TP}),
        ], "u1", ORG)

        assert r[0]["status"] == "conflict"
        assert r[1]["status"] == "applied"

    def test_lote_vazio_devolve_lista_vazia(self, monkeypatch):
        _monta(monkeypatch)
        assert SyncService.apply_batch([], "u1", ORG) == []
        assert SyncService.apply_batch(None, "u1", ORG) == []


class TestOperacoesSuportadas:
    def test_sangria_offline_e_reaplicada(self, monkeypatch):
        _monta(monkeypatch)
        recebido = {}
        monkeypatch.setattr(
            CashRegisterService, "perform_sangria",
            staticmethod(lambda dados, user_id: recebido.update(valor=dados.amount)),
        )
        corpo = {"stage_id": "11111111-1111-1111-1111-111111111111",
                 "stage_name": "Etapa", "amount": 250, "rake_percentage": 20}
        r = SyncService.apply_op(_op("sangria", "cm-s", corpo), "u1", ORG)
        assert r["status"] == "applied"
        assert float(recebido["valor"]) == 250.0

    def test_criacao_de_jogador_devolve_o_id_do_servidor(self, monkeypatch):
        """O dispositivo precisa do id real para ligar os lancamentos seguintes."""
        _monta(monkeypatch)

        class _P:
            id = "id-do-servidor"

        monkeypatch.setattr(PlayerService, "create_player", staticmethod(lambda dados: _P()))
        corpo = {"name": "Fulano", "email": "f@x.com", "phone": "1",
                 "nationality": "Brasil", "document_type": "national_id",
                 "document_number": "123"}
        r = SyncService.apply_op(_op("player-create", "cm-p", corpo), "u1", ORG)
        assert r["status"] == "applied"
        assert r["serverId"] == "id-do-servidor"


class TestComandosDeRelogio:
    """O relogio tambem entra na fila: comandos dados sem internet precisam
    ser reaplicados na ordem quando ela volta."""

    def _timer(self, monkeypatch):
        from app.services.tournament_day_service import TournamentDayService
        _monta(monkeypatch)
        chamadas = []
        for nome in ("start_timer", "pause_timer", "next_level",
                     "previous_level", "reset_timer"):
            monkeypatch.setattr(TournamentDayService, nome,
                                staticmethod(lambda day_id, _n=nome: chamadas.append(_n)))
        monkeypatch.setattr(TournamentDayService, "adjust_timer",
                            staticmethod(lambda day_id, seg: chamadas.append(("adjust", seg))))
        return chamadas

    @pytest.mark.parametrize("acao,esperado", [
        ("start", "start_timer"),
        ("pause", "pause_timer"),
        ("next-level", "next_level"),
        ("prev-level", "previous_level"),
        ("reset", "reset_timer"),
    ])
    def test_cada_comando_chama_a_operacao_certa(self, monkeypatch, acao, esperado):
        chamadas = self._timer(monkeypatch)
        r = SyncService.apply_op(
            _op("timer", f"cm-{acao}", {"day_id": "d1", "action": acao}), "u1", ORG
        )
        assert r["status"] == "applied"
        assert chamadas == [esperado]

    def test_ajuste_leva_os_segundos(self, monkeypatch):
        chamadas = self._timer(monkeypatch)
        SyncService.apply_op(
            _op("timer", "cm-adj", {"day_id": "d1", "action": "adjust", "seconds": 90}),
            "u1", ORG,
        )
        assert chamadas == [("adjust", 90)]

    def test_acao_desconhecida_vira_conflito(self, monkeypatch):
        self._timer(monkeypatch)
        r = SyncService.apply_op(
            _op("timer", "cm-?", {"day_id": "d1", "action": "voar"}), "u1", ORG
        )
        assert r["status"] == "conflict"
        assert "desconhecida" in r["error"]


class TestDemaisOperacoes:
    def test_eliminacao_e_restauracao(self, monkeypatch):
        _monta(monkeypatch)
        feitos = []
        monkeypatch.setattr(TournamentPlayerService, "eliminate_player",
                            staticmethod(lambda *a, **k: feitos.append("elim")))
        monkeypatch.setattr(TournamentPlayerService, "update_tournament_player",
                            staticmethod(lambda *a, **k: feitos.append("restore")))

        SyncService.apply_op(_op("eliminate", "cm-e", {"tournament_player_id": TP}), "u1", ORG)
        SyncService.apply_op(_op("restore", "cm-r", {"tournament_player_id": TP}), "u1", ORG)
        assert feitos == ["elim", "restore"]

    def test_addon_offline(self, monkeypatch):
        _monta(monkeypatch)
        feitos = []
        monkeypatch.setattr(TournamentPlayerService, "add_addon",
                            staticmethod(lambda *a, **k: feitos.append("addon")))
        r = SyncService.apply_op(_op("addon", "cm-ad", {"tournament_player_id": TP}), "u1", ORG)
        assert r["status"] == "applied"
        assert feitos == ["addon"]

    def test_contador_de_eliminados(self, monkeypatch):
        from app.services.tournament_day_service import TournamentDayService
        _monta(monkeypatch)
        recebido = {}
        monkeypatch.setattr(TournamentDayService, "adjust_eliminations",
                            staticmethod(lambda day_id, n: recebido.update(n=n)))
        SyncService.apply_op(_op("elim-counter", "cm-c", {"day_id": "d1", "count": 3}), "u1", ORG)
        assert recebido["n"] == 3

    def test_registro_de_jogador_devolve_o_id(self, monkeypatch):
        _monta(monkeypatch)

        class _TP:
            id = "tp-servidor"

        recebido = {}

        def _registrar(dados, user_id, skip_sales_block=False):
            recebido["skip"] = skip_sales_block
            return _TP()

        monkeypatch.setattr(TournamentPlayerService, "register_player", staticmethod(_registrar))
        corpo = {"tournament_id": "22222222-2222-2222-2222-222222222222",
                 "player_id": "44444444-4444-4444-4444-444444444444"}
        r = SyncService.apply_op(_op("register", "cm-reg", corpo), "u1", ORG)
        assert r["serverId"] == "tp-servidor"
        # A venda ja aconteceu em tempo real, antes de o diretor bloquear: o
        # replay nao pode rejeitar dinheiro que ja esta na gaveta do operador.
        assert recebido["skip"] is True
