-- ============================================================================
-- MÓDULOS: torneio × cash game  (Fase 0 do módulo de Cash Game)
-- ----------------------------------------------------------------------------
-- O sistema nasceu só com torneio. O cash game é um módulo IRMÃO: o clube pode
-- contratar um, o outro ou os dois, e escolhe qual acessar ao entrar.
--
-- POR QUE UMA TABELA, E NÃO UMA COLUNA EM `plans`:
--   `plans` responde "QUANTO você pode usar" (usuários, torneios/mês, mesas).
--   Módulo responde "O QUE você contratou". São eixos independentes — existe
--   clube `free` que só faz cash e clube `pro` que só faz torneio. Amarrar os
--   dois obrigaria a criar um plano novo a cada combinação.
--   O limite QUANTITATIVO de cash (mesas simultâneas) fica no eixo certo:
--   `plans.max_cash_tables`, lido por `org_limit(p_org,'cash_tables')`.
--
-- POR QUE NÃO É CLAIM NO JWT:
--   Módulo NÃO é fronteira de isolamento de dados — isso continua sendo
--   `organization_id` + RLS. Módulo é entitlement comercial + roteamento de UI.
--   Pôr no claim significaria mexer no `custom_access_token_hook`, que roda em
--   TODO login (e por isso tem `EXCEPTION WHEN OTHERS THEN RETURN event`), e
--   obrigaria um `refreshSession()` a cada contratação. O frontend lê os
--   módulos junto de GET /staff/me/permissions, que ele já chama uma vez.
--
-- GRANDFATHERING: toda organização existente recebe 'tournament'. Ninguém que
-- usa o sistema hoje percebe qualquer diferença.
-- ============================================================================

-- ── 1) Entitlement por organização ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.org_modules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL DEFAULT public.current_org_id()
                    REFERENCES public.organizations(id) ON DELETE CASCADE,
    module          TEXT NOT NULL CHECK (module IN ('tournament','cash')),
    enabled         BOOLEAN NOT NULL DEFAULT true,
    activated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, module)
);

CREATE INDEX IF NOT EXISTS idx_org_modules_organization_id
    ON public.org_modules(organization_id);

COMMENT ON TABLE public.org_modules IS
  'Quais módulos (tournament/cash) a organização contratou. Entitlement comercial, NÃO fronteira de segurança: o isolamento entre clubes continua sendo organization_id + RLS.';

-- Grandfathering: quem já usa o sistema hoje faz torneio.
INSERT INTO public.org_modules (organization_id, module, enabled)
SELECT id, 'tournament', true FROM public.organizations
ON CONFLICT (organization_id, module) DO NOTHING;


-- ── 2) Limite quantitativo de mesas de cash ─────────────────────────────────
-- Sem isto, o plano `free` (que limita 4 torneios/mês) seria gratuito e
-- ILIMITADO para um clube que só faz cash. A métrica é MESAS ABERTAS AO MESMO
-- TEMPO, que é o que corresponde ao tamanho da operação. NULL = ilimitado.
ALTER TABLE public.plans ADD COLUMN IF NOT EXISTS max_cash_tables INT;

UPDATE public.plans SET max_cash_tables = CASE code
    WHEN 'free'     THEN 2
    WHEN 'standard' THEN 8
    ELSE NULL
END;

COMMENT ON COLUMN public.plans.max_cash_tables IS
  'Mesas de cash game abertas SIMULTANEAMENTE. NULL = ilimitado.';

-- `org_limit` ganha o novo tipo. Corpo copiado de
-- database_migration_saas_plans_limits.sql (não dá para alterar só o CASE).
CREATE OR REPLACE FUNCTION public.org_limit(p_org uuid, p_kind text)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT CASE p_kind
    WHEN 'users'             THEN COALESCE(o.max_users_override, p.max_users)
    WHEN 'tournaments_month' THEN p.max_tournaments_month
    WHEN 'tables_tournament' THEN p.max_tables_tournament
    WHEN 'clients'           THEN p.max_clients
    WHEN 'cash_tables'       THEN p.max_cash_tables
  END
  FROM public.organizations o
  JOIN public.plans p ON p.code = o.plan_code
  WHERE o.id = p_org;
