-- ============================================================================
-- Programa de Fidelidade — Fase 2 (cashback + recompensas + resgate)
-- ----------------------------------------------------------------------------
-- Cashback: % do gasto vira saldo de cashback (dinheiro) na conta; convertível
--   em CRÉDITO no caixa (player_credits) via um sponsor de sistema "Fidelidade".
-- Recompensas: catálogo (custo em pontos → valor em crédito). Resgate atômico
--   deduz pontos e cria o crédito. (Recompensa em ticket fica p/ Fase 4.)
-- Sponsor de sistema é necessário porque player_credits.sponsor_id é NOT NULL.
-- ============================================================================

-- 1) Novas colunas -----------------------------------------------------------
alter table public.loyalty_accounts add column if not exists cashback_balance numeric(14,2) not null default 0;
alter table public.loyalty_settings add column if not exists system_sponsor_id uuid references public.sponsors(id);

-- Perk de cashback por tier (%).
update public.loyalty_tiers set cashback_percent = case name
  when 'Bronze' then 0 when 'Prata' then 1 when 'Ouro' then 2 when 'Diamante' then 3
  else cashback_percent end
where name in ('Bronze','Prata','Ouro','Diamante');

-- 2) Catálogo de recompensas -------------------------------------------------
create table if not exists public.loyalty_rewards (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  name            text not null,
  description     text,
  cost_points     numeric(14,2) not null,
  credit_value    numeric(14,2) not null default 0,   -- valor em crédito (R$) ao resgatar
  active          boolean not null default true,
  stock           int,                                 -- null = ilimitado
  sort_order      int not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists idx_loyalty_rewards_org on public.loyalty_rewards(organization_id, active);

-- 3) Resgates ----------------------------------------------------------------
create table if not exists public.loyalty_redemptions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  player_id       uuid not null references public.players(id) on delete cascade,
  reward_id       uuid references public.loyalty_rewards(id),
  points_spent    numeric(14,2) not null,
  credit_id       uuid,
  created_at      timestamptz not null default now()
);
create index if not exists idx_loyalty_redemptions_player on public.loyalty_redemptions(player_id, created_at desc);

-- 4) RLS ---------------------------------------------------------------------
do $$
declare tbl text;
begin
  foreach tbl in array array['loyalty_rewards','loyalty_redemptions'] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists %I on public.%I', tbl||'_org_isolation', tbl);
    execute format($f$create policy %I on public.%I for all
      using ((organization_id = (select current_org_id())) or (select is_platform_admin()))
      with check ((organization_id = (select current_org_id())) or (select is_platform_admin()))$f$,
      tbl||'_org_isolation', tbl);
  end loop;
end $$;

-- 5) Sponsor de sistema "Fidelidade" para orgs existentes --------------------
do $$
declare o record; v_sp uuid;
begin
  for o in select id from public.organizations loop
    select id into v_sp from public.sponsors where organization_id=o.id and name='Fidelidade' limit 1;
    if v_sp is null then
      insert into public.sponsors (name, status, organization_id) values ('Fidelidade','active',o.id) returning id into v_sp;
    end if;
    update public.loyalty_settings set system_sponsor_id=v_sp where organization_id=o.id and system_sponsor_id is null;
  end loop;
end $$;

-- 6) Auto-seed de novas orgs (agora com sponsor de sistema + cashback do tier)
create or replace function public.loyalty_seed_new_org()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_sp uuid;
begin
  insert into public.loyalty_settings (organization_id) values (NEW.id) on conflict (organization_id) do nothing;
  insert into public.sponsors (name, status, organization_id) values ('Fidelidade','active',NEW.id) returning id into v_sp;
  update public.loyalty_settings set system_sponsor_id=v_sp where organization_id=NEW.id;
  insert into public.loyalty_tiers (organization_id, name, min_points, points_multiplier, cashback_percent, color, sort_order) values
    (NEW.id, 'Bronze',   0,     1.00, 0, '#cd7f32', 1),
    (NEW.id, 'Prata',    500,   1.10, 1, '#9ca3af', 2),
    (NEW.id, 'Ouro',     2000,  1.25, 2, '#d9b45f', 3),
    (NEW.id, 'Diamante', 10000, 1.50, 3, '#7233f8', 4);
  return NEW;
end $$;

-- 7) Trigger de ganho: agora também acumula CASHBACK -------------------------
create or replace function public.loyalty_earn_on_transaction()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_settings public.loyalty_settings%rowtype;
  v_mult numeric := 1;
  v_points numeric;
  v_balance numeric;
  v_lifetime numeric;
  v_tier uuid;
  v_cb_pct numeric;
  v_cb numeric;
