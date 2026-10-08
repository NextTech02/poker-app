"""ENTRADAS, REENTRADAS e ELIMINAÇÕES de um dia — a regra única dos dois modos.

A regra, nas palavras do diretor:

- toda ENTRADA (buy-in) soma um jogador;
- toda REENTRADA (rebuy) traz de volta UM jogador eliminado;
- ADD-ON não conta para nada além de fichas e dinheiro;
- na tela aparecem só ENTRADAS e REENTRADAS.

    ENTRADAS   = Σ buy_in_count + classificados vindos de outro dia
    REENTRADAS = Σ rebuy_count            (add-on NÃO entra)
    ATIVOS     = ENTRADAS − eliminations_count

O torneio escolhe na criação COMO o diretor elimina (`tournaments.elimination_mode`):

- 'bulk' (em massa): "Eliminar 1 / Eliminar N" no Controle. O contador não
  sabe QUEM saiu; a reentrada só exige que haja alguém eliminado (> 0).
- 'table' (por mesa): o jogador é eliminado no assento. O contador passa a ser
  SEMPRE a contagem de inscritos 'eliminated' (`recontar_eliminacoes`), e a
  reentrada exige que AQUELE jogador esteja eliminado.

Cada operação do contador tem um RPC atômico no banco
(database_migration_modo_de_eliminacao.sql) e um caminho em Python para o
banco que ainda não recebeu a migração — o deploy não é atômico com ela. Ao
mudar uma regra aqui, procure o par SQL antes de dar por encerrado.

`cliente`: quem chama passa o PRÓPRIO `supabase`. Os testes trocam o cliente
módulo a módulo; recebendo-o de quem chama, esta regra nunca fala com um banco
diferente do serviço que a usou.
"""
import logging
from typing import List, Optional

from app.database import supabase

logger = logging.getLogger("uvicorn.error")

MODO_MESA = "table"
MODO_MASSA = "bulk"

# Colunas que a conta de ENTRADAS precisa ler de cada inscrito.
COLUNAS_DE_ENTRADA = "buy_in_count, rebuy_count, addon_count, is_qualified_entry, status"


def _campo(dia, nome):
    """Lê um campo do dia venha ele como modelo ou como dict."""
    if dia is None:
        return None
    if isinstance(dia, dict):
        return dia.get(nome)
    return getattr(dia, nome, None)


def entradas_para_ativos(inscritos: List[dict], dia=None) -> int:
    """ENTRADAS do dia — o número de onde sai ATIVOS = ENTRADAS − ELIMINAÇÕES.

    Entrada é o buy-in, MAIS o classificado vindo de outro dia: ele chega ao
    dia final com buy_in_count = 0 (a entrada foi cobrada no classificatório),
    e sem contá-lo o dia final mostrava ~0 ativos e recusava eliminações.

    No dia final avançado pelo CONTADOR não existe linha de classificado — só
    `registered_players` somado na hora do avanço. Ali vale o maior dos dois.

    Par SQL: `entradas_do_dia`.
    """
    entradas = 0
    for p in inscritos:
        entradas += p.get("buy_in_count") or 0
        if p.get("is_qualified_entry") and (p.get("status") or "") != "cancelled":
            entradas += 1
    tipo = _campo(dia, "day_type")
    if getattr(tipo, "value", tipo) == "final":
        entradas = max(entradas, _campo(dia, "registered_players") or 0)
    return entradas


def reentradas(inscritos: List[dict]) -> int:
    """REENTRADAS = recompras. Add-on compra fichas; não traz ninguém de volta."""
    return sum(p.get("rebuy_count") or 0 for p in inscritos)


def normalizar_modo(valor) -> str:
    """Qualquer coisa que não seja 'table' vale 'bulk', o padrão de antes."""
    return MODO_MESA if valor == MODO_MESA else MODO_MASSA


def modo_do_torneio(tournament_id, cliente=None) -> str:
    """'table' ou 'bulk'. Sem torneio, sem a coluna (banco sem a migração) ou
    sem valor, vale 'bulk' — o único modo que existia antes."""
    if not tournament_id:
        return MODO_MASSA
    db = cliente or supabase
    try:
        linhas = (
            db.table("tournaments")
            .select("elimination_mode")
            .eq("id", tournament_id)
            .execute()
            .data
            or []
        )
    except Exception:
        logger.warning("tournaments.elimination_mode indisponível; usando 'bulk'", exc_info=True)
        return MODO_MASSA
    return normalizar_modo((linhas[0] if linhas else {}).get("elimination_mode"))


