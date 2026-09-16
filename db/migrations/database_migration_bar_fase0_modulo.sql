-- ============================================================================
-- MÓDULO DE BAR — Fase 0: o terceiro módulo (`bar`) e as suas permissões
-- ----------------------------------------------------------------------------
-- O clube vende bebida e comida aos jogadores ao longo da noite e cobra no
-- fim, por COMANDA. Hoje isso roda em caderno ou em sistema de terceiros.
--
-- O bar é o TERCEIRO módulo de `org_modules`, irmão do torneio e do cash: o
-- clube contrata o que quiser e escolhe qual acessar ao entrar. Mesmo desenho
-- de database_migration_cash_fase0_modulos.sql — entitlement por organização,
-- NÃO claim no JWT e NÃO fronteira de isolamento (isso continua sendo
-- organization_id + RLS).
--
-- Esta fase é INVISÍVEL para quem não contratou: nenhuma org recebe 'bar'
-- aqui. Ligar é decisão comercial (painel do platform admin ou o INSERT da
-- seção de conferência).
--
-- ORDEM: aplicar DEPOIS de database_migration_cash_fase0_modulos.sql e de
-- database_migration_access_log_permission.sql (é a versão mais recente de
-- provision_organization que este arquivo recria). Reaplicável.
-- ============================================================================

DO $guard$ BEGIN
  IF to_regclass('public.org_modules') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cash_fase0_modulos.sql';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'provision_organization'
       AND pg_get_function_identity_arguments(p.oid) LIKE '%p_modules%'
  ) THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cash_fase0_modulos.sql (provision_organization com p_modules)';
  END IF;
END $guard$;


-- ── 1) 'bar' passa a ser um módulo válido ───────────────────────────────────
-- O CHECK nasceu inline e sem nome; o Postgres o batizou org_modules_module_check.
-- Mesmo DROP+ADD de cashbox_transactions_type_check (cash_fase1_core.sql).
ALTER TABLE public.org_modules DROP CONSTRAINT IF EXISTS org_modules_module_check;
ALTER TABLE public.org_modules ADD CONSTRAINT org_modules_module_check
  CHECK (module IN ('tournament','cash','bar'));

COMMENT ON TABLE public.org_modules IS
  'Quais módulos (tournament/cash/bar) a organização contratou. Entitlement comercial, NÃO fronteira de segurança: o isolamento entre clubes continua sendo organization_id + RLS.';


-- ── 2) Permissões do módulo de bar ──────────────────────────────────────────
-- Mesmo template de database_migration_ticket_master_permission.sql:
--   (a) BACKFILL de quem já administra o clube — sem isso o DONO perde acesso
--       a um recurso novo no instante do deploy;
--   (b) CREATE OR REPLACE do provision_organization inteiro com as chaves em
--       v_all_perms (não dá para alterar só o array).
--
--   bar.operate  abrir comanda, lançar/entregar/cancelar item pendente,
--                receber pagamento, fechar comanda
--   bar.shift    abrir/fechar o turno do bar
--   bar.admin    produtos, categorias, estoque, desconto/cortesia, estorno de
--                pagamento, reabrir/cancelar comanda, cancelar item entregue
--   bar.reports  relatórios do bar
UPDATE public.permission_groups
   SET permissions = permissions
        || ARRAY['bar.operate','bar.shift','bar.admin','bar.reports']::text[],
       updated_at  = now()
 WHERE 'employees' = ANY(permissions)
   AND NOT ('bar.operate' = ANY(permissions));


-- 2.1) Cargos padrão ganham o "Bar", traduzido. Corpo copiado de
--      database_migration_cash_fase0_modulos.sql com a linha nova.
--      O barman precisa de `cashbox.operate` (a gaveta dele é um `cashboxes`
--      ancorado no turno) e de `players` (a comanda é sempre de um jogador
--      cadastrado — ele precisa achar e, se for o caso, cadastrar).
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
      ('es-ES', 'Bar',     'Operación del bar',         ARRAY['bar.operate','cashbox.operate','players']::text[],                false),
      ('en-US', 'Admin',   'Full access',               ARRAY[]::text[],                                                         true),
      ('en-US', 'Cashier', 'Cash desk operation',       ARRAY['cashier','cashier_tickets','cashier_players','prizes']::text[],   false),
      ('en-US', 'Sangeur', 'Chip sales (sangeur)',      ARRAY['sangi']::text[],                                                  false),
      ('en-US', 'Cash',    'Cash game floor',           ARRAY['cash.operate','cash.tables','cashbox.operate','players']::text[], false),
      ('en-US', 'Bar',     'Bar operation',             ARRAY['bar.operate','cashbox.operate','players']::text[],                false),
      ('pt-BR', 'Admin',   'Acesso total',              ARRAY[]::text[],                                                         true),
      ('pt-BR', 'Caixa',   'Operação de caixa',         ARRAY['cashier','cashier_tickets','cashier_players','prizes']::text[],   false),
      ('pt-BR', 'Sangeur', 'Venda de fichas (sangeur)', ARRAY['sangi']::text[],                                                  false),
      ('pt-BR', 'Cash',    'Operação de cash game',     ARRAY['cash.operate','cash.tables','cashbox.operate','players']::text[], false),
      ('pt-BR', 'Bar',     'Operação do bar',           ARRAY['bar.operate','cashbox.operate','players']::text[],                false)
    ) AS t(idioma, nome, descricao, permissoes, eh_admin), escolhido e
   WHERE t.idioma = e.idioma;
