# -*- coding: utf-8 -*-
"""Folhas de contato para revisar um vídeo sem assistir inteiro.

    python revisar.py caixa-registrar-venda --idioma en-US --quadros 8

Quatro quadros por imagem, espaçados por igual, em cache/revisao/. Imprime os
caminhos e a legenda, para comparar a fala com a tela.
"""
import argparse
import subprocess
from pathlib import Path

from narracao import duracao
from produzir import AQUI


def _ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def main() -> None:
    args = argparse.ArgumentParser()
    args.add_argument("id")
    args.add_argument("--idioma", default="pt-BR")
    args.add_argument("--quadros", type=int, default=8)
    args.add_argument("--pasta", choices=("final", "rascunho"), default="final")
    opcoes = args.parse_args()

    video = AQUI / "saida" / opcoes.pasta / opcoes.idioma / f"{opcoes.id}.mp4"
    pasta = AQUI / "cache" / "revisao"
    pasta.mkdir(parents=True, exist_ok=True)
    total = duracao(video)
    quantos = max(4, opcoes.quadros + (-opcoes.quadros % 4))
    tempos = [total * (i + 1) / (quantos + 1) for i in range(quantos)]

    for inicio in range(0, quantos, 4):
        entradas = []
        for t in tempos[inicio:inicio + 4]:
            quadro = pasta / f"{opcoes.id}-{opcoes.idioma}-{t:06.2f}.png"
            _ffmpeg("-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1", str(quadro))
            entradas += ["-i", str(quadro)]
        folha = pasta / f"{opcoes.id}-{opcoes.idioma}-folha{inicio // 4}.png"
        filtro = "[0][1]hstack[a];[2][3]hstack[b];[a][b]vstack,scale=1800:-1"
        _ffmpeg(*entradas, "-filter_complex", filtro, "-frames:v", "1", str(folha))
        print(folha, "tempos:", [round(t, 1) for t in tempos[inicio:inicio + 4]])
    print(video.with_suffix(".vtt").read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
