# -*- coding: utf-8 -*-
"""Junta quadros, narração e legendas num MP4 pronto para a web."""
import re
import subprocess
import wave
from pathlib import Path

TAXA = 24000  # Hz, mono: a saída do sintetizador
MAX_LEGENDA = 84  # duas linhas de 42 caracteres
MAIOR_INTERVALO = 120  # segundos sem quadro: nenhuma fala dura isso


def _rodar(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def trilha_de_video(pasta: Path, quadros: list[tuple[str, float]], fim: float, saida: Path) -> float:
    """Quadros têm horário próprio: a tela parada não gera quadro, então cada um
    fica na tela até o próximo. Devolve a duração total, em segundos."""
    inicio = quadros[0][1]
    maior = max(b[1] - a[1] for a, b in zip(quadros, quadros[1:] + [("", fim)]))
    if maior > MAIOR_INTERVALO:
        # A máquina suspendeu no meio: sem isto sairia um vídeo de horas.
        raise RuntimeError(f"gravação com {maior:.0f} s sem quadros: refaça")
    lista = pasta / "quadros.txt"
    linhas = []
    for (nome, quando), (_, seguinte) in zip(quadros, quadros[1:] + [("", fim)]):
        linhas += [f"file '{nome}'", f"duration {max(seguinte - quando, 0.001):.4f}"]
    # O concat ignora a duração do último item se ele não for repetido.
    linhas.append(f"file '{quadros[-1][0]}'")
    lista.write_text("\n".join(linhas), encoding="utf-8")
    _rodar(
        "-f", "concat", "-safe", "0", "-i", str(lista),
        "-vf", "fps=30,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-tune", "stillimage",
        str(saida),
    )
    return fim - inicio


def trilha_de_audio(falas: list[tuple[Path, float]], total: float, pasta: Path, saida: Path) -> None:
    """Cada fala entra no segundo exato em que o passo começou na gravação."""
    linha_do_tempo = bytearray(int(total * TAXA) * 2)
    for indice, (audio, inicio) in enumerate(falas):
        pcm = pasta / f"fala{indice:04d}.wav"
        _rodar("-i", str(audio), "-ar", str(TAXA), "-ac", "1", "-sample_fmt", "s16", str(pcm))
        with wave.open(str(pcm)) as arquivo:
            dados = arquivo.readframes(arquivo.getnframes())
        posicao = int(inicio * TAXA) * 2
        fim = min(posicao + len(dados), len(linha_do_tempo))
        linha_do_tempo[posicao:fim] = dados[: fim - posicao]
    bruto = pasta / "narracao.wav"
    with wave.open(str(bruto), "wb") as arquivo:
        arquivo.setnchannels(1)
        arquivo.setsampwidth(2)
        arquivo.setframerate(TAXA)
        arquivo.writeframes(bytes(linha_do_tempo))
    _rodar("-i", str(bruto), "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "128k", str(saida))


def juntar(video: Path, audio: Path, saida: Path) -> None:
    saida.parent.mkdir(parents=True, exist_ok=True)
    _rodar("-i", str(video), "-i", str(audio), "-c", "copy", "-shortest", "-movflags", "+faststart", str(saida))


def capa(video: Path, segundo: float, saida: Path) -> None:
    _rodar("-ss", f"{segundo:.2f}", "-i", str(video), "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", str(saida))


def _pedacos(texto: str) -> list[str]:
    """Quebra em frases e, se a frase não couber em duas linhas, nas vírgulas ou espaços."""
    pedacos = []
    for frase in re.split(r"(?<=[.!?])\s+", texto.strip()):
        while len(frase) > MAX_LEGENDA:
            corte = frase.rfind(", ", 0, MAX_LEGENDA)
            corte = corte + 1 if corte > 30 else frase.rfind(" ", 0, MAX_LEGENDA)
            pedacos.append(frase[:corte].strip())
            frase = frase[corte:].strip()
        if frase:
            pedacos.append(frase)
    return pedacos


def _hora(segundos: float) -> str:
    h, resto = divmod(segundos, 3600)
    m, s = divmod(resto, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


def legendas(falas: list[tuple[str, float, float]], saida: Path) -> None:
    """(texto, início, duração) -> WebVTT. O REST do Azure não devolve o tempo de
    cada palavra, então o tempo da fala é dividido pelo tamanho de cada trecho."""
    blocos = ["WEBVTT", ""]
    for texto, inicio, duracao in falas:
        pedacos = _pedacos(texto)
        total = sum(len(p) for p in pedacos) or 1
        agora = inicio
        for pedaco in pedacos:
            tempo = duracao * len(pedaco) / total
            blocos += [f"{_hora(agora)} --> {_hora(agora + tempo)}", pedaco, ""]
            agora += tempo
    saida.write_text("\n".join(blocos), encoding="utf-8")
