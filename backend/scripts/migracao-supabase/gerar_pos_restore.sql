-- Gera, a partir do projeto ANTIGO, o SQL que o restore do banco não traz.
--
-- Rodado contra o banco antigo na hora do dump (2_dump.sh), para sair sempre
-- com o estado do dia — e não com uma cópia escrita à mão que envelhece:
--
--   psql "$OLD_DB_URL" -At -f gerar_pos_restore.sql > pos_restore.sql
--
-- O que o restore (roles + schema + data) NÃO recria, segundo o guia oficial
-- (supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore):
--   1. políticas RLS dos schemas gerenciados (`storage`) — as dos buckets;
--   2. a publicação do Realtime (quais tabelas avisam a tela);
--   3. os jobs do pg_cron (por nome: rodar de novo só atualiza o mesmo job).
--
-- Tudo idempotente, para o ensaio e a virada poderem rodar mais de uma vez.

\echo '-- Gerado por gerar_pos_restore.sql a partir do projeto antigo.'
\echo 'begin;'

-- 1. Políticas dos buckets (storage.objects / storage.buckets).
\echo '-- 1. Políticas do storage'
select format(
  'drop policy if exists %I on storage.%I; create policy %I on storage.%I as %s for %s to %s%s%s;',
  policyname, tablename, policyname, tablename, lower(permissive), cmd,
  array_to_string(array(
    select case when r = 'public' then 'public' else quote_ident(r) end from unnest(roles) r
  ), ', '),
  case when qual is not null then ' using (' || qual || ')' else '' end,
  case when with_check is not null then ' with check (' || with_check || ')' else '' end
)
from pg_policies
where schemaname = 'storage'
order by tablename, policyname;

-- 2. Publicação do Realtime. A do projeto novo já existe (vazia); `set table`
-- deixa exatamente a lista do antigo.
\echo '-- 2. Tabelas do Realtime'
select 'alter publication supabase_realtime set table '
       || string_agg(format('%I.%I', schemaname, tablename), ', ' order by tablename) || ';'
from pg_publication_tables
where pubname = 'supabase_realtime';

-- 3. Jobs agendados (pg_cron precisa estar HABILITADO no projeto novo antes).
\echo '-- 3. Jobs do pg_cron'
select format('select cron.schedule(%L, %L, %L);', jobname, schedule, command)
from cron.job
order by jobname;

\echo 'commit;'
