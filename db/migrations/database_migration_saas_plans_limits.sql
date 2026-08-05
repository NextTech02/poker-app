-- ============================================================================
-- SaaS: Planos e limites por organização
-- ----------------------------------------------------------------------------
-- Catálogo `plans` (fonte da verdade dos limites) + colunas na `organizations`
-- (plano contratado, início, fim do trial, override de usuários) + fiscalização
-- em nível de banco (triggers) para: usuários, torneios/mês, mesas/torneio e
-- clientes. NULL em qualquer limite = ilimitado (Pro/Premium).
--
-- Enforcement no banco = à prova de bala: nem chamando a API na mão fura o
-- limite. Os services também checam antes, para devolver erro amigável.
--
-- Trial Free (60 dias): `trial_ends_at`. A expiração AUTO-SUSPENDE a org via
-- pg_cron (job agendado à parte, fora desta migração transacional).
--
-- Grandfathering: TODAS as orgs existentes viram 'pro' (ilimitado) para não
-- limitar/quebrar nenhum cliente atual. Novas orgs recebem o plano escolhido.
-- ============================================================================

-- 1) Catálogo de planos ------------------------------------------------------
create table if not exists public.plans (
  code                   text primary key,
  name                   text not null,
  max_users              int,            -- null = ilimitado
  max_tournaments_month  int,
  max_tables_tournament  int,
  max_clients            int,
  trial_days             int,            -- null = sem trial
  price_month            numeric(10,2),
  price_year             numeric(10,2),
  sort_order             int  not null default 0,
  created_at             timestamptz not null default now()
);

insert into public.plans
  (code, name, max_users, max_tournaments_month, max_tables_tournament, max_clients, trial_days, price_month, price_year, sort_order)
values
  ('free',     'Free',     2,    4,    4,    150,  60,   0,    0,    1),
  ('standard', 'Standard', 6,    20,   null, 1000, null, 69,   49,   2),
  ('pro',      'Pro',      null, null, null, null, null, 129,  99,   3),
  ('premium',  'Premium',  null, null, null, null, null, null, null, 4)
on conflict (code) do update set
  name=excluded.name,
  max_users=excluded.max_users,
  max_tournaments_month=excluded.max_tournaments_month,
  max_tables_tournament=excluded.max_tables_tournament,
  max_clients=excluded.max_clients,
  trial_days=excluded.trial_days,
  price_month=excluded.price_month,
  price_year=excluded.price_year,
  sort_order=excluded.sort_order;

alter table public.plans enable row level security;
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select using (true);

-- 2) Colunas de plano na organização ----------------------------------------
alter table public.organizations
  add column if not exists plan_code       text not null default 'free' references public.plans(code),
  add column if not exists plan_started_at timestamptz not null default now(),
  add column if not exists trial_ends_at   timestamptz,
  add column if not exists max_users_override int;

-- Grandfathering: orgs já existentes ficam ilimitadas (pro).
update public.organizations set plan_code='pro' where plan_code='free';
update public.organizations set plan_started_at=created_at;

-- 3) Limite efetivo de uma org (override de usuários vence o plano) ----------
create or replace function public.org_limit(p_org uuid, p_kind text)
returns int
language sql stable security definer set search_path=public as $$
  select case p_kind
    when 'users'             then coalesce(o.max_users_override, p.max_users)
    when 'tournaments_month' then p.max_tournaments_month
    when 'tables_tournament' then p.max_tables_tournament
    when 'clients'           then p.max_clients
  end
  from public.organizations o
  join public.plans p on p.code = o.plan_code
  where o.id = p_org;
$$;

-- 4) Triggers de fiscalização (NULL = ilimitado → early return) --------------

-- 4a) Usuários (staff ativo). Vale para INSERT e para reativação (active f→t).
create or replace function public.enforce_staff_limit()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_lim int; v_cnt int;
begin
  if TG_OP='INSERT' then
    if coalesce(NEW.active,true) is not true then return NEW; end if;
  elsif TG_OP='UPDATE' then
    if not (coalesce(NEW.active,true) is true and coalesce(OLD.active,true) is not true) then
      return NEW;
    end if;
  end if;

  v_org := coalesce(NEW.organization_id, current_org_id());
  if v_org is null then return NEW; end if;

  v_lim := public.org_limit(v_org, 'users');
  if v_lim is null then return NEW; end if;

  select count(*) into v_cnt from public.staff
   where organization_id = v_org and active = true;
  if v_cnt >= v_lim then
    raise exception
      'PLANO_LIMITE_USUARIOS: O plano atual permite % usuario(s) ativo(s). Faca upgrade para adicionar mais.', v_lim;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_enforce_staff_limit on public.staff;
create trigger trg_enforce_staff_limit
  before insert or update of active on public.staff
  for each row execute function public.enforce_staff_limit();

-- 4b) Torneios por mês (mês-calendário corrente).
create or replace function public.enforce_tournament_limit()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_lim int; v_cnt int;
begin
  v_org := coalesce(NEW.organization_id, current_org_id());
  if v_org is null then return NEW; end if;

  v_lim := public.org_limit(v_org, 'tournaments_month');
  if v_lim is null then return NEW; end if;

  select count(*) into v_cnt from public.tournaments
   where organization_id = v_org and created_at >= date_trunc('month', now());
  if v_cnt >= v_lim then
    raise exception
      'PLANO_LIMITE_TORNEIOS: O plano atual permite % torneio(s) por mes.', v_lim;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_enforce_tournament_limit on public.tournaments;
