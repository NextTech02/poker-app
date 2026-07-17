-- SaaS Fase 1 — Fundação do multi-tenant (ADITIVA, não muda comportamento).
--
-- Cria a tabela `organizations` e adiciona `organization_id` em TODAS as tabelas
-- de dados, com backfill dos dados existentes para a Org #1.
--
-- Por que organization_id desnormalizado em toda tabela (e não derivado por join
-- a partir de stages)? Porque o RLS da Fase 3 vai comparar organization_id com o
-- claim do JWT em CADA linha — um join/subquery por linha seria caro e frágil.
--
-- Nesta fase NADA lê a coluna ainda: o app continua funcionando igual. As fases
-- seguintes ligam o claim no JWT (2), o RLS de verdade (3) e o filtro no
-- backend/frontend (4).
--
-- Reversível: DROP da coluna em cada tabela + DROP TABLE organizations.

CREATE TABLE IF NOT EXISTS public.organizations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'suspended', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deny-by-default: só a service_role (backend) enxerga por enquanto.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- Org #1 = os dados que já existem hoje. O nome pode ser trocado com um UPDATE.
INSERT INTO public.organizations (name, slug)
VALUES ('NextHub', 'nexthub')
ON CONFLICT (slug) DO NOTHING;

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
    IF org IS NULL THEN
        RAISE EXCEPTION 'Org #1 (nexthub) não encontrada — abortando.';
    END IF;

    FOREACH t IN ARRAY tbls LOOP
        -- 1) coluna (nullable primeiro, para o backfill)
        EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS organization_id UUID', t);

        -- 2) backfill: tudo que existe hoje pertence à Org #1
        EXECUTE format('UPDATE public.%I SET organization_id = %L WHERE organization_id IS NULL', t, org);

        -- 3) trava: a partir daqui toda linha nasce com dono
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL', t);

        -- 4) FK (idempotente). RESTRICT: apagar org com dados é erro, não cascata silenciosa.
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = t || '_organization_id_fkey'
              AND conrelid = format('public.%I', t)::regclass
        ) THEN
            EXECUTE format(
                'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (organization_id) '
                'REFERENCES public.organizations(id) ON DELETE RESTRICT',
                t, t || '_organization_id_fkey');
        END IF;

        -- 5) índice: o RLS filtra por organization_id em toda query
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(organization_id)',
                       'idx_' || t || '_organization_id', t);
    END LOOP;
END $$;

-- Singletons deixam de ser "uma linha global" e passam a ser UM POR ORGANIZAÇÃO.
CREATE UNIQUE INDEX IF NOT EXISTS uq_general_cash_register_org ON public.general_cash_register(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rake_register_org         ON public.rake_register(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_settings_org          ON public.app_settings(organization_id);
