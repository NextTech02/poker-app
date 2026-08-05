-- ============================================================================
-- Programa de Fidelidade — Fase 1 (núcleo)
-- ----------------------------------------------------------------------------
-- Pontos (extrato imutável) ganhos em buy-in/rebuy/addon + níveis VIP.
-- Disponível apenas para orgs em plano PRO/PREMIUM (amarra no sistema de planos).
-- O ganho é feito por trigger FAIL-SAFE em transactions: se algo der errado na
-- fidelidade, a venda NÃO é bloqueada (fidelidade é best-effort).
-- Fases seguintes (cashback→crédito, recompensas, cupons, metas, aniversário)
-- constroem por cima deste núcleo.
-- ============================================================================

-- 1) Config por organização --------------------------------------------------
create table if not exists public.loyalty_settings (
  organization_id     uuid primary key default current_org_id() references public.organizations(id) on delete cascade,
  enabled             boolean not null default true,
  points_per_currency numeric(10,4) not null default 1,       -- pontos por unidade de moeda gasta
  earn_on             text[] not null default array['buy_in','rebuy','addon'],
  point_value         numeric(10,4) not null default 0.01,    -- valor de 1 ponto no resgate (Fase 2)
  cashback_percent    numeric(6,2) not null default 0,        -- Fase 2
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- 2) Níveis VIP (por org) ----------------------------------------------------
create table if not exists public.loyalty_tiers (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  name              text not null,
  min_points        numeric(14,2) not null default 0,   -- limiar em pontos vitalícios
  points_multiplier numeric(6,2) not null default 1,    -- perk: multiplicador de ganho
  cashback_percent  numeric(6,2),                        -- perk (Fase 2); null = usa o default
  color             text,
  sort_order        int not null default 0,
  created_at        timestamptz not null default now()
);
create index if not exists idx_loyalty_tiers_org on public.loyalty_tiers(organization_id, min_points);

-- 3) Conta do jogador --------------------------------------------------------
create table if not exists public.loyalty_accounts (
  player_id       uuid primary key references public.players(id) on delete cascade,
  organization_id uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  points_balance  numeric(14,2) not null default 0,
  lifetime_points numeric(14,2) not null default 0,
  tier_id         uuid references public.loyalty_tiers(id),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_loyalty_accounts_org on public.loyalty_accounts(organization_id);

-- 4) Extrato de pontos (imutável) --------------------------------------------
create table if not exists public.loyalty_ledger (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  player_id       uuid not null references public.players(id) on delete cascade,
  delta           numeric(14,2) not null,        -- +ganho / -resgate
  balance_after   numeric(14,2) not null,
  reason          text not null,                 -- earn_buy_in, earn_rebuy, earn_addon, redeem, cashback, birthday, goal, coupon, manual
  transaction_id  uuid,
  description     text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_loyalty_ledger_player on public.loyalty_ledger(player_id, created_at desc);

-- 5) RLS (org-scoped, mesmo padrão do resto) ---------------------------------
do $$
declare tbl text;
begin
  foreach tbl in array array['loyalty_settings','loyalty_tiers','loyalty_accounts','loyalty_ledger'] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists %I on public.%I', tbl||'_org_isolation', tbl);
    execute format($f$create policy %I on public.%I for all
      using ((organization_id = (select current_org_id())) or (select is_platform_admin()))
      with check ((organization_id = (select current_org_id())) or (select is_platform_admin()))$f$,
      tbl||'_org_isolation', tbl);
  end loop;
end $$;

-- 6) Helpers -----------------------------------------------------------------
-- Fidelidade só vale para PRO/PREMIUM e com o programa habilitado.
create or replace function public.org_has_loyalty(p_org uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select coalesce((
    select o.plan_code in ('pro','premium') and coalesce(s.enabled, true)
    from public.organizations o
    left join public.loyalty_settings s on s.organization_id = o.id
    where o.id = p_org
  ), false);
$$;

-- Tier correspondente a um total de pontos vitalícios.
create or replace function public.loyalty_tier_for(p_org uuid, p_points numeric)
returns uuid language sql stable security definer set search_path=public as $$
  select id from public.loyalty_tiers
  where organization_id = p_org and min_points <= p_points
  order by min_points desc limit 1;
$$;

-- 7) Motor de ganho (trigger FAIL-SAFE em transactions) ----------------------
create or replace function public.loyalty_earn_on_transaction()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_settings public.loyalty_settings%rowtype;
  v_mult numeric := 1;
  v_points numeric;
  v_balance numeric;
  v_lifetime numeric;
  v_tier uuid;
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
  if v_points <= 0 then return NEW; end if;

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

  return NEW;
exception when others then
  -- Fidelidade é best-effort: qualquer erro aqui NÃO pode bloquear a venda.
  return NEW;
end $$;

drop trigger if exists trg_loyalty_earn on public.transactions;
create trigger trg_loyalty_earn after insert on public.transactions
  for each row execute function public.loyalty_earn_on_transaction();

-- 8) Auto-seed de fidelidade para novas orgs ---------------------------------
create or replace function public.loyalty_seed_new_org()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.loyalty_settings (organization_id) values (NEW.id)
    on conflict (organization_id) do nothing;
  insert into public.loyalty_tiers (organization_id, name, min_points, points_multiplier, color, sort_order) values
    (NEW.id, 'Bronze',   0,     1.00, '#cd7f32', 1),
    (NEW.id, 'Prata',    500,   1.10, '#9ca3af', 2),
    (NEW.id, 'Ouro',     2000,  1.25, '#d9b45f', 3),
    (NEW.id, 'Diamante', 10000, 1.50, '#7233f8', 4);
  return NEW;
end $$;

drop trigger if exists trg_loyalty_seed_new_org on public.organizations;
create trigger trg_loyalty_seed_new_org after insert on public.organizations
  for each row execute function public.loyalty_seed_new_org();

-- 9) Seed das orgs existentes ------------------------------------------------
insert into public.loyalty_settings (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

insert into public.loyalty_tiers (organization_id, name, min_points, points_multiplier, color, sort_order)
select o.id, v.name, v.min_points, v.mult, v.color, v.ord
from public.organizations o
cross join (values
  ('Bronze',   0::numeric,     1.00::numeric, '#cd7f32', 1),
  ('Prata',    500::numeric,   1.10::numeric, '#9ca3af', 2),
  ('Ouro',     2000::numeric,  1.25::numeric, '#d9b45f', 3),
  ('Diamante', 10000::numeric, 1.50::numeric, '#7233f8', 4)
) as v(name, min_points, mult, color, ord)
where not exists (select 1 from public.loyalty_tiers t where t.organization_id = o.id);
