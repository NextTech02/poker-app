-- ============================================================================
-- Outras receitas da etapa — completa o outro lado do DRE
-- ----------------------------------------------------------------------------
-- Ate aqui a receita do DRE era so entrada de torneio (buy-in/rebuy/addon). Um
-- clube fatura tambem bar/cozinha, patrocinio, aluguel de espaco e venda de
-- produtos — dinheiro real que ficava de fora do resultado.
--
-- Tabela propria (e nao um "valor negativo" em `expenses`): o sentido no caixa e
-- oposto (credita em vez de debitar) e misturar os dois faria toda consulta
-- precisar lembrar do sinal.
--
-- `source` e texto livre com sugestoes na UI, em vez de um catalogo com tabela
-- propria: sao poucas origens e estaveis — nao compensa a maquinaria de um
-- segundo cadastro para o cliente manter.
-- ============================================================================

create table if not exists public.other_revenues (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  stage_id          uuid not null references public.stages(id) on delete cascade,
  tournament_id     uuid references public.tournaments(id) on delete set null,
  source            text not null default 'Outros',
  description       text not null,
  amount            numeric(12,2) not null check (amount > 0),
  status            text not null default 'pendente' check (status in ('pendente','recebido')),
  received_at       timestamptz,
  payment_method    text,
  -- Espelha `expenses.paid_from_cash`: false = caiu direto no banco, nao entra
  -- no caixa geral.
  to_cash           boolean not null default true,
  notes             text,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_other_revenues_stage on public.other_revenues(stage_id, status);
create index if not exists idx_other_revenues_org   on public.other_revenues(organization_id, created_at desc);

alter table public.other_revenues enable row level security;
drop policy if exists other_revenues_org_isolation on public.other_revenues;
create policy other_revenues_org_isolation on public.other_revenues for all
  using ((organization_id = (select current_org_id())) or (select is_platform_admin()))
  with check ((organization_id = (select current_org_id())) or (select is_platform_admin()));

-- Recebimento credita o caixa geral. Mesma estrutura do `expense_set_status`:
-- atomico (usa o valor da coluna) e idempotente (compara com o status atual).
create or replace function public.revenue_set_status(
  p_org uuid,
  p_revenue uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  r public.other_revenues%rowtype;
  v_delta numeric := 0;
  v_balance numeric;
begin
  if p_status not in ('pendente', 'recebido') then
    raise exception 'RECEITA: Status invalido.';
  end if;

  select * into r from public.other_revenues
   where id = p_revenue and organization_id = p_org
   for update;

  if not found then
    raise exception 'RECEITA: Receita nao encontrada.';
  end if;

  if r.status = p_status then
    return jsonb_build_object('id', r.id, 'status', r.status, 'changed', false);
  end if;

  -- Sinal invertido em relacao a despesa: receber ENTRA no caixa.
  if r.to_cash then
    v_delta := case when p_status = 'recebido' then r.amount else -r.amount end;
  end if;

  update public.other_revenues
     set status = p_status,
         received_at = case when p_status = 'recebido' then now() else null end,
         updated_at = now()
   where id = p_revenue;

  if v_delta <> 0 then
    update public.general_cash_register
       set current_balance = current_balance + v_delta,
           total_received = total_received + greatest(v_delta, 0),
           updated_at = now()
     where organization_id = p_org
     returning current_balance into v_balance;
  end if;

  return jsonb_build_object(
    'id', r.id, 'status', p_status, 'changed', true,
    'cash_delta', v_delta, 'cash_balance', v_balance
  );
end $function$;

-- A tabela referencia `stages`, apagada antes de `organizations` na exclusao —
-- precisa entrar na lista, senao a exclusao da organizacao quebra.
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
        'expenses','expense_categories','other_revenues',
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
