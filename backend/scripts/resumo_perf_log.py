"""Resume uma noite de PERF_LOG: onde o backend gasta tempo, rota por rota.

Com PERF_LOG=true o backend escreve uma linha por requisição
(app/main.py, PerfLogMiddleware):

    [perf] 21:05:33 GET    /tournament-days/<uuid>/timer/status-enriched     45ms   2 consultas

Este script lê essas linhas da entrada padrão, troca ids e códigos de TV por
`{id}`/`{codigo}` (para cada ROTA virar uma linha só) e imprime, por rota:
quantas vezes rodou, o tempo somado, p50/p95/máximo e quantas idas ao banco
fez em média e no pior caso.

A ordem é pelo TEMPO SOMADO: uma rota de 80 ms que roda 20 mil vezes pesa
mais na noite do que uma de 2 s que rodou três vezes — e é isso que decide
onde vale a pena mexer primeiro.

Na VPS (o script já está dentro da imagem do backend):

    docker compose logs backend --since 14h --no-log-prefix > perf.log
    docker compose exec -T backend python scripts/resumo_perf_log.py < perf.log

Opções: --top N (padrão 25), --desde HH:MM e --ate HH:MM (recorte da noite).
"""
import argparse
import re
import sys
from collections import defaultdict

LINHA = re.compile(
    r"\[perf\]\s+(?P<hora>\d\d:\d\d:\d\d)\s+(?P<metodo>[A-Z]+)\s+(?P<rota>\S+)\s+"
    r"(?P<ms>\d+)ms\s+(?P<consultas>\d+)\s+consultas"
)
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
# Código público da TV (/public/tv/AB12CD...): letras maiúsculas e dígitos.
CODIGO_DE_TV = re.compile(r"(/public/tv/)(?!days/)[A-Z0-9]{4,12}(?=/|$)")
NUMERO = re.compile(r"/\d+(?=/|$)")


def rota_generica(rota: str) -> str:
    rota = rota.split("?", 1)[0]
    rota = UUID.sub("{id}", rota)
    rota = CODIGO_DE_TV.sub(r"\1{codigo}", rota)
    return NUMERO.sub("/{n}", rota)


def percentil(valores, p):
    if not valores:
        return 0
    ordenados = sorted(valores)
    k = min(len(ordenados) - 1, max(0, int(round(p / 100 * (len(ordenados) - 1)))))
    return ordenados[k]


def ler(linhas, desde=None, ate=None):
    por_rota = defaultdict(lambda: {"ms": [], "consultas": []})
    lidas = 0
    for linha in linhas:
        m = LINHA.search(linha)
        if not m:
            continue
        hora = m["hora"][:5]
        if desde and hora < desde:
            continue
        if ate and hora > ate:
            continue
        chave = (m["metodo"], rota_generica(m["rota"]))
        por_rota[chave]["ms"].append(int(m["ms"]))
        por_rota[chave]["consultas"].append(int(m["consultas"]))
        lidas += 1
    return por_rota, lidas


def resumir(por_rota):
    linhas = []
    for (metodo, rota), d in por_rota.items():
        ms, cons = d["ms"], d["consultas"]
        linhas.append({
            "metodo": metodo, "rota": rota, "vezes": len(ms), "total_s": sum(ms) / 1000,
            "p50": percentil(ms, 50), "p95": percentil(ms, 95), "max": max(ms),
            "cons_media": sum(cons) / len(cons), "cons_max": max(cons),
        })
    linhas.sort(key=lambda l: l["total_s"], reverse=True)
    return linhas


def imprimir(linhas, top, lidas):
    total = sum(l["total_s"] for l in linhas) or 1
    print(f"{lidas} requisições, {len(linhas)} rotas, {total:.0f} s de backend no total\n")
    cab = f"{'%':>5} {'total':>8} {'vezes':>7} {'p50':>6} {'p95':>6} {'máx':>6} {'consultas':>11}  rota"
    print(cab)
    print("-" * len(cab) + "-" * 30)
    for l in linhas[:top]:
        print(
            f"{100 * l['total_s'] / total:5.1f} {l['total_s']:7.0f}s {l['vezes']:7d} "
            f"{l['p50']:5d}ms {l['p95']:5d}ms {l['max']:5d}ms "
            f"{l['cons_media']:5.1f} ({l['cons_max']:2d})  {l['metodo']} {l['rota']}"
        )


def main(argv=None):
    parser = argparse.ArgumentParser(description="Resume as linhas [perf] do backend por rota.")
    parser.add_argument("--top", type=int, default=25)
    parser.add_argument("--desde", help="HH:MM — ignora o que veio antes")
    parser.add_argument("--ate", help="HH:MM — ignora o que veio depois")
    args = parser.parse_args(argv)
    por_rota, lidas = ler(sys.stdin, args.desde, args.ate)
    if not lidas:
        print("Nenhuma linha [perf] encontrada. O backend está com PERF_LOG=true?")
        return 1
    imprimir(resumir(por_rota), args.top, lidas)
    return 0


if __name__ == "__main__":
    sys.exit(main())
