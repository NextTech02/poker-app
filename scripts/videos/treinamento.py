# -*- coding: utf-8 -*-
"""Monta o treinamento completo a partir dos vídeos curtos.

    python treinamento.py                  # os 3 idiomas
    python treinamento.py --idioma en-US

Cada vídeo curto entra sem o próprio cartão de abertura e de fim, e cada
capítulo abre com um cartão narrado. Sai um MP4, a legenda unificada e um JSON
com a duração e o início de cada capítulo, que a tela de Suporte mostra como
atalhos. Quando um vídeo curto é regravado, basta montar de novo: nada aqui
grava a tela.
"""
import argparse
import asyncio
import base64
import json
import re
import shutil
import subprocess
from pathlib import Path

import yaml
from playwright.async_api import async_playwright

import narracao
from gravador import ALTURA, CAMADA, LARGURA, LOGO
from produzir import AQUI, IDIOMAS, carregar_env, por_idioma

FINAL = AQUI / "saida" / "final"
# Os curtos abrem com 3 s de cartão e fecham com 2,6 s de cartão (produzir.py).
CORTE_INICIO = 2.9
CORTE_FIM = 2.6
FOLGA_CARTAO = 0.9  # silêncio depois da fala do cartão


def _ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def _normalizar(entrada_video: list[str], destino: Path, filtros_audio: str = "anull") -> None:
    """Todo trecho sai com o mesmo formato, para o concat juntar sem recodificar."""
    _ffmpeg(*entrada_video,
            "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "23",
            "-tune", "stillimage", "-af", filtros_audio, "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
            "-ac", "1", str(destino))


async def _imagem_do_cartao(titulo: str, sub: str, destino: Path) -> None:
    logo = "data:image/png;base64," + base64.b64encode(LOGO.read_bytes()).decode()
    async with async_playwright() as pw:
        navegador = await pw.chromium.launch()
        pagina = await navegador.new_page(viewport={"width": LARGURA, "height": ALTURA})
        await pagina.set_content("<html><body style='margin:0;background:#0b0a12'></body></html>")
        await pagina.add_script_tag(content=CAMADA)
        await pagina.evaluate("([t, s, m]) => { window.__ace.monta(); window.__ace.cartao(t, s, m); }",
                              [titulo, sub, logo])
        await pagina.evaluate("() => { const c = document.getElementById('__ace_cursor'); if (c) c.remove(); }")
        await pagina.wait_for_timeout(700)
        await pagina.screenshot(path=str(destino))
        await navegador.close()


async def _cartao(titulo: str, sub: str, fala: str, idioma: str, pasta: Path, nome: str) -> tuple[Path, float, str]:
    imagem = pasta / f"{nome}.png"
    await _imagem_do_cartao(titulo, sub, imagem)
    audio, segundos = await narracao.sintetizar(fala, idioma, narracao.carregar_pronuncia())
    duracao = segundos + FOLGA_CARTAO
    trecho = pasta / f"{nome}.mp4"
    _normalizar(["-loop", "1", "-framerate", "30", "-t", f"{duracao:.3f}", "-i", str(imagem),
                 "-i", str(audio)], trecho, f"apad,atrim=0:{duracao:.3f}")
    return trecho, duracao, fala


