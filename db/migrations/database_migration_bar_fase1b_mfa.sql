-- ============================================================================
-- MÓDULO DE BAR — Fase 1b: política RESTRICTIVE de 2FA nas tabelas do bar
-- ----------------------------------------------------------------------------
-- database_migration_mfa_2fa.sql aplicou `<tabela>_exige_mfa` num loop único
-- sobre "todas as tabelas com RLS" NAQUELE momento. As tabelas do bar nasceram
-- depois e ficaram sem a política: um usuário com 2FA cadastrado e sessão
-- ainda em aal1 leria o bar enquanto o resto do sistema estaria fechado.
--
-- LIÇÃO PARA A PRÓXIMA TABELA NOVA: o loop do MFA não é retroativo. Toda
-- migração que cria tabela com RLS precisa deste bloco.
--
-- ORDEM: aplicar DEPOIS de database_migration_bar_fase1_core.sql e de
-- database_migration_mfa_2fa.sql. Reaplicável.
-- ============================================================================

DO $guard$ BEGIN
  IF to_regclass('public.bar_tab_payments') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_bar_fase1_core.sql';
  END IF;
  IF to_regproc('public.mfa_satisfeito') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_mfa_2fa.sql';
  END IF;
END $guard$;

DO $aplica$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bar_shifts','bar_product_categories','bar_products','bar_stock_movements',
    'bar_tabs','bar_tab_items','bar_tab_payments'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_exige_mfa', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE TO authenticated '
      'USING ((SELECT public.mfa_satisfeito()))',
      t || '_exige_mfa', t
    );
  END LOOP;
END $aplica$;

-- ── Conferência ─────────────────────────────────────────────────────────────
-- Toda tabela bar_% com RLS tem a política restritiva (deve ser 0):
--   SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relname LIKE 'bar\_%'
--      AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = c.relname || '_exige_mfa');