def _ler_dia(day_id, db) -> dict:
    linhas = (
        db.table("tournament_days")
        .select("id, day_type, registered_players, eliminations_count")
        .eq("id", day_id)
        .execute()
        .data
        or []
    )
    return linhas[0] if linhas else {}


def entradas_do_dia(day_id, dia: Optional[dict] = None, cliente=None) -> int:
    """ENTRADAS do dia lidas do banco (caminho em Python de `entradas_do_dia`)."""
    db = cliente or supabase
    inscritos = (
        db.table("tournament_players")
        .select(COLUNAS_DE_ENTRADA)
        .eq("tournament_day_id", day_id)
        .execute()
        .data
        or []
    )
    return entradas_para_ativos(inscritos, dia if dia is not None else _ler_dia(day_id, db))


def _escalar(resposta):
    """Valor de um RPC que devolve um escalar (o PostgREST às vezes embrulha)."""
    valor = getattr(resposta, "data", None)
    if isinstance(valor, list):
        valor = valor[0] if valor else None
    if isinstance(valor, dict):
        valor = next(iter(valor.values()), None)
    return valor


def registrar_eliminacao(day_id, qtd: int, cliente=None) -> Optional[int]:
    """Soma (ou, negativo, desfaz) `qtd` eliminações: piso 0, teto ENTRADAS.

    Devolve o contador novo (None se o dia não existe).
    """
    if not day_id:
        return None
    db = cliente or supabase
    try:
        valor = _escalar(
            db.rpc(
                "registrar_eliminacao", {"p_day_id": str(day_id), "p_qtd": int(qtd)}
            ).execute()
        )
        if valor is not None:
            return int(valor)
    except Exception:
        logger.warning(
            "RPC registrar_eliminacao indisponível; somando pelo caminho em Python",
            exc_info=True,
        )
    dia = _ler_dia(day_id, db)
    if not dia:
        return None
    teto = entradas_do_dia(day_id, dia, db)
    novo = min(max(int(dia.get("eliminations_count") or 0) + int(qtd), 0), teto)
    db.table("tournament_days").update({"eliminations_count": novo}).eq("id", day_id).execute()
    return novo


def consumir_eliminacao(day_id, cliente=None) -> bool:
    """Reentrada em massa: baixa UMA eliminação, se houver alguma.

    False = não há ninguém eliminado para voltar, e a reentrada é recusada.
    No banco, a trava e a baixa são a mesma instrução: duas caixas vendendo
    reentrada com o contador em 1 não passam as duas.
    """
    if not day_id:
        return False
    db = cliente or supabase
    try:
        valor = _escalar(db.rpc("consumir_eliminacao", {"p_day_id": str(day_id)}).execute())
        if valor is not None:
            return bool(valor)
    except Exception:
        logger.warning(
            "RPC consumir_eliminacao indisponível; baixando pelo caminho em Python",
            exc_info=True,
        )
    # Sem o RPC: grava só se o número ainda for o que foi lido (concorrência
    # otimista), para duas caixas não consumirem a mesma eliminação.
    for _ in range(3):
        atual = int(_ler_dia(day_id, db).get("eliminations_count") or 0)
        if atual <= 0:
            return False
        r = (
            db.table("tournament_days")
            .update({"eliminations_count": atual - 1})
            .eq("id", day_id)
            .eq("eliminations_count", atual)
            .execute()
        )
        if r.data:
            return True
    return False


def recontar_eliminacoes(day_id, cliente=None) -> Optional[int]:
    """Modo mesa: o contador do dia passa a ser a contagem de eliminados."""
    if not day_id:
        return None
    db = cliente or supabase
    try:
        valor = _escalar(db.rpc("recontar_eliminacoes", {"p_day_id": str(day_id)}).execute())
        if valor is not None:
            return int(valor)
    except Exception:
        logger.warning(
            "RPC recontar_eliminacoes indisponível; recontando pelo caminho em Python",
            exc_info=True,
        )
    eliminados = (
        db.table("tournament_players")
        .select("id")
        .eq("tournament_day_id", day_id)
        .eq("status", "eliminated")
        .execute()
        .data
        or []
    )
    total = len(eliminados)
    db.table("tournament_days").update({"eliminations_count": total}).eq("id", day_id).execute()
    return total


def acertar_contador(day_id, modo: str, delta: int, cliente=None) -> Optional[int]:
    """Depois de um jogador mudar de status: modo mesa reconta, em massa soma."""
    if modo == MODO_MESA:
        return recontar_eliminacoes(day_id, cliente)
    return registrar_eliminacao(day_id, delta, cliente)
