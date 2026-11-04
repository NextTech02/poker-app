"""Tira as imagens do telão de DENTRO do dia de torneio e põe no Storage.

Até a biblioteca de fundos (e, para a logo do clube, até 2026-11), a imagem
era gravada como `data:` URL em base64 na própria linha de `tournament_days`.
O dia é lido a cada 3 s pelo relógio de cada tela aberta, então uma logo de
400 KB (houve fundo de 2 MB) viajava do Supabase em TODA leitura.

Este script sobe cada imagem embutida para o bucket público
`broadcast-backgrounds` e troca o campo pelo link público. A mesma imagem
repetida em vários dias (o caso comum: a logo do clube) sobe UMA vez — o
caminho é o hash do conteúdo, o que também torna o script seguro de rodar de
novo. Fundos entram na biblioteca do clube, para aparecerem na galeria; a logo
não (é por dia, não um item para escolher).

ORDEM no deploy: rodar ANTES de subir o backend que recusa `data:` URL — senão
salvar a configuração do telão de um dia ainda não migrado é recusado.

Roda de dentro de backend/:
    venv\\Scripts\\python.exe scripts\\migrar_imagens_do_telao.py            (só mostra)
    venv\\Scripts\\python.exe scripts\\migrar_imagens_do_telao.py --aplicar  (grava)
"""
import argparse
import base64
import binascii
import datetime as dt
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.getcwd())

from app.database.supabase_client import supabase_admin  # noqa: E402

BUCKET = "broadcast-backgrounds"
# Campo -> pasta no bucket e se entra na biblioteca de fundos do clube.
CAMPOS = {
    "broadcast_bg_image_url": ("legado", True),
    "broadcast_break_bg_image_url": ("legado", True),
    "broadcast_promo_url": ("legado", True),
    "broadcast_club_logo_url": ("logo", False),
}
# Os tipos que o bucket aceita (allowed_mime_types).
EXTENSOES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
DATA_URL = re.compile(r"^data:([\w/+.-]+);base64,(.*)$", re.S)


def decodificar(valor):
    """`data:<tipo>;base64,<dados>` -> (tipo, bytes). None se não der para usar."""
    m = DATA_URL.match(valor.strip())
    if not m:
        return None
    tipo = m.group(1).lower()
    if tipo not in EXTENSOES:
        return None
    try:
        return tipo, base64.b64decode(m.group(2), validate=False)
    except (binascii.Error, ValueError):
        return None


def link_publico(caminho):
    # storage3 às vezes devolve a URL com um "?" sobrando no fim.
    return supabase_admin.storage.from_(BUCKET).get_public_url(caminho).rstrip("?")


def dias_com_imagem_embutida():
    """Dias com pelo menos um campo `data:` — por campo, para não puxar a tabela toda."""
    por_id = {}
    for campo in CAMPOS:
        linhas = (
            supabase_admin.table("tournament_days")
            .select(f"id, organization_id, day_name, {campo}")
            .like(campo, "data:*")
            .execute()
            .data
            or []
        )
        for linha in linhas:
            dia = por_id.setdefault(linha["id"], {
                "id": linha["id"], "organization_id": linha["organization_id"],
                "day_name": linha.get("day_name"), "campos": {},
            })
            dia["campos"][campo] = linha[campo]
    return list(por_id.values())


def na_biblioteca(org, caminho):
    r = (
        supabase_admin.table("broadcast_backgrounds")
        .select("id").eq("organization_id", org).eq("path", caminho).limit(1).execute()
    )
    return bool(r.data)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--aplicar", action="store_true", help="grava de verdade (sem isto, só mostra)")
    args = parser.parse_args()

    dias = dias_com_imagem_embutida()
    if not dias:
        print("Nenhum dia com imagem embutida. Nada a fazer.")
        return

    if args.aplicar:
        # Volta possível: o valor original de cada campo fica num arquivo local
        # ANTES de qualquer escrita. Não versionar (tem as imagens dos clubes).
        copia = f"backup_imagens_do_telao_{dt.datetime.now():%Y%m%d_%H%M%S}.json"
        with open(copia, "w", encoding="utf-8") as f:
            json.dump({d["id"]: d["campos"] for d in dias}, f)
        print(f"Cópia dos valores originais: {os.path.abspath(copia)}\n")

    enviados = {}   # caminho -> link (cada imagem sobe uma vez)
    bytes_antes = 0
    pulados = []
    print(f"{len(dias)} dia(s) com imagem embutida{'' if args.aplicar else ' (simulação: nada é gravado)'}\n")

    for dia in dias:
        org = dia["organization_id"]
        novos = {}
        for campo, valor in dia["campos"].items():
            bytes_antes += len(valor)
            lida = decodificar(valor)
            if not lida:
                pulados.append((dia["id"], campo))
                continue
            tipo, dados = lida
            pasta, biblioteca = CAMPOS[campo]
            caminho = f"{org}/{pasta}/{hashlib.sha256(dados).hexdigest()[:24]}.{EXTENSOES[tipo]}"

            if caminho not in enviados:
                if args.aplicar:
                    supabase_admin.storage.from_(BUCKET).upload(
                        caminho, dados, {"content-type": tipo, "upsert": "true"}
                    )
                    if biblioteca and not na_biblioteca(org, caminho):
                        supabase_admin.table("broadcast_backgrounds").insert({
                            "organization_id": org, "path": caminho, "name": "Fundo importado",
                            "content_type": tipo, "size_bytes": len(dados),
                        }).execute()
                enviados[caminho] = link_publico(caminho)
                print(f"  imagem {caminho}  ({len(dados) // 1024} KB)")
            novos[campo] = enviados[caminho]

        if novos:
            if args.aplicar:
                supabase_admin.table("tournament_days").update(novos).eq("id", dia["id"]).execute()
            print(f"  dia {dia['id']}  {dia['day_name']!r}: {', '.join(novos)}")

    print(f"\n{len(enviados)} imagem(ns) distinta(s); {bytes_antes // 1024} KB de base64 saem das linhas dos dias.")
    if pulados:
        print(f"ATENÇÃO: {len(pulados)} campo(s) com formato não reconhecido ficaram como estavam: {pulados}")
    if not args.aplicar:
        print("\nSimulação. Para gravar: acrescente --aplicar")


if __name__ == "__main__":
    main()
