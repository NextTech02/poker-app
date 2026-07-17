-- SaaS Fase 2 — Identidade: organization_id no JWT via Auth Hook.
--
-- O RLS da Fase 3 vai comparar organization_id de cada linha com um CLAIM do
-- token. O claim precisa vir do servidor de auth — nunca de um header enviado
-- pelo cliente (que é forjável). O Auth Hook da Supabase é uma função Postgres
-- chamada a cada emissão de token, que injeta claims derivados do banco.
--
-- ⚠️ Esta função roda em TODO login. Se ela levantar exceção, NINGUÉM loga.
-- Por isso ela é defensiva: qualquer erro -> devolve o event original intacto.
--
-- Depois de aplicar, é preciso HABILITAR o hook em:
--   Dashboard -> Authentication -> Hooks -> Customize Access Token (JWT) Claims
-- Rollback instantâneo: desabilitar o hook no dashboard.

-- ── Platform admins (NextHub) ───────────────────────────────────────────────
-- Quem pode atravessar organizações para dar suporte. Deliberadamente uma
-- TABELA (e não a env SUPER_ADMIN_USER_IDS) porque o hook roda no Postgres e
-- não enxerga variáveis de ambiente. A env continua valendo para o backend.
CREATE TABLE IF NOT EXISTS public.platform_admins (
    auth_user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
-- Sem policies: deny-by-default. Só service_role (backend) e o hook
-- (SECURITY DEFINER) enxergam. Um usuário comum não pode nem listar quem é admin.

INSERT INTO public.platform_admins (auth_user_id, note)
VALUES ('74061c25-3678-45d7-834a-eafc59147d3a', 'nexttech02@nexthubco.com — dono/NextHub')
ON CONFLICT (auth_user_id) DO NOTHING;

-- ── Auth Hook ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER          -- precisa ler staff/platform_admins ignorando RLS
SET search_path = public, pg_temp   -- evita search_path mutável (sequestro de função)
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
        RETURN event;  -- user_id ausente/inválido: não mexe no token
    END;

    -- Org do funcionário (só staff ATIVO recebe org).
    SELECT s.organization_id INTO v_org
    FROM public.staff s
    WHERE s.auth_user_id = v_user
      AND s.active = true
    LIMIT 1;

    SELECT EXISTS (
        SELECT 1 FROM public.platform_admins pa WHERE pa.auth_user_id = v_user
    ) INTO v_admin;

    -- Sempre reescreve os dois claims (nunca confia no que veio),
    -- e REMOVE quando não se aplica — senão um valor antigo poderia persistir.
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
    -- Blindagem: nenhum erro aqui pode impedir login.
    RETURN event;
END;
$$;

-- O hook é executado pelo servidor de auth, por ninguém mais.
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated, anon, public;
