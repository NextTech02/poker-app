-- ============================================================================
-- CASH GAME — fecha o `search_path` das funções de trigger
-- ----------------------------------------------------------------------------
-- ORDEM: aplicar DEPOIS de database_migration_cash_fase3_jackpot.sql.
--
-- Sem `search_path` fixo, um schema no caminho de busca do papel que executa o
-- trigger pode SOMBREAR uma tabela ou função e mudar o que a função faz. Estas
-- são SECURITY INVOKER, então o risco é menor do que num DEFINER — mas fechar
-- é gratuito, e o linter do Supabase aponta
-- (0011_function_search_path_mutable).
--
-- Foi ALTER, e não recriação do corpo: nada do comportamento muda.
--
-- NOTA: as funções equivalentes do TORNEIO (update_stage_cash_on_transaction,
-- mirror_transaction_to_cashbox, update_tournament_prize_pool e outras) têm o
-- mesmo aviso. Ficaram de fora de propósito: mexer nelas é risco não pedido, e
-- o aviso é anterior a este trabalho.
-- ============================================================================

DO $guard$ BEGIN
  IF to_regclass('public.cash_jackpot_fund') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cash_fase3_jackpot.sql';
  END IF;
END $guard$;

ALTER FUNCTION public.cash_seed_seats() SET search_path = public, pg_temp;
ALTER FUNCTION public.cash_touch_player_session() SET search_path = public, pg_temp;
ALTER FUNCTION public.resolve_cash_transaction_cashbox() SET search_path = public, pg_temp;
ALTER FUNCTION public.mirror_cash_transaction_to_cashbox() SET search_path = public, pg_temp;
ALTER FUNCTION public.impedir_exclusao_de_dia_de_cash_com_movimento() SET search_path = public, pg_temp;
ALTER FUNCTION public.cash_jackpot_accumulate() SET search_path = public, pg_temp;
ALTER FUNCTION public.cash_jackpot_pay() SET search_path = public, pg_temp;


-- ── Conferência ─────────────────────────────────────────────────────────────
-- Deve retornar 0 linhas:
--   SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname LIKE 'cash%' AND p.proconfig IS NULL;
