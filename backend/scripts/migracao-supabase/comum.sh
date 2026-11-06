# Carregado pelos scripts da migração (não rodar sozinho).
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f variaveis.env ]; then
  echo "Falta variaveis.env nesta pasta (copie de $AQUI/variaveis.env.exemplo)." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./variaveis.env
set +a

# psql 17 (o banco é Postgres 17). Usa o instalado, se for 17+; senão roda o da
# imagem oficial no Docker — a VPS já tem Docker, e assim não é preciso
# instalar nada. A pasta atual vai montada em /w para os arquivos .sql.
psql17() {
  if command -v psql >/dev/null 2>&1 && psql --version | grep -Eq ' (1[7-9]|[2-9][0-9])\.'; then
    psql "$@"
  else
    docker run --rm -i -v "$PWD:/w" -w /w postgres:17 psql "$@"
  fi
}

exigir() {
  for nome in "$@"; do
    if [ -z "${!nome:-}" ]; then
      echo "Variável $nome vazia em variaveis.env" >&2
      exit 1
    fi
  done
}
