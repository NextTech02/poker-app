-- SaaS — o mesmo usuário pode pertencer a VÁRIAS organizações.
--
-- Reverte a decisão inicial de "1 usuário = 1 organização". Caso de uso real:
-- a mesma pessoa administra/opera mais de um clube.
--
-- O que muda:
--   1. staff.auth_user_id deixa de ser UNIQUE global e passa a ser único POR
--      ORGANIZAÇÃO — um vínculo (staff) por clube, cada um com seu grupo de
--      permissão. As permissões, portanto, são por organização.
--   2. Passa a existir uma organização ATIVA por usuário (user_active_org).
--
-- Por que uma tabela de "org ativa" e não um header enviado pelo cliente?
-- Porque o RLS decide a partir do CLAIM do JWT, que é assinado pelo servidor de
-- auth. Um header seria controlado pelo cliente — o mesmo buraco do X-Stage-ID.
-- Trocar de organização exige, então, um TOKEN NOVO: o app grava a escolha aqui
-- e chama refreshSession(); o Auth Hook roda de novo e emite o token com a org
-- correta.

-- 1) Vínculo passa a ser por organização
ALTER TABLE public.staff DROP CONSTRAINT IF EXISTS staff_auth_user_id_key;
DROP INDEX IF EXISTS public.staff_auth_user_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS staff_auth_user_org_key
    ON public.staff (auth_user_id, organization_id);

-- 2) Organização ativa do usuário
CREATE TABLE IF NOT EXISTS public.user_active_org (
    auth_user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.user_active_org ENABLE ROW LEVEL SECURITY;
-- Sem policies: só service_role e as funções SECURITY DEFINER acessam.

-- 3) Auth Hook: usa a organização ativa, VALIDANDO o vínculo.
--    Se a escolha for inválida (perdeu acesso, org suspensa), cai para qualquer
--    vínculo válido — assim o usuário nunca fica preso sem organização.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    claims   jsonb;
    v_user   uuid;
    v_org    uuid;
    v_admin  boolean := false;
BEGIN
    claims := COALESCE(event->'claims', '{}'::jsonb);

    BEGIN
        v_user := (event->>'user_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
        RETURN event;
    END;

    -- (a) organização escolhida, se ainda for um vínculo válido e ativa
    SELECT s.organization_id INTO v_org
    FROM public.user_active_org ua
    JOIN public.staff s
      ON s.auth_user_id = ua.auth_user_id
     AND s.organization_id = ua.organization_id
     AND s.active = true
    JOIN public.organizations o
      ON o.id = s.organization_id AND o.status = 'active'
    WHERE ua.auth_user_id = v_user
    LIMIT 1;

    -- (b) fallback: qualquer vínculo ativo em organização ativa
    IF v_org IS NULL THEN
        SELECT s.organization_id INTO v_org
        FROM public.staff s
        JOIN public.organizations o ON o.id = s.organization_id AND o.status = 'active'
        WHERE s.auth_user_id = v_user AND s.active = true
        ORDER BY s.created_at
        LIMIT 1;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.platform_admins pa WHERE pa.auth_user_id = v_user
    ) INTO v_admin;

    IF v_org IS NOT NULL THEN
        claims := jsonb_set(claims, '{organization_id}', to_jsonb(v_org::text), true);
    ELSE
        claims := claims - 'organization_id';
    END IF;

    IF v_admin THEN
        claims := jsonb_set(claims, '{platform_admin}', 'true'::jsonb, true);
    ELSE
        claims := claims - 'platform_admin';
    END IF;

    RETURN jsonb_set(event, '{claims}', claims, true);
EXCEPTION WHEN OTHERS THEN
    RETURN event;   -- nunca impedir o login
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated, anon, public;

