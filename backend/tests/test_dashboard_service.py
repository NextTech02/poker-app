"""Estatísticas do dashboard — a tela que fica aberta o dia inteiro.

Duas decisões de projeto governam este serviço, e são o que os testes fixam:

1. **RPC primeiro, cálculo em Python como rede de proteção.** A agregação
   `get_dashboard_stats` resolve tudo em UMA ida ao banco; sem ela, seria
   preciso baixar até 5.000 linhas de transações só para somar. Mas a RPC pode
   não existir num banco ainda não migrado — e aí o serviço precisa continuar
   respondendo, não quebrar a tela inicial.

2. **Nunca estourar.** Toda consulta é isolada: a que falhar vira zero, e uma
   falha geral devolve os quatro zeros. Um dashboard em branco com erro 500 é
   pior do que um dashboard dizendo "0" — o gerente abre essa tela para saber
   se o sistema está de pé.

O filtro por etapa é aplicado por dentro: os torneios da etapa viram uma lista
de ids, e uma etapa SEM torneio devolve zeros direto, sem consultar mais nada
(consultar sem filtro traria os números do clube inteiro, atribuídos à etapa
errada).
"""
import pytest

from app.services import dashboard_service as mod
from app.services.dashboard_service import DashboardService as S

from tests.conftest import FakeSupabase


ETAPA = "11111111-1111-1111-1111-111111111111"
TOUR_A = "22222222-2222-2222-2222-22222222222a"
TOUR_B = "22222222-2222-2222-2222-22222222222b"
DIA_A = "33333333-3333-3333-3333-33333333333a"


def _monta(monkeypatch, rpcs=None, **tabelas):
    base = {
        "tournaments": [],
        "tournament_days": [],
        "tournament_players": [],
        "transactions": [],
    }
    base.update(tabelas)
    fake = FakeSupabase(base)
    fake.rpcs = dict(rpcs or {})
    monkeypatch.setattr(mod, "supabase", fake)
    return fake


class TestCaminhoRapidoPelaRPC:
    def test_uma_unica_ida_ao_banco_resolve_tudo(self, monkeypatch):
        """Sem a RPC seria preciso baixar milhares de linhas só para somar."""
        fake = _monta(monkeypatch, rpcs={"get_dashboard_stats": [{
            "active_tournaments": 3, "total_players": 128,
            "total_revenue": "45000.50", "today_revenue": "7200",
        }]})
        r = S.get_stats()
        assert r == {
            "activeTournaments": 3, "totalPlayers": 128,
            "totalRevenue": 45000.50, "todayRevenue": 7200.0,
        }
        # Nenhuma consulta de tabela foi necessária.
        assert fake.rpc_calls[0][0] == "get_dashboard_stats"

    def test_a_etapa_e_repassada_para_a_rpc(self, monkeypatch):
        fake = _monta(monkeypatch, rpcs={"get_dashboard_stats": [{}]})
        S.get_stats(ETAPA)
        assert fake.rpc_calls[0][1] == {"p_stage_id": ETAPA}

    def test_campos_nulos_da_rpc_viram_zero_e_nao_none(self, monkeypatch):
        """`None` no JSON quebraria a formatação de moeda na tela."""
        _monta(monkeypatch, rpcs={"get_dashboard_stats": [{
            "active_tournaments": None, "total_players": None,
            "total_revenue": None, "today_revenue": None,
        }]})
        assert S.get_stats() == {
            "activeTournaments": 0, "totalPlayers": 0,
            "totalRevenue": 0.0, "todayRevenue": 0.0,
        }

    def test_rpc_sem_linha_nenhuma_cai_no_calculo_em_python(self, monkeypatch):
        """Resposta vazia não é resposta: seguir com ela mostraria zeros falsos."""
        _monta(
            monkeypatch,
            rpcs={"get_dashboard_stats": []},
            tournament_days=[{"id": DIA_A, "status": "active", "tournament_id": TOUR_A}],
        )
        assert S.get_stats()["activeTournaments"] == 1


