-- Migration: código público de exibição (TV) por torneio
--
-- Um código curto e único por torneio. Numa TV, a pessoa entra em /tv e digita o
-- código -> abre a tela de blinds/timer do dia ATIVO do torneio (segue sozinho).
--
-- Aplicada em prod em 2026-07-14 via Supabase MCP (name: tournament_broadcast_code).

ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS broadcast_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournaments_broadcast_code
  ON tournaments(broadcast_code) WHERE broadcast_code IS NOT NULL;
