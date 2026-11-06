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
--   3. os jobs do pg_cron (por nome: rodar de novo só atualiza o mesmo job);
--   4. as permissões REVOGADAS de propósito (ver o item 4 abaixo).
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

-- 4. Permissões dos objetos do public. O projeto novo dá a anon,
-- authenticated e service_role acesso PADRÃO a cada tabela e função que o
-- restore cria, e o dump não leva as revogações feitas no antigo. No ensaio de
-- 2026-11-05 voltaram assim anon/authenticated em delete_organization,
-- set_active_organization, list_my_organizations, custom_access_token_hook e
-- na tabela activity_logs. Aqui cada objeto fica, para esses papéis, exatamente
-- como no antigo (o dono, postgres, não muda).
\echo '-- 4. Permissões (iguais às do antigo)'
with objetos as (
  select case c.relkind when 'S' then 'sequence' else 'table' end as tipo,
         format('public.%I', c.relname) as nome,
         coalesce(c.relacl, acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner)) as acl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
  union all
  select 'routine', format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)),
         coalesce(p.proacl, acldefault('f', p.proowner))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
)
select format('revoke all on %s %s from public, anon, authenticated, service_role, supabase_auth_admin;',
              o.tipo, o.nome)
       || coalesce((
            select string_agg(format(' grant %s on %s %s to %s;', g.privs, o.tipo, o.nome, g.papel),
                              '' order by g.papel)
            from (
              select case when e.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(e.grantee)) end as papel,
                     string_agg(e.privilege_type, ', ' order by e.privilege_type) as privs
              from aclexplode(o.acl) e
              where e.grantee = 0
                 or pg_get_userbyid(e.grantee) in ('anon', 'authenticated', 'service_role', 'supabase_auth_admin')
              group by 1
            ) g), '')
from objetos o
order by o.tipo, o.nome;

\echo 'commit;'
