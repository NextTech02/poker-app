# -*- coding: utf-8 -*-
"""Texto -> áudio, com cache por hash.

Azure Speech é a voz FINAL (licenciada). Sem chave, cai no edge-tts, que usa as
mesmas vozes por um serviço não oficial: serve para rascunho, nunca para vídeo
publicado. `produzir.py` separa as saídas pelos dois casos.
"""
import asyncio
import hashlib
import html
import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path

VOZES = {
    "pt-BR": "pt-BR-FranciscaNeural",
    "en-US": "en-US-AvaNeural",
    # O app usa o locale es-ES, mas a voz é latina: decisão do dono do produto.
    "es-ES": "es-CO-SalomeNeural",
}
XML_LANG = {"pt-BR": "pt-BR", "en-US": "en-US", "es-ES": "es-CO"}

AQUI = Path(__file__).resolve().parent
CACHE = AQUI / "cache" / "audio"


def provedor() -> str:
    return "azure" if os.environ.get("AZURE_SPEECH_KEY") else "edge"


def carregar_pronuncia() -> dict:
    caminho = AQUI / "pronuncia.json"
    return json.loads(caminho.read_text(encoding="utf-8")) if caminho.exists() else {}


def para_voz(texto: str, idioma: str, tabela: dict) -> str:
    """Troca termos de poker pela grafia que a voz lê certo. A legenda continua
    usando o texto original: isto só existe para o sintetizador."""
    for termo, leitura in tabela.get(idioma, {}).items():
        texto = re.sub(rf"(?<!\w){re.escape(termo)}(?!\w)", leitura, texto, flags=re.IGNORECASE)
    return texto


def _azure(texto: str, idioma: str, destino: Path) -> None:
    regiao = os.environ["AZURE_SPEECH_REGION"]
    ssml = (
        f"<speak version='1.0' xml:lang='{XML_LANG[idioma]}'>"
        f"<voice name='{VOZES[idioma]}'>{html.escape(texto, quote=False)}</voice></speak>"
    )
    pedido = urllib.request.Request(
        f"https://{regiao}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": os.environ["AZURE_SPEECH_KEY"],
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
            "User-Agent": "aceblind-videos",
        },
    )
    with urllib.request.urlopen(pedido, timeout=60) as resposta:
        destino.write_bytes(resposta.read())


async def _edge(texto: str, idioma: str, destino: Path) -> None:
    import edge_tts

    await edge_tts.Communicate(texto, VOZES[idioma]).save(str(destino))


def duracao(caminho: Path) -> float:
    saida = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(caminho)]
    )
    return float(saida.strip())


async def sintetizar(texto: str, idioma: str, tabela: dict) -> tuple[Path, float]:
    """Devolve (arquivo, segundos). Mesmo texto, voz e provedor reaproveitam o cache."""
    CACHE.mkdir(parents=True, exist_ok=True)
    falado = para_voz(texto, idioma, tabela)
    fornecedor = provedor()
    chave = hashlib.sha256(f"{fornecedor}|{VOZES[idioma]}|{falado}".encode("utf-8")).hexdigest()[:20]
    destino = CACHE / f"{idioma}-{chave}.mp3"
    if not destino.exists():
        if fornecedor == "azure":
            await asyncio.to_thread(_azure, falado, idioma, destino)
        else:
            await _edge(falado, idioma, destino)
    return destino, duracao(destino)