$fn$;


-- ── 3) Helpers de leitura ───────────────────────────────────────────────────
-- SECURITY INVOKER, e não DEFINER: database_migration_saas_phase5_fix_definer_leak.sql
-- documenta o vazamento REAL que DEFINER causou aqui (o dashboard de um clube
-- novo mostrava o faturamento de outro).
CREATE OR REPLACE FUNCTION public.org_has_module(p_org uuid, p_module text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.org_modules
     WHERE organization_id = p_org AND module = p_module AND enabled
  );
$fn$;

CREATE OR REPLACE FUNCTION public.org_modules_list(p_org uuid)
RETURNS text[]
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $fn$
  SELECT COALESCE(array_agg(module ORDER BY module), ARRAY[]::text[])
    FROM public.org_modules
   WHERE organization_id = p_org AND enabled;
$fn$;


-- ── 4) Toda organização nova nasce com pelo menos um módulo ─────────────────
-- Fail-safe: uma org sem nenhuma linha aqui teria a sidebar vazia e nenhuma
-- rota acessível. O trigger garante o piso; quem vende o módulo de cash liga
-- a linha correspondente pelo painel do platform admin.
CREATE OR REPLACE FUNCTION public.org_modules_seed_default()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
    INSERT INTO public.org_modules (organization_id, module, enabled)
    VALUES (NEW.id, 'tournament', true)
    ON CONFLICT (organization_id, module) DO NOTHING;
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_org_modules_seed_default ON public.organizations;
CREATE TRIGGER trg_org_modules_seed_default
    AFTER INSERT ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION public.org_modules_seed_default();


-- ── 5) RLS, no padrão InitPlan ──────────────────────────────────────────────
-- A subquery `(SELECT public.current_org_id())` é OBRIGATÓRIA: ela vira um
-- InitPlan, avaliado 1x por statement. A forma `can_access_org(organization_id)`
-- foi medida em 340x o baseline (ver database_migration_saas_rls_performance.sql).
ALTER TABLE public.org_modules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_modules_org_isolation ON public.org_modules;
CREATE POLICY org_modules_org_isolation ON public.org_modules
FOR ALL TO authenticated
USING (
  organization_id = (SELECT public.current_org_id())
  OR (SELECT public.is_platform_admin())
)
WITH CHECK (
  organization_id = (SELECT public.current_org_id())
  OR (SELECT public.is_platform_admin())
);


-- ── 6) Permissões novas do módulo cash ──────────────────────────────────────
-- Mesmo template de database_migration_ticket_master_permission.sql:
--   (a) BACKFILL de quem já administra o clube — sem isso o DONO perde acesso
--       a um recurso novo no instante do deploy;
--   (b) CREATE OR REPLACE do provision_organization inteiro com as chaves em
--       v_all_perms (não dá para alterar só o array).
--
--   cash.operate  sentar/levantar jogador, buy-in, rebuy, cash-out, fila
--   cash.tables   abrir/fechar/configurar mesa, apurar rake
--   cash.day      abrir/fechar o dia de operação
--   cash.reports  relatórios e faturamento diário
--   cash.admin    modalidades (stakes/rake/jackpot), jackpot, cancelamentos
UPDATE public.permission_groups
   SET permissions = permissions
        || ARRAY['cash.operate','cash.tables','cash.day','cash.reports','cash.admin']::text[],
       updated_at  = now()
 WHERE 'employees' = ANY(permissions)
   AND NOT ('cash.operate' = ANY(permissions));


