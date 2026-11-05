"""Copia os ARQUIVOS do Storage do projeto antigo para o novo.

O restore do banco traz os buckets e o registro de cada arquivo
(storage.objects), mas não o arquivo em si — ele mora no S3 do projeto. Este
script lista os buckets do antigo pasta por pasta, baixa cada arquivo e o sobe
no novo no MESMO caminho (com upsert), então os caminhos gravados no banco
(`broadcast_backgrounds.path`, `ticket_logo_path`, comprovantes) continuam
valendo. É o equivalente em Python do script do guia oficial
(supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

Variáveis de ambiente (ver variaveis.env.exemplo):
    OLD_URL, OLD_SERVICE_KEY, NEW_URL, NEW_SERVICE_KEY

Uso (dentro do container do backend, que já tem o httpx):
    python scripts/migracao-supabase/copiar_storage.py --somente-listar
    python scripts/migracao-supabase/copiar_storage.py

Idempotente: rodar de novo sobrescreve com o mesmo conteúdo.
"""
import argparse
import os
import sys

import httpx

PAGINA = 1000


def _cabecalhos(chave: str) -> dict:
    # Chave nova (sb_secret_...) vai SÓ no apikey — o gateway troca por um JWT.
    # A antiga (service_role, um JWT) vai também no Authorization.
    h = {"apikey": chave}
    if chave.count(".") == 2:
        h["Authorization"] = f"Bearer {chave}"
    return h


def listar(cliente: httpx.Client, url: str, chave: str, bucket: str, prefixo: str = "") -> list:
    """Todos os arquivos do bucket, descendo nas pastas: [(caminho, mimetype)]."""
    arquivos = []
    inicio = 0
    while True:
        r = cliente.post(
            f"{url}/storage/v1/object/list/{bucket}",
            headers=_cabecalhos(chave),
            json={"prefix": prefixo, "limit": PAGINA, "offset": inicio,
                  "sortBy": {"column": "name", "order": "asc"}},
        )
        r.raise_for_status()
        itens = r.json()
        for item in itens:
            caminho = f"{prefixo}/{item['name']}" if prefixo else item["name"]
            if item.get("id") is None:          # pasta: desce nela
                arquivos.extend(listar(cliente, url, chave, bucket, caminho))
            else:
                tipo = (item.get("metadata") or {}).get("mimetype") or "application/octet-stream"
                arquivos.append((caminho, tipo))
        if len(itens) < PAGINA:
            return arquivos
        inicio += PAGINA


def buckets(cliente: httpx.Client, url: str, chave: str) -> list:
    r = cliente.get(f"{url}/storage/v1/bucket", headers=_cabecalhos(chave))
    r.raise_for_status()
    return [b["id"] for b in r.json()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--somente-listar", action="store_true",
                        help="só lista o que há no antigo (não precisa do projeto novo)")
    args = parser.parse_args()

    old_url, old_key = os.environ["OLD_URL"].rstrip("/"), os.environ["OLD_SERVICE_KEY"]
    with httpx.Client(timeout=60) as cliente:
        total = 0
        plano = []
        for bucket in buckets(cliente, old_url, old_key):
            arquivos = listar(cliente, old_url, old_key, bucket)
            print(f"{bucket}: {len(arquivos)} arquivo(s)")
            plano.extend((bucket, caminho, tipo) for caminho, tipo in arquivos)
        if args.somente_listar:
            return 0

        new_url, new_key = os.environ["NEW_URL"].rstrip("/"), os.environ["NEW_SERVICE_KEY"]
        falhas = []
        for bucket, caminho, tipo in plano:
            baixado = cliente.get(f"{old_url}/storage/v1/object/{bucket}/{caminho}",
                                  headers=_cabecalhos(old_key))
            if baixado.status_code != 200:
                falhas.append((bucket, caminho, f"download {baixado.status_code}"))
                continue
            subido = cliente.post(
                f"{new_url}/storage/v1/object/{bucket}/{caminho}",
                headers={**_cabecalhos(new_key), "Content-Type": tipo, "x-upsert": "true"},
                content=baixado.content,
            )
            if subido.status_code not in (200, 201):
                falhas.append((bucket, caminho, f"upload {subido.status_code}: {subido.text[:120]}"))
                continue
            total += 1
        print(f"\n{total} de {len(plano)} arquivo(s) copiados.")
        for f in falhas:
            print("FALHOU:", *f)
        return 1 if falhas else 0


if __name__ == "__main__":
    sys.exit(main())
