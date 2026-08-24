-- ============================================================================
-- Idioma por organização
-- ============================================================================
-- Já APLICADA em produção (Supabase), nesta ordem, em 24/08/2026. O arquivo
-- existe para o histórico e para reconstruir o banco do zero.
--
-- O PROBLEMA: o i18next traduz a INTERFACE. Os nomes dos cargos e das formas de
-- pagamento não são interface — são DADO, gravado no banco no momento em que a
-- organização é criada, e sempre em português. Um clube colombiano abria a tela
-- de Funcionários e lia "Caixa / Operacao de caixa", e o Caixa oferecia
-- "Cartao" e "Transferencia" (sem acento, ainda por cima).
--
-- A SAÍDA: a organização passa a ter idioma, escolhido na criação junto com a
-- moeda. O texto padrão sai de duas funções — uma para cargos, outra para
-- formas de pagamento — em vez de estar cravado dentro do provisionamento.
--
-- O idioma do clube é o PADRÃO, não uma prisão: quem trabalha num clube
-- colombiano e prefere a interface em inglês continua podendo escolher, e a
-- escolha da pessoa ganha (ver frontend/src/utils/idiomaDoUsuario.js).
-- ============================================================================


-- ── 1) A coluna ─────────────────────────────────────────────────────────────
-- Fica em app_settings junto de `currency` porque é a mesma natureza: uma
-- preferência do clube, uma linha por organização.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS language VARCHAR(5) NOT NULL DEFAULT 'pt-BR';

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_language_check;
ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_language_check
  CHECK (language IN ('pt-BR', 'en-US', 'es-ES'));

COMMENT ON COLUMN public.app_settings.language IS
  'Idioma padrão do clube (pt-BR, en-US, es-ES). Define o texto dos cargos criados no provisionamento e o idioma inicial da interface. A escolha explícita do usuário tem precedência.';


-- ── 2) Cargos padrão, traduzidos ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cargos_padrao(p_language text DEFAULT 'pt-BR')
RETURNS TABLE(nome text, descricao text, permissoes text[], eh_admin boolean)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  WITH escolhido AS (
    -- Idioma desconhecido cai no português em vez de devolver nada: um clube
    -- sem cargo nenhum não consegue nem cadastrar o primeiro funcionário.
    SELECT CASE WHEN COALESCE(NULLIF(p_language, ''), 'pt-BR') IN ('pt-BR','en-US','es-ES')
                THEN COALESCE(NULLIF(p_language, ''), 'pt-BR')
                ELSE 'pt-BR' END AS idioma
  )
  SELECT t.nome, t.descricao, t.permissoes, t.eh_admin
    FROM (VALUES
      ('es-ES', 'Admin',   'Acceso total',              ARRAY[]::text[],                                                        true),
      ('es-ES', 'Cajero',  'Operación de caja',         ARRAY['cashier','cashier_tickets','cashier_players','prizes']::text[],  false),
      ('es-ES', 'Sangeur', 'Venta de fichas (sangeur)', ARRAY['sangi']::text[],                                                 false),
      ('en-US', 'Admin',   'Full access',               ARRAY[]::text[],                                                        true),
      ('en-US', 'Cashier', 'Cash desk operation',       ARRAY['cashier','cashier_tickets','cashier_players','prizes']::text[],  false),
      ('en-US', 'Sangeur', 'Chip sales (sangeur)',      ARRAY['sangi']::text[],                                                 false),
      ('pt-BR', 'Admin',   'Acesso total',              ARRAY[]::text[],                                                        true),
      ('pt-BR', 'Caixa',   'Operação de caixa',         ARRAY['cashier','cashier_tickets','cashier_players','prizes']::text[],  false),
      ('pt-BR', 'Sangeur', 'Venda de fichas (sangeur)', ARRAY['sangi']::text[],                                                 false)
    ) AS t(idioma, nome, descricao, permissoes, eh_admin), escolhido e
   WHERE t.idioma = e.idioma;
$$;

COMMENT ON FUNCTION public.cargos_padrao(text) IS
  'Cargos padrão de uma organização nova, no idioma dela. O texto mora aqui, num lugar só — antes estava cravado em português (e sem acento) dentro de provision_organization. Idioma desconhecido cai no português: clube sem cargo não cadastra funcionário.';


