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
import time
from datetime import date
import urllib.error
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

# Plano gratuito (F0): 20 pedidos por minuto, limite que não pode ser aumentado.
INTERVALO_AZURE = 3.2
TENTATIVAS = 5
# Margem sob os 500 mil caracteres mensais do F0: passar disso bloqueia a voz.
TETO_MENSAL = 480_000


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


def _arquivo_de_uso() -> Path:
    return CACHE / f"caracteres-{date.today():%Y-%m}.txt"


def caracteres_do_mes() -> int:
    arquivo = _arquivo_de_uso()
    return int(arquivo.read_text() or 0) if arquivo.exists() else 0


def _com_trava(acao):
    """O limite do F0 vale por recurso, não por processo: quem grava em paralelo
    precisa dividir a mesma fila."""
    trava = CACHE / ".trava"
    while True:
        try:
            descritor = os.open(trava, os.O_CREAT | os.O_EXCL)
            break
        except FileExistsError:
            try:
                if time.time() - trava.stat().st_mtime > 30:  # sobra de processo morto
                    trava.unlink(missing_ok=True)
            except OSError:
                pass
            time.sleep(0.1)
    try:
        return acao()
    finally:
        os.close(descritor)
        trava.unlink(missing_ok=True)


def _esperar_a_vez() -> None:
    marca = CACHE / ".ultimo-pedido"

    def agendar():
        ultimo = float(marca.read_text() or 0) if marca.exists() else 0.0
        espera = ultimo + INTERVALO_AZURE - time.time()
        if espera > 0:
            time.sleep(espera)
        marca.write_text(str(time.time()))

    _com_trava(agendar)


def _somar_caracteres(quantidade: int) -> None:
    _com_trava(lambda: _arquivo_de_uso().write_text(str(caracteres_do_mes() + quantidade)))


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
    uso = caracteres_do_mes()
    if uso + len(texto) > TETO_MENSAL:
        raise RuntimeError(f"cota mensal do Azure quase esgotada: {uso} caracteres usados")
    for tentativa in range(TENTATIVAS):
        _esperar_a_vez()
        try:
            with urllib.request.urlopen(pedido, timeout=60) as resposta:
                destino.write_bytes(resposta.read())
            _somar_caracteres(len(texto))
            return
        except urllib.error.HTTPError as erro:
            # 429 também vem de falta de capacidade momentânea da voz na região,
            # não só do limite por minuto. Cota do mês esgotada dá outro erro,
            # que sobe direto: esperar não resolve.
            if erro.code != 429 or tentativa == TENTATIVAS - 1:
                raise
            time.sleep(15 * (tentativa + 1))


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
    if not destino.exists() or destino.stat().st_size == 0:
        if fornecedor == "azure":
            await asyncio.to_thread(_azure, falado, idioma, destino)
        else:
            await _edge(falado, idioma, destino)
    return destino, duracao(destino)
