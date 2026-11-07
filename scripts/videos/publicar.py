# -*- coding: utf-8 -*-
"""Sobe os vídeos de `saida/final/` para o bucket e gera o catalogo.json.

    python publicar.py            # mostra o que subiria, sem enviar nada
    python publicar.py --enviar   # envia

Só publica `saida/final/`: rascunho usa voz sem licença para publicação.
O catálogo sobe por último, porque é ele que faz o vídeo aparecer no app.
"""
import argparse
import json
import mimetypes
import os
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

from produzir import AQUI, IDIOMAS, carregar_env

BUCKET = "videos-suporte"
PROJETO = "https://obhfozqcxbdvuqxugjxz.supabase.co"
FINAL = AQUI / "saida" / "final"
TIPOS = {".mp4": "video/mp4", ".vtt": "text/vtt", ".jpg": "image/jpeg", ".json": "application/json"}


def montar_catalogo() -> dict:
    areas = yaml.safe_load((AQUI / "areas.yaml").read_text(encoding="utf-8"))
    videos = []
    for arquivo in sorted((AQUI / "roteiros").glob("*.yaml")):
        roteiro = yaml.safe_load(arquivo.read_text(encoding="utf-8"))
        duracao = {}
        for idioma in IDIOMAS:
            dados = FINAL / idioma / f"{roteiro['id']}.json"
            if dados.exists():
                duracao[idioma] = json.loads(dados.read_text(encoding="utf-8"))["duracao"]
        if duracao:
            videos.append({
                "id": roteiro["id"],
                "tipo": roteiro.get("tipo", "curto"),
                "area": roteiro.get("area"),
                "titulo": roteiro["titulo"],
                "descricao": roteiro.get("descricao", {}),
                "duracao": duracao,
            })
    return {"versao": 1, "areas": areas, "videos": videos}


def enviar(caminho: str, corpo: bytes, tipo: str, cache: str) -> None:
    chave = os.environ["SUPABASE_SERVICE_KEY"]
    url = f"{PROJETO}/storage/v1/object/{BUCKET}/{urllib.parse.quote(caminho)}"
    pedido = urllib.request.Request(url, data=corpo, method="POST", headers={
        "Authorization": f"Bearer {chave}",
        "apikey": chave,
        "Content-Type": tipo,
        "Cache-Control": f"max-age={cache}",
        "x-upsert": "true",
    })
    with urllib.request.urlopen(pedido, timeout=1800) as resposta:
        resposta.read()


def main() -> None:
    carregar_env()
    args = argparse.ArgumentParser()
    args.add_argument("--enviar", action="store_true")
    opcoes = args.parse_args()

    catalogo = montar_catalogo()
    publicados = {v["id"] for v in catalogo["videos"]}
    arquivos = [
        arquivo
        for idioma in IDIOMAS
        for arquivo in sorted((FINAL / idioma).glob("*"))
        if arquivo.suffix in (".mp4", ".vtt", ".jpg") and arquivo.stem in publicados
    ]
    total = sum(a.stat().st_size for a in arquivos)
    print(f"{len(catalogo['videos'])} vídeos, {len(arquivos)} arquivos, {total / 1e6:.1f} MB")
    if not opcoes.enviar:
        return
    for arquivo in arquivos:
        caminho = f"{arquivo.parent.name}/{arquivo.name}"
        enviar(caminho, arquivo.read_bytes(), TIPOS[arquivo.suffix], "3600")
        print("ok", caminho)
    # Cache curto: é este arquivo que anuncia vídeo novo.
    enviar("catalogo.json", json.dumps(catalogo, ensure_ascii=False).encode("utf-8"), TIPOS[".json"], "60")
    print("catálogo publicado")


if __name__ == "__main__":
    main()
