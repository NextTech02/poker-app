-- Migration: performance indexes
-- Description: índices para acelerar o Financeiro/Extrato (filtra transações por
--   intervalo de created_at e ordena por created_at), além do caso "por torneio
--   no período". Sem eles, vira full scan conforme transactions cresce.

CREATE INDEX IF NOT EXISTS idx_transactions_created_at
  ON public.transactions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_tournament_created
  ON public.transactions (tournament_id, created_at DESC);