create trigger trg_enforce_tournament_limit
  before insert on public.tournaments
  for each row execute function public.enforce_tournament_limit();

-- 4c) Mesas por torneio.
create or replace function public.enforce_table_limit()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_lim int; v_cnt int;
begin
  v_org := coalesce(NEW.organization_id, current_org_id());
  if v_org is null then return NEW; end if;
  if NEW.tournament_id is null then return NEW; end if;

  v_lim := public.org_limit(v_org, 'tables_tournament');
  if v_lim is null then return NEW; end if;

  select count(*) into v_cnt from public.tournament_tables
   where tournament_id = NEW.tournament_id;
  if v_cnt >= v_lim then
    raise exception
      'PLANO_LIMITE_MESAS: O plano atual permite % mesa(s) por torneio.', v_lim;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_enforce_table_limit on public.tournament_tables;
create trigger trg_enforce_table_limit
  before insert on public.tournament_tables
  for each row execute function public.enforce_table_limit();

-- 4d) Clientes (players) por org.
create or replace function public.enforce_player_limit()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_lim int; v_cnt int;
begin
  v_org := coalesce(NEW.organization_id, current_org_id());
  if v_org is null then return NEW; end if;

  v_lim := public.org_limit(v_org, 'clients');
  if v_lim is null then return NEW; end if;

  select count(*) into v_cnt from public.players where organization_id = v_org;
  if v_cnt >= v_lim then
    raise exception
      'PLANO_LIMITE_CLIENTES: O plano atual permite % cliente(s).', v_lim;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_enforce_player_limit on public.players;
create trigger trg_enforce_player_limit
  before insert on public.players
  for each row execute function public.enforce_player_limit();

-- 5) Auto-suspensão de trials Free expirados (chamado pelo pg_cron) ----------
create or replace function public.suspend_expired_trials()
returns int language sql security definer set search_path=public as $$
  with upd as (
    update public.organizations
       set status='suspended', updated_at=now()
     where plan_code='free' and status='active'
       and trial_ends_at is not null and trial_ends_at < now()
    returning 1
  ) select count(*)::int from upd;
$$;

-- 6) Provisionamento passa a receber o plano ---------------------------------
drop function if exists public.provision_organization(text, text, uuid, text, text, text);

create or replace function public.provision_organization(
  p_org_name text, p_org_slug text, p_auth_user uuid,
  p_admin_name text, p_admin_email text,
  p_currency text DEFAULT 'BRL',
  p_plan text DEFAULT 'free'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid; v_group uuid;
    v_trial_days int; v_trial_ends timestamptz;
    v_all_perms text[] := ARRAY['dashboard','stages','tournaments','players','cashier',
      'cashier_players','cashier_tickets','prizes','prizes_release','financial','reports',
      'general_cash','rankings','blinds','tables','broadcast','employees',
      'cashbox.operate','cashbox.admin','sangi'];
BEGIN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_auth_user) THEN
        RAISE EXCEPTION 'Usuario % nao existe em auth.users', p_auth_user;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.plans WHERE code = p_plan) THEN
        RAISE EXCEPTION 'Plano % invalido', p_plan;
    END IF;

    SELECT trial_days INTO v_trial_days FROM public.plans WHERE code = p_plan;
    IF v_trial_days IS NOT NULL THEN
        v_trial_ends := now() + (v_trial_days || ' days')::interval;
    END IF;

    INSERT INTO public.organizations (name, slug, plan_code, plan_started_at, trial_ends_at)
    VALUES (p_org_name, p_org_slug, p_plan, now(), v_trial_ends)
    RETURNING id INTO v_org;

    INSERT INTO public.permission_groups (name, description, permissions, organization_id)
    VALUES ('Admin','Acesso total', v_all_perms, v_org) RETURNING id INTO v_group;
    INSERT INTO public.permission_groups (name, description, permissions, organization_id) VALUES
      ('Caixa','Operacao de caixa', ARRAY['cashier','cashier_tickets','cashier_players','prizes'], v_org),
      ('Sanger','Venda de fichas (sanger)', ARRAY['sangi'], v_org);
    INSERT INTO public.staff (auth_user_id, name, email, permission_group_id, active, organization_id)
    VALUES (p_auth_user, p_admin_name, p_admin_email, v_group, true, v_org);
    INSERT INTO public.app_settings (currency, organization_id) VALUES (p_currency, v_org);
    INSERT INTO public.general_cash_register (current_balance, total_received, organization_id) VALUES (0,0,v_org);
    INSERT INTO public.rake_register (total_rake, organization_id) VALUES (0, v_org);
    INSERT INTO public.payment_methods (code,label,active,sort_order,organization_id) VALUES
      ('cash','Dinheiro',true,1,v_org),('card','Cartao',true,2,v_org),
      ('pix','PIX',true,3,v_org),('transfer','Transferencia',true,4,v_org);
    RETURN v_org;
END $function$;
