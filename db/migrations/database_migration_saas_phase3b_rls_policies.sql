-- SaaS Fase 3b — RLS de verdade: troca as políticas `USING(true)` por org scoping.
--
-- Antes: toda política era `USING(true)` => qualquer usuário autenticado lia e
-- escrevia TUDO. Como o frontend fala direto com o Supabase (anon/publishable
-- key) em várias telas, isso vazaria dados entre organizações no primeiro dia
-- de SaaS — e permitiria, por exemplo, debitar o caixa de outra empresa pelo
-- navegador.
--
-- Agora: `can_access_org(organization_id)` — a linha só é visível/gravável se
-- pertencer à organização do CLAIM do JWT (ou se for platform admin).
--   USING      -> filtra o que o usuário PODE VER/alterar
--   WITH CHECK -> impede gravar linha com organization_id de OUTRA org
--
-- O backend usa service_role, que ignora RLS por definição: nenhuma rota quebra.
-- O que esta migração protege é o acesso DIRETO com a chave pública.
--
-- ── Exceção deliberada: a TV pública ──────────────────────────────────────────
-- A tela de blinds (/broadcast, /tv) roda SEM login e é pública por design.
-- Ela depende de leitura anônima em:
--   * tournament_days e blinds  -> Realtime (postgres_changes respeita RLS)
--   * app_settings              -> moeda usada na formatação
-- Essas três mantêm SELECT liberado para anon. Escrita continua restrita por
-- org. Trade-off consciente: dados que já aparecem na TV continuam públicos.

DO $$
DECLARE
    t    text;
    pol  record;
    -- Tabelas 100% internas: acesso apenas da própria organização.
    internas text[] := ARRAY[
        'stages','players','tournaments','tournament_players','tournament_tables',
        'transactions','seat_allocations','stage_cash_register',
        'general_cash_register','rake_register','sangria_transactions',
        'prize_allocations','blind_templates','sponsors','player_credits',
        'credit_transactions','satellite_tickets','permission_groups','staff',
        'cashboxes','cashbox_sessions','cashbox_transactions','chip_consignments',
        'chip_consignment_sales','staff_payments','payment_methods','buy_types'
    ];
    -- Tabelas lidas pela TV pública (SELECT anon liberado, escrita por org).
    publicas text[] := ARRAY['tournament_days','blinds','app_settings'];
BEGIN
    -- Limpa TODAS as políticas antigas dessas tabelas (as USING(true)).
    FOREACH t IN ARRAY internas || publicas LOOP
        FOR pol IN SELECT policyname FROM pg_policies
                   WHERE schemaname='public' AND tablename=t LOOP
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, t);
        END LOOP;
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;

    -- Internas: uma política única cobrindo SELECT/INSERT/UPDATE/DELETE.
    FOREACH t IN ARRAY internas LOOP
        EXECUTE format($f$
            CREATE POLICY %I ON public.%I
            FOR ALL TO authenticated
            USING (public.can_access_org(organization_id))
            WITH CHECK (public.can_access_org(organization_id))
        $f$, t || '_org_isolation', t);
    END LOOP;

    -- Públicas: leitura anônima (TV) + acesso completo por org.
    FOREACH t IN ARRAY publicas LOOP
        EXECUTE format($f$
            CREATE POLICY %I ON public.%I
            FOR SELECT TO anon
            USING (true)
        $f$, t || '_public_read', t);

        EXECUTE format($f$
            CREATE POLICY %I ON public.%I
            FOR ALL TO authenticated
            USING (public.can_access_org(organization_id))
            WITH CHECK (public.can_access_org(organization_id))
        $f$, t || '_org_isolation', t);
    END LOOP;
END $$;
