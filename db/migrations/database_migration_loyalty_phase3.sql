-- ============================================================================
-- Programa de Fidelidade — Fase 3 (cupons + metas/desafios)
-- ----------------------------------------------------------------------------
-- Cupons: códigos promocionais (pontos ou crédito) com validade e limites.
-- Metas: desafios ("jogue 5 torneios no mês") com progresso calculado dos dados
--   e recompensa em pontos ao concluir (1 claim por período).
-- RPCs atômicos com prefixo de erro FIDELIDADE (mapeados a 400 no backend).
-- ============================================================================

-- 1) Cupons ------------------------------------------------------------------
create table if not exists public.loyalty_coupons (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  code              text not null,
  description       text,
  reward_type       text not null default 'points',   -- 'points' | 'credit'
  points_value      numeric(14,2) not null default 0,
  credit_value      numeric(14,2) not null default 0,
  usage_limit       int,                                -- null = ilimitado (total)
  per_player_limit  int not null default 1,
  used_count        int not null default 0,
  valid_from        timestamptz,
  valid_until       timestamptz,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (organization_id, code)
);

create table if not exists public.loyalty_coupon_redemptions (
  id          uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  coupon_id   uuid not null references public.loyalty_coupons(id) on delete cascade,
  player_id   uuid not null references public.players(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists idx_loyalty_coupon_red on public.loyalty_coupon_redemptions(coupon_id, player_id);

-- 2) Metas / desafios --------------------------------------------------------
create table if not exists public.loyalty_goals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  name            text not null,
  description     text,
  metric          text not null,                       -- 'tournaments' | 'entries' | 'amount_spent'
  target          numeric(14,2) not null,
  period          text not null default 'monthly',     -- 'monthly' | 'all_time'
  reward_points   numeric(14,2) not null default 0,
  active          boolean not null default true,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now()
);

create table if not exists public.loyalty_goal_claims (
  id          uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  goal_id     uuid not null references public.loyalty_goals(id) on delete cascade,
  player_id   uuid not null references public.players(id) on delete cascade,
  period_key  text not null,                            -- 'YYYY-MM' (monthly) | 'all'
  reward_points numeric(14,2) not null default 0,
  created_at  timestamptz not null default now(),
  unique (goal_id, player_id, period_key)
);

-- 3) RLS ---------------------------------------------------------------------
do $$
declare tbl text;
begin
  foreach tbl in array array['loyalty_coupons','loyalty_coupon_redemptions','loyalty_goals','loyalty_goal_claims'] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists %I on public.%I', tbl||'_org_isolation', tbl);
    execute format($f$create policy %I on public.%I for all
      using ((organization_id = (select current_org_id())) or (select is_platform_admin()))
      with check ((organization_id = (select current_org_id())) or (select is_platform_admin()))$f$,
      tbl||'_org_isolation', tbl);
  end loop;
end $$;

-- 4) Progresso de uma meta (calculado dos dados) -----------------------------
create or replace function public.loyalty_goal_current(p_org uuid, p_player uuid, p_goal uuid)
returns numeric language plpgsql stable security definer set search_path=public as $$
declare g public.loyalty_goals%rowtype; v_start timestamptz; v numeric;
begin
  select * into g from public.loyalty_goals where id=p_goal and organization_id=p_org;
  if not found then return 0; end if;
  v_start := case when g.period='monthly' then date_trunc('month', now()) else '-infinity'::timestamptz end;
  if g.metric = 'tournaments' then
    select count(distinct tournament_id) into v from public.tournament_players
     where player_id=p_player and organization_id=p_org and registered_at >= v_start;
  elsif g.metric = 'entries' then
    select count(*) into v from public.tournament_players
     where player_id=p_player and organization_id=p_org and registered_at >= v_start;
  elsif g.metric = 'amount_spent' then
    select coalesce(sum(total_spent),0) into v from public.tournament_players
     where player_id=p_player and organization_id=p_org and registered_at >= v_start;
  else
    v := 0;
  end if;
  return coalesce(v,0);
end $$;

