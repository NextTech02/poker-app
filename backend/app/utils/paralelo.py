"""Leituras INDEPENDENTES ao mesmo tempo, dentro de uma requisição sync.

Cada ida ao Supabase espera ~50ms de rede. Um relatório que faz vinte
consultas uma depois da outra espera um segundo inteiro, por mais rápido que
o Postgres responda cada uma. Quando uma não depende da outra (as despesas, o
cash, o bar e o fiado do DRE, por exemplo), elas podem esperar juntas.

Cada tarefa roda numa CÓPIA do contexto de quem chamou: o JWT da requisição
(o RLS continua sendo o do usuário), a memória da requisição e o contador de
consultas vão junto. Sem isso, a consulta na outra thread rodaria com a chave
de serviço e enxergaria todos os clubes.

Regras de uso:
- Só para LEITURAS que não dependem umas das outras.
- Não chamar `iniciar` de dentro de uma tarefa (a fila é uma só e limitada:
  esperar dentro dela por outra tarefa pode travar tudo).
"""
import contextvars
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict

# Por processo, compartilhado entre as requisições. Pequeno de propósito: o
# ganho vem de não esperar em fila, não de abrir mais conexões que o pool HTTP.
_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="leituras-paralelas")


class Paralelas:
    def __init__(self, futuros: Dict[str, Any]):
        self._futuros = futuros

    def resultados(self) -> Dict[str, Any]:
        """{nome: resultado}, esperando todas. A exceção de uma tarefa sobe
        aqui, como se ela tivesse sido chamada direto (a primeira, na ordem)."""
        return {nome: futuro.result() for nome, futuro in self._futuros.items()}


def iniciar(**tarefas: Callable[[], Any]) -> Paralelas:
    """Dispara cada `nome=funcao` já, cada uma no contexto de quem chamou.
    Quem chama pode fazer outra coisa enquanto isso e depois pedir `resultados()`."""
    futuros = {}
    for nome, tarefa in tarefas.items():
        contexto = contextvars.copy_context()
        futuros[nome] = _pool.submit(contexto.run, tarefa)
    return Paralelas(futuros)
