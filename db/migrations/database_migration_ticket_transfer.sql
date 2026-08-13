-- ============================================================================
-- Troca de dono do ticket: transferência (de graça) e venda (com dinheiro)
-- ----------------------------------------------------------------------------
-- Acontece toda etapa: o jogador ganha a vaga, não pode jogar o dia e passa
-- (ou vende) para outro. Hoje o clube resolve isso apagando o ticket e
-- emitindo outro no nome do novo dono — o que perde o rastro de quem ganhou a
-- vaga e, quando há dinheiro envolvido, deixa a venda fora do caixa.
--
-- Tabela própria (e não uma coluna `previous_player_id` em satellite_tickets):
-- um ticket pode mudar de mão mais de uma vez, e a venda carrega valor, forma
-- de pagamento e o lançamento no caixa — dados que não cabem numa coluna e que
-- precisam sobreviver à PRÓXIMA transferência.
--
-- O ticket NÃO ganha status novo. O CHECK de `satellite_tickets.status` difere
-- entre as migrações v1 ('awarded') e v2 ('available') e não dá para confirmar
-- qual está valendo em produção sem rodar SQL lá; inventar 'transferred'
-- arriscaria derrubar toda troca de dono. O ticket continua disponível, só
-- troca de `player_id`.
-- ============================================================================

create table if not exists public.satellite_ticket_transfers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null default public.current_org_id()
                     references public.organizations(id) on delete cascade,
  ticket_id        uuid not null references public.satellite_tickets(id) on delete cascade,
  -- Nulo em ticket legado que não tinha dono: é atribuição, não transferência.
  from_player_id   uuid references public.players(id),
  to_player_id     uuid not null references public.players(id),
  -- amount = 0 é passagem simples; > 0 é venda.
  kind             text not null default 'transfer' check (kind in ('transfer','sale')),
  amount           numeric(12,2) not null default 0 check (amount >= 0),
  payment_method   text,
  stage_id         uuid references public.stages(id) on delete set null,
  -- Liga a venda ao lançamento no caixa (other_revenues). ON DELETE SET NULL:
  -- apagar a receita estorna o caixa, mas não pode apagar o histórico da troca.
  revenue_id       uuid references public.other_revenues(id) on delete set null,
  notes            text,
  performed_by     uuid,
  created_at       timestamptz not null default now(),
  constraint satellite_ticket_transfers_sale_amount
    check ((kind = 'sale' and amount > 0) or (kind = 'transfer' and amount = 0))
);

create index if not exists idx_stt_ticket on public.satellite_ticket_transfers(ticket_id, created_at desc);
create index if not exists idx_stt_org    on public.satellite_ticket_transfers(organization_id, created_at desc);
create index if not exists idx_stt_to     on public.satellite_ticket_transfers(to_player_id);

alter table public.satellite_ticket_transfers enable row level security;
drop policy if exists satellite_ticket_transfers_org_isolation on public.satellite_ticket_transfers;
create policy satellite_ticket_transfers_org_isolation on public.satellite_ticket_transfers for all
  using      ((organization_id = (select public.current_org_id())) or (select public.is_platform_admin()))
  with check ((organization_id = (select public.current_org_id())) or (select public.is_platform_admin()));

-- ----------------------------------------------------------------------------
-- A tabela nova referencia stages/players/other_revenues, apagados ANTES de
-- organizations. Sem entrar na lista, excluir uma organização quebra por chave
-- estrangeira. Corpo copiado de database_migration_other_revenues.sql com
-- 'satellite_ticket_transfers' ANTES de 'satellite_tickets'.
-- ----------------------------------------------------------------------------
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
        'credit_transactions','chip_consignment_sales',
        'satellite_ticket_transfers','satellite_tickets',
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