-- ── 3) Formas de pagamento padrão, traduzidas ───────────────────────────────
-- O CÓDIGO (cash/card/pix/transfer) é identificador e NÃO se traduz — é o que o
-- sistema grava na venda. Só o rótulo muda.
--
-- PIX é nome próprio de um sistema brasileiro: fica "PIX" nos três idiomas.
CREATE OR REPLACE FUNCTION public.formas_pagamento_padrao(p_language text DEFAULT 'pt-BR')
RETURNS TABLE(codigo text, rotulo text, ordem int)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  WITH escolhido AS (
    SELECT CASE WHEN COALESCE(NULLIF(p_language, ''), 'pt-BR') IN ('pt-BR','en-US','es-ES')
                THEN COALESCE(NULLIF(p_language, ''), 'pt-BR')
                ELSE 'pt-BR' END AS idioma
  )
  SELECT t.codigo, t.rotulo, t.ordem
    FROM (VALUES
      ('es-ES', 'cash',     'Efectivo',      1),
      ('es-ES', 'card',     'Tarjeta',       2),
      ('es-ES', 'pix',      'PIX',           3),
      ('es-ES', 'transfer', 'Transferencia', 4),
      ('en-US', 'cash',     'Cash',          1),
      ('en-US', 'card',     'Card',          2),
      ('en-US', 'pix',      'PIX',           3),
      ('en-US', 'transfer', 'Transfer',      4),
      ('pt-BR', 'cash',     'Dinheiro',      1),
      ('pt-BR', 'card',     'Cartão',        2),
      ('pt-BR', 'pix',      'PIX',           3),
      ('pt-BR', 'transfer', 'Transferência', 4)
    ) AS t(idioma, codigo, rotulo, ordem), escolhido e
   WHERE t.idioma = e.idioma;
$$;

COMMENT ON FUNCTION public.formas_pagamento_padrao(text) IS
  'Formas de pagamento padrão de uma organização nova, no idioma dela. O código (cash/card/pix/transfer) é identificador e não se traduz — só o rótulo.';


-- ── 4) O provisionamento passa a receber o idioma ───────────────────────────
-- SOBRE A ASSINATURA: `p_language` entra com DEFAULT no fim, então a chamada
-- antiga (7 argumentos nomeados) continua resolvendo para esta função. Isso
-- importa porque o deploy não é atômico: por um tempo o backend antigo ainda
-- chama sem o idioma, e criar organização não pode quebrar nesse intervalo.
DROP FUNCTION IF EXISTS public.provision_organization(text, text, uuid, text, text, text, text);

CREATE OR REPLACE FUNCTION public.provision_organization(
    p_org_name text,
    p_org_slug text,
    p_auth_user uuid,
    p_admin_name text,
    p_admin_email text,
    p_currency text DEFAULT 'BRL'::text,
    p_plan text DEFAULT 'free'::text,
    p_language text DEFAULT 'pt-BR'::text
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
      'cashbox.operate','cashbox.admin','sangi','cashier_tickets.master'];
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

COMMENT ON FUNCTION public.provision_organization(text, text, uuid, text, text, text, text, text) IS
  'Cria uma organização completa. p_language define o idioma dos cargos e das formas de pagamento — antes eram gravados em português para todo mundo.';

-- Sobrecarga morta de 6 argumentos (sem plano, sem idioma). Nada no código a
-- chamava, e mantê-la criaria ambiguidade de resolução com a nova versão.
DROP FUNCTION IF EXISTS public.provision_organization(text, text, uuid, text, text, text);


-- ── 5) Backfill dos clubes que já existem ───────────────────────────────────
-- A guarda é a igualdade EXATA com o texto padrão antigo. Quem renomeou o cargo
-- (um clube pode ter trocado "Caixa" por "Recepção") não é tocado: ali o texto
-- é decisão do cliente, não sobra do seed.
--
-- Nas formas de pagamento só o RÓTULO muda. O `code` é o que as vendas antigas
-- gravaram; mexer nele quebraria o histórico.

-- 5.1) Acentuação, para todo mundo que ainda tem o texto padrão.
UPDATE public.permission_groups SET description = 'Operação de caixa'
 WHERE description = 'Operacao de caixa';
UPDATE public.payment_methods SET label = 'Cartão'        WHERE label = 'Cartao';
UPDATE public.payment_methods SET label = 'Transferência' WHERE label = 'Transferencia';

-- 5.2) Tradução, só nos clubes cujo idioma configurado não é o português.
WITH clubes AS (
  SELECT organization_id, language FROM public.app_settings WHERE language <> 'pt-BR'
)
UPDATE public.permission_groups pg
   SET name = c.nome, description = c.descricao
  FROM clubes cl
  JOIN LATERAL public.cargos_padrao(cl.language) c ON true
 WHERE pg.organization_id = cl.organization_id
   AND ((pg.name = 'Admin'   AND pg.description = 'Acesso total'              AND c.eh_admin)
     OR (pg.name = 'Caixa'   AND pg.description = 'Operação de caixa'         AND c.permissoes @> ARRAY['cashier'])
     OR (pg.name = 'Sangeur' AND pg.description = 'Venda de fichas (sangeur)' AND c.permissoes @> ARRAY['sangi']));

WITH clubes AS (
  SELECT organization_id, language FROM public.app_settings WHERE language <> 'pt-BR'
)
UPDATE public.payment_methods pm
   SET label = f.rotulo
  FROM clubes cl
  JOIN LATERAL public.formas_pagamento_padrao(cl.language) f ON true
 WHERE pm.organization_id = cl.organization_id
   AND f.codigo = pm.code
   AND pm.label IN ('Dinheiro','Cartão','PIX','Transferência');