class TestFallbackSemRPC:
    """Banco ainda não migrado: a RPC não existe e o serviço calcula sozinho."""

    def test_conta_dias_ativos_jogadores_e_soma_a_receita(self, monkeypatch):
        _monta(
            monkeypatch,
            tournament_days=[
                {"id": DIA_A, "status": "active", "tournament_id": TOUR_A},
                {"id": "d2", "status": "completed", "tournament_id": TOUR_A},
            ],
            tournament_players=[
                {"id": "tp1", "status": "active", "tournament_day_id": DIA_A},
                {"id": "tp2", "status": "eliminated", "tournament_day_id": DIA_A},
            ],
            transactions=[{"amount": "300"}, {"amount": 200}],
        )
        r = S.get_stats()
        assert r["activeTournaments"] == 1
        assert r["totalPlayers"] == 1
        assert r["totalRevenue"] == 500.0

    def test_etapa_filtra_pelos_torneios_dela(self, monkeypatch):
        """Sem o filtro, os números do clube inteiro apareceriam como sendo da etapa."""
        _monta(
            monkeypatch,
            tournaments=[
                {"id": TOUR_A, "stage_id": ETAPA},
                {"id": TOUR_B, "stage_id": "outra"},
            ],
            tournament_days=[
                {"id": DIA_A, "status": "active", "tournament_id": TOUR_A},
                {"id": "d2", "status": "active", "tournament_id": TOUR_B},
            ],
            tournament_players=[
                {"id": "tp1", "status": "active", "tournament_day_id": DIA_A},
            ],
            transactions=[
                {"amount": 100, "tournament_id": TOUR_A},
                {"amount": 900, "tournament_id": TOUR_B},
            ],
        )
        r = S.get_stats(ETAPA)
        assert r["activeTournaments"] == 1
        assert r["totalPlayers"] == 1
        assert r["totalRevenue"] == 100.0

    def test_etapa_sem_torneio_devolve_zeros_sem_consultar_mais_nada(self, monkeypatch):
        """Seguir sem filtro traria os números do clube inteiro."""
        fake = _monta(
            monkeypatch,
            tournaments=[{"id": TOUR_B, "stage_id": "outra"}],
            transactions=[{"amount": 999}],
        )
        assert S.get_stats(ETAPA) == {
            "activeTournaments": 0, "totalPlayers": 0,
            "totalRevenue": 0.0, "todayRevenue": 0.0,
        }

    def test_receita_do_dia_filtra_por_data(self, monkeypatch):
        from datetime import datetime, timedelta
        hoje = datetime.now().date().isoformat()
        ontem = (datetime.now().date() - timedelta(days=1)).isoformat()
        _monta(monkeypatch, transactions=[
            {"amount": 100, "created_at": f"{hoje}T10:00:00"},
            {"amount": 900, "created_at": f"{ontem}T10:00:00"},
        ])
        r = S.get_stats()
        assert r["totalRevenue"] == 1000.0
        assert r["todayRevenue"] == 100.0


class TestNuncaEstourar:
    """Um 500 aqui deixa a tela inicial em branco — pior do que mostrar zero."""

    def test_falha_ao_resolver_os_torneios_da_etapa_devolve_lista_vazia(self, monkeypatch):
        fake = _monta(monkeypatch)

        def explode(*a, **k):
            raise RuntimeError("banco fora do ar")

        monkeypatch.setattr(fake, "table", explode)
        assert S._get_stage_tournament_ids(ETAPA) == []

    def test_consulta_de_soma_que_falha_vira_zero(self, monkeypatch):
        class QueryQuebrada:
            def execute(self):
                raise RuntimeError("timeout")

        assert S._safe_sum(QueryQuebrada()) == 0.0

    def test_consulta_de_contagem_que_falha_vira_zero(self, monkeypatch):
        class QueryQuebrada:
            def execute(self):
                raise RuntimeError("timeout")

        assert S._safe_count(QueryQuebrada()) == 0

    def test_contagem_sem_count_no_retorno_vira_zero(self, monkeypatch):
        from types import SimpleNamespace

        class QuerySemCount:
            def execute(self):
                return SimpleNamespace(count=None)

        assert S._safe_count(QuerySemCount()) == 0

    def test_falha_geral_devolve_os_quatro_zeros(self, monkeypatch):
        fake = _monta(monkeypatch)

        def explode(*a, **k):
            raise RuntimeError("banco fora do ar")

        monkeypatch.setattr(fake, "table", explode)
        assert S.get_stats() == {
            "activeTournaments": 0, "totalPlayers": 0,
            "totalRevenue": 0.0, "todayRevenue": 0.0,
        }
