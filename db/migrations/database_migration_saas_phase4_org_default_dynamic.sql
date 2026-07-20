-- SaaS Fase 4 — remove a muleta do DEFAULT fixo na Org #1.
--
-- A Fase 1b pôs `DEFAULT '<uuid da Org #1>'` em organization_id nas 31 tabelas,
-- porque o NOT NULL sem default quebrava todo INSERT do backend. Isso era uma
-- ARMADILHA para o multi-tenant: com mais de uma organização, um INSERT que
-- esquecesse a org cairia SILENCIOSAMENTE na Org #1 em vez de falhar.
--
-- Agora o default é dinâmico: `public.current_org_id()`, que lê o claim do JWT.
-- Cada linha nasce na organização de QUEM a criou. Isso só é possível porque a
-- Fase 4 fez o backend executar as queries como o usuário (antes, com
-- service_role, não havia claim e a função devolveria NULL).
--
-- Testado antes de aplicar (com rollback): INSERT sem organization_id herda a org
-- do claim, e os triggers que inserem em cascata (create_stage_cash_register,
-- mirror_transaction_to_cashbox) também recebem a org correta, porque rodam na
-- mesma sessão e enxergam o mesmo claim.
--
-- Efeito colateral desejado: sem claim (service_role puro), current_org_id() é
-- NULL e o INSERT falha no NOT NULL — em vez de gravar na org errada. Falhar
-- alto é melhor que corromper dados entre clientes.

DO $$
DECLARE
    t    text;
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
    FOREACH t IN ARRAY tbls LOOP
        EXECUTE format(
            'ALTER TABLE public.%I ALTER COLUMN organization_id SET DEFAULT public.current_org_id()', t);
    END LOOP;
END $$;
