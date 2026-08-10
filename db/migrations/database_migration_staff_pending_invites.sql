-- ============================================================================
-- Convite pendente para quem JÁ tem conta no sistema
-- ============================================================================
-- Quem já trabalha num clube e é convidado por outro não precisa criar conta de
-- novo — só decidir se aceita. Hoje essa pessoa era ADICIONADA EM SILÊNCIO: o
-- convite do Supabase falha para e-mail existente, e o código apenas criava o
-- vínculo ativo, sem aviso e sem escolha.
--
-- Estado novo: o vínculo nasce `active = false` + `invite_status = 'pending'`.
-- Isso já se encaixa no que existe, sem mexer em nada:
--   • `enforce_staff_limit` só conta `active = true` e checa na virada para
--     ativo  -> convite pendente não ocupa vaga do plano; o limite é cobrado
--     no momento do aceite, que é quando a pessoa de fato entra.
--   • `list_my_organizations` e o Auth Hook filtram `active = true`
--     -> um convite pendente não vira organização ativa sozinho.
--
-- Recusar APAGA a linha (em vez de marcar 'declined'): assim o clube pode
-- convidar de novo depois, e a chave única (auth_user_id, organization_id) não
-- fica presa por uma recusa antiga.
-- ============================================================================

ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS invite_status text NOT NULL DEFAULT 'accepted';

-- Default 'accepted': todo vínculo que já existe continua valendo como está.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.staff'::regclass AND conname = 'staff_invite_status_check'
  ) THEN
    ALTER TABLE public.staff
      ADD CONSTRAINT staff_invite_status_check
      CHECK (invite_status IN ('pending', 'accepted'));
  END IF;
END $$;

-- Busca dos convites de uma pessoa: cruza organizações, então roda como DEFINER.
-- O filtro é sempre pelo próprio usuário (p_user), nunca por organização.
CREATE OR REPLACE FUNCTION public.list_my_pending_invites(p_user uuid)
RETURNS TABLE (staff_id uuid, organization_id uuid, organization_name text,
               group_name text, invited_at timestamptz)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.id, o.id, o.name, pg.name, s.created_at
  FROM public.staff s
  JOIN public.organizations o
    ON o.id = s.organization_id AND o.status = 'active'
  LEFT JOIN public.permission_groups pg ON pg.id = s.permission_group_id
  WHERE s.auth_user_id = p_user
    AND s.invite_status = 'pending'
    AND s.active = false
  ORDER BY s.created_at;
$function$;


-- Aceitar: ativa o vínculo. O gatilho de limite dispara AQUI (false -> true),
-- que é o momento certo — a vaga só é ocupada por quem realmente entrou.
CREATE OR REPLACE FUNCTION public.accept_org_invite(p_user uuid, p_staff uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_org uuid; v_nome text;
BEGIN
    -- A posse é checada aqui: o convite precisa ser DESTE usuário.
    SELECT s.organization_id INTO v_org
    FROM public.staff s
    WHERE s.id = p_staff AND s.auth_user_id = p_user
      AND s.invite_status = 'pending' AND s.active = false;

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'CONVITE_INVALIDO: convite não encontrado ou já respondido.';
    END IF;

    UPDATE public.staff
       SET active = true, invite_status = 'accepted', updated_at = now()
     WHERE id = p_staff;

    SELECT name INTO v_nome FROM public.organizations WHERE id = v_org;
    RETURN jsonb_build_object('organization_id', v_org, 'organization_name', v_nome);
END $function$;


-- Recusar: apaga o vínculo, liberando um convite futuro.
CREATE OR REPLACE FUNCTION public.decline_org_invite(p_user uuid, p_staff uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int;
BEGIN
    DELETE FROM public.staff
     WHERE id = p_staff AND auth_user_id = p_user
       AND invite_status = 'pending' AND active = false;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
END $function$;
