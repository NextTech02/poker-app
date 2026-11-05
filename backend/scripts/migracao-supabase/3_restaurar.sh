#!/usr/bin/env bash
# Restaura a cópia (dump/) no projeto NOVO — que precisa estar VAZIO (recém
# criado) e com o pg_cron habilitado (Database > Extensions).
#
#   bash 3_restaurar.sh
#
# Tudo numa transação só (como no guia oficial): se qualquer comando falhar,
# nada fica gravado e dá para corrigir e rodar de novo.
# `session_replication_role = replica` desliga os triggers durante a carga —
# senão cada venda copiada moveria o caixa de novo.
#
# Depois do restore:
#   - regras dos buckets, Realtime e jobs (pos_restore.sql);
#   - os links gravados com o endereço do projeto antigo (imagens do telão)
#     passam a apontar para o novo;
#   - uma varredura confirma que não sobrou nenhum link antigo.
source "$(dirname "${BASH_SOURCE[0]}")/comum.sh"
exigir NEW_DB_URL OLD_REF NEW_REF

cd dump

echo "==> banco (roles + schema + dados), numa transação"
psql17 --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql \
  --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql \
  --dbname "$NEW_DB_URL"

echo "==> histórico de migrações"
psql17 --single-transaction --variable ON_ERROR_STOP=1 \
  --file history_schema.sql --file history_data.sql --dbname "$NEW_DB_URL"

echo "==> regras dos buckets, Realtime e jobs"
psql17 --variable ON_ERROR_STOP=1 --file pos_restore.sql --dbname "$NEW_DB_URL"

echo "==> links com o endereço do projeto antigo -> novo"
psql17 --variable ON_ERROR_STOP=1 --dbname "$NEW_DB_URL" \
  -v antigo="$OLD_REF" -v novo="$NEW_REF" <<'SQL'
begin;
update public.tournament_days set
  broadcast_bg_image_url       = replace(broadcast_bg_image_url,       :'antigo', :'novo'),
  broadcast_break_bg_image_url = replace(broadcast_break_bg_image_url, :'antigo', :'novo'),
  broadcast_club_logo_url      = replace(broadcast_club_logo_url,      :'antigo', :'novo'),
  broadcast_promo_url          = replace(broadcast_promo_url,          :'antigo', :'novo')
where concat_ws(' ', broadcast_bg_image_url, broadcast_break_bg_image_url,
                broadcast_club_logo_url, broadcast_promo_url) like '%' || :'antigo' || '%';
commit;
SQL

echo "==> varredura: nenhum texto do banco pode citar o projeto antigo"
restantes=$(psql17 -At --dbname "$NEW_DB_URL" -v antigo="$OLD_REF" <<'SQL'
select coalesce(string_agg(table_name || '.' || column_name || ' (' || n || ')', ', '), 'nenhum')
from (
  select c.table_name, c.column_name,
    (xpath('/row/c/text()', query_to_xml(format(
      'select count(*) as c from public.%I where %I::text like %L',
      c.table_name, c.column_name, '%' || :'antigo' || '%'), false, true, '')))[1]::text::int as n
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
  where c.table_schema = 'public' and c.data_type in ('text', 'character varying', 'jsonb', 'json')
) x where n > 0;
SQL
)
echo "   links antigos restantes: $restantes"
if [ "$restantes" != "nenhum" ]; then
  echo "ATENÇÃO: ainda há texto citando o projeto antigo — corrigir antes de seguir." >&2
  exit 1
fi

echo
echo "Pronto. Próximos: bash 1_config.sh aplicar  ->  copiar_storage.py  ->  bash 5_conferir.sh"
