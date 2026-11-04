"""Memória POR REQUISIÇÃO para leituras que se repetem dentro dela.

Cada ida ao Supabase custa ~50ms de rede, e uma venda lia a MESMA linha várias
vezes: o `staff` do operador três vezes (guarda de permissão, caixa aberto,
id do funcionário), o torneio quatro, a inscrição do jogador duas. Aqui a
primeira leitura fica guardada até o fim da requisição.

Regras que tornam isso seguro:

- **Só o que for pedido explicitamente** (`lembrar`). Nada de cache
  transparente de toda consulta: quem usa diz a chave e sabe o que guarda.
- **Morre com a requisição.** O middleware abre e fecha a memória; fora de
  uma requisição (scripts, startup, testes de serviço) não há memória e cada
  chamada vai ao banco, como antes.
- **Nenhuma leitura sobrevive a uma ESCRITA.** Todo insert/update/upsert/
  delete/rpc feito pelo cliente da requisição apaga a memória (ver
  `_SupabaseProxy`). Ler, escrever e ler de novo sempre traz o dado novo —
  inclusive o que um trigger mudou.
- **Não atravessa usuários.** A memória é desta requisição, que tem um token
  só; o RLS de quem pediu já está aplicado no que foi guardado.

A memória é um DICT dentro de um ContextVar, e não um valor: o FastAPI roda
dependências e rotas sync em threads, cada uma com uma CÓPIA do contexto. A
cópia aponta para o mesmo dict, então o que uma guarda a outra enxerga (o
mesmo truque do contador de consultas em supabase_client.py).
"""
from contextvars import ContextVar, Token
from typing import Any, Callable, Hashable, Optional

_memo: ContextVar[Optional[dict]] = ContextVar("memo_da_requisicao", default=None)


def abrir() -> Token:
    """Começa uma memória vazia (uma por requisição). Devolve o Token para `fechar`."""
    return _memo.set({})


def fechar(token: Token) -> None:
    _memo.reset(token)


def lembrar(chave: Hashable, calcular: Callable[[], Any]) -> Any:
    """O valor guardado para `chave` nesta requisição, ou `calcular()` (e guarda).

    Exceção não é guardada: a próxima chamada tenta de novo.
    """
    memo = _memo.get()
    if memo is None:
        return calcular()
    if chave in memo:
        return memo[chave]
    valor = calcular()
    memo[chave] = valor
    return valor


def esquecer_tudo() -> None:
    """Apaga a memória desta requisição — chamado a cada escrita."""
    memo = _memo.get()
    if memo:
        memo.clear()
