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
import importlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

import yaml
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeout

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


def preencher(valor, variaveis: dict):
    return valor.format(**variaveis) if isinstance(valor, str) and "{" in valor else valor


def localizar(pagina, alvo, idioma: str, variaveis: dict):
    """`t` = chave de tradução, `texto` = texto por idioma, `css` = seletor.
    `papel` restringe a um papel ARIA; `n` escolhe entre vários resultados."""
    texto = traducao(idioma, alvo["t"]) if "t" in alvo else por_idioma(alvo.get("texto"), idioma)
    texto = preencher(texto, variaveis)
    if "css" in alvo:
        achado = pagina.locator(preencher(alvo["css"], variaveis))
        if texto:
            achado = achado.filter(has_text=texto)
    elif "papel" in alvo:
        achado = pagina.get_by_role(alvo["papel"], name=texto)
    elif "rotulo" in alvo:
        achado = pagina.get_by_label(por_idioma(alvo["rotulo"], idioma))
    else:
        achado = pagina.get_by_text(texto, exact=alvo.get("exato", False))
    return achado.nth(alvo.get("n", 0))


async def assentar(pagina) -> None:
    """Espera a tela carregar. O app faz polling em algumas telas e a rede pode
    nunca ficar quieta, então o limite de tempo aqui não é erro."""
    try:
        await pagina.wait_for_load_state("networkidle", timeout=8000)
    except PlaywrightTimeout:
        pass
    await pagina.evaluate("() => window.__ace.monta()")


async def executar(g: Gravador, acao: dict, idioma: str, base: str, variaveis: dict) -> None:
    pagina = g.pagina

    def achar(alvo):
        return localizar(pagina, alvo, idioma, variaveis)

    def valor(campo):
        return preencher(por_idioma(campo, idioma), variaveis)

    if "ir" in acao:
        await pagina.goto(base + preencher(acao["ir"], variaveis), wait_until="domcontentloaded")
        await assentar(pagina)
    elif "clicar" in acao:
        await g.clicar(achar(acao["clicar"]))
    elif "digitar" in acao:
        d = acao["digitar"]
        await g.digitar(achar(d), str(valor(d["valor"])), limpar=d.get("limpar", False))
    elif "preencher" in acao:
        d = acao["preencher"]
        await g.preencher(achar(d), str(valor(d["valor"])))
    elif "escolher" in acao:
        d = acao["escolher"]
        await g.escolher(achar(d), valor(d.get("opcao")), valor(d.get("rotulo_opcao")))
    elif "destacar" in acao:
        await g.destacar(achar(acao["destacar"]), acao.get("segundos", 1.6))
    elif "enviar" in acao:
        d = acao["enviar"]
        await achar(d).set_input_files(str(valor(d["arquivo"])))
    elif "arrastar" in acao:
        await g.arrastar(achar(acao["arrastar"]["de"]), achar(acao["arrastar"]["para"]))
    elif "passar" in acao:
        await g.passar(achar(acao["passar"]))
    elif "rolar" in acao:
        await achar(acao["rolar"]).scroll_into_view_if_needed()
    elif "tecla" in acao:
        await pagina.keyboard.press(acao["tecla"])
    elif "esperar" in acao:
        await achar(acao["esperar"]).wait_for(state="visible", timeout=20000)
    elif "pausa" in acao:
        await asyncio.sleep(acao["pausa"])
    else:
        raise ValueError(f"ação desconhecida: {acao}")


def preparar(roteiro: dict, idioma: str, api) -> dict:
    """`preparar: cash:mesa_com_jogadores` chama essa função de sementes/cash.py
    antes de gravar. Ela deixa o clube no estado que o vídeo precisa e devolve
    as variáveis que o roteiro usa, como `{mesa}`."""
    nome = roteiro.get("preparar")
    if not nome:
        return {}
    modulo, funcao = nome.split(":")
    return getattr(importlib.import_module(f"sementes.{modulo}"), funcao)(idioma, api) or {}


async def entrar_no_app(pagina, entrada: str) -> None:
    """Abre a sessão pela URL com os tokens.

    O erro do Playwright repete a URL, e um log guardaria os tokens: por isso a
    falha final sai fora do `except`, sem a exceção original encadeada."""
    for _ in range(3):
        try:
            await pagina.goto(entrada, wait_until="domcontentloaded", timeout=60000)
            await pagina.wait_for_function(
                "() => Object.keys(localStorage).some((k) => k.endsWith('-auth-token'))", timeout=20000
            )
            return
        except PlaywrightError:
            continue
    raise RuntimeError("não consegui abrir a sessão no app")


