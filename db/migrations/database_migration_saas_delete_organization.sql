-- SaaS — excluir definitivamente uma organização (e todos os seus dados).
--
-- Só permitido para organização NÃO ATIVA (suspensa/cancelada): obriga o
-- operador a suspender antes, o que já corta o acesso e dá uma chance de
-- perceber o engano. É DESTRUTIVO e IRREVERSÍVEL — apaga torneios, jogadores,
-- caixa, transações e histórico daquele cliente.
--
-- Todas as FKs de organization_id são ON DELETE RESTRICT (de propósito: evita
-- cascata silenciosa), então a exclusão precisa remover os filhos na ordem
-- certa. O grafo tem dois casos especiais:
--   * ciclo cashboxes <-> cashbox_sessions  -> zera o ponteiro antes
--   * auto-referência em tournament_days    -> zera qualifies_to_day_id antes
--
-- NÃO remove usuários do auth: a mesma pessoa pode pertencer a outra
-- organização (multi-org). Remove apenas os vínculos (staff) desta.

CREATE OR REPLACE FUNCTION public.delete_organization(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status text;
    v_name   text;
    v_t      text;
    v_del    jsonb := '{}'::jsonb;
    v_n      bigint;
    -- Ordem: filhos primeiro, pais depois.
    v_order  text[] := ARRAY[
        'cashbox_transactions',
        'prize_allocations',
        'transactions',
        'seat_allocations',
        'credit_transactions',
        'chip_consignment_sales',
        'satellite_tickets',
        'tournament_players',
        'blinds',
        'tournament_tables',
        'tournament_days',
        'tournaments',
        'player_credits',
        'chip_consignments',
        'staff_payments',
        'cashbox_sessions',
        'cashboxes',
        'stage_cash_register',
        'sangria_transactions',
        'blind_templates',
        'buy_types',
        'stages',
        'players',
        'sponsors',
        'staff',
        'permission_groups',
        'payment_methods',
        'app_settings',
        'general_cash_register',
        'rake_register',
        'sync_mutations'
    ];
BEGIN
    SELECT status, name INTO v_status, v_name FROM public.organizations WHERE id = p_org;
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'Organização não encontrada.';
    END IF;
    IF v_status = 'active' THEN
        RAISE EXCEPTION 'Suspenda a organização antes de excluí-la.';
    END IF;

    -- Quebra o ciclo cashboxes -> cashbox_sessions
    BEGIN
        EXECUTE 'UPDATE public.cashboxes SET current_session_id = NULL WHERE organization_id = $1' USING p_org;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;

    -- Quebra a auto-referência de tournament_days
    BEGIN
        EXECUTE 'UPDATE public.tournament_days SET qualifies_to_day_id = NULL WHERE organization_id = $1' USING p_org;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;

    FOREACH v_t IN ARRAY v_order LOOP
        EXECUTE format('DELETE FROM public.%I WHERE organization_id = $1', v_t) USING p_org;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN
            v_del := v_del || jsonb_build_object(v_t, v_n);
        END IF;
    END LOOP;

    DELETE FROM public.organizations WHERE id = p_org;

    RETURN jsonb_build_object('organization', v_name, 'deleted', v_del);
END $$;

REVOKE EXECUTE ON FUNCTION public.delete_organization(uuid) FROM public, anon, authenticated;
