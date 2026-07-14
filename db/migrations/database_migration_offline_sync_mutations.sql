-- Migration: ledger genérico de idempotência do modo offline (replay /sync/batch)
--
-- Cobre operações que NÃO têm uma linha âncora própria (timer, contador de
-- eliminação). O /sync/batch registra cada client_mutation_id aplicado e pula no
-- replay. Para register/rebuy/addon/sangria é redundante (já idempotentes via
-- client_id) — apenas reforça.
--
-- Aplicada em prod em 2026-07-14 via Supabase MCP (name: offline_sync_mutations_ledger).

CREATE TABLE IF NOT EXISTS sync_mutations (
  client_mutation_id UUID PRIMARY KEY,
  kind TEXT,
  applied_at TIMESTAMPTZ DEFAULT now()
);
