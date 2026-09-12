-- ============================================================================
-- CORREÇÃO — `provision_organization` estava AMBÍGUA, e criar organização
--            falhava sempre
-- ----------------------------------------------------------------------------
-- O QUE ACONTECEU
--
-- `database_migration_cash_fase0_modulos.sql` acrescentou `p_modules text[]
-- DEFAULT NULL` à função, usando `CREATE OR REPLACE FUNCTION`.
--
-- Acrescentar parâmetro MUDA A ASSINATURA. `CREATE OR REPLACE` só substitui uma
-- função de assinatura idêntica; com uma assinatura nova ele CRIA OUTRA. O
-- banco ficou com duas:
--
--     provision_organization(text,text,uuid,text,text,text,text,text)
--     provision_organization(text,text,uuid,text,text,text,text,text,text[])
--
-- O backend chama com os OITO argumentos nomeados. Como o nono tem DEFAULT, as
-- duas candidatas casam e o Postgres recusa a chamada:
--
--     ERROR: 42725: function public.provision_organization(...) is not unique
--     HINT:  Could not choose a best candidate function.
--
-- Efeito: TODA criação de organização falhava desde então. E falhava tarde
-- demais — o convite por e-mail é enviado ANTES do provisionamento, então cada
-- tentativa mandava um e-mail para um cliente cuja organização nunca existiu.
-- O rollback apaga o usuário do auth; e-mail não tem rollback, e o link do
-- convite fica apontando para um usuário que não existe mais.
--
-- A CORREÇÃO
--
-- Apagar a versão de 8 argumentos. A de 9 é superconjunto dela — faz os mesmos
-- INSERTs (organizations, permission_groups, staff, app_settings,
-- general_cash_register, rake_register, payment_methods) e ainda semeia
-- `org_modules` e as permissões `cash.*`. Com `p_modules` tendo DEFAULT, a
-- chamada de 8 argumentos do backend continua funcionando sem alteração.
--
-- LIÇÃO, para a próxima migração que mexer numa função:
--   acrescentar/remover parâmetro exige DROP explícito da assinatura antiga.
--   `CREATE OR REPLACE` sozinho deixa as duas vivas, e o erro só aparece na
--   primeira chamada real — que aqui foi na frente de um cliente.
--
-- ORDEM: aplicar DEPOIS de database_migration_cash_fase0_modulos.sql.
-- Reaplicável: `DROP ... IF EXISTS` não reclama se já foi apagada.
-- ============================================================================

DO $guard$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'provision_organization'
       AND pg_get_function_identity_arguments(p.oid) LIKE '%p_modules%'
  ) THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cash_fase0_modulos.sql '
                    '(a versão com p_modules não existe; apagar a antiga deixaria '
                    'o sistema sem nenhuma)';
  END IF;
END $guard$;

DROP FUNCTION IF EXISTS public.provision_organization(
  text, text, uuid, text, text, text, text, text
);


-- ── Conferência ─────────────────────────────────────────────────────────────
-- Deve sobrar UMA linha, a de 9 argumentos:
--   SELECT pg_get_function_identity_arguments(p.oid)
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname='provision_organization';
--
-- E a chamada do backend (8 nomeados) deve PLANEJAR sem erro. `EXPLAIN` sem
-- `ANALYZE` resolve a função e não a executa:
--   EXPLAIN SELECT public.provision_organization(
--     p_org_name=>'x', p_org_slug=>'x',
--     p_auth_user=>'00000000-0000-0000-0000-000000000000'::uuid,
--     p_admin_name=>'x', p_admin_email=>'x@x.com',
--     p_currency=>'BRL', p_plan=>'free', p_language=>'pt-BR');
