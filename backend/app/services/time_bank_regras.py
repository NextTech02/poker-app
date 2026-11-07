"""As contas do time bank: funções puras, sem banco.

O saldo é CALCULADO. Nada grava "ganhou um cartão" quando o intervalo começa:
o direito sai da configuração e da estrutura de blinds, e os eventos só
registram o que mudou depois disso. Sem rotina de crédito, não há como dar
cartão em dobro nem deixar de dar.
"""
from typing import Iterable


def intervalos_passados(blinds: list, nivel_atual: int) -> int:
    """Intervalos já começados. `level` é a posição interna, que conta os
    intervalos: o cartão do intervalo vale assim que ele começa."""
    return sum(
        1 for b in blinds
        if b.get("is_break") and b.get("level") is not None and b["level"] <= nivel_atual
    )


def direito(config, blinds: list, nivel_atual: int) -> int:
    """Quantos cartões cada jogador tem direito agora. Quem entra tarde recebe
    o mesmo que os demais."""
    return config.initial_cards + config.cards_per_break * intervalos_passados(blinds, nivel_atual)


def saldo(cartoes_de_direito: int, eventos: Iterable[dict], marca_da_entrada: int) -> int:
    """Direito mais os eventos DA ENTRADA ATUAL. A marca é o `rebuy_count` de
    quando o evento aconteceu: reentrada recomeça os cartões, e estornar a
    reentrada traz de volta o saldo anterior, sem nenhum gatilho."""
    movimento = sum(e["cards"] for e in eventos if e.get("entry_marker", 0) == marca_da_entrada)
    return max(0, cartoes_de_direito + movimento)