def _segundos(marca: str) -> float:
    h, m, s = marca.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def _hora(segundos: float) -> str:
    h, resto = divmod(max(segundos, 0), 3600)
    m, s = divmod(resto, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


def _legendas_do_curto(vtt: Path, deslocamento: float, inicio: float, fim: float) -> list[str]:
    blocos = []
    for bloco in re.split(r"\n\s*\n", vtt.read_text(encoding="utf-8")):
        linhas = bloco.strip().splitlines()
        if not linhas or "-->" not in linhas[0]:
            continue
        a, b = (_segundos(x.strip()) for x in linhas[0].split("-->"))
        if b <= inicio or a >= fim:
            continue
        a, b = max(a, inicio), min(b, fim)
        blocos.append(f"{_hora(a - inicio + deslocamento)} --> {_hora(b - inicio + deslocamento)}\n"
                      + "\n".join(linhas[1:]))
    return blocos


async def montar(plano: dict, idioma: str) -> Path:
    pasta = AQUI / "cache" / "treinamento" / idioma
    shutil.rmtree(pasta, ignore_errors=True)
    pasta.mkdir(parents=True)
    titulo = por_idioma(plano["titulo"], idioma)

    trechos, legendas, capitulos, faltando = [], [], [], []
    agora = 0.0

    def cartao_na_legenda(fala: str, duracao: float):
        legendas.append(f"{_hora(agora)} --> {_hora(agora + duracao - FOLGA_CARTAO)}\n{fala}")

    abertura = await _cartao(titulo, por_idioma(plano["descricao"], idioma),
                             por_idioma(plano["abertura"], idioma), idioma, pasta, "00-abertura")
    trechos.append(abertura[0])
    cartao_na_legenda(abertura[2], abertura[1])
    agora += abertura[1]

    for numero, capitulo in enumerate(plano["capitulos"], start=1):
        presentes = [v for v in capitulo["videos"] if (FINAL / idioma / f"{v}.mp4").exists()]
        faltando += [v for v in capitulo["videos"] if v not in presentes]
        if not presentes:
            continue
        nome_cap = por_idioma(capitulo["titulo"], idioma)
        capitulos.append({"titulo": nome_cap, "inicio": round(agora, 2)})
        rotulo = {"pt-BR": "Capítulo", "en-US": "Chapter", "es-ES": "Capítulo"}[idioma]
        cartao = await _cartao(nome_cap, f"{rotulo} {numero}", f"{rotulo} {numero}: {nome_cap}.",
                               idioma, pasta, f"{numero:02d}-capitulo")
        trechos.append(cartao[0])
        cartao_na_legenda(cartao[2], cartao[1])
        agora += cartao[1]

        for indice, video in enumerate(presentes):
            origem = FINAL / idioma / f"{video}.mp4"
            total = narracao.duracao(origem)
            inicio, fim = CORTE_INICIO, total - CORTE_FIM
            trecho = pasta / f"{numero:02d}-{indice:02d}-{video}.mp4"
            _normalizar(["-ss", f"{inicio:.3f}", "-to", f"{fim:.3f}", "-i", str(origem)], trecho)
            legendas += _legendas_do_curto(origem.with_suffix(".vtt"), agora, inicio, fim)
            agora += narracao.duracao(trecho)
            trechos.append(trecho)

    encerramento = await _cartao(titulo, "", por_idioma(plano["encerramento"], idioma), idioma, pasta, "99-fim")
    trechos.append(encerramento[0])
    cartao_na_legenda(encerramento[2], encerramento[1])

    lista = pasta / "lista.txt"
    lista.write_text("\n".join(f"file '{t.as_posix()}'" for t in trechos), encoding="utf-8")
    destino = FINAL / idioma / f"{plano['id']}.mp4"
    _ffmpeg("-f", "concat", "-safe", "0", "-i", str(lista), "-c", "copy", "-movflags", "+faststart", str(destino))
    destino.with_suffix(".vtt").write_text("WEBVTT\n\n" + "\n\n".join(legendas) + "\n", encoding="utf-8")
    shutil.copy2(pasta / "00-abertura.png", destino.with_suffix(".png"))
    _ffmpeg("-i", str(pasta / "00-abertura.png"), "-vf", "scale=640:-2", "-q:v", "4", str(destino.with_suffix(".jpg")))
    destino.with_suffix(".png").unlink()
    duracao = narracao.duracao(destino)
    destino.with_suffix(".json").write_text(json.dumps(
        {"duracao": round(duracao, 2), "capitulos": capitulos}, ensure_ascii=False), encoding="utf-8")
    if faltando:
        print(idioma, "sem estes vídeos curtos:", ", ".join(faltando))
    print(idioma, destino, f"{duracao / 60:.1f} min", f"{destino.stat().st_size / 1e6:.0f} MB",
          len(capitulos), "capítulos")
    shutil.rmtree(pasta, ignore_errors=True)
    return destino


def main() -> None:
    carregar_env()
    args = argparse.ArgumentParser()
    args.add_argument("--idioma", choices=IDIOMAS, action="append")
    args.add_argument("--plano", default=str(AQUI / "treinamento.yaml"))
    opcoes = args.parse_args()
    plano = yaml.safe_load(Path(opcoes.plano).read_text(encoding="utf-8"))
    for idioma in opcoes.idioma or IDIOMAS:
        asyncio.run(montar(plano, idioma))


if __name__ == "__main__":
    main()
