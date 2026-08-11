-- ============================================================================
-- Status "awaiting_signup": convidado que ainda não concluiu o cadastro
-- ============================================================================
-- Bug reportado: todo funcionário convidado aparecia como ATIVO na hora, mesmo
-- sem ter clicado no e-mail nem definido senha. O administrador não tinha como
-- saber quem já entrou de fato.
--
-- Eram dois casos tratados como um só. Agora:
--   'awaiting_signup' -> conta NOVA, convite enviado, senha ainda não definida.
--                        Fica `active = true` de propósito: o Auth Hook exige
--                        vínculo ativo para emitir o claim de organização, e sem
--                        ele a pessoa não conseguiria nem concluir o cadastro
--                        pelo link do e-mail. Só não deve LER como "ativo".
--   'pending'         -> conta que JÁ existia, precisa aceitar ou recusar.
--                        Fica `active = false` e aparece no aviso de convite.
--   'accepted'        -> membro de fato.
--
-- Vira 'accepted' quando a pessoa conclui o cadastro (SetPassword) ou quando
-- aceita o convite (accept_org_invite).
-- ============================================================================

ALTER TABLE public.staff DROP CONSTRAINT IF EXISTS staff_invite_status_check;
ALTER TABLE public.staff ADD CONSTRAINT staff_invite_status_check
  CHECK (invite_status IN ('pending', 'accepted', 'awaiting_signup'));

-- Retroativo: quem foi convidado e NUNCA definiu senha estava marcado como
-- membro ativo. O critério é a senha, não o `onboarded_at` — há contas
-- convidadas antes do gate de cadastro existir que já usam o sistema
-- normalmente e não podem regredir de status.
UPDATE public.staff s
   SET invite_status = 'awaiting_signup'
  FROM auth.users u
 WHERE u.id = s.auth_user_id
   AND s.invite_status = 'accepted'
   AND s.active = true
   AND u.raw_user_meta_data->>'organization_name' IS NOT NULL
   AND u.raw_user_meta_data->>'onboarded_at' IS NULL
   AND (u.encrypted_password IS NULL OR u.encrypted_password = '');


-- Fechamento do cadastro pelo próprio usuário. O `UPDATE` direto em `staff`
-- pelo navegador esbarra no RLS quando o claim de organização ainda não foi
-- emitido, então isso roda como DEFINER e só mexe na linha do próprio usuário.
CREATE OR REPLACE FUNCTION public.complete_staff_signup(p_user uuid, p_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int;
BEGIN
    UPDATE public.staff
       SET name = COALESCE(NULLIF(btrim(p_name), ''), name),
           invite_status = CASE WHEN invite_status = 'awaiting_signup'
                                THEN 'accepted' ELSE invite_status END,
           updated_at = now()
     WHERE auth_user_id = p_user
       AND invite_status <> 'pending';   -- convite não respondido não vira membro aqui
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
END $function$;