-- 4) Trocar de organização (valida o vínculo; o token novo vem do refresh)
CREATE OR REPLACE FUNCTION public.set_active_organization(p_user uuid, p_org uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.staff s
        JOIN public.organizations o ON o.id = s.organization_id AND o.status = 'active'
        WHERE s.auth_user_id = p_user AND s.organization_id = p_org AND s.active = true
    ) THEN
        RAISE EXCEPTION 'Usuário não pertence a esta organização (ou ela não está ativa).';
    END IF;

    INSERT INTO public.user_active_org (auth_user_id, organization_id, updated_at)
    VALUES (p_user, p_org, now())
    ON CONFLICT (auth_user_id)
    DO UPDATE SET organization_id = EXCLUDED.organization_id, updated_at = now();
END $$;

REVOKE EXECUTE ON FUNCTION public.set_active_organization(uuid, uuid) FROM public, anon, authenticated;

-- 5) Organizações do usuário (para o seletor)
CREATE OR REPLACE FUNCTION public.list_my_organizations(p_user uuid)
RETURNS TABLE(id uuid, name text, slug text, is_active_org boolean, group_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.id, o.name, o.slug,
         COALESCE(ua.organization_id = o.id, false) AS is_active_org,
         pg.name AS group_name
  FROM public.staff s
  JOIN public.organizations o ON o.id = s.organization_id AND o.status = 'active'
  LEFT JOIN public.permission_groups pg ON pg.id = s.permission_group_id
  LEFT JOIN public.user_active_org ua ON ua.auth_user_id = p_user
  WHERE s.auth_user_id = p_user AND s.active = true
  ORDER BY o.name
$$;

REVOKE EXECUTE ON FUNCTION public.list_my_organizations(uuid) FROM public, anon, authenticated;

-- 6) provision_organization deixa de recusar usuário que já tem organização
CREATE OR REPLACE FUNCTION public.provision_organization(
    p_org_name text, p_org_slug text, p_auth_user uuid,
    p_admin_name text, p_admin_email text, p_currency text DEFAULT 'BRL'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_org   uuid;
    v_group uuid;
    v_all_perms text[] := ARRAY[
        'dashboard','stages','tournaments','players','cashier','cashier_players',
        'cashier_tickets','prizes','prizes_release','financial','reports',
        'general_cash','rankings','blinds','tables','broadcast','employees',
        'cashbox.operate','cashbox.admin','sangi'
    ];
BEGIN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_auth_user) THEN
        RAISE EXCEPTION 'Usuário % não existe em auth.users', p_auth_user;
    END IF;
    -- multi-org: só recusa se JÁ pertencer A ESTA organização (não a qualquer uma)

    INSERT INTO public.organizations (name, slug) VALUES (p_org_name, p_org_slug)
    RETURNING id INTO v_org;

    INSERT INTO public.permission_groups (name, description, permissions, organization_id)
    VALUES ('Admin', 'Acesso total', v_all_perms, v_org)
    RETURNING id INTO v_group;

    INSERT INTO public.permission_groups (name, description, permissions, organization_id) VALUES
      ('Caixa',  'Operação de caixa',        ARRAY['cashier','cashier_tickets','cashier_players','prizes'], v_org),
      ('Sanger', 'Venda de fichas (sanger)', ARRAY['sangi'], v_org);

    INSERT INTO public.staff (auth_user_id, name, email, permission_group_id, active, organization_id)
    VALUES (p_auth_user, p_admin_name, p_admin_email, v_group, true, v_org);

    INSERT INTO public.app_settings (currency, organization_id) VALUES (p_currency, v_org);
    INSERT INTO public.general_cash_register (current_balance, total_received, organization_id) VALUES (0, 0, v_org);
    INSERT INTO public.rake_register (total_rake, organization_id) VALUES (0, v_org);

    INSERT INTO public.payment_methods (code, label, active, sort_order, organization_id) VALUES
      ('cash','Dinheiro',true,1,v_org), ('card','Cartão',true,2,v_org),
      ('pix','PIX',true,3,v_org), ('transfer','Transferência',true,4,v_org);

    RETURN v_org;
END $$;

REVOKE EXECUTE ON FUNCTION public.provision_organization(text,text,uuid,text,text,text) FROM public, anon, authenticated;
