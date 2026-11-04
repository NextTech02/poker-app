"""Memória por requisição (app/database/memo.py) e o que ela economiza na venda.

Cada ida ao Supabase custa ~50ms de rede; a venda lia a mesma linha do
funcionário três vezes, o torneio quatro e a inscrição do jogador duas. O que
os testes cercam:

- **Dentro da requisição a leitura repete da memória; fora, vai ao banco.**
- **Nenhuma leitura sobrevive a uma escrita** — é o que torna a memória segura
  (ler, gravar, ler de novo traz o dado novo, inclusive o que um trigger mudou).
- **A venda cai de 13 para 8 idas ao banco.**
"""
import pytest

from app.database import memo
from app.database.supabase_client import _EscritaEsqueceMemo, _AdminEsqueceMemo
from app.models.transaction import TransactionCreate
from app.services import (
    cashbox_service, sales_block_service, staff_service, tournament_service, transaction_service,
)
from app.services.sales_block_service import SalesBlockService
from app.services.staff_service import StaffService
from app.services.tournament_service import TournamentService
from app.services.transaction_service import TransactionService

from tests.conftest import FakeSupabase

UID = "99999999-9999-9999-9999-999999999999"
STAFF = "88888888-8888-8888-8888-888888888888"
TOUR = "22222222-2222-2222-2222-222222222222"
ETAPA = "11111111-1111-1111-1111-111111111111"
DIA = "77777777-7777-7777-7777-777777777777"
JOGADOR = "44444444-4444-4444-4444-444444444444"


@pytest.fixture
def memoria():
    token = memo.abrir()
    yield
    memo.fechar(token)


class TestRegras:
    def test_dentro_da_requisicao_a_segunda_leitura_vem_da_memoria(self, memoria):
        chamadas = []
        ler = lambda: chamadas.append(1) or "valor"
        assert memo.lembrar("k", ler) == "valor"
        assert memo.lembrar("k", ler) == "valor"
        assert len(chamadas) == 1

    def test_fora_de_requisicao_nao_ha_memoria(self):
        # Scripts, startup e testes de serviço continuam indo ao banco sempre.
        chamadas = []
        ler = lambda: chamadas.append(1) or "valor"
        memo.lembrar("k", ler)
        memo.lembrar("k", ler)
        assert len(chamadas) == 2

    def test_falha_nao_e_guardada(self, memoria):
        tentativas = []

        def ler():
            tentativas.append(1)
            if len(tentativas) == 1:
                raise RuntimeError("rede")
            return "ok"

        with pytest.raises(RuntimeError):
            memo.lembrar("k", ler)
        assert memo.lembrar("k", ler) == "ok"

    def test_requisicoes_nao_compartilham_memoria(self):
        token = memo.abrir()
        memo.lembrar("k", lambda: "da primeira")
        memo.fechar(token)
        token = memo.abrir()
        try:
            assert memo.lembrar("k", lambda: "da segunda") == "da segunda"
        finally:
            memo.fechar(token)


class _Construtor:
    """Imita o request builder do PostgREST: só os nomes importam aqui."""
    def select(self, *a):
        return "select"

    def insert(self, *a):
        return "insert"

    def update(self, *a):
        return "update"

    def upsert(self, *a):
        return "upsert"

    def delete(self, *a):
        return "delete"


class TestEscritaApagaAMemoria:
    @pytest.mark.parametrize("escrita", ["insert", "update", "upsert", "delete"])
    def test_escrita_pelo_cliente_da_requisicao(self, memoria, escrita):
        memo.lembrar("torneio", lambda: "antes da venda")
        getattr(_EscritaEsqueceMemo(_Construtor()), escrita)({})
        assert memo.lembrar("torneio", lambda: "depois da venda") == "depois da venda"

    def test_leitura_nao_apaga(self, memoria):
        memo.lembrar("torneio", lambda: "guardado")
        _EscritaEsqueceMemo(_Construtor()).select("*")
        assert memo.lembrar("torneio", lambda: "outro") == "guardado"

    def test_escrita_e_rpc_pelo_service_role_tambem(self, memoria):
        class _Cliente:
            def table(self, nome):
                return _Construtor()

            def rpc(self, *a, **k):
                return "rpc"

        admin = _AdminEsqueceMemo(_Cliente())
        memo.lembrar("k", lambda: 1)
        admin.table("transactions").insert({})
        assert memo.lembrar("k", lambda: 2) == 2
        admin.rpc("recalcular", {})
        assert memo.lembrar("k", lambda: 3) == 3


class _BancoQueConta(FakeSupabase):
    """O banco falso de sempre, contando cada ida (uma por `.table()`)."""
    def __init__(self, tabelas):
        super().__init__(tabelas)
        self.idas = []

    def table(self, name):
        self.idas.append(name)
        return super().table(name)

    from_ = table


class TestVendaAvulsa:
    """POST /transactions com a etapa selecionada, na ordem em que a rota roda."""

    def _monta(self, monkeypatch):
        banco = _BancoQueConta({
            "staff": [{"id": STAFF, "auth_user_id": UID, "active": True, "name": "Caixa 1",
                       "permission_groups": {"name": "Caixa", "permissions": ["cashbox.operate"]}}],
            "cashboxes": [{"id": "cx1", "staff_id": STAFF, "stage_id": ETAPA, "status": "open"}],
            "tournaments": [{"id": TOUR, "name": "Main Event", "stage_id": ETAPA,
                             "created_by": UID, "created_at": "2026-11-01T00:00:00Z"}],
            "tournament_days": [{"id": DIA, "sales_blocked": False}],
            "tournament_players": [{"id": "tp1", "tournament_id": TOUR, "player_id": JOGADOR,
                                    "tournament_day_id": DIA, "registered_at": "2026-11-01T20:00:00Z"}],
            "players": [{"id": JOGADOR, "name": "Ana", "nickname": None}],
            "transactions": [],
        })
        for mod in (cashbox_service, sales_block_service, staff_service, tournament_service,
                    transaction_service):
            monkeypatch.setattr(mod, "supabase", banco)
        return banco

    def _vender(self):
        StaffService.get_my_permissions(UID)                       # guarda da rota
        assert TournamentService.get_tournament(TOUR).stage_id == ETAPA   # etapa da rota
        SalesBlockService.assert_day_sales_allowed(TOUR, JOGADOR, "buy_in")
        venda = TransactionCreate(tournament_id=TOUR, player_id=JOGADOR, type="buy_in",
                                  amount=100, payment_method="cash")
        return TransactionService.create_transaction(venda, UID)

    def test_sem_memoria_eram_13_idas(self, monkeypatch):
        banco = self._monta(monkeypatch)
        self._vender()
        assert len(banco.idas) == 13
        assert banco.idas.count("staff") == 3
        assert banco.idas.count("tournaments") == 4

    def test_com_memoria_sao_8_e_cada_linha_e_lida_uma_vez(self, monkeypatch, memoria):
        banco = self._monta(monkeypatch)
        feita = self._vender()
        assert banco.idas.count("staff") == 1
        assert banco.idas.count("tournament_players") == 1
        # o torneio + a consulta própria da trava da etapa (que embute a etapa)
        assert banco.idas.count("tournaments") == 2
        assert len(banco.idas) == 8
        # e a venda saiu inteira: inscrição certa e o nome do torneio na resposta
        assert feita.tournament_player_id == "tp1"
        assert feita.tournament_name == "Main Event"
