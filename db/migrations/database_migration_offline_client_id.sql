-- Migration: idempotência para o modo OFFLINE (replay via /sync/batch)
--
-- Cada operação financeira replicada offline carrega um id gerado no cliente na sua
-- LINHA ÂNCORA. O service pré-checa esse id antes de aplicar; o índice UNIQUE parcial
-- garante que reexecutar a mesma op (ex.: ack perdido) não duplique nada. NULLs ficam
-- livres para todas as linhas históricas.
--
-- Aplicada em prod em 2026-07-14 via Supabase MCP (name: offline_client_id_idempotency).
-- Idempotente — seguro re-rodar.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS client_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_client_id
  ON transactions(client_id) WHERE client_id IS NOT NULL;

ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS client_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_players_client_id
  ON tournament_players(client_id) WHERE client_id IS NOT NULL;

ALTER TABLE sangria_transactions ADD COLUMN IF NOT EXISTS client_mutation_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sangria_client_mutation_id
  ON sangria_transactions(client_mutation_id) WHERE client_mutation_id IS NOT NULL;
