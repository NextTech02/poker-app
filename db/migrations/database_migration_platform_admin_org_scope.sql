-- ============================================================================
-- Platform admin: inspecionar UMA organização por vez
-- ============================================================================
-- Problema: o admin da plataforma via os dados de TODAS as organizações
-- misturados. Motivo: as 46 policies seguem o padrão
--     organization_id = current_org_id() OR is_platform_admin()
-- e o segundo ramo é um bypass geral — todo SELECT passava para todas as orgs.
--
-- Solução: em vez de criar um canal novo (um header X-Org-ID seria justamente
-- o furo que `dependencies.py` documenta — organização NUNCA vem do cliente),
-- reaproveitamos o mecanismo que já existe para quem trabalha em mais de um
-- clube: `user_active_org` -> Auth Hook -> claim assinado -> RLS.
--
-- O admin "entra" numa organização; o token novo carrega aquele
-- organization_id; TODAS as policies, services e as chamadas diretas do
-- navegador ao Supabase passam a enxergar só aquele clube — sem alterar
-- nenhuma policy, nenhum service e nenhuma das ~385 queries.
--
-- A tela de Organizações continua funcionando porque roda com service_role
-- (`supabase_admin`), que ignora RLS: `organizations`/`platform_admins` têm RLS
-- ligado e ZERO policies, então nenhum usuário as lê direto.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Helper: é admin da plataforma? (por user_id, sem depender do claim)
-- ─────────────────────────────────────────────────────────────────────────────
-- Necessário porque `set_active_organization` e o Auth Hook rodam FORA do
-- contexto de request do usuário (service_role / GoTrue), onde
-- `request.jwt.claims` não existe.
CREATE OR REPLACE FUNCTION public.is_platform_admin_user(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins pa WHERE pa.auth_user_id = p_user
  )
$function$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2) is_platform_admin(): o bypass deixa de ser incondicional
-- ─────────────────────────────────────────────────────────────────────────────
-- Passa a valer só quando o admin NÃO está dentro de uma organização.
-- Como o admin sempre entra em alguma (a própria ou a de um cliente), na
-- prática ele enxerga exatamente um clube por vez — que é o pedido.
--
-- O ramo `true` sobrevive como escotilha para um operador de plataforma sem
-- organização nenhuma (claim organization_id ausente).
--
-- ATENÇÃO: esta função é a chave de leitura das 46 policies. Mexer nela muda o
-- isolamento do produto inteiro de uma vez — que é justamente por que a
-- correção cabe aqui e não em 46 lugares.
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
           (current_setting('request.jwt.claims', true)::jsonb ->> 'platform_admin')::boolean,
           false
         )
     AND NULLIF(
           current_setting('request.jwt.claims', true)::jsonb ->> 'organization_id',
           ''
         ) IS NULL
$function$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3) set_active_organization(): o admin pode entrar em qualquer org ativa
-- ─────────────────────────────────────────────────────────────────────────────
-- Para os demais usuários nada muda: continua exigindo vínculo ativo em `staff`.
CREATE OR REPLACE FUNCTION public.set_active_organization(p_user uuid, p_org uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF public.is_platform_admin_user(p_user) THEN
        -- Admin da plataforma: basta a organização existir e estar ativa.
        IF NOT EXISTS (
            SELECT 1 FROM public.organizations o
            WHERE o.id = p_org AND o.status = 'active'
        ) THEN
            RAISE EXCEPTION 'Organizacao inexistente ou inativa.';
        END IF;
    ELSE
        -- Demais usuários: exige vínculo ativo (regra original, intacta).
        IF NOT EXISTS (
            SELECT 1 FROM public.staff s
            JOIN public.organizations o ON o.id = s.organization_id AND o.status = 'active'
            WHERE s.auth_user_id = p_user AND s.organization_id = p_org AND s.active = true
        ) THEN
            RAISE EXCEPTION 'Usuario nao pertence a esta organizacao (ou ela nao esta ativa).';
        END IF;
    END IF;

    INSERT INTO public.user_active_org (auth_user_id, organization_id, updated_at)
    VALUES (p_user, p_org, now())
    ON CONFLICT (auth_user_id)
    DO UPDATE SET organization_id = EXCLUDED.organization_id, updated_at = now();
END $function$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Auth Hook: emitir o claim da org escolhida pelo admin
-- ─────────────────────────────────────────────────────────────────────────────
-- A busca original casa `user_active_org` com `staff` — o admin não tem linha
-- em `staff` do clube do cliente, então o claim cairia no fallback (a própria
-- org) e a troca não teria efeito. Para admin, honramos `user_active_org`
-- direto, exigindo apenas que a organização esteja ativa.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE claims jsonb; v_user uuid; v_org uuid; v_admin boolean := false;
BEGIN
    claims := COALESCE(event->'claims', '{}'::jsonb);
    BEGIN v_user := (event->>'user_id')::uuid;
    EXCEPTION WHEN OTHERS THEN RETURN event; END;

    SELECT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.auth_user_id = v_user)
      INTO v_admin;

    IF v_admin THEN
        -- Admin da plataforma: a org escolhida vale por si só (sem vínculo em staff).
        SELECT o.id INTO v_org
        FROM public.user_active_org ua
        JOIN public.organizations o ON o.id = ua.organization_id AND o.status = 'active'
        WHERE ua.auth_user_id = v_user
        LIMIT 1;
    END IF;

    IF v_org IS NULL THEN
        -- Caminho original: org ativa com vínculo em staff.
        SELECT s.organization_id INTO v_org
        FROM public.user_active_org ua
        JOIN public.staff s ON s.auth_user_id = ua.auth_user_id
          AND s.organization_id = ua.organization_id AND s.active = true
        JOIN public.organizations o ON o.id = s.organization_id AND o.status = 'active'
        WHERE ua.auth_user_id = v_user LIMIT 1;
    END IF;

    IF v_org IS NULL THEN
        -- Fallback: primeira organização do usuário.
        SELECT s.organization_id INTO v_org
        FROM public.staff s
        JOIN public.organizations o ON o.id = s.organization_id AND o.status = 'active'
        WHERE s.auth_user_id = v_user AND s.active = true
        ORDER BY s.created_at LIMIT 1;
    END IF;

    IF v_org IS NOT NULL THEN
        claims := jsonb_set(claims, '{organization_id}', to_jsonb(v_org::text), true);
    ELSE claims := claims - 'organization_id'; END IF;

    IF v_admin THEN claims := jsonb_set(claims, '{platform_admin}', 'true'::jsonb, true);
    ELSE claims := claims - 'platform_admin'; END IF;

    RETURN jsonb_set(event, '{claims}', claims, true);
EXCEPTION WHEN OTHERS THEN RETURN event;
END; $function$;
