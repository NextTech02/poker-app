"""Regras do torneio por equipes — funções PURAS, sem banco.

Bases do NSOP ("Torneo de póker por equipos"):

- Equipe = capitão + 3. Na Fase 1 os 4 sentam em mesas DIFERENTES (até 8 por
  mesa, mesas equilibradas) e cada mesa joga até sobrar 1.
- Pontos pela posição NA MESA: o 1º eliminado faz 5, cada posição seguinte +5
  até o vencedor. Numa mesa de N, a posição p vale 5·(N − p + 1).
- Eliminação na mesma mão: quem começou a mão com mais fichas fica melhor; com
  fichas iguais, os pontos das posições envolvidas são somados e divididos.
- Pontuação da equipe = soma dos 4. Desempate: o capitão com mais pontos; se
  empatar, um 2º critério anunciado antes (aqui: melhores pontos individuais ou
  ordem da direção).
- Final por revezamento: a cada nível de blinds entra o próximo da ordem.

Por que os pontos saem da ORDEM de eliminação e não de uma foto do tamanho da
mesa: o k-º a cair faz 5·k e o vencedor 5·N, com N = todos que jogaram ali.
É a mesma conta de 5·(N − p + 1), e continua certa quando alguém senta
atrasado, quando uma eliminação é desfeita ou quando o jogador reentra.
"""
import math
from decimal import Decimal, ROUND_HALF_UP
from typing import Dict, Iterable, List, Optional, Sequence

from app.utils.erros import ErroDeNegocio

PONTOS_POR_POSICAO = Decimal("5")
JOGADORES_POR_EQUIPE = 4
MAX_POR_MESA = 8
MAX_FINALISTAS = 8
CRITERIOS = ("best_individual", "manual")
_CENTESIMO = Decimal("0.01")


def _pontos(ordem_media: Decimal) -> Decimal:
    return (PONTOS_POR_POSICAO * ordem_media).quantize(_CENTESIMO, rounding=ROUND_HALF_UP)


# ── Pontos de uma mesa ──────────────────────────────────────────────────────
def resultado_da_mesa(eliminados: Sequence[dict], vivos: Iterable[str]) -> dict:
    """Posição e pontos de cada jogador de UMA mesa da Fase 1.

    ``eliminados``: dicts com ``id`` (inscrição) e ``tie_with_previous``, JÁ na
    ordem em que caíram (hora da eliminação). Uma linha com
    ``tie_with_previous`` cai junto com a anterior: o grupo divide a média dos
    pontos das posições que ocupa.
    ``vivos``: inscrições ainda sentadas na mesa.

    Devolve ``{"tamanho", "terminada", "jogadores": {id: {ordem, posicao,
    pontos, empate}}}``. Com 1 vivo ele é o vencedor (5·N); com mais de 1 a mesa
    está em jogo e os vivos ainda não têm pontos.
    """
    vivos = [str(v) for v in vivos]
    tamanho = len(eliminados) + len(vivos)
    jogadores: Dict[str, dict] = {}

    grupos: List[List[str]] = []
    for linha in eliminados:
        if grupos and linha.get("tie_with_previous"):
            grupos[-1].append(str(linha["id"]))
        else:
            grupos.append([str(linha["id"])])

    ordem = 0
    for grupo in grupos:
        primeira = ordem + 1
        ordem += len(grupo)
        media = Decimal(primeira + ordem) / Decimal(2)
        for tp_id in grupo:
            jogadores[tp_id] = {
                "ordem": primeira,
                # Empatados dividem a MELHOR das posições que ocupam.
                "posicao": tamanho - ordem + 1,
                "pontos": _pontos(media),
                "empate": len(grupo) > 1,
            }

    terminada = len(vivos) <= 1
    if len(vivos) == 1:
        jogadores[vivos[0]] = {
            "ordem": tamanho, "posicao": 1, "pontos": _pontos(Decimal(tamanho)), "empate": False,
        }
    return {"tamanho": tamanho, "terminada": terminada, "jogadores": jogadores}


