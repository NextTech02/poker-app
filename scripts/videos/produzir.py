# -*- coding: utf-8 -*-
"""Produz um vídeo a partir de um roteiro.

    python produzir.py roteiros/caixa-registrar-venda.yaml --idioma pt-BR

Um roteiro serve aos três idiomas: só as falas mudam. Os alvos usam a chave de
tradução do próprio app (`t: sidebar.sales`), então o mesmo passo acha o botão
em qualquer idioma, e o vídeo mostra a tela de verdade naquele idioma.

Sem AZURE_SPEECH_KEY a saída vai para `saida/rascunho/`: a voz de rascunho não
é licenciada para publicação. Com a chave, vai para `saida/final/`.
"""
import argparse
import asyncio
import json
import os
import shutil
import sys
import time
from pathlib import Path

import yaml

import montar
import narracao
from gravador import Gravador

AQUI = Path(__file__).resolve().parent
LOCALES = AQUI.parent.parent / "frontend" / "src" / "locales"
IDIOMAS = ("pt-BR", "en-US", "es-ES")
RESPIRO = 0.45  # silêncio entre uma fala e a próxima, em segundos
CHAVE_IDIOMA = "aceblind:idiomaEscolhido"
FIM_POR_IDIOMA = {
    "pt-BR": "Dúvidas? Veja os outros vídeos em Suporte.",
    "en-US": "Questions? See the other videos under Support.",
    "es-ES": "¿Dudas? Mira los demás videos en Soporte.",
}


def carregar_env() -> None:
    """Chaves ficam fora do repositório, num arquivo apontado por VIDEOS_ENV."""
    caminho = os.environ.get("VIDEOS_ENV")
    if not caminho or not Path(caminho).exists():
        return
    for linha in Path(caminho).read_text(encoding="utf-8").splitlines():
        if "=" in linha and not linha.lstrip().startswith("#"):
            nome, valor = linha.split("=", 1)
            os.environ.setdefault(nome.strip(), valor.strip())


def traducao(idioma: str, chave: str) -> str:
    atual = json.loads((LOCALES / f"{idioma}.json").read_text(encoding="utf-8"))
    for parte in chave.split("."):
        atual = atual[parte]
    return atual


def por_idioma(valor, idioma: str):
    return valor[idioma] if isinstance(valor, dict) and idioma in valor else valor


def localizar(pagina, alvo, idioma: str):
    """`t` = chave de tradução, `texto` = texto por idioma, `css` = seletor.
    `papel` restringe a um papel ARIA; `n` escolhe entre vários resultados."""
    texto = traducao(idioma, alvo["t"]) if "t" in alvo else por_idioma(alvo.get("texto"), idioma)
    if "css" in alvo:
        achado = pagina.locator(alvo["css"])
        if texto:
            achado = achado.filter(has_text=texto)
    elif "papel" in alvo:
        achado = pagina.get_by_role(alvo["papel"], name=texto)
    elif "rotulo" in alvo:
        achado = pagina.get_by_label(por_idioma(alvo["rotulo"], idioma))
    else:
        achado = pagina.get_by_text(texto, exact=alvo.get("exato", False))
    return achado.nth(alvo.get("n", 0))


async def executar(g: Gravador, acao: dict, idioma: str, base: str) -> None:
    pagina = g.pagina
    if "ir" in acao:
        await pagina.goto(base + acao["ir"], wait_until="domcontentloaded")
        await pagina.wait_for_load_state("networkidle")
        await pagina.evaluate("() => window.__ace.monta()")
    elif "clicar" in acao:
        await g.clicar(localizar(pagina, acao["clicar"], idioma))
    elif "digitar" in acao:
        d = acao["digitar"]
        await g.digitar(localizar(pagina, d, idioma), por_idioma(d["valor"], idioma))
    elif "destacar" in acao:
        await g.destacar(localizar(pagina, acao["destacar"], idioma), acao.get("segundos", 1.6))
    elif "esperar" in acao:
        await localizar(pagina, acao["esperar"], idioma).wait_for(state="visible", timeout=20000)
    elif "pausa" in acao:
        await asyncio.sleep(acao["pausa"])
    else:
        raise ValueError(f"ação desconhecida: {acao}")


