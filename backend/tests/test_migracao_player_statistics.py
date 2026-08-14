"""A view `player_statistics` conta o que o jogador REALMENTE disputou.

Quando um buy-in e' cancelado, a linha de `tournament_players` fica na base
(auditoria da venda estornada) com status 'cancelled'. A v3 agregava essa tabela
sem olhar o status, entao os tres contadores de LINHA — entries,
tournaments_played e days_played — continuavam contando a inscricao desfeita: o
perfil mostrava um torneio que o jogador nao jogou, e win_rate / itm_rate /
rebuy_rate / ROI (que dividem por esses contadores) saiam menores do que a
realidade. O jogador cobra o clube pelo ranking dele; esse numero precisa bater.

Nao ha' Postgres nos testes, entao o que da' para garantir aqui e' a ESTRUTURA
da migracao — e ela pega os dois jeitos de esta migracao dar errado em
producao:
  1. a v4 esquecer o filtro (o bug volta calado, ninguem percebe ate' o jogador
     reclamar);
  2. a v4 mudar a lista de colunas — `CREATE OR REPLACE VIEW` EXIGE nomes, ordem
     e tipos identicos, entao uma coluna a mais ou a menos faz a migracao
     estourar na hora de aplicar, no meio do evento.
"""
import re
from pathlib import Path

MIGRACOES = Path(__file__).resolve().parents[2] / "db" / "migrations"
V3 = MIGRACOES / "database_migration_player_statistics_v3.sql"
V4 = MIGRACOES / "database_migration_player_statistics_v4.sql"


def _sem_comentarios(caminho: Path) -> str:
    texto = caminho.read_text(encoding="utf-8")
    return "\n".join(l for l in texto.splitlines() if not l.strip().startswith("--"))


def _agregacao_das_inscricoes(sql: str) -> str:
    """Trecho da CTE que agrega `tournament_players` (do FROM ate' o GROUP BY)."""
    inicio = sql.index("FROM tournament_players tp")
    fim = sql.index("GROUP BY tp.player_id", inicio)
    return sql[inicio:fim]


def _colunas_da_view(sql: str) -> list:
    """Nomes das colunas que a view expoe, na ordem."""
    inicio = sql.index("SELECT p.id")
    fim = sql.index("FROM players p", inicio)
    trecho = sql[inicio:fim]
    # As tres primeiras vem sem AS (p.id, p.name, p.nickname); o resto e' aliased.
    return ["id", "name", "nickname"] + re.findall(r"\bAS\s+(\w+)", trecho, re.IGNORECASE)


class TestPlayerStatisticsV4:
    def test_a_migracao_existe(self):
        assert V4.exists(), "sem a v4 o perfil segue contando torneio cancelado"

    def test_inscricao_cancelada_fica_de_fora_da_agregacao(self):
        """E' o achado: contar a LINHA (nao o valor) da inscricao desfeita."""
        agregacao = _agregacao_das_inscricoes(_sem_comentarios(V4))
        assert "WHERE" in agregacao.upper()
        assert "cancelled" in agregacao

    def test_a_v3_realmente_nao_filtrava(self):
        """Ancora do achado: se um dia a v3 mudar, o teste acima perde o sentido."""
        assert "cancelled" not in _agregacao_das_inscricoes(_sem_comentarios(V3))

    def test_mantem_exatamente_as_colunas_da_v3(self):
        """CREATE OR REPLACE VIEW so' aceita a MESMA lista de colunas. Mudar
        aqui faz a migracao estourar na hora de aplicar, e a tela de perfil fica
        sem os dados ate' alguem descobrir por que."""
        assert _colunas_da_view(_sem_comentarios(V4)) == _colunas_da_view(_sem_comentarios(V3))

    def test_e_idempotente_e_nao_derruba_a_view(self):
        """DROP VIEW levaria junto qualquer dependente e abriria uma janela sem
        estatistica; CREATE OR REPLACE pode ser reaplicado a' vontade."""
        sql = _sem_comentarios(V4).lower()
        assert "create or replace view public.player_statistics" in sql
        assert "drop view" not in sql

    def test_continua_respeitando_o_rls_de_quem_consulta(self):
        """Sem security_invoker a view roda com o dono e um clube veria a
        estatistica do jogador de outro (o vazamento corrigido na fase 5 do
        SaaS)."""
        assert "security_invoker=on" in _sem_comentarios(V4).replace(" ", "")