-- 6.1) Cargos padrão ganham o "Cash", traduzido. Corpo copiado de
--      database_migration_idioma_por_organizacao.sql com a linha nova.
CREATE OR REPLACE FUNCTION public.cargos_padrao(p_language text DEFAULT 'pt-BR')
RETURNS TABLE(nome text, descricao text, permissoes text[], eh_admin boolean)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
  WITH escolhido AS (
    SELECT CASE WHEN COALESCE(NULLIF(p_language, ''), 'pt-BR') IN ('pt-BR','en-US','es-ES')
                THEN COALESCE(NULLIF(p_language, ''), 'pt-BR')
                ELSE 'pt-BR' END AS idioma
  )
  SELECT t.nome, t.descricao, t.permissoes, t.eh_admin
    FROM (VALUES
      ('es-ES', 'Admin',   'Acceso total',              ARRAY[]::text[],                                                         true),
      ('es-ES', 'Cajero',  'Operación de caja',         ARRAY['cashier','cashier_tickets','cashier_players','prizes']::text[],   false),
      ('es-ES', 'Sangeur', 'Venta de fichas (sangeur)', ARRAY['sangi']::text[],                                                  false),
      ('es-ES', 'Cash',    'Operación de cash game',    ARRAY['cash.operate','cash.tables','cashbox.operate','players']::text[], false),
      ('en-US', 'Admin',   'Full access',               ARRAY[]::text[],                                                         true),
      ('en-US', 'Cashier', 'Cash desk operation',       ARRAY['cashier','cashier_tickets','cashier_players','prizes']::text[],   false),
      ('en-US', 'Sangeur', 'Chip sales (sangeur)',      ARRAY['sangi']::text[],                                                  false),
      ('en-US', 'Cash',    'Cash game floor',           ARRAY['cash.operate','cash.tables','cashbox.operate','players']::text[], false),
      ('pt-BR', 'Admin',   'Acesso total',              ARRAY[]::text[],                                                         true),
      ('pt-BR', 'Caixa',   'Operação de caixa',         ARRAY['cashier','cashier_tickets','cashier_players','prizes']::text[],   false),
      ('pt-BR', 'Sangeur', 'Venda de fichas (sangeur)', ARRAY['sangi']::text[],                                                  false),
      ('pt-BR', 'Cash',    'Operação de cash game',     ARRAY['cash.operate','cash.tables','cashbox.operate','players']::text[], false)
    ) AS t(idioma, nome, descricao, permissoes, eh_admin), escolhido e
   WHERE t.idioma = e.idioma;
$fn$;

COMMENT ON FUNCTION public.cargos_padrao(text) IS
  'Cargos padrão de uma organização nova, no idioma dela. O cargo "Cash" só serve a quem contratou o módulo de cash game — mas criá-lo sempre é mais barato do que criar depois, e um grupo que ninguém usa não dá acesso a nada.';


