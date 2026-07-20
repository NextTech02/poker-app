-- SaaS Fase 5 — suspender uma organização passa a ter EFEITO REAL.
--
-- `organizations.status` já existia ('active' | 'suspended' | 'cancelled'), mas
-- ninguém o consultava: suspender era puramente cosmético — os usuários do
-- clube continuavam operando normalmente. Para um SaaS (inadimplência, fim de
-- contrato, fraude) isso precisa cortar o acesso de fato.
--
-- Estratégia: em vez de espalhar checagens de status por dezenas de lugares, a
-- organização suspensa simplesmente PERDE o claim:
--
--   current_org_id() -> NULL quando a org não está ativa
--
-- Como TODO o RLS é `can_access_org(organization_id)` e ele é fail-closed
-- (NULL => nada visível), o corte é automático em todas as tabelas, para
-- leitura E escrita. O DEFAULT das colunas também usa current_org_id(), então
-- INSERTs passam a falhar no NOT NULL em vez de gravar dados órfãos.
--
-- Vantagem sobre checar só no login: tokens já emitidos valem ~1h. Checando
-- aqui, a suspensão vale na PRÓXIMA QUERY, não na próxima hora.
--
-- SECURITY DEFINER é necessário: `organizations` é deny-all no RLS, então a
-- função precisa de privilégio para ler o status. Ela só devolve o próprio
-- org_id do usuário — não expõe nada de outras organizações.

CREATE OR REPLACE FUNCTION public.current_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.id
  FROM public.organizations o
  WHERE o.id = NULLIF(
          COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'organization_id', ''),
        '')::uuid
    AND o.status = 'active'
$$;

-- O Auth Hook também para de injetar o claim para orgs não-ativas, para que um
-- login novo já venha sem organização (defesa em camadas).
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

    -- Só staff ATIVO de organização ATIVA recebe o claim de organização.
    SELECT s.organization_id INTO v_org
    FROM public.staff s
    JOIN public.organizations o ON o.id = s.organization_id
    WHERE s.auth_user_id = v_user
      AND s.active = true
      AND o.status = 'active'
    LIMIT 1;

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
    RETURN event;   -- nunca impedir o login por erro aqui
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION public.current_org_id() TO anon, authenticated;
