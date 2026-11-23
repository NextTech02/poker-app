"""Regras do ranking de pontos (Manual de Ranking NSOP), sem banco.

Por torneio, cada posição PREMIADA (ITM) vale

    PONTOS = ARREDONDAR[ (100 ÷ √POSIÇÃO) × FJ × FB ]
    FJ = máx(0,75 ; mín(1,50 ; (N ÷ 50)^0,17))     N = jogadores ÚNICOS
    FB = máx(0,75 ; mín(1,40 ; (B ÷ 350)^0,16))    B = buy-in oficial, sem a taxa

Fora do ITM, ou num torneio com menos de 12 jogadores únicos, vale 0.
Recompra, add-on, prêmio, bounty e acordo de divisão não dão ponto: só a
posição final oficial conta. Os números (100, 50, 0,17, 0,75...) são os
sugeridos pelo manual e o clube pode ajustá-los antes da temporada.

O ranking de uma etapa soma todos os resultados; o da temporada soma só os
N melhores de cada jogador (o manual sugere 8). Empate se resolve por: mais
1ºs lugares → mais 2ºs → mais 3ºs → mais mesas finais (top 9) → maior
pontuação num só torneio; persistindo, a posição é compartilhada.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, fields
from typing import Dict, Iterable, List, Optional

POSICAO_DA_MESA_FINAL = 9

# Campo da regra → coluna de `ranking_rules` (o banco é em inglês, como o resto).
# O buy-in de referência (350) está em soles, a moeda do manual. Clube de outra
# moeda precisa trocá-lo: com 350 pesos colombianos, todo torneio bate no teto.
COLUNA_DO_CAMPO = {
    "pontos_base": "base_points",
    "jogadores_referencia": "players_reference",
    "jogadores_expoente": "players_exponent",
    "jogadores_fator_minimo": "players_factor_min",
    "jogadores_fator_maximo": "players_factor_max",
    "buy_in_referencia": "buy_in_reference",
    "buy_in_expoente": "buy_in_exponent",
    "buy_in_fator_minimo": "buy_in_factor_min",
    "buy_in_fator_maximo": "buy_in_factor_max",
    "minimo_de_jogadores": "min_unique_players",
}


@dataclass(frozen=True)
class RegrasDoRanking:
    pontos_base: float = 100.0
    jogadores_referencia: float = 50.0
    jogadores_expoente: float = 0.17
    jogadores_fator_minimo: float = 0.75
    jogadores_fator_maximo: float = 1.50
    buy_in_referencia: float = 350.0
    buy_in_expoente: float = 0.16
    buy_in_fator_minimo: float = 0.75
    buy_in_fator_maximo: float = 1.40
    minimo_de_jogadores: int = 12

    @classmethod
    def da_linha(cls, linha: Optional[dict]) -> "RegrasDoRanking":
        """As regras gravadas do clube (linha de `ranking_rules`, ou já com os
        nomes dos campos); campo ausente fica com o padrão do manual."""
        if not linha:
            return cls()
        valores = {}
        for campo in fields(cls):
            bruto = linha.get(COLUNA_DO_CAMPO[campo.name], linha.get(campo.name))
            if bruto is None:
                continue
            valores[campo.name] = int(bruto) if campo.type in ("int", int) else float(bruto)
        return cls(**valores)

    def como_dict(self) -> Dict[str, float]:
        return {campo.name: getattr(self, campo.name) for campo in fields(self)}

    def como_linha(self) -> Dict[str, float]:
        """Os valores com os nomes das colunas de `ranking_rules`."""
        return {COLUNA_DO_CAMPO[campo.name]: getattr(self, campo.name) for campo in fields(self)}


def _limitar(valor: float, minimo: float, maximo: float) -> float:
    return max(minimo, min(maximo, valor))


def arredondar(valor: float) -> int:
    """Arredonda como o REDONDEAR do Excel: meio para longe do zero (o round
    do Python arredonda 2,5 para 2)."""
    return int(math.floor(valor + 0.5)) if valor >= 0 else -int(math.floor(-valor + 0.5))


def fator_jogadores(jogadores_unicos: int, regras: RegrasDoRanking) -> float:
    if jogadores_unicos <= 0:
        return regras.jogadores_fator_minimo
    bruto = (jogadores_unicos / regras.jogadores_referencia) ** regras.jogadores_expoente
    return _limitar(bruto, regras.jogadores_fator_minimo, regras.jogadores_fator_maximo)


def fator_buy_in(buy_in: float, regras: RegrasDoRanking) -> float:
    if buy_in <= 0:
        return regras.buy_in_fator_minimo
    bruto = (buy_in / regras.buy_in_referencia) ** regras.buy_in_expoente
    return _limitar(bruto, regras.buy_in_fator_minimo, regras.buy_in_fator_maximo)


def torneio_pontua(jogadores_unicos: int, regras: RegrasDoRanking) -> bool:
    """Abaixo do mínimo de jogadores únicos, o torneio não dá pontos."""
    return jogadores_unicos >= regras.minimo_de_jogadores


def pontos_brutos(posicao: int, jogadores_unicos: int, buy_in: float, premiados: int,
                  regras: RegrasDoRanking) -> float:
    """Pontos com todas as casas: só o resultado final é arredondado."""
    if posicao < 1 or posicao > premiados or not torneio_pontua(jogadores_unicos, regras):
        return 0.0
    return (regras.pontos_base / math.sqrt(posicao)) \
        * fator_jogadores(jogadores_unicos, regras) * fator_buy_in(buy_in, regras)


def pontos(posicao: int, jogadores_unicos: int, buy_in: float, premiados: int,
           regras: RegrasDoRanking) -> int:
    return arredondar(pontos_brutos(posicao, jogadores_unicos, buy_in, premiados, regras))


def tabela_de_pontos(jogadores_unicos: int, buy_in: float, premiados: int,
                     regras: RegrasDoRanking) -> List[dict]:
    """Os pontos de cada posição premiada (1..T) — a prévia antes de oficializar."""
    return [
        {"position": p, "points": pontos(p, jogadores_unicos, buy_in, premiados, regras)}
        for p in range(1, max(0, premiados) + 1)
    ]


# ── Classificação (etapa e temporada) ────────────────────────────────────────

@dataclass
class LinhaDoRanking:
    player_id: str
    player_name: str
    total: int = 0
    eventos: int = 0
    contados: int = 0
    primeiros: int = 0
    segundos: int = 0
    terceiros: int = 0
    mesas_finais: int = 0
    melhor_resultado: int = 0
    posicao: int = 0
    empatado: bool = False
    # {tournament_id: pontos} e quais resultados ficaram fora da soma.
    por_torneio: Dict[str, int] = field(default_factory=dict)
    descartados: List[str] = field(default_factory=list)

    def chave(self):
        return (-self.total, -self.primeiros, -self.segundos, -self.terceiros,
                -self.mesas_finais, -self.melhor_resultado)


def classificar(resultados: Iterable[dict], melhores: Optional[int] = None) -> List[LinhaDoRanking]:
    """Classifica jogadores a partir dos resultados oficiais.

    `resultados`: dicts com player_id, player_name, tournament_id, position,
    points e (opcional) tournament_date, para desempatar qual resultado conta
    quando dois valem o mesmo. `melhores`: só os N maiores resultados de cada
    jogador entram na soma (temporada); None soma todos (etapa). Os critérios
    de desempate olham TODOS os torneios do período, contados ou não.
    """
    por_jogador: Dict[str, List[dict]] = {}
    nomes: Dict[str, str] = {}
    for r in resultados:
        pid = str(r["player_id"])
        por_jogador.setdefault(pid, []).append(r)
        if r.get("player_name"):
            nomes[pid] = r["player_name"]

    linhas: List[LinhaDoRanking] = []
    for pid, lista in por_jogador.items():
        ordenados = sorted(
            lista,
            key=lambda r: (-int(r.get("points") or 0), int(r.get("position") or 10 ** 6),
                           str(r.get("tournament_date") or "")),
        )
        corte = len(ordenados) if not melhores or melhores <= 0 else melhores
        contados, fora = ordenados[:corte], ordenados[corte:]
        posicoes = [int(r.get("position") or 0) for r in lista]
        linhas.append(LinhaDoRanking(
            player_id=pid,
            player_name=nomes.get(pid, ""),
            total=sum(int(r.get("points") or 0) for r in contados),
            eventos=len(lista),
            contados=len(contados),
            primeiros=posicoes.count(1),
            segundos=posicoes.count(2),
            terceiros=posicoes.count(3),
            mesas_finais=sum(1 for p in posicoes if 1 <= p <= POSICAO_DA_MESA_FINAL),
            melhor_resultado=max((int(r.get("points") or 0) for r in lista), default=0),
            por_torneio={str(r["tournament_id"]): int(r.get("points") or 0) for r in lista},
            descartados=[str(r["tournament_id"]) for r in fora],
        ))

    linhas.sort(key=lambda l: (l.chave(), l.player_name.lower()))
    anterior = None
    for i, linha in enumerate(linhas):
        if anterior is not None and linha.chave() == anterior.chave():
            # Empate em todos os critérios: posição compartilhada (1, 1, 3).
            linha.posicao = anterior.posicao
            linha.empatado = anterior.empatado = True
        else:
            linha.posicao = i + 1
        anterior = linha
    return linhas
