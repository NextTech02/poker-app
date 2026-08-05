-- ============================================================================
-- Programa de Fidelidade — Fase 4 (aniversário + presentear buy-in)
-- ----------------------------------------------------------------------------
-- Aniversário: no dia, o jogador ganha bônus (pontos + crédito de "buy grátis").
--   Concedido 1x/ano por um job pg_cron. O crédito de aniversário pode ser
--   PRESENTEADO a outro jogador (repasse a novos jogadores / indicação).
-- ============================================================================

-- 1) Data de nascimento do jogador + config de aniversário --------------------
alter table public.players add column if not exists birth_date date;

alter table public.loyalty_settings
  add column if not exists birthday_bonus_points numeric(14,2) not null default 0,
  add column if not exists birthday_credit        numeric(14,2) not null default 0;

-- Registro de concessões de aniversário (evita duplicar no mesmo ano).
create table if not exists public.loyalty_birthday_grants (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  player_id       uuid not null references public.players(id) on delete cascade,
  year            int not null,
  points          numeric(14,2) not null default 0,
  credit_id       uuid,
  created_at      timestamptz not null default now(),
  unique (player_id, year)
);

alter table public.loyalty_birthday_grants enable row level security;
drop policy if exists loyalty_birthday_grants_org_isolation on public.loyalty_birthday_grants;
create policy loyalty_birthday_grants_org_isolation on public.loyalty_birthday_grants for all
  using ((organization_id = (select current_org_id())) or (select is_platform_admin()))
  with check ((organization_id = (select current_org_id())) or (select is_platform_admin()));

-- 2) Concessão de aniversários (rodada pelo pg_cron) -------------------------
create or replace function public.loyalty_grant_birthdays()
returns int language plpgsql security definer set search_path=public as $$
declare
  rec record; v_bal numeric; v_credit uuid; v_sponsor uuid; v_count int := 0;
  v_yr int := extract(year from now())::int;
begin
  for rec in
    select p.id as player_id, p.organization_id, s.birthday_bonus_points, s.birthday_credit, s.system_sponsor_id
    from public.players p
    join public.loyalty_settings s on s.organization_id = p.organization_id
    where p.birth_date is not null
      and to_char(p.birth_date,'MM-DD') = to_char(now(),'MM-DD')
      and public.org_has_loyalty(p.organization_id)
      and (s.birthday_bonus_points > 0 or s.birthday_credit > 0)
      and not exists (select 1 from public.loyalty_birthday_grants g
                       where g.player_id = p.id and g.year = v_yr)
  loop
    v_credit := null;
    -- pontos
    if rec.birthday_bonus_points > 0 then
      insert into public.loyalty_accounts (player_id, organization_id)
       values (rec.player_id, rec.organization_id) on conflict (player_id) do nothing;
      update public.loyalty_accounts
         set points_balance=points_balance+rec.birthday_bonus_points,
             lifetime_points=lifetime_points+rec.birthday_bonus_points, updated_at=now()
       where player_id=rec.player_id returning points_balance into v_bal;
      update public.loyalty_accounts set tier_id=public.loyalty_tier_for(rec.organization_id,
             (select lifetime_points from public.loyalty_accounts where player_id=rec.player_id))
       where player_id=rec.player_id;
      insert into public.loyalty_ledger (organization_id, player_id, delta, balance_after, reason, description)
       values (rec.organization_id, rec.player_id, rec.birthday_bonus_points, v_bal, 'birthday', 'Aniversario');
    end if;
    -- crédito (buy grátis)
    if rec.birthday_credit > 0 and rec.system_sponsor_id is not null then
      insert into public.player_credits (player_id, sponsor_id, original_amount, remaining_amount, used_amount, status, sponsor_owes, notes, organization_id)
       values (rec.player_id, rec.system_sponsor_id, rec.birthday_credit, rec.birthday_credit, 0, 'active', 0, 'Aniversario (buy gratis)', rec.organization_id)
       returning id into v_credit;
    end if;

    insert into public.loyalty_birthday_grants (organization_id, player_id, year, points, credit_id)
     values (rec.organization_id, rec.player_id, v_yr, rec.birthday_bonus_points, v_credit);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- 3) Presentear crédito (repasse a novo jogador / indicação) ------------------
create or replace function public.loyalty_gift_credit(p_org uuid, p_credit uuid, p_to uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.player_credits%rowtype; v_sponsor uuid; v_new uuid; v_from_name text;
begin
  select * into c from public.player_credits where id=p_credit and organization_id=p_org for update;
  if not found then raise exception 'FIDELIDADE: Credito nao encontrado.'; end if;
  if c.status <> 'active' or coalesce(c.used_amount,0) > 0 then
    raise exception 'FIDELIDADE: So e possivel presentear um credito ainda nao utilizado.';
  end if;
  if p_to = c.player_id then raise exception 'FIDELIDADE: Escolha outro jogador para presentear.'; end if;

  select coalesce(name, 'jogador') into v_from_name from public.players where id=c.player_id;
  select coalesce(c.sponsor_id, s.system_sponsor_id) into v_sponsor
    from public.loyalty_settings s where s.organization_id=p_org;

  insert into public.player_credits (player_id, sponsor_id, original_amount, remaining_amount, used_amount, status, sponsor_owes, notes, organization_id)
   values (p_to, v_sponsor, c.original_amount, c.original_amount, 0, 'active', 0, 'Presente de '||v_from_name, p_org)
   returning id into v_new;

  update public.player_credits set status='cancelled', remaining_amount=0, updated_at=now() where id=p_credit;

  return jsonb_build_object('new_credit_id', v_new, 'amount', c.original_amount, 'to_player', p_to);
end $$;

-- 4) Agenda diária do job de aniversário -------------------------------------
create extension if not exists pg_cron;
do $$
begin
  if not exists (select 1 from cron.job where jobname='loyalty-birthday-grants') then
    perform cron.schedule('loyalty-birthday-grants', '0 6 * * *', $$select public.loyalty_grant_birthdays();$$);
  end if;
end $$;

-- 5) Auto-seed já inclui as colunas novas por default (0). Sem mudança extra. --