begin
  if NEW.player_id is null then return NEW; end if;
  if not public.org_has_loyalty(NEW.organization_id) then return NEW; end if;

  select * into v_settings from public.loyalty_settings where organization_id = NEW.organization_id;
  if not found or not v_settings.enabled then return NEW; end if;
  if NEW.type is null or not (NEW.type = any(v_settings.earn_on)) then return NEW; end if;

  insert into public.loyalty_accounts (player_id, organization_id)
  values (NEW.player_id, NEW.organization_id)
  on conflict (player_id) do nothing;

  select coalesce(t.points_multiplier, 1) into v_mult
  from public.loyalty_accounts a
  left join public.loyalty_tiers t on t.id = a.tier_id
  where a.player_id = NEW.player_id;
  v_mult := coalesce(v_mult, 1);

  v_points := floor(coalesce(NEW.amount, 0) * v_settings.points_per_currency * v_mult);
  if v_points > 0 then
    update public.loyalty_accounts
       set points_balance = points_balance + v_points,
           lifetime_points = lifetime_points + v_points,
           updated_at = now()
     where player_id = NEW.player_id
     returning points_balance, lifetime_points into v_balance, v_lifetime;

    v_tier := public.loyalty_tier_for(NEW.organization_id, v_lifetime);
    update public.loyalty_accounts set tier_id = v_tier where player_id = NEW.player_id;

    insert into public.loyalty_ledger (organization_id, player_id, delta, balance_after, reason, transaction_id)
    values (NEW.organization_id, NEW.player_id, v_points, v_balance, 'earn_' || NEW.type, NEW.id);
  end if;

  -- Cashback (dinheiro): % do gasto → saldo de cashback. Perk do tier vence o default.
  select coalesce(t.cashback_percent, v_settings.cashback_percent) into v_cb_pct
  from public.loyalty_accounts a
  left join public.loyalty_tiers t on t.id = a.tier_id
  where a.player_id = NEW.player_id;
  v_cb := round(coalesce(NEW.amount, 0) * coalesce(v_cb_pct, 0) / 100.0, 2);
  if v_cb > 0 then
    update public.loyalty_accounts set cashback_balance = cashback_balance + v_cb, updated_at = now()
     where player_id = NEW.player_id;
  end if;

  return NEW;
exception when others then
  return NEW;  -- best-effort: nunca bloqueia a venda
end $$;

-- 8) Resgate de recompensa (atômico) -----------------------------------------
create or replace function public.loyalty_redeem_reward(p_org uuid, p_player uuid, p_reward uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.loyalty_rewards%rowtype; v_bal numeric; v_sponsor uuid; v_credit uuid;
begin
  select * into r from public.loyalty_rewards where id=p_reward and organization_id=p_org;
  if not found or not r.active then raise exception 'FIDELIDADE: Recompensa indisponível.'; end if;
  if r.stock is not null and r.stock <= 0 then raise exception 'FIDELIDADE: Recompensa esgotada.'; end if;

  select points_balance into v_bal from public.loyalty_accounts
   where player_id=p_player and organization_id=p_org for update;
  if v_bal is null then raise exception 'FIDELIDADE: Jogador ainda nao tem pontos.'; end if;
  if v_bal < r.cost_points then raise exception 'FIDELIDADE: Pontos insuficientes (saldo %, custo %).', v_bal, r.cost_points; end if;

  select system_sponsor_id into v_sponsor from public.loyalty_settings where organization_id=p_org;
  if v_sponsor is null then raise exception 'FIDELIDADE: Programa nao configurado (sponsor).'; end if;

  update public.loyalty_accounts set points_balance = points_balance - r.cost_points, updated_at=now()
   where player_id=p_player and organization_id=p_org
   returning points_balance into v_bal;

  insert into public.loyalty_ledger (organization_id, player_id, delta, balance_after, reason, description)
   values (p_org, p_player, -r.cost_points, v_bal, 'redeem', r.name);

  insert into public.player_credits (player_id, sponsor_id, original_amount, remaining_amount, used_amount, status, sponsor_owes, notes, organization_id)
   values (p_player, v_sponsor, r.credit_value, r.credit_value, 0, 'active', 0, 'Resgate fidelidade: '||r.name, p_org)
   returning id into v_credit;

  if r.stock is not null then
    update public.loyalty_rewards set stock = stock - 1 where id=p_reward;
  end if;

  insert into public.loyalty_redemptions (organization_id, player_id, reward_id, points_spent, credit_id)
   values (p_org, p_player, p_reward, r.cost_points, v_credit);

  return jsonb_build_object('credit_id', v_credit, 'points_spent', r.cost_points, 'points_balance', v_bal, 'credit_value', r.credit_value);
end $$;

-- 9) Converter cashback em crédito no caixa ----------------------------------
create or replace function public.loyalty_convert_cashback(p_org uuid, p_player uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_cb numeric; v_sponsor uuid; v_credit uuid;
begin
  select cashback_balance into v_cb from public.loyalty_accounts
   where player_id=p_player and organization_id=p_org for update;
  if v_cb is null or v_cb <= 0 then raise exception 'FIDELIDADE: Sem cashback para converter.'; end if;
  select system_sponsor_id into v_sponsor from public.loyalty_settings where organization_id=p_org;
  if v_sponsor is null then raise exception 'FIDELIDADE: Programa nao configurado (sponsor).'; end if;

  insert into public.player_credits (player_id, sponsor_id, original_amount, remaining_amount, used_amount, status, sponsor_owes, notes, organization_id)
   values (p_player, v_sponsor, v_cb, v_cb, 0, 'active', 0, 'Cashback fidelidade', p_org)
   returning id into v_credit;

  update public.loyalty_accounts set cashback_balance = 0, updated_at=now()
   where player_id=p_player and organization_id=p_org;

  return jsonb_build_object('credit_id', v_credit, 'amount', v_cb);
end $$;