async def produzir(roteiro: dict, idioma: str, base: str, sessao: dict | None, armazenamento: dict) -> Path:
    tabela = narracao.carregar_pronuncia()
    falas = [
        await narracao.sintetizar(por_idioma(p["fala"], idioma), idioma, tabela)
        for p in roteiro["passos"]
    ]
    rascunho = narracao.provedor() != "azure"
    trabalho = AQUI / "cache" / "gravacao" / f"{roteiro['id']}-{idioma}"
    shutil.rmtree(trabalho, ignore_errors=True)
    trabalho.mkdir(parents=True)

    linha_do_tempo = []
    guardado = {CHAVE_IDIOMA: idioma, "i18nextLng": idioma, **armazenamento}
    async with Gravador(trabalho, idioma, guardado) as g:
        await g.pagina.goto(base + (sessao or {}).get("hash", roteiro.get("inicio", "/")), wait_until="domcontentloaded")
        await g.pagina.wait_for_load_state("networkidle")
        await g.pagina.evaluate("() => window.__ace.monta()")
        await g.cartao(por_idioma(roteiro["titulo"], idioma), por_idioma(roteiro.get("descricao", ""), idioma))
        await asyncio.sleep(0.6)
        await g.iniciar_captura()
        await asyncio.sleep(2.4)
        await g.sem_cartao()
        await asyncio.sleep(0.6)

        for passo, (audio, segundos) in zip(roteiro["passos"], falas):
            comeco = time.time()
            for acao in passo.get("acoes", []):
                await executar(g, acao, idioma, base)
            sobra = segundos - (time.time() - comeco)
            await asyncio.sleep(max(sobra, 0) + RESPIRO)
            linha_do_tempo.append((por_idioma(passo["fala"], idioma), audio, comeco, segundos))

        await g.cartao(por_idioma(roteiro["titulo"], idioma), FIM_POR_IDIOMA[idioma])
        await asyncio.sleep(2.6)
        fim = await g.parar_captura()

    if not g.quadros:
        raise RuntimeError("a captura não gerou nenhum quadro")
    origem = g.quadros[0][1]
    video = trabalho / "video.mp4"
    total = montar.trilha_de_video(trabalho, g.quadros, fim, video)
    audio_final = trabalho / "audio.m4a"
    montar.trilha_de_audio([(a, c - origem) for _, a, c, _ in linha_do_tempo], total, trabalho, audio_final)

    pasta = AQUI / "saida" / ("rascunho" if rascunho else "final") / idioma
    saida = pasta / f"{roteiro['id']}.mp4"
    montar.juntar(video, audio_final, saida)
    montar.legendas([(t, c - origem, s) for t, _, c, s in linha_do_tempo], pasta / f"{roteiro['id']}.vtt")
    montar.capa(saida, min(total / 2, 8), pasta / f"{roteiro['id']}.jpg")
    (pasta / f"{roteiro['id']}.json").write_text(
        json.dumps({"quadros": len(g.quadros), "duracao": round(total, 2)}), encoding="utf-8"
    )
    shutil.rmtree(trabalho, ignore_errors=True)
    return saida


def main() -> None:
    carregar_env()
    args = argparse.ArgumentParser()
    args.add_argument("roteiro")
    args.add_argument("--idioma", choices=IDIOMAS, action="append")
    args.add_argument("--base", default="https://app.aceblind.net")
    opcoes = args.parse_args()
    roteiro = yaml.safe_load(Path(opcoes.roteiro).read_text(encoding="utf-8"))
    for idioma in opcoes.idioma or IDIOMAS:
        saida = asyncio.run(produzir(roteiro, idioma, opcoes.base, None, {}))
        print(idioma, saida, narracao.duracao(saida))


if __name__ == "__main__":
    sys.exit(main())
