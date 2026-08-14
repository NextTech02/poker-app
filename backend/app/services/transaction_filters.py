"""Leitura de transações IGNORANDO as vendas canceladas.

Uma venda cancelada continua na base (auditoria: quem cancelou, quando, por
quê), mas o dinheiro voltou para o jogador. Se ela continuar entrando nas
somas, o clube fecha a noite achando que tem um dinheiro que não tem: o caixa
da etapa fica inflado, a sangria extrai rake de entrada estornada e o DRE conta
receita que não existe.

Esquecer UM lugar já basta para isso acontecer — por isso a regra mora aqui, e
não copiada em cada service.
"""
from typing import Callable, List

CANCELADA = "cancelled"
EM_CANCELAMENTO = "cancelling"
ATIVA = "active"


def esta_cancelada(linha: dict) -> bool:
    """True para uma linha de `transactions` estornada.

    Vale para os DOIS estados do estorno: 'cancelled' (concluído) e 'cancelling'
    (em andamento). O dinheiro sai das somas no instante em que o cancelamento
    começa — se a venda continuasse contando durante o estorno, a sangria feita
    nesse meio-tempo extrairia rake de dinheiro que está voltando para o jogador.

    Linha sem a coluna `status` (schema anterior à migração) conta como ativa —
    é o comportamento de hoje, preservado.
    """
    return (linha.get("status") or ATIVA) != ATIVA


def sem_canceladas(linhas: List[dict]) -> List[dict]:
    """Descarta as canceladas de uma lista já lida com `select("*")`."""
    return [linha for linha in (linhas or []) if not esta_cancelada(linha)]


def ler_transacoes_ativas(monta_query: Callable[[str], object], colunas: str) -> List[dict]:
    """Lê `transactions` já sem as canceladas.

    `monta_query(colunas)` deve devolver a consulta pronta (sem execute()).

    Duas tentativas de propósito: o deploy do backend NÃO é atômico com a
    migração que cria `transactions.status`. Enquanto a coluna não existir, o
    PostgREST recusa a consulta filtrada e caímos na consulta de hoje — o clube
    continua vendendo e faturando, em vez de tomar 500 no meio do evento.
    """
    com_status = colunas if colunas.strip() == "*" else f"{colunas}, status"
    try:
        # Os DOIS estados do estorno saem da soma: 'cancelled' (concluído) e
        # 'cancelling' (em andamento). Excluir só o primeiro deixaria a venda
        # contando durante o estorno — e uma sangria feita nesse meio-tempo
        # extrairia rake de dinheiro que já está voltando para o jogador.
        resposta = (
            monta_query(com_status)
            .neq("status", CANCELADA)
            .neq("status", EM_CANCELAMENTO)
            .execute()
        )
        return resposta.data or []
    except Exception:
        resposta = monta_query(colunas).execute()
        return resposta.data or []
