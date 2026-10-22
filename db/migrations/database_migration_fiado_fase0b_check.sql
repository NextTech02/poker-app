-- ============================================================================
-- FIADO DA CASA — Fase 0b: tipo `debt_payment` no ledger da gaveta
-- ----------------------------------------------------------------------------
-- Recebimento de fiado é dinheiro de verdade entrando na gaveta, mas NÃO é
-- venda: não pode virar `cash_buy_in` nem `bar_sale` (o faturamento do dia e o
-- do turno somariam dívida antiga como receita). Tipo próprio, como o bar fez
-- com `bar_sale`.
--
-- SEPARADO da fase 0 porque exige DROP CONSTRAINT e o conector do MCP recusa
-- comando destrutivo ("Invalid or expired requestState"). Se recusar, rodar
-- este arquivo no SQL Editor do Supabase.
--
-- A lista é a vigente em prod (pg_get_constraintdef em 2026-10-22: 11 tipos,
-- definida por database_migration_bar_fase1_core.sql) + debt_payment.
-- `type` é VARCHAR(20): 'debt_payment' tem 12.
--
-- ORDEM: DEPOIS de database_migration_fiado_fase0.sql. Reaplicável.
-- ============================================================================

SET lock_timeout = '5s';

DO $swap$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'cashbox_transactions_type_check'
                AND pg_get_constraintdef(oid) LIKE '%debt_payment%') THEN
    RAISE NOTICE 'cashbox_transactions_type_check já aceita debt_payment';
    RETURN;
  END IF;
  -- Trava: se a lista em prod mudou desde a escrita deste arquivo, parar em
  -- vez de apagar um tipo que alguém acrescentou.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cashbox_transactions_type_check'
                    AND pg_get_constraintdef(oid) LIKE '%bar_sale%'
                    AND pg_get_constraintdef(oid) LIKE '%refund%'
                    AND pg_get_constraintdef(oid) LIKE '%cash_out%') THEN
    RAISE EXCEPTION 'CHECK de cashbox_transactions.type diferente do esperado — conferir antes';
  END IF;

  ALTER TABLE public.cashbox_transactions DROP CONSTRAINT cashbox_transactions_type_check;
  ALTER TABLE public.cashbox_transactions ADD CONSTRAINT cashbox_transactions_type_check
    CHECK (type IN ('buy_in','rebuy','addon','prize','supply','sangria','refund','adjustment',
                    'cash_buy_in','cash_out','bar_sale','debt_payment'));
END $swap$;

RESET lock_timeout;

-- ── Conferência ─────────────────────────────────────────────────────────────
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'cashbox_transactions_type_check';