def resultado_manual(posicoes: Dict[str, int]) -> dict:
    """Mesa com as posições digitadas pela direção (o papel da mesa vale mais
    que a ordem dos cliques). Posições iguais = empate: o grupo divide a média
    das vagas que ocupa. Exige posições de 1 a N."""
    tamanho = len(posicoes)
    for tp_id, posicao in posicoes.items():
        if not isinstance(posicao, int) or posicao < 1 or posicao > tamanho:
            raise ErroDeNegocio(
                "posicao_fora_da_mesa",
                f"As posições desta mesa vão de 1 a {tamanho}.",
                maximo=tamanho,
            )
    por_posicao: Dict[int, List[str]] = {}
    for tp_id, posicao in posicoes.items():
        por_posicao.setdefault(posicao, []).append(str(tp_id))

    jogadores: Dict[str, dict] = {}
    for posicao, grupo in por_posicao.items():
        # Ocupa as posições posicao .. posicao+k−1 → ordens N−p+1 descendo.
        ordens = [tamanho - (posicao + i) + 1 for i in range(len(grupo))]
        if min(ordens) < 1:
            raise ErroDeNegocio(
                "posicao_fora_da_mesa",
                f"As posições desta mesa vão de 1 a {tamanho}.",
                maximo=tamanho,
            )
        media = Decimal(sum(ordens)) / Decimal(len(ordens))
        for tp_id in grupo:
            jogadores[tp_id] = {
                "ordem": min(ordens), "posicao": posicao, "pontos": _pontos(media),
                "empate": len(grupo) > 1,
            }
    return {"tamanho": tamanho, "terminada": True, "jogadores": jogadores}


# ── Ranking das equipes ─────────────────────────────────────────────────────
def ranking(equipes: Sequence[dict], pontos: Dict[str, Decimal], criterio: str = "best_individual") -> List[dict]:
    """Classificação das equipes pela soma dos pontos dos integrantes.

    ``equipes``: dicts com ``id``, ``captain_player_id``, ``members`` (ids de
    jogador) e ``tiebreak_rank`` (desempate manual; menor = melhor).
    ``pontos``: pontos por JOGADOR (quem não tem conta como 0).

    Ordem: soma ↓ → capitão ↓ → 2º critério. Equipes que continuam iguais
    dividem a posição e saem com ``empatada=True`` (a direção resolve antes da
    final).
    """
    criterio = criterio if criterio in CRITERIOS else "best_individual"
    linhas = []
    for equipe in equipes:
        membros = [str(m) for m in equipe.get("members") or []]
        individuais = sorted((Decimal(pontos.get(m) or 0) for m in membros), reverse=True)
        total = sum(individuais, Decimal("0"))
        capitao = Decimal(pontos.get(str(equipe.get("captain_player_id"))) or 0)
        if criterio == "manual":
            rank_manual = equipe.get("tiebreak_rank")
            segundo = (rank_manual if rank_manual is not None else 10 ** 6,)
        else:
            # Completa com zeros: equipe desfalcada compara do mesmo tamanho.
            completos = individuais + [Decimal("0")] * (JOGADORES_POR_EQUIPE - len(individuais))
            segundo = tuple(-p for p in completos)
        linhas.append({
            "team_id": str(equipe["id"]),
            "pontos": total,
            "pontos_capitao": capitao,
            "individuais": individuais,
            "_chave": (-total, -capitao, segundo),
        })

    linhas.sort(key=lambda l: (l["_chave"], l["team_id"]))
    for i, linha in enumerate(linhas):
        anterior = linhas[i - 1] if i > 0 else None
        if anterior is not None and anterior["_chave"] == linha["_chave"]:
            linha["rank"] = anterior["rank"]
        else:
            linha["rank"] = i + 1
    for i, linha in enumerate(linhas):
        vizinhos = [linhas[j] for j in (i - 1, i + 1) if 0 <= j < len(linhas)]
        linha["empatada"] = any(v["_chave"] == linha["_chave"] for v in vizinhos)
    for linha in linhas:
        del linha["_chave"]
    return linhas


def empate_na_linha_de_corte(classificacao: Sequence[dict], finalistas: Optional[int]) -> bool:
    """Equipes empatadas entre a última vaga da final e a primeira de fora."""
    if not finalistas or finalistas >= len(classificacao):
        return False
    return classificacao[finalistas - 1]["rank"] == classificacao[finalistas]["rank"]


# ── Sorteio de mesas ────────────────────────────────────────────────────────
def mesas_minimas(total_jogadores: int, maior_equipe: int = JOGADORES_POR_EQUIPE) -> int:
    """Quantas mesas a Fase 1 precisa: os integrantes em mesas diferentes e no
    máximo 8 por mesa."""
    return max(maior_equipe, math.ceil(total_jogadores / MAX_POR_MESA)) if total_jogadores else 0


def tamanhos_alvo(mesas: Sequence[dict], a_sentar: int) -> Dict[str, int]:
    """Quantos jogadores NOVOS cada mesa recebe para os tamanhos finais ficarem
    o mais iguais possível (diferença de no máximo 1, salvo mesa já cheia).

    ``mesas``: dicts com ``id``, ``table_number``, ``ocupados`` (já sentados) e
    ``capacidade`` (lugares livres, já com o teto de 8 e sem os bloqueados).
    """
    cota = {str(m["id"]): 0 for m in mesas}
    for _ in range(a_sentar):
        livres = [m for m in mesas if cota[str(m["id"])] < int(m["capacidade"])]
        if not livres:
            break
        alvo = min(livres, key=lambda m: (int(m["ocupados"]) + cota[str(m["id"])], m["table_number"]))
        cota[str(alvo["id"])] += 1
    return cota


