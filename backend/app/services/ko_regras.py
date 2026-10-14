"""Regras de dinheiro da premiação por eliminação — funções PURAS, sem banco.

Três formatos (`tournaments.ko_format`):

- ``ko``      KO fixo: quem elimina leva o bounty inteiro da vítima.
- ``pko``     progressivo: quem elimina leva ``ko_cash_share`` % do bounty da
              vítima em dinheiro; o resto soma no PRÓPRIO bounty.
- ``mystery`` envelopes: ao iniciar a fase, o pozo KO congela em envelopes
              (um por jogador vivo); cada eliminação na fase sorteia um.

O dinheiro do pozo KO nasce nas VENDAS: cada uma congela a sua parte
(`transactions.bounty_amount`), como já faz com o rake. Daí sai a regra que os
testes conferem — depois do encerramento, a soma de tudo o que foi pago em KO é
exatamente o pozo KO. Nenhum centavo some no arredondamento nem sobra no caixa.

Por que o bounty atual de um jogador é DERIVADO (e não um contador gravado):
duas eliminações na mesma mão creditando o mesmo eliminador não podem perder
uma atualização, e desfazer um KO precisa devolver o bounty exato. Somas
comutam; um contador lido e regravado pelo Python não.
"""
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
from typing import Dict, Iterable, List, Optional

from app.utils.erros import ErroDeNegocio

CENTAVO = Decimal("0.01")
FORMATOS_KO = ("ko", "pko", "mystery")
NENHUM = "none"


def dinheiro(valor) -> Decimal:
    """Valor monetário em Decimal, arredondado ao centavo (meio para cima)."""
    if valor is None or valor == "":
        return Decimal("0.00")
    return Decimal(str(valor)).quantize(CENTAVO, rounding=ROUND_HALF_UP)


def formato(torneio: Optional[dict]) -> str:
    """Formato KO do torneio; ``none`` quando falta a coluna ou o valor."""
    valor = (torneio or {}).get("ko_format") or NENHUM
    return valor if valor in FORMATOS_KO else NENHUM


def e_ko(torneio: Optional[dict]) -> bool:
    return formato(torneio) != NENHUM


def fase_mystery_iniciada(torneio: Optional[dict]) -> bool:
    return formato(torneio) == "mystery" and bool((torneio or {}).get("mystery_started_at"))


def parte_dinheiro(torneio: Optional[dict]) -> Decimal:
    """% do bounty pago em dinheiro a quem elimina. KO fixo é sempre 100."""
    if formato(torneio) == "pko":
        return Decimal(str((torneio or {}).get("ko_cash_share") or 0))
    return Decimal("100")


def parte_ko_da_venda(torneio: Optional[dict], amount, rake_amount) -> Decimal:
    """Parte KO de UMA venda: valor da venda × ko% — congelada na venda.

    A porcentagem vale sobre o VALOR DA ENTRADA, que é como o clube pensa
    ("40% do buy-in vai para o Mystery": buy-in de 600 → 240), e nunca passa
    do líquido (valor − rake): o KO sai do que entrou no pozo, não do rake.

    Zero quando o torneio não é KO, quando a fase Mystery já começou (o pozo
    congelou: a venda vai para as posições) ou quando os bounties foram
    encerrados. Entrada por ticket (valor 0) e BONUS DEALER (rake 100%) dão
    líquido zero, e portanto bounty zero.
    """
    if not e_ko(torneio) or fase_mystery_iniciada(torneio):
        return Decimal("0.00")
    if (torneio or {}).get("ko_closed_at"):
        return Decimal("0.00")
    percentual = Decimal(str((torneio or {}).get("ko_percentage") or 0))
    valor = dinheiro(amount)
    liquido = valor - dinheiro(rake_amount)
    if percentual <= 0 or liquido <= 0:
        return Decimal("0.00")
    parte = (valor * percentual / Decimal("100")).quantize(CENTAVO, rounding=ROUND_HALF_UP)
    return min(parte, liquido)


def _repartir(total: Decimal, partes: int) -> List[Decimal]:
    """Divide ``total`` em ``partes`` ao centavo; os centavos que sobram vão
    para as PRIMEIRAS partes. Quem chama ordena os destinatários antes, para o
    replay do mesmo KO dar exatamente o mesmo resultado."""
    if partes <= 0:
        return []
    base = (total / partes).quantize(CENTAVO, rounding=ROUND_DOWN)
    sobra = int(((total - base * partes) / CENTAVO).to_integral_value())
    return [base + (CENTAVO if i < sobra else Decimal("0")) for i in range(partes)]


