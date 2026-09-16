-- ============================================================================
-- MÓDULO DE BAR — Fase 2: auditoria (activity_logs) e exclusão de organização
-- ----------------------------------------------------------------------------
-- 1) As tabelas do bar entram no log de atividade, com as MESMAS regras das
--    outras: INSERT/DELETE inteiros e UPDATE só das colunas que um humano
--    muda de propósito (os totais recontados por trigger ficam de fora — seriam
--    ruído a cada item). Movimentos de estoque gerados por trigger são
--    ignorados pelo próprio log_activity (pg_trigger_depth() > 1).
--
-- 2) `delete_organization` passa a apagar as tabelas do bar — e fecha um buraco
--    que já existia: as tabelas de CASH nunca entraram na lista, e `cash_days`
--    é RESTRICT para organizations, então excluir um clube com cash falhava
--    por chave estrangeira. A ordem respeita as FKs (filhas antes das mães;
--    `cashboxes` antes de `bar_shifts`/`cash_days`, que ela referencia).
--
-- ORDEM: aplicar DEPOIS de database_migration_bar_fase1_core.sql e de
-- database_migration_activity_logs.sql. Reaplicável.
-- ============================================================================

DO $guard$ BEGIN
  IF to_regclass('public.bar_tab_payments') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_bar_fase1_core.sql';
  END IF;
  IF to_regproc('public.log_activity') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_activity_logs.sql';
  END IF;
END $guard$;


-- ── 1) Log de atividade ─────────────────────────────────────────────────────
DO $$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT * FROM (VALUES
            ('bar_shifts',             true,  true,  'status, closed_at, label, notes'),
            ('bar_product_categories', true,  true,  'name, active, sort_order'),
            ('bar_products',           true,  true,  'name, price, cost_price, active, track_stock, min_stock, category_id, sku'),
            -- Comanda: o que muda por decisão (status, desconto), não o que o
            -- trigger reconta (subtotal, total, paid_amount).
            ('bar_tabs',               true,  false, 'status, discount_amount, discount_reason, cancel_reason, notes'),
            ('bar_tab_items',          true,  false, 'status, is_courtesy, courtesy_reason, cancel_reason'),
            ('bar_tab_payments',       true,  false, 'status, cancel_reason'),
            -- Entrada/ajuste/perda manuais; os automáticos (trigger) não passam.
            ('bar_stock_movements',    true,  false, 'notes')
        ) AS v(tabela, com_insert, com_delete, colunas_update)
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_log_%1$s_ins ON public.%1$I', t.tabela);
        EXECUTE format('DROP TRIGGER IF EXISTS trg_log_%1$s_upd ON public.%1$I', t.tabela);
        EXECUTE format('DROP TRIGGER IF EXISTS trg_log_%1$s_del ON public.%1$I', t.tabela);

        IF t.com_insert THEN
            EXECUTE format(
                'CREATE TRIGGER trg_log_%1$s_ins AFTER INSERT ON public.%1$I '
                'FOR EACH ROW EXECUTE FUNCTION public.log_activity()', t.tabela);
        END IF;
        EXECUTE format(
            'CREATE TRIGGER trg_log_%1$s_upd AFTER UPDATE OF %2$s ON public.%1$I '
            'FOR EACH ROW EXECUTE FUNCTION public.log_activity()', t.tabela, t.colunas_update);
        IF t.com_delete THEN
            EXECUTE format(
                'CREATE TRIGGER trg_log_%1$s_del AFTER DELETE ON public.%1$I '
                'FOR EACH ROW EXECUTE FUNCTION public.log_activity()', t.tabela);
        END IF;
    END LOOP;
END $$;


-- ── 2) delete_organization com as tabelas do bar (e do cash) ────────────────
-- Corpo copiado de database_migration_ticket_transfer.sql, só com a lista
-- v_order acrescida. Mesma assinatura → CREATE OR REPLACE de verdade.
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
        -- Ledger da gaveta primeiro: referencia vendas de torneio, de cash e do bar.
        'cashbox_transactions',
        -- Bar: pagamentos e itens antes da comanda; movimentos antes do produto.
        'bar_tab_payments','bar_tab_items','bar_stock_movements','bar_tabs',
        'prize_allocations','transactions','seat_allocations',
        'credit_transactions','chip_consignment_sales',
        'satellite_ticket_transfers','satellite_tickets',
        'tournament_players','blinds','tournament_tables','tournament_days',
        'expenses','expense_categories','other_revenues',
        'tournaments','player_credits','chip_consignments','staff_payments',
        -- Gavetas antes das âncoras diárias (cash_days / bar_shifts).
        'cashbox_sessions','cashboxes','stage_cash_register','sangria_transactions',
        'blind_templates','buy_types','stages',
        -- Cash game (faltava: cash_days é RESTRICT para organizations).
        'cash_transactions','cash_rake_entries','cash_jackpot_payouts','cash_waitlist',
        'cash_player_sessions','cash_seats','cash_tables','cash_jackpot_fund',
        'cash_game_types','cash_days',
        -- Bar: turno e catálogo, depois das gavetas e dos itens.
        'bar_shifts','bar_products','bar_product_categories',
        'loyalty_ledger','loyalty_redemptions','loyalty_coupon_redemptions',
        'loyalty_goal_claims','loyalty_birthday_grants','loyalty_accounts',
        'loyalty_rewards','loyalty_coupons','loyalty_goals','loyalty_tiers',
        'loyalty_settings',
        'players','sponsors','staff',
        'permission_groups','payment_methods','app_settings','general_cash_register',
        'rake_register','sync_mutations','org_modules'
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

    -- Os triggers de "não apague turno/dia com movimento" existem para a
    -- operação, não para a exclusão do clube inteiro: aqui as comandas e as
    -- transações já foram apagadas antes (ordem de v_order), então eles não
    -- disparam — e se dispararem, é sinal de ordem errada, e a exclusão para.

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


-- ── Conferência ─────────────────────────────────────────────────────────────
-- Triggers de log nas tabelas do bar (deve listar 7 tabelas):
--   SELECT DISTINCT event_object_table FROM information_schema.triggers
--    WHERE trigger_name LIKE 'trg_log_bar_%' ORDER BY 1;
--
-- A lista de exclusão contém cash_days e bar_shifts:
--   SELECT prosrc LIKE '%cash_days%' AND prosrc LIKE '%bar_shifts%' FROM pg_proc WHERE proname = 'delete_organization';
