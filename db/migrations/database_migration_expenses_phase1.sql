-- ============================================================================
-- Despesas da etapa — Fase 1 (núcleo do DRE)
-- ----------------------------------------------------------------------------
-- Hoje o DRE nao subtrai despesa nenhuma (`net_result = gross_revenue - prizes`),
-- entao o cliente nao consegue fechar o resultado da etapa. Este modulo registra
-- os gastos e passa a alimentar o DRE.
--
-- Ancora: a ETAPA (stage). Torneio e dia sao opcionais, para quem quiser saber o
-- custo de um torneio especifico sem perder o fechamento da etapa.
--
-- `paid_from_cash` ja nasce aqui (default true) para a Fase 2, quando marcar
-- como pago passar a debitar o caixa geral — assim nao havera migracao nova.
-- ============================================================================

-- 1) Catálogo de categorias (por organização) --------------------------------
create table if not exists public.expense_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  name            text not null,
  kind            text not null default 'variavel' check (kind in ('fixo','variavel')),
  active          boolean not null default true,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists idx_expense_categories_org on public.expense_categories(organization_id, active);

-- 2) Lançamentos --------------------------------------------------------------
create table if not exists public.expenses (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  -- Âncora do DRE. Apagar a etapa leva as despesas dela junto.
  stage_id          uuid not null references public.stages(id) on delete cascade,
  -- Atribuição opcional: custo de um torneio/dia específico dentro da etapa.
  tournament_id     uuid references public.tournaments(id) on delete set null,
  tournament_day_id uuid references public.tournament_days(id) on delete set null,
  -- Categoria some sem levar o lançamento: o histórico financeiro é preservado.
  category_id       uuid references public.expense_categories(id) on delete set null,
  description       text not null,
  supplier          text,
  amount            numeric(12,2) not null check (amount > 0),
  status            text not null default 'pendente' check (status in ('pendente','pago')),
  due_date          date,
  paid_at           timestamptz,
  payment_method    text,
  -- Fase 2: false = pago por fora (banco), não movimenta o caixa geral.
  paid_from_cash    boolean not null default true,
  notes             text,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_expenses_stage    on public.expenses(stage_id, status);
create index if not exists idx_expenses_org      on public.expenses(organization_id, created_at desc);
create index if not exists idx_expenses_category on public.expenses(category_id);

-- 3) RLS (mesmo padrão do restante) ------------------------------------------
do $$
declare tbl text;
begin
  foreach tbl in array array['expense_categories','expenses'] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists %I on public.%I', tbl||'_org_isolation', tbl);
    execute format($f$create policy %I on public.%I for all
      using ((organization_id = (select current_org_id())) or (select is_platform_admin()))
      with check ((organization_id = (select current_org_id())) or (select is_platform_admin()))$f$,
      tbl||'_org_isolation', tbl);
  end loop;
end $$;

-- 4) Categorias padrão para as organizações existentes ------------------------
insert into public.expense_categories (organization_id, name, kind, sort_order)
select o.id, v.name, v.kind, v.ord
from public.organizations o
cross join (values
  ('Aluguel do espaço', 'fixo',     1),
  ('Dealers',           'variavel', 2),
  ('Equipe de apoio',   'variavel', 3),
  ('Alimentação',       'variavel', 4),
  ('Marketing',         'variavel', 5),
  ('Material',          'variavel', 6),
  ('Estrutura',         'variavel', 7),
  ('Taxas e impostos',  'variavel', 8),
  ('Outros',            'variavel', 9)
) as v(name, kind, ord)
where not exists (
  select 1 from public.expense_categories c
  where c.organization_id = o.id and c.name = v.name
);

