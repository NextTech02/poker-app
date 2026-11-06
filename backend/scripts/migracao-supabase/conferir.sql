-- Conferência da cópia: rode no projeto ANTIGO e no NOVO e compare as saídas.
--
--   psql "$OLD_DB_URL" -At -f conferir.sql > conferencia_antigo.txt
--   psql "$NEW_DB_URL" -At -f conferir.sql > conferencia_novo.txt
--   diff conferencia_antigo.txt conferencia_novo.txt && echo "IGUAIS"
--
-- Precisa sair IDÊNTICO (5_conferir.sh faz isso). Linhas por tabela pegam
-- tabela que não veio; as somas pegam dinheiro que não veio; o resto pega o
-- que o restore não traz sozinho (usuários, arquivos, jobs, Realtime, regras
-- dos buckets, permissões revogadas). Rodar com o sistema PARADO (na virada),
-- senão uma venda entre as duas rodadas aparece como diferença.
-- Ordem em collate "C": não depende da versão do ICU de cada projeto.

with tabelas as (
  select table_name
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
),
permissoes as (
  -- Permissões de cada tabela, sequência e função do public. O restore NÃO
  -- leva as revogações (item 4 de gerar_pos_restore.sql); aqui se vê se o
  -- pos_restore.sql as refez. Os objetos sem anon saem um por linha, para o
  -- diff dizer qual.
  select x.objeto,
         (select string_agg(a::text, ',' order by a::text collate "C") from unnest(x.acl) a) as acl
  from (
    select 'tabela ' || c.relname as objeto,
           coalesce(c.relacl, acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner)) as acl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
    union all
    select 'funcao ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           coalesce(p.proacl, acldefault('f', p.proowner))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  ) x
)
select linha from (
select 'linhas ' || table_name || ' = '
       || (xpath('/row/c/text()', query_to_xml(
            format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text as linha
from tabelas
union all select 'soma transactions.amount = ' || coalesce(sum(amount), 0)::text from public.transactions
union all select 'soma cashbox_transactions.signed_amount = ' || coalesce(sum(signed_amount), 0)::text from public.cashbox_transactions
union all select 'soma cash_transactions.amount = ' || coalesce(sum(amount), 0)::text from public.cash_transactions
union all select 'soma bar_tab_payments.amount = ' || coalesce(sum(amount), 0)::text from public.bar_tab_payments
union all select 'soma house_credit_entries.amount = ' || coalesce(sum(amount), 0)::text from public.house_credit_entries
union all select 'auth.users = ' || count(*) from auth.users
union all select 'auth.identities = ' || count(*) from auth.identities
union all select 'auth.mfa_factors = ' || count(*) from auth.mfa_factors
union all select 'storage.buckets = ' || string_agg(id || case when public then ':publico' else ':privado' end, ',' order by id) from storage.buckets
union all select 'storage.objects = ' || count(*) from storage.objects
union all select 'politicas do storage = ' || count(*) from pg_policies where schemaname = 'storage'
union all select 'tabelas no realtime = ' || count(*) from pg_publication_tables where pubname = 'supabase_realtime'
union all select 'jobs do cron = ' || string_agg(jobname || ' ' || schedule, ', ' order by jobname) from cron.job
union all select 'funcao do hook de login = ' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'custom_access_token_hook'
union all select 'permissoes do public (hash de ' || count(*) || ' objetos) = '
                 || md5(string_agg(objeto || ' ' || acl, ';' order by objeto collate "C")) from permissoes
union all select 'permissao sem anon: ' || objeto || ' = ' || acl from permissoes where acl not like '%anon=%'
) conferencia
order by linha collate "C";