-- ── 7) Organizações NOVAS já nascem com as permissões de cash ───────────────
-- CREATE OR REPLACE do corpo inteiro, copiado de
-- database_migration_idioma_por_organizacao.sql, com as chaves novas em
-- v_all_perms e o parâmetro p_modules no fim.
--
-- SOBRE p_modules: entra com DEFAULT no fim, então toda chamada existente
-- (8 argumentos) continua resolvendo para esta função. O deploy não é atômico:
-- por um tempo o backend antigo ainda chama sem os módulos, e criar organização
-- não pode quebrar nesse intervalo. NULL = mantém o que o trigger semeou
-- (só torneio).
CREATE OR REPLACE FUNCTION public.provision_organization(
    p_org_name    text,
    p_org_slug    text,
    p_auth_user   uuid,
    p_admin_name  text,
    p_admin_email text,
    p_currency    text DEFAULT 'BRL'::text,
    p_plan        text DEFAULT 'free'::text,
    p_language    text DEFAULT 'pt-BR'::text,
    p_modules     text[] DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid; v_group uuid;
    v_trial_days int; v_trial_ends timestamptz;
    v_idioma text := CASE WHEN COALESCE(NULLIF(p_language, ''), 'pt-BR') IN ('pt-BR','en-US','es-ES')
                          THEN COALESCE(NULLIF(p_language, ''), 'pt-BR') ELSE 'pt-BR' END;
    v_all_perms text[] := ARRAY['dashboard','stages','tournaments','players','cashier',
      'cashier_players','cashier_tickets','prizes','prizes_release','financial','reports',
      'general_cash','rankings','blinds','tables','broadcast','employees',
      'cashbox.operate','cashbox.admin','sangi','cashier_tickets.master',
      'cash.operate','cash.tables','cash.day','cash.reports','cash.admin'];
BEGIN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_auth_user) THEN
        RAISE EXCEPTION 'Usuario % nao existe em auth.users', p_auth_user;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.plans WHERE code = p_plan) THEN
        RAISE EXCEPTION 'Plano % invalido', p_plan;
    END IF;
    SELECT trial_days INTO v_trial_days FROM public.plans WHERE code = p_plan;
    IF v_trial_days IS NOT NULL THEN
        v_trial_ends := now() + (v_trial_days || ' days')::interval;
    END IF;

    INSERT INTO public.organizations (name, slug, plan_code, plan_started_at, trial_ends_at)
    VALUES (p_org_name, p_org_slug, p_plan, now(), v_trial_ends) RETURNING id INTO v_org;

    -- Módulos contratados. O trigger já semeou 'tournament'; se o cliente
    -- comprou outra combinação, ela manda.
    IF p_modules IS NOT NULL AND array_length(p_modules, 1) > 0 THEN
        INSERT INTO public.org_modules (organization_id, module, enabled)
        SELECT v_org, m, true FROM unnest(p_modules) AS m
        ON CONFLICT (organization_id, module) DO UPDATE SET enabled = true, updated_at = now();
        UPDATE public.org_modules SET enabled = false, updated_at = now()
         WHERE organization_id = v_org AND NOT (module = ANY(p_modules));
    END IF;

    -- O Admin recebe TODAS as permissões; os demais, as suas. O nome e a
    -- descrição vêm traduzidos de cargos_padrao().
    INSERT INTO public.permission_groups (name, description, permissions, organization_id)
    SELECT c.nome, c.descricao, v_all_perms, v_org
      FROM public.cargos_padrao(v_idioma) c WHERE c.eh_admin
    RETURNING id INTO v_group;

    INSERT INTO public.permission_groups (name, description, permissions, organization_id)
    SELECT c.nome, c.descricao, c.permissoes, v_org
      FROM public.cargos_padrao(v_idioma) c WHERE NOT c.eh_admin;

    INSERT INTO public.staff (auth_user_id, name, email, permission_group_id, active, organization_id)
    VALUES (p_auth_user, p_admin_name, p_admin_email, v_group, true, v_org);

    INSERT INTO public.app_settings (currency, language, organization_id)
    VALUES (p_currency, v_idioma, v_org);

    INSERT INTO public.general_cash_register (current_balance, total_received, organization_id) VALUES (0,0,v_org);
    INSERT INTO public.rake_register (total_rake, organization_id) VALUES (0, v_org);

    INSERT INTO public.payment_methods (code, label, active, sort_order, organization_id)
    SELECT f.codigo, f.rotulo, true, f.ordem, v_org
      FROM public.formas_pagamento_padrao(v_idioma) f;

    RETURN v_org;
END $function$;

COMMENT ON FUNCTION public.provision_organization(text, text, uuid, text, text, text, text, text, text[]) IS
  'Cria uma organização completa. p_modules define os módulos contratados (tournament/cash); NULL mantém o padrão semeado pelo trigger (só torneio).';


-- ── 8) Conferência ──────────────────────────────────────────────────────────
-- Toda org tem ao menos um módulo habilitado?  Deve retornar 0 linhas.
--   SELECT o.id, o.name FROM public.organizations o
--    WHERE NOT EXISTS (SELECT 1 FROM public.org_modules m
--                       WHERE m.organization_id = o.id AND m.enabled);
--
-- Ligar o cash para um clube:
--   INSERT INTO public.org_modules (organization_id, module, enabled)
--   VALUES ('<org-uuid>', 'cash', true)
--   ON CONFLICT (organization_id, module) DO UPDATE SET enabled = true;