async def produzir(roteiro: dict, idioma: str, base: str) -> Path:
    """Grava e, com ou sem sucesso, encerra a sessão aberta para a gravação."""
    sessoes = []
    try:
        return await gravar(roteiro, idioma, base, sessoes)
    finally:
        if sessoes:
            import clube_demo

            for sessao in sessoes:
                clube_demo.encerrar_sessao(sessao)


async def gravar(roteiro: dict, idioma: str, base: str, sessoes: list) -> Path:
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
    guardado = {CHAVE_IDIOMA: idioma, "i18nextLng": idioma}
    variaveis = {}
    entrada = None
    if roteiro.get("sessao"):
        import clube_demo

        guardado["selected_module"] = roteiro.get("modulo", "tournament")
        dados = clube_demo.estado(idioma)
        guardado["selected_stage"] = json.dumps(dados["etapa"])
        variaveis.update(dia=dados["dia"], torneio=dados["torneio"], etapa=dados["etapa"]["id"], org=dados["org"])
        if "{jogador}" in json.dumps(roteiro):
            variaveis["jogador"] = clube_demo.proximo_jogador(idioma)
        tokens = clube_demo.abrir_sessao(idioma)
        sessoes.append(tokens)
        variaveis.update(preparar(roteiro, idioma, clube_demo.Api(tokens)))
        # Uma semente pode trocar a etapa selecionada: cada área grava na sua,
        # para fechar o caixa num vídeo não atrapalhar outro.
        if "etapa_selecionada" in variaveis:
            selecionada = variaveis.pop("etapa_selecionada")
            guardado["selected_stage"] = json.dumps(selecionada)
            variaveis["etapa"] = selecionada["id"]
        entrada = (
            f"{base}/#access_token={tokens['access_token']}&refresh_token={tokens['refresh_token']}"
            f"&expires_in={tokens.get('expires_in', 3600)}&token_type=bearer&type=magiclink"
        )

    async with Gravador(trabalho, idioma, guardado) as g:
        if entrada:
            # O supabase-js guarda a sessão ao ler o hash; depois disso o token
            # não fica na URL de nenhuma tela gravada.
            await entrar_no_app(g.pagina, entrada)
        await g.pagina.goto(base + preencher(roteiro.get("inicio", "/"), variaveis), wait_until="domcontentloaded")
        await assentar(g.pagina)
        await g.cartao(por_idioma(roteiro["titulo"], idioma), por_idioma(roteiro.get("descricao", ""), idioma))
        await asyncio.sleep(0.6)
        await g.iniciar_captura()
        await asyncio.sleep(2.4)
        await g.sem_cartao()
        await asyncio.sleep(0.6)

        for numero, (passo, (audio, segundos)) in enumerate(zip(roteiro["passos"], falas), start=1):
            comeco = time.time()
            try:
                for acao in passo.get("acoes", []):
                    await executar(g, acao, idioma, base, variaveis)
            except Exception:
                # O print da tela no momento da falha é o que resolve um seletor errado.
                erro = AQUI / "cache" / "erros" / f"{roteiro['id']}-{idioma}-passo{numero}.png"
                erro.parent.mkdir(parents=True, exist_ok=True)
                await g.pagina.screenshot(path=str(erro))
                print(f"falhou no passo {numero}: {erro}", file=sys.stderr)
                raise
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
    args.add_argument("roteiros", nargs="+")
    args.add_argument("--idioma", choices=IDIOMAS, action="append")
    args.add_argument("--base", default="https://app.aceblind.net")
    opcoes = args.parse_args()
    for caminho in opcoes.roteiros:
        roteiro = yaml.safe_load(Path(caminho).read_text(encoding="utf-8"))
        for idioma in opcoes.idioma or IDIOMAS:
            saida = asyncio.run(produzir(roteiro, idioma, opcoes.base))
            print(idioma, saida, narracao.duracao(saida))
    print("caracteres usados no Azure neste mês:", narracao.caracteres_do_mes())


if __name__ == "__main__":
    sys.exit(main())
