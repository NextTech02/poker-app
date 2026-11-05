#!/usr/bin/env bash
# Cópia do banco ANTIGO (só leitura). Comandos do guia oficial:
# supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
#
#   bash 2_dump.sh
#
# Gera em dump/: roles.sql, schema.sql, data.sql, o histórico de migrações
# (history_*.sql), o pos_restore.sql (regras dos buckets, Realtime e jobs, ver
# gerar_pos_restore.sql) e a conferência do antigo (conferencia_antigo.txt).
#
# Precisa do Supabase CLI e do Docker (o CLI roda o pg_dump num container).
# 30 MB de banco: um ou dois minutos.
source "$(dirname "${BASH_SOURCE[0]}")/comum.sh"
exigir OLD_DB_URL

mkdir -p dump
cd dump
cp "$AQUI/gerar_pos_restore.sql" "$AQUI/conferir.sql" .

echo "==> roles"
supabase db dump --db-url "$OLD_DB_URL" -f roles.sql --role-only
echo "==> schema"
supabase db dump --db-url "$OLD_DB_URL" -f schema.sql
echo "==> dados"
supabase db dump --db-url "$OLD_DB_URL" -f data.sql --use-copy --data-only \
  -x "storage.buckets_vectors" -x "storage.vector_indexes"
echo "==> histórico de migrações (137 registradas)"
supabase db dump --db-url "$OLD_DB_URL" -f history_schema.sql --schema supabase_migrations
supabase db dump --db-url "$OLD_DB_URL" -f history_data.sql --use-copy --data-only --schema supabase_migrations

echo "==> o que o restore não traz (buckets, Realtime, jobs)"
psql17 "$OLD_DB_URL" -At -f gerar_pos_restore.sql > pos_restore.sql
echo "==> conferência do antigo"
psql17 "$OLD_DB_URL" -At -f conferir.sql > conferencia_antigo.txt

ls -la
echo
echo "Pronto. Próximo passo: bash 3_restaurar.sh (no projeto NOVO)."
