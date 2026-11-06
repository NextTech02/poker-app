#!/usr/bin/env bash
# Compara o projeto NOVO com o ANTIGO (contagem de linhas de cada tabela,
# somas de dinheiro, usuários, arquivos, jobs, Realtime, regras dos buckets).
#
#   bash 5_conferir.sh
#
# Usa a conferência do antigo salva no dump (dump/conferencia_antigo.txt).
# Na virada o sistema está PARADO desde o dump, então tem de sair idêntico.
source "$(dirname "${BASH_SOURCE[0]}")/comum.sh"
exigir NEW_DB_URL

cd dump
psql17 "$NEW_DB_URL" -At -f conferir.sql > conferencia_novo.txt

if diff -u conferencia_antigo.txt conferencia_novo.txt; then
  echo "IGUAIS: $(wc -l < conferencia_novo.txt) itens conferidos."
else
  echo
  echo "DIFERENTE (acima, '-' é o antigo e '+' é o novo). Não troque o .env da VPS." >&2
  exit 1
fi
