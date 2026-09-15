-- ============================================================================
-- Permissão `access_log`: quem pode ver o log de acessos e atividade
-- ----------------------------------------------------------------------------
-- O log (database_migration_activity_logs.sql) mostra o que CADA funcionário
-- fez e de onde entrou. É assunto do dono do clube — não de quem opera o caixa.
--
-- Só que "dono do clube" não existe como flag: o `is_admin` do backend vale
-- apenas para o super-admin da PLATAFORMA (conta sem linha em `staff`), nunca
-- para o admin da organização, que tem linha em `staff` com o grupo 'Admin'.
-- Mesmo caminho de `cashier_tickets.master`: chave própria, concedida a quem
-- já administra a equipe (`employees`), e que o clube pode dar ou tirar de
-- qualquer grupo pela tela de Funcionários.
-- ============================================================================

-- 1) Backfill: todo grupo que já administra a equipe passa a ver o log. Sem
--    isso o dono do clube perderia acesso a um recurso novo no deploy.
UPDATE public.permission_groups
   SET permissions = array_append(permissions, 'access_log'),
       updated_at  = now()
 WHERE 'employees' = ANY(permissions)
   AND NOT ('access_log' = ANY(permissions));

-- 2) Organizações NOVAS já nascem com a chave no grupo Admin. Mesma assinatura
--    da versão atual (9 parâmetros) — é CREATE OR REPLACE de verdade, não uma
--    segunda função (ver database_migration_fix_provision_organization_ambigua.sql).
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
      'access_log'];
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

-- Verificação:
-- SELECT count(*) FROM pg_proc WHERE proname = 'provision_organization';        -- 1
-- SELECT name FROM permission_groups WHERE NOT ('access_log' = ANY(permissions)) AND 'employees' = ANY(permissions); -- 0 linhas
