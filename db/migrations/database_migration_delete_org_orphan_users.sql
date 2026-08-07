-- ============================================================================
-- Exclusão de organização também remove contas que ficaram sem vínculo
-- ----------------------------------------------------------------------------
-- Antes: excluir uma org apagava os vínculos (staff) mas nunca a conta do auth,
-- deixando "contas fantasma" — logam, mas não enxergam nada (sem staff => sem
-- permissão e sem organização no RLS). O e-mail também ficava preso: convidar
-- de novo caía em "usuário já existe", sem novo e-mail de convite.
--
-- Agora, ao final da exclusão, cada conta que participava DESTA org é removida
-- somente quando:
--   1) não sobrou nenhum outro vínculo de staff (multi-org preservado — quem
--      trabalha em outro clube nunca perde o acesso);
--   2) não é administrador da plataforma;
--   3) não há histórico de auditoria apontando para ela (created_by e afins).
--
-- O item (3) é tratado por exceção: várias colunas de auditoria referenciam
-- auth.users e `tournaments.created_by` é NOT NULL, então apagar quebraria o
-- rastro de autoria. Nesse caso a conta é PRESERVADA e a exclusão da org segue
-- normalmente — nunca falha por causa da limpeza de contas.
--
-- O retorno ganha `accounts_removed` para a UI informar o que foi removido.
-- ============================================================================

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

    -- Quem tinha acesso a esta org (capturado ANTES de apagar os vínculos).
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

    -- Contas que ficaram órfãs: remove, preservando quem ainda tem vínculo,
    -- admins da plataforma e quem deixou histórico de auditoria.
    FOREACH v_u IN ARRAY v_users LOOP
        CONTINUE WHEN EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = v_u);
        CONTINUE WHEN EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.auth_user_id = v_u);
        BEGIN
            DELETE FROM auth.users WHERE id = v_u;
            v_removed := v_removed + 1;
        EXCEPTION WHEN others THEN
            -- FK de auditoria (created_by...) ou falta de permissão: mantém a
            -- conta. A exclusão da organização NUNCA falha por isso.
            NULL;
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'organization', v_name,
        'deleted', v_del,
        'accounts_removed', v_removed
    );
END $function$;
