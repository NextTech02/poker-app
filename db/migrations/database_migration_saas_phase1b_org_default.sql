-- SaaS Fase 1b — CORREÇÃO da Fase 1.
--
-- A Fase 1 colocou `organization_id NOT NULL` SEM DEFAULT. Como o backend ainda
-- não envia essa coluna, todo INSERT passou a violar o NOT NULL — quebrando
-- criação de torneio, registro de jogador, transações etc. Isto restaura o
-- funcionamento: enquanto o backend não setar a coluna explicitamente (Fase 4),
-- o DEFAULT aponta para a Org #1.
--
-- ⚠️ ESTE DEFAULT DEVE SER REMOVIDO NA FASE 4. Com mais de uma organização ele
-- vira armadilha: um INSERT que "esquecer" o organization_id cairia silenciosamente
-- na Org #1 em vez de falhar. O RLS da Fase 3 (WITH CHECK) já barra org errada,
-- mas o certo é o backend setar sempre a partir do claim do JWT e o DEFAULT sumir.
--
-- Verificado: POST /tournaments pela API voltou a funcionar e a linha nasceu com
-- organization_id = Org #1 (probe criada e removida).

DO $$
DECLARE
    t    text;
    org  uuid;
    tbls text[] := ARRAY[
        'stages','players','tournaments','tournament_days','tournament_players',
        'tournament_tables','transactions','blinds','seat_allocations',
        'stage_cash_register','general_cash_register','rake_register',
        'sangria_transactions','prize_allocations','blind_templates','sponsors',
        'player_credits','credit_transactions','satellite_tickets',
        'permission_groups','staff','cashboxes','cashbox_sessions',
        'cashbox_transactions','chip_consignments','chip_consignment_sales',
        'app_settings','staff_payments','payment_methods','buy_types',
        'sync_mutations'
    ];
BEGIN
    SELECT id INTO org FROM public.organizations WHERE slug = 'nexthub';
    IF org IS NULL THEN RAISE EXCEPTION 'Org #1 nao encontrada'; END IF;
    FOREACH t IN ARRAY tbls LOOP
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET DEFAULT %L', t, org);
    END LOOP;
END $$;
