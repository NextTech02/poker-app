-- ============================================================================
-- Fix: exclusão de organização falhava por causa da fidelidade
-- ----------------------------------------------------------------------------
-- Sintoma: "update or delete on table sponsors violates foreign key constraint
-- loyalty_settings_system_sponsor_id_fkey".
--
-- Causa: `delete_organization` apaga `sponsors` antes de `organizations`, mas
-- `loyalty_settings.system_sponsor_id` (sponsor de sistema "Fidelidade", criado
-- na Fase 2) referenciava sponsors SEM regra de deleção — a FK barrava.
--
-- Correção em duas frentes:
--  1) FK vira ON DELETE SET NULL (robusto e independente de ordem);
--  2) as tabelas loyalty_* entram na lista de exclusão da função, na ordem
--     correta (filhas antes das pais), para a limpeza ser explícita e o
--     relatório de registros removidos ficar completo.
-- ============================================================================

-- 1) FK do sponsor de sistema: apagar o sponsor apenas zera a referência.
alter table public.loyalty_settings
  drop constraint if exists loyalty_settings_system_sponsor_id_fkey;

alter table public.loyalty_settings
  add constraint loyalty_settings_system_sponsor_id_fkey
  foreign key (system_sponsor_id) references public.sponsors(id) on delete set null;

-- 2) Função de exclusão passa a limpar também as tabelas de fidelidade.
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
    v_order  text[] := ARRAY[
        'cashbox_transactions','prize_allocations','transactions','seat_allocations',
        'credit_transactions','chip_consignment_sales','satellite_tickets',
        'tournament_players','blinds','tournament_tables','tournament_days',
        'tournaments','player_credits','chip_consignments','staff_payments',
        'cashbox_sessions','cashboxes','stage_cash_register','sangria_transactions',
        'blind_templates','buy_types','stages',
        -- Fidelidade: filhas antes das pais (accounts antes de tiers; resgates
        -- antes de rewards/coupons/goals; settings antes de sponsors).
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

    BEGIN
        EXECUTE 'UPDATE public.cashboxes SET current_session_id = NULL WHERE organization_id = $1' USING p_org;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;

    BEGIN
        EXECUTE 'UPDATE public.tournament_days SET qualifies_to_day_id = NULL WHERE organization_id = $1' USING p_org;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;

    FOREACH v_t IN ARRAY v_order LOOP
        -- Tabela ainda não criada neste ambiente: ignora e segue.
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
    RETURN jsonb_build_object('organization', v_name, 'deleted', v_del);
END $function$;