def dividir_bounty(bounty, cash_share, eliminadores: Iterable[str]) -> List[Dict]:
    """O que cada eliminador recebe de um bounty.

    ``cash = arred(B × share/100)`` vai em dinheiro, ``added = B − cash`` soma
    no bounty dele. Pote dividido entre k eliminadores: cada parte é repartida
    ao centavo; os centavos de sobra vão aos eliminadores na ordem dos ids.
    """
    ordem = sorted({str(e) for e in eliminadores if e})
    if not ordem:
        return []
    total = dinheiro(bounty)
    share = Decimal(str(cash_share))
    cash_total = (total * share / Decimal("100")).quantize(CENTAVO, rounding=ROUND_HALF_UP)
    added_total = total - cash_total
    cash = _repartir(cash_total, len(ordem))
    added = _repartir(added_total, len(ordem))
    return [
        {"eliminator_tp_id": tp_id, "cash_amount": cash[i], "added_to_bounty": added[i]}
        for i, tp_id in enumerate(ordem)
    ]


def bounties_derivados(vendas: Iterable[dict], knockouts: Iterable[dict], payouts: Iterable[dict]) -> Dict[str, Decimal]:
    """Bounty atual de cada inscrição (tournament_player).

    = Σ bounty_amount das vendas ATIVAS dela
    + Σ added_to_bounty dos KOs ATIVOS que ela fez
    − Σ bounty_value dos KOs ATIVOS em que ela caiu (ou foi encerrada).

    A reentrada reaproveita a mesma inscrição: a venda nova soma sozinha.
    """
    saldo: Dict[str, Decimal] = {}

    def somar(tp_id, valor):
        if not tp_id:
            return
        chave = str(tp_id)
        saldo[chave] = saldo.get(chave, Decimal("0.00")) + dinheiro(valor)

    for v in vendas:
        if (v.get("status") or "active") != "active":
            continue
        if v.get("type") not in ("buy_in", "rebuy", "addon"):
            continue
        somar(v.get("tournament_player_id"), v.get("bounty_amount"))

    ativos = {str(k["id"]) for k in knockouts if (k.get("status") or "active") == "active"}
    for k in knockouts:
        if str(k.get("id")) in ativos and k.get("eliminated_tp_id"):
            somar(k.get("eliminated_tp_id"), -dinheiro(k.get("bounty_value")))
    for p in payouts:
        if str(p.get("knockout_id")) in ativos:
            somar(p.get("eliminator_tp_id"), p.get("added_to_bounty"))
    return saldo


def sem_autor(knockouts: Iterable[dict], payouts: Iterable[dict]) -> Decimal:
    """Bounties que saíram de uma vítima sem ninguém receber (abandono,
    desclassificação). Vão para o campeão no encerramento."""
    com_pagamento = {str(p.get("knockout_id")) for p in payouts}
    total = Decimal("0.00")
    for k in knockouts:
        if (k.get("status") or "active") != "active" or k.get("kind") != "elimination":
            continue
        if k.get("format") == "mystery":
            continue  # no Mystery, sem autor não sorteia: o envelope fica para o campeão
        if str(k.get("id")) not in com_pagamento:
            total += dinheiro(k.get("bounty_value"))
    return total


def validar_envelopes(envelopes: Iterable[dict], jogadores: int, pozo) -> List[Decimal]:
    """Lista de envelopes (valor × quantidade) que o clube cadastrou.

    Exige um envelope por jogador vivo e a soma EXATA do pozo KO congelado:
    sobra viraria dinheiro sem dono; falta, prêmio sem dinheiro.
    """
    valores: List[Decimal] = []
    for linha in envelopes:
        valor = dinheiro(linha.get("value"))
        quantidade = int(linha.get("quantity") or 0)
        if valor <= 0 or quantidade < 1:
            raise ErroDeNegocio(
                "envelope_invalido",
                "Cada envelope precisa de valor maior que zero e quantidade de pelo menos 1.",
            )
        valores.extend([valor] * quantidade)
    if len(valores) != jogadores:
        raise ErroDeNegocio(
            "envelopes_quantidade_errada",
            f"São {jogadores} jogadores vivos: cadastre {jogadores} envelopes (há {len(valores)}).",
            esperado=jogadores,
            informado=len(valores),
        )
    soma = sum(valores, Decimal("0.00"))
    alvo = dinheiro(pozo)
    if soma != alvo:
        raise ErroDeNegocio(
            "envelopes_soma_errada",
            f"Os envelopes somam {soma} e o pozo KO é {alvo}.",
            esperado=float(alvo),
            informado=float(soma),
        )
    return valores