-- 5) Auto-seed em organização nova -------------------------------------------
create or replace function public.expense_seed_new_org()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.expense_categories (organization_id, name, kind, sort_order) values
    (NEW.id, 'Aluguel do espaço', 'fixo',     1),
    (NEW.id, 'Dealers',           'variavel', 2),
    (NEW.id, 'Equipe de apoio',   'variavel', 3),
    (NEW.id, 'Alimentação',       'variavel', 4),
    (NEW.id, 'Marketing',         'variavel', 5),
    (NEW.id, 'Material',          'variavel', 6),
    (NEW.id, 'Estrutura',         'variavel', 7),
    (NEW.id, 'Taxas e impostos',  'variavel', 8),
    (NEW.id, 'Outros',            'variavel', 9);
  return NEW;
end $$;

drop trigger if exists trg_expense_seed_new_org on public.organizations;
create trigger trg_expense_seed_new_org after insert on public.organizations
  for each row execute function public.expense_seed_new_org();

-- 6) Exclusão de organização precisa conhecer as tabelas novas ----------------
-- `expenses` referencia `stages`, que é apagada ANTES de `organizations` — sem
-- entrar na lista, a exclusão quebraria (mesmo problema já visto na fidelidade).
create or replace function public.delete_organization(p_org uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
    v_status text;
    v_name   text;
    v_t      text;
    v_del    jsonb := '{}'::jsonb;
    v_n      bigint;
    v_users  uuid[];
    v_u      uuid;
    v_removed int := 0;
    v_order  text[] := ARRAY[
        'cashbox_transactions','prize_allocations','transactions','seat_allocations',
        'credit_transactions','chip_consignment_sales','satellite_tickets',
        'tournament_players','blinds','tournament_tables','tournament_days',
        'expenses','expense_categories',
        'tournaments','player_credits','chip_consignments','staff_payments',
        'cashbox_sessions','cashboxes','stage_cash_register','sangria_transactions',
        'blind_templates','buy_types','stages',
        'loyalty_ledger','loyalty_redemptions','loyalty_coupon_redemptions',
        'loyalty_goal_claims','loyalty_birthday_grants','loyalty_accounts',
        'loyalty_rewards','loyalty_coupons','loyalty_goals','loyalty_tiers',
        'loyalty_settings',
        'players','sponsors','staff',
        'permission_groups','payment_methods','app_settings','general_cash_register',
        'rake_register','sync_mutations'
    ];
BEGIN
    SELECT status, name INTO v_status, v_name FROM public.organizations WHERE id = p_org;
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'Organizacao nao encontrada.';
    END IF;
    IF v_status = 'active' THEN
        RAISE EXCEPTION 'Suspenda a organizacao antes de exclui-la.';
    END IF;

    SELECT COALESCE(array_agg(DISTINCT auth_user_id), '{}'::uuid[])
      INTO v_users
      FROM public.staff
     WHERE organization_id = p_org AND auth_user_id IS NOT NULL;

    BEGIN
        EXECUTE 'UPDATE public.cashboxes SET current_session_id = NULL WHERE organization_id = $1' USING p_org;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;

    BEGIN
        EXECUTE 'UPDATE public.tournament_days SET qualifies_to_day_id = NULL WHERE organization_id = $1' USING p_org;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;

    FOREACH v_t IN ARRAY v_order LOOP
        BEGIN
            EXECUTE format('DELETE FROM public.%I WHERE organization_id = $1', v_t) USING p_org;
            GET DIAGNOSTICS v_n = ROW_COUNT;
            IF v_n > 0 THEN
                v_del := v_del || jsonb_build_object(v_t, v_n);
            END IF;
        EXCEPTION WHEN undefined_table THEN NULL;
        END;
    END LOOP;

    DELETE FROM public.organizations WHERE id = p_org;

    FOREACH v_u IN ARRAY v_users LOOP
        CONTINUE WHEN EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = v_u);
        CONTINUE WHEN EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.auth_user_id = v_u);
        BEGIN
            DELETE FROM auth.users WHERE id = v_u;
            v_removed := v_removed + 1;
        EXCEPTION WHEN others THEN
            NULL;
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'organization', v_name,
        'deleted', v_del,
        'accounts_removed', v_removed
    );
END $function$;
