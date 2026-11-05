#!/usr/bin/env bash
# Copia os arquivos do Storage (antigo -> novo) rodando copiar_storage.py num
# container AVULSO da imagem do backend na VPS (ela já tem Python e httpx).
#
#   bash 4_copiar_storage.sh                  # copia
#   bash 4_copiar_storage.sh --somente-listar # só lista o que há no antigo
#
# `run --rm` e não `exec`: na virada o backend está PARADO (para nenhuma venda
# cair no projeto antigo depois do dump), e subir o serviço só para copiar
# arquivos reabriria o sistema apontando para Oregon. O container avulso roda
# só o script, sem o servidor da API e sem porta publicada.
source "$(dirname "${BASH_SOURCE[0]}")/comum.sh"
exigir OLD_URL OLD_SERVICE_KEY

# backend/scripts/migracao-supabase -> raiz do repositório
REPO="$(cd "$AQUI/../../.." && pwd)"

if [ "${1:-}" != "--somente-listar" ]; then
  exigir NEW_URL NEW_SERVICE_KEY
fi

# `-e NOME` sem valor repassa a variável do ambiente atual (já carregada do
# variaveis.env) — as chaves não aparecem na linha de comando.
docker compose -f "$REPO/docker-compose.yml" run --rm -T --no-deps \
  -e OLD_URL -e OLD_SERVICE_KEY -e NEW_URL -e NEW_SERVICE_KEY \
  backend python scripts/migracao-supabase/copiar_storage.py "$@"