$fn$;

COMMENT ON FUNCTION public.cargos_padrao(text) IS
  'Cargos padrão de uma organização nova, no idioma dela. "Cash" e "Bar" só servem a quem contratou o módulo — mas criá-los sempre é mais barato do que criar depois, e um grupo que ninguém usa não dá acesso a nada.';


-- ── 3) Organizações NOVAS já nascem com as permissões de bar ────────────────
-- MESMA assinatura de 9 parâmetros de database_migration_access_log_permission.sql
-- — é CREATE OR REPLACE de verdade, não uma segunda função (a lição de
-- database_migration_fix_provision_organization_ambigua.sql).
CREATE OR REPLACE FUNCTION public.provision_organization(
    p_org_name    text,
    p_org_slug    text,
    p_auth_user   uuid,
    p_admin_name  text,
    p_admin_email text,
    p_currency    text   DEFAULT 'BRL',
    p_plan        text   DEFAULT 'free',
    p_language    text   DEFAULT 'pt-BR',
    p_modules     text[] DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_org uuid; v_group uuid;
    v_trial_days int; v_trial_ends timestamptz;
    v_idioma text := CASE WHEN COALESCE(NULLIF(p_language, ''), 'pt-BR') IN ('pt-BR','en-US','es-ES')
                          THEN COALESCE(NULLIF(p_language, ''), 'pt-BR') ELSE 'pt-BR' END;
    -- Mesma lista de ALL_PERMISSIONS do backend (staff_service.py).
    v_all_perms text[] := ARRAY['dashboard','stages','tournaments','players','cashier',
      'cashier_players','cashier_tickets','prizes','prizes_release','financial','reports',
      'general_cash','rankings','blinds','tables','broadcast','employees',
      'cashbox.operate','cashbox.admin','sangi','cashier_tickets.master',
      'cash.operate','cash.tables','cash.day','cash.reports','cash.admin',
      'access_log',
      'bar.operate','bar.shift','bar.admin','bar.reports'];
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
END $$;


-- ── 4) Guarda de módulo para as tabelas-raiz do bar (chega na Fase 1) ───────
-- Definida já aqui para a Fase 1 só precisar pendurar os triggers. O prefixo
-- PLANO_LIMITE_ faz o _plan_limit_detail() do main.py devolver 409 com frase
-- amigável, sem tocar em nenhum service (padrão de enforce_cash_module).
CREATE OR REPLACE FUNCTION public.enforce_bar_module()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_org uuid;
BEGIN
    v_org := COALESCE(NEW.organization_id, current_org_id());
    IF v_org IS NULL THEN RETURN NEW; END IF;
    IF NOT public.org_has_module(v_org, 'bar') THEN
        RAISE EXCEPTION 'PLANO_LIMITE_MODULO_BAR: O módulo de bar não está contratado.';
    END IF;
    RETURN NEW;
END $fn$;


-- ── 5) Conferência ──────────────────────────────────────────────────────────
-- O CHECK aceita o módulo novo?  (deve devolver a linha com 'bar')
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'org_modules_module_check';
--
-- Continua havendo UMA provision_organization (9 argumentos)?
--   SELECT count(*) FROM pg_proc WHERE proname = 'provision_organization';        -- 1
--
-- Todo grupo que administra a equipe já tem bar.operate?  (0 linhas)
--   SELECT name FROM permission_groups WHERE 'employees' = ANY(permissions) AND NOT ('bar.operate' = ANY(permissions));
--
-- Ligar o bar para um clube:
--   INSERT INTO public.org_modules (organization_id, module, enabled)
--   VALUES ('<org-uuid>', 'bar', true)
--   ON CONFLICT (organization_id, module) DO UPDATE SET enabled = true;
