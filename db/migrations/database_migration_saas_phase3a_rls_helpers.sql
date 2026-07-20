-- SaaS Fase 3a — Funções auxiliares do RLS.
--
-- Lêem os claims que o Auth Hook (Fase 2) injetou no JWT. São a base de TODAS
-- as políticas: o Postgres passa a decidir o acesso a partir de um valor
-- assinado pelo servidor de auth, que o cliente não consegue forjar.
--
-- STABLE + marcadas para o planner: o Postgres avalia uma vez por query, não
-- por linha — importante porque isso roda em toda leitura de toda tabela.

-- Organização do usuário atual (NULL se o token não tiver o claim).
CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT NULLIF(
    COALESCE(
      current_setting('request.jwt.claims', true)::jsonb ->> 'organization_id',
      ''
    ), ''
  )::uuid
$$;

-- Platform admin (NextHub) — atravessa organizações para dar suporte.
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (current_setting('request.jwt.claims', true)::jsonb ->> 'platform_admin')::boolean,
    false
  )
$$;

-- Predicado único usado por todas as políticas.
-- Fail-closed: sem claim de org e sem ser platform admin => nada é visível.
CREATE OR REPLACE FUNCTION public.can_access_org(row_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT row_org IS NOT NULL
     AND (
       row_org = public.current_org_id()
       OR public.is_platform_admin()
     )
$$;

GRANT EXECUTE ON FUNCTION public.current_org_id()      TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_platform_admin()   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_org(uuid)  TO anon, authenticated;
