"""Ler TODAS as linhas de uma consulta, de mil em mil.

O PostgREST do Supabase devolve no máximo 1000 linhas por resposta
(`max_rows`) e corta EM SILÊNCIO: sem erro, sem aviso, a lista simplesmente
para na milésima linha. Medido em produção em 2026-11-04 (`activity_logs`, com
1813 linhas, voltou com 1000). Um clube já tinha 893 vendas e 872 movimentos
de caixa: na noite seguinte, toda soma feita em Python sobre essas listas —
totais da gaveta, DRE, bounty do KO — passaria a sair MENOR que o real.

`todas_as_linhas` pede a consulta página por página até vir uma incompleta.
Só custa ida a mais quando há mais de mil linhas.

Duas exigências de quem chama:

- **Ordem estável.** Sem ORDER BY, o Postgres não garante a mesma ordem entre
  uma página e outra, e linhas sumiriam ou se repetiriam. Ponha `id` como
  desempate no fim (`created_at` sozinho empata: várias linhas da mesma
  transação têm o mesmo instante).
- **A consulta é MONTADA de novo a cada página** (`montar` é uma função): o
  request builder do PostgREST acumula parâmetros, e reaproveitá-lo somaria
  `offset`s.

Uma venda que entra ENTRE duas páginas empurra tudo uma posição, e a página
seguinte repetiria a última linha da anterior — numa soma, contada duas vezes.
Por isso as linhas repetidas (mesmo `id`) são descartadas — e o select PRECISA
trazer o `id` para isso valer.
"""
from typing import Callable

# O `max_rows` do PostgREST deste projeto. Pedir páginas maiores não adianta
# (o servidor corta em 1000 do mesmo jeito) e faria o laço parar cedo achando
# que a página veio incompleta.
PAGINA = 1000


def todas_as_linhas(montar: Callable, pagina: int = PAGINA) -> list:
    """Todas as linhas de `montar()` — uma consulta pronta, com filtros e ordem
    estável, SEM `.limit`/`.range` (esses ficam por conta daqui)."""
    linhas = []
    vistos = set()
    inicio = 0
    while True:
        lote = montar().range(inicio, inicio + pagina - 1).execute().data or []
        for linha in lote:
            chave = linha.get("id") if isinstance(linha, dict) else None
            if chave is not None:
                if chave in vistos:
                    continue
                vistos.add(chave)
            linhas.append(linha)
        if len(lote) < pagina:
            return linhas
        inicio += pagina
