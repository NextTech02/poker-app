-- PERFORMANCE do RLS — corrige lentidão introduzida pelo multi-tenant.
--
-- Sintoma relatado: tela de vendas (Caixa) muito lenta ao registrar venda, e as
-- demais telas mais lentas que antes.
--
-- Causa medida (não suposta):
--   baseline .............. 1,7 ms / 10.000 chamadas
--   current_org_id() .... 157,0 ms / 10.000
--   can_access_org() .... 580,3 ms / 10.000   <-- 340x o baseline
--
-- A política era `USING (can_access_org(organization_id))`. Como recebe uma
-- COLUNA como argumento, o Postgres precisa executá-la PARA CADA LINHA. Pior:
-- desde o controle de status (Fase 5), current_org_id() consulta a tabela
-- `organizations` — ou seja, era uma consulta por linha varrida. O plano
-- confirmava: `Filter: can_access_org(organization_id)` com "Rows Removed".
--
-- Correção (padrão consagrado de RLS no Postgres/Supabase): comparar a coluna
-- com o resultado de uma SUBQUERY. Assim o valor não depende da linha, o
-- planner o promove a InitPlan e avalia UMA VEZ por statement:
--
--   USING (organization_id = (SELECT current_org_id()) OR (SELECT is_platform_admin()))
--
-- Plano depois: `Filter: ((organization_id = (InitPlan 1).col1) OR (InitPlan 2).col1)`
-- com loops=1 — de O(linhas) para O(1).
--
-- A SEMÂNTICA é idêntica à de can_access_org(): mesma org OU platform admin, e
-- fail-closed quando não há claim (NULL nunca casa com organization_id NOT NULL).
-- O isolamento entre organizações continua exatamente o mesmo.

DO $$
DECLARE
    t    text;
    internas text[] := ARRAY[
        'stages','players','tournaments','tournament_players','tournament_tables',
        'transactions','seat_allocations','stage_cash_register',
        'general_cash_register','rake_register','sangria_transactions',
        'prize_allocations','blind_templates','sponsors','player_credits',
        'credit_transactions','satellite_tickets','permission_groups','staff',
        'cashboxes','cashbox_sessions','cashbox_transactions','chip_consignments',
        'chip_consignment_sales','staff_payments','payment_methods','buy_types'
    ];
    publicas text[] := ARRAY['tournament_days','blinds','app_settings'];
BEGIN
    FOREACH t IN ARRAY internas || publicas LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_isolation', t);
        EXECUTE format($f$
            CREATE POLICY %I ON public.%I
            FOR ALL TO authenticated
            USING (
              organization_id = (SELECT public.current_org_id())
              OR (SELECT public.is_platform_admin())
            )
            WITH CHECK (
              organization_id = (SELECT public.current_org_id())
              OR (SELECT public.is_platform_admin())
            )
        $f$, t || '_org_isolation', t);
    END LOOP;
END $$;
