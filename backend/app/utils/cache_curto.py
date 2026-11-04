"""Cache em memória, por processo, com validade curta.

Para o que é lido o tempo todo e quase nunca muda — os módulos contratados
pelo clube (checados em toda rota do cash e do bar), o resumo que todas as TVs
de um dia pedem a cada 30 s. Cada ida ao Supabase custa ~50ms; perguntar a
mesma coisa centenas de vezes por minuto é espera pura.

O preço é a validade: uma mudança leva até `validade_s` para aparecer. Por
isso só entra aqui o que tolera esse atraso — permissão de funcionário NÃO
(essa fica na memória por requisição, app/database/memo.py).

Por PROCESSO: com dois workers do gunicorn, cada um tem o seu. É de propósito
— nada aqui pode depender de os dois concordarem.
"""
import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Hashable

_todos: "list[CacheCurto]" = []


class CacheCurto:
    def __init__(self, validade_s: float, maximo: int = 512):
        self.validade_s = validade_s
        self.maximo = maximo
        self._itens: "OrderedDict[Hashable, tuple]" = OrderedDict()
        # Endpoints sync rodam num threadpool: duas threads mexendo no
        # OrderedDict ao mesmo tempo sem o lock corrompem a ordem.
        self._lock = threading.Lock()
        _todos.append(self)

    def obter(self, chave: Hashable, calcular: Callable[[], Any]) -> Any:
        """O valor ainda válido para `chave`, ou `calcular()` (e guarda).

        O cálculo roda FORA do lock: uma consulta lenta não segura as outras
        chaves. Duas threads podem calcular a mesma chave ao mesmo tempo —
        custa uma consulta a mais, nunca um valor errado. Exceção não é guardada.
        """
        agora = time.monotonic()
        with self._lock:
            item = self._itens.get(chave)
            if item is not None and item[1] > agora:
                self._itens.move_to_end(chave)
                return item[0]
        valor = calcular()
        with self._lock:
            self._itens[chave] = (valor, time.monotonic() + self.validade_s)
            self._itens.move_to_end(chave)
            while len(self._itens) > self.maximo:
                self._itens.popitem(last=False)
        return valor

    def esquecer(self, chave: Hashable) -> None:
        with self._lock:
            self._itens.pop(chave, None)

    def limpar(self) -> None:
        with self._lock:
            self._itens.clear()


def limpar_todos() -> None:
    """Zera todos os caches curtos do processo (usado entre testes)."""
    for cache in list(_todos):
        cache.limpar()