def _repartir_inteiro(total: int, pesos: Dict[str, int], rng) -> Dict[str, int]:
    """Divide ``total`` proporcional aos pesos; as sobras vão a equipes
    sorteadas (ninguém fica com 2 a mais que outra)."""
    soma = sum(pesos.values())
    if soma <= 0 or total <= 0:
        return {k: 0 for k in pesos}
    base = {k: (total * p) // soma for k, p in pesos.items()}
    sobra = total - sum(base.values())
    ordem = list(pesos)
    rng.shuffle(ordem)
    ordem.sort(key=lambda k: -((total * pesos[k]) % soma))
    for k in ordem[:sobra]:
        base[k] += 1
    return base


def distribuir_por_mesas(
    equipes: Sequence[dict], avulsos: Sequence[str], mesas: Sequence[dict], rng, tentativas: int = 200,
) -> Dict[str, str]:
    """Sorteia a MESA de cada jogador da Fase 1 (o assento a tela sorteia depois).

    ``equipes``: dicts com ``id``, ``a_sentar`` (ids de jogador ainda sem mesa)
    e ``proibidas`` (mesas onde já há um colega sentado).
    ``avulsos``: jogadores sem equipe (completam as mesas, sem restrição).
    ``mesas``: dicts com ``id``, ``table_number``, ``ocupados`` e
    ``capacidade`` (lugares livres sob o teto de 8, sem os bloqueados).

    Usa o MENOR número de mesas que comporta todo mundo (sem espalhar 20
    jogadores por 8 mesas) e:
      1. cada equipe em mesas distintas, nunca com um colega;
      2. tamanhos finais equilibrados (diferença de no máximo 1);
      3. justiça entre equipes: mesa maior vale mais pontos (o vencedor de uma
         mesa de 8 faz 40; de 7, 35), então cada equipe recebe a sua parte das
         vagas nas mesas "grandes". A regra diagonal (integrante i da equipe j
         na mesa j+i) falha nisso: 9 equipes em 8 mesas deixariam equipes
         inteiras só em mesas de 5.

    Devolve ``{player_id: table_id}``.
    """
    equipes = [e for e in equipes if e.get("a_sentar")]
    novos = sum(len(e["a_sentar"]) for e in equipes) + len(avulsos)
    if not novos:
        return {}
    ja_sentados = sum(int(m["ocupados"]) for m in mesas)
    total = ja_sentados + novos
    maior = max([len(e["a_sentar"]) for e in equipes] + [0])
    minimo = mesas_minimas(total, max(maior, JOGADORES_POR_EQUIPE if equipes else 1))

    capacidade_total = sum(max(0, int(m["capacidade"])) for m in mesas)
    if capacidade_total < novos:
        raise ErroDeNegocio(
            "mesas_sem_lugar_para_equipes",
            f"Faltam {novos - capacidade_total} lugares nas mesas ativas (até 8 por mesa).",
            faltam=novos - capacidade_total, minimo=minimo,
        )
    for equipe in equipes:
        proibidas = {str(p) for p in equipe.get("proibidas") or ()}
        permitidas = [m for m in mesas if int(m["capacidade"]) > 0 and str(m["id"]) not in proibidas]
        if len(permitidas) < len(equipe["a_sentar"]):
            raise ErroDeNegocio(
                "mesas_insuficientes_para_equipes",
                f"São necessárias pelo menos {minimo} mesas ativas para os integrantes "
                f"de cada equipe ficarem em mesas diferentes (há {len(mesas)}).",
                minimo=minimo, mesas=len(mesas),
            )

    # Mesas com gente primeiro (não dá para ignorá-las), depois pela numeração.
    ordenadas = sorted(mesas, key=lambda m: (0 if int(m["ocupados"]) else 1, m["table_number"]))
    ocupadas = sum(1 for m in ordenadas if int(m["ocupados"]))
    inicio = max(minimo, ocupadas, 1)
    for quantas in range(min(inicio, len(ordenadas)), len(ordenadas) + 1):
        escolhidas = ordenadas[:quantas]
        if sum(int(m["capacidade"]) for m in escolhidas) < novos:
            continue
        resultado = _melhor_tentativa(equipes, avulsos, escolhidas, novos, rng, tentativas)
        if resultado is not None:
            return resultado
    raise ErroDeNegocio(
        "sorteio_de_equipes_impossivel",
        "Não foi possível separar os integrantes de cada equipe nas mesas ativas. "
        "Crie mais mesas ou libere lugares.",
        minimo=minimo, mesas=len(mesas),
    )


def _melhor_tentativa(equipes, avulsos, mesas, novos, rng, tentativas) -> Optional[Dict[str, str]]:
    cota_base = tamanhos_alvo(mesas, novos)
    if sum(cota_base.values()) < novos:
        return None
    final = {str(m["id"]): int(m["ocupados"]) + cota_base[str(m["id"])] for m in mesas}
    usadas = [t for t, c in cota_base.items() if c > 0]
    maior_tamanho = max(final[t] for t in usadas) if usadas else 0
    menor_tamanho = min(final[t] for t in usadas) if usadas else 0
    grandes = {t for t in usadas if final[t] == maior_tamanho and maior_tamanho != menor_tamanho}
    vagas_grandes = sum(cota_base[t] for t in grandes)

    membros = sum(len(e["a_sentar"]) for e in equipes)
    # Parte das vagas grandes que fica com as equipes (os avulsos levam o resto).
    das_equipes = round(vagas_grandes * membros / novos) if novos else 0
    das_equipes = max(vagas_grandes - len(avulsos), min(vagas_grandes, membros, das_equipes))

    melhor, melhor_nota = None, None
    for _ in range(max(1, tentativas)):
        alvo_grande = _repartir_inteiro(
            das_equipes, {str(e["id"]): len(e["a_sentar"]) for e in equipes}, rng,
        )
        tentativa = _uma_tentativa(equipes, avulsos, mesas, dict(cota_base), grandes, alvo_grande, rng)
        if tentativa is None:
            continue
        mesa_de, nas_grandes = tentativa
        ideal = {str(e["id"]): Decimal(len(e["a_sentar"]) * das_equipes) / Decimal(membros or 1) for e in equipes}
        desvios = [Decimal(nas_grandes[k]) - ideal[k] for k in ideal]
        nota = (max(desvios) - min(desvios)) if desvios else Decimal(0)
        if melhor_nota is None or nota < melhor_nota:
            melhor, melhor_nota = mesa_de, nota
        if nota <= 1:
            break
    return melhor


def _uma_tentativa(equipes, avulsos, mesas, cota, grandes, alvo_grande, rng):
    ordem = list(equipes)
    rng.shuffle(ordem)
    mesa_de: Dict[str, str] = {}
    nas_grandes: Dict[str, int] = {}
    numeros = {str(m["id"]): m["table_number"] for m in mesas}
    for equipe in ordem:
        chave = str(equipe["id"])
        proibidas = {str(p) for p in equipe.get("proibidas") or ()}
        jogadores = list(equipe["a_sentar"])
        rng.shuffle(jogadores)
        quer_grandes = alvo_grande.get(chave, 0)
        sorteio = {t: rng.random() for t in cota}

        def candidatas(grande: bool, ja: set):
            lista = [t for t, c in cota.items()
                     if c > 0 and t not in proibidas and t not in ja and ((t in grandes) == grande)]
            # Mesas com mais vagas sobrando primeiro: guarda espaço espalhado
            # para as últimas equipes, que também precisam de 4 mesas distintas.
            lista.sort(key=lambda t: (-cota[t], sorteio[t], numeros[t]))
            return lista

        escolhidas: List[str] = []
        for t in candidatas(True, set())[:quer_grandes]:
            escolhidas.append(t)
        faltam = len(jogadores) - len(escolhidas)
        escolhidas += candidatas(False, set(escolhidas))[:faltam]
        faltam = len(jogadores) - len(escolhidas)
        if faltam:
            escolhidas += candidatas(True, set(escolhidas))[:faltam]
        if len(escolhidas) < len(jogadores):
            return None
        nas_grandes[chave] = sum(1 for t in escolhidas if t in grandes)
        for jogador, t in zip(jogadores, escolhidas):
            mesa_de[str(jogador)] = t
            cota[t] -= 1

    restantes = [t for t, c in cota.items() for _ in range(c)]
    rng.shuffle(restantes)
    if len(restantes) < len(avulsos):
        return None
    for jogador, t in zip(avulsos, restantes):
        mesa_de[str(jogador)] = t
    return mesa_de, nas_grandes


# ── Final por revezamento ───────────────────────────────────────────────────
def membro_da_vez(integrantes: int, nivel_exibido: Optional[int], nivel_inicial: int = 1) -> int:
    """Índice (0 a n−1) de quem joga no nível: a cada nível entra o próximo da
    ordem apresentada. Antes do início (ou sem nível) joga o primeiro."""
    if integrantes <= 0:
        return 0
    if nivel_exibido is None or nivel_exibido < nivel_inicial:
        return 0
    return (int(nivel_exibido) - int(nivel_inicial)) % integrantes
