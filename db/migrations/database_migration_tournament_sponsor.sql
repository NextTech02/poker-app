-- Migration: Tournament sponsor link
-- Description: Adds optional sponsor reference to tournaments (feature: edit tournament sponsor).
--   sponsors table already exists; this only wires the FK on tournaments.

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS sponsor_id UUID NULL REFERENCES sponsors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tournaments_sponsor ON tournaments(sponsor_id);

COMMENT ON COLUMN tournaments.sponsor_id IS 'Patrocinador do torneio (opcional). FK para sponsors.';