-- 5) Resgatar cupom (atômico) ------------------------------------------------
create or replace function public.loyalty_redeem_coupon(p_org uuid, p_player uuid, p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.loyalty_coupons%rowtype; v_used_by_player int; v_bal numeric; v_sponsor uuid; v_credit uuid;
begin
  select * into c from public.loyalty_coupons
   where organization_id=p_org and upper(code)=upper(p_code) for update;
  if not found or not c.active then raise exception 'FIDELIDADE: Cupom invalido.'; end if;
  if c.valid_from is not null and now() < c.valid_from then raise exception 'FIDELIDADE: Cupom ainda nao vigente.'; end if;
  if c.valid_until is not null and now() > c.valid_until then raise exception 'FIDELIDADE: Cupom expirado.'; end if;
  if c.usage_limit is not null and c.used_count >= c.usage_limit then raise exception 'FIDELIDADE: Cupom esgotado.'; end if;

  select count(*) into v_used_by_player from public.loyalty_coupon_redemptions
   where coupon_id=c.id and player_id=p_player;
  if v_used_by_player >= c.per_player_limit then raise exception 'FIDELIDADE: Cupom ja utilizado por este jogador.'; end if;

  insert into public.loyalty_accounts (player_id, organization_id)
   values (p_player, p_org) on conflict (player_id) do nothing;

  if c.reward_type = 'points' and c.points_value > 0 then
    update public.loyalty_accounts
       set points_balance=points_balance+c.points_value, lifetime_points=lifetime_points+c.points_value, updated_at=now()
     where player_id=p_player returning points_balance into v_bal;
    update public.loyalty_accounts set tier_id=public.loyalty_tier_for(p_org,(select lifetime_points from public.loyalty_accounts where player_id=p_player))
     where player_id=p_player;
    insert into public.loyalty_ledger (organization_id, player_id, delta, balance_after, reason, description)
     values (p_org, p_player, c.points_value, v_bal, 'coupon', c.code);
  elsif c.reward_type = 'credit' and c.credit_value > 0 then
    select system_sponsor_id into v_sponsor from public.loyalty_settings where organization_id=p_org;
    if v_sponsor is null then raise exception 'FIDELIDADE: Programa nao configurado (sponsor).'; end if;
    insert into public.player_credits (player_id, sponsor_id, original_amount, remaining_amount, used_amount, status, sponsor_owes, notes, organization_id)
     values (p_player, v_sponsor, c.credit_value, c.credit_value, 0, 'active', 0, 'Cupom fidelidade: '||c.code, p_org)
     returning id into v_credit;
  end if;

  update public.loyalty_coupons set used_count=used_count+1 where id=c.id;
  insert into public.loyalty_coupon_redemptions (organization_id, coupon_id, player_id)
   values (p_org, c.id, p_player);

  return jsonb_build_object('code', c.code, 'reward_type', c.reward_type,
    'points_value', c.points_value, 'credit_value', c.credit_value, 'credit_id', v_credit);
end $$;

-- 6) Reivindicar meta concluída (atômico) ------------------------------------
create or replace function public.loyalty_claim_goal(p_org uuid, p_player uuid, p_goal uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare g public.loyalty_goals%rowtype; v_key text; v_prog numeric; v_bal numeric;
begin
  select * into g from public.loyalty_goals where id=p_goal and organization_id=p_org;
  if not found or not g.active then raise exception 'FIDELIDADE: Meta indisponivel.'; end if;

  v_key := case when g.period='monthly' then to_char(now(),'YYYY-MM') else 'all' end;
  if exists (select 1 from public.loyalty_goal_claims where goal_id=g.id and player_id=p_player and period_key=v_key) then
    raise exception 'FIDELIDADE: Meta ja reivindicada neste periodo.';
  end if;

  v_prog := public.loyalty_goal_current(p_org, p_player, p_goal);
  if v_prog < g.target then raise exception 'FIDELIDADE: Meta ainda nao concluida (% de %).', v_prog, g.target; end if;

  insert into public.loyalty_accounts (player_id, organization_id)
   values (p_player, p_org) on conflict (player_id) do nothing;
  update public.loyalty_accounts
     set points_balance=points_balance+g.reward_points, lifetime_points=lifetime_points+g.reward_points, updated_at=now()
   where player_id=p_player returning points_balance into v_bal;
  update public.loyalty_accounts set tier_id=public.loyalty_tier_for(p_org,(select lifetime_points from public.loyalty_accounts where player_id=p_player))
   where player_id=p_player;
  insert into public.loyalty_ledger (organization_id, player_id, delta, balance_after, reason, description)
   values (p_org, p_player, g.reward_points, v_bal, 'goal', g.name);
  insert into public.loyalty_goal_claims (organization_id, goal_id, player_id, period_key, reward_points)
   values (p_org, g.id, p_player, v_key, g.reward_points);

  return jsonb_build_object('goal', g.name, 'reward_points', g.reward_points, 'points_balance', v_bal);
end $$;

-- 7) Metas padrão para orgs existentes + auto-seed ---------------------------
insert into public.loyalty_goals (organization_id, name, description, metric, target, period, reward_points, sort_order)
select o.id, v.name, v.descr, v.metric, v.target, 'monthly', v.reward, v.ord
from public.organizations o
cross join (values
  ('Frequência mensal', 'Jogue 5 torneios no mês',   'tournaments', 5::numeric,  300::numeric, 1),
  ('Grinder',           'Jogue 15 torneios no mês',  'tournaments', 15::numeric, 1000::numeric, 2)
) as v(name, descr, metric, target, reward, ord)
where not exists (select 1 from public.loyalty_goals x where x.organization_id=o.id and x.name=v.name);
