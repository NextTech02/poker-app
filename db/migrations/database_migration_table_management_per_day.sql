-- ============================================================================
-- Migration: Table Management Per Day
-- Scopes tables and seat allocations to tournament_day instead of tournament.
-- Adds tables_locked flag to tournament_days.
-- ============================================================================

-- 1. Add tournament_day_id to tournament_tables
ALTER TABLE tournament_tables
  ADD COLUMN tournament_day_id UUID REFERENCES tournament_days(id) ON DELETE CASCADE;

-- 2. Add tournament_day_id to seat_allocations
ALTER TABLE seat_allocations
  ADD COLUMN tournament_day_id UUID REFERENCES tournament_days(id) ON DELETE CASCADE;

-- 3. Add tables_locked flag to tournament_days
ALTER TABLE tournament_days
  ADD COLUMN tables_locked BOOLEAN NOT NULL DEFAULT false;

-- 4. Backfill existing data: map to first day of each tournament
UPDATE tournament_tables tt
SET tournament_day_id = (
  SELECT td.id FROM tournament_days td
  WHERE td.tournament_id = tt.tournament_id
  ORDER BY td.day_number ASC, td.created_at ASC
  LIMIT 1
)
WHERE tt.tournament_day_id IS NULL;

UPDATE seat_allocations sa
SET tournament_day_id = (
  SELECT td.id FROM tournament_days td
  WHERE td.tournament_id = sa.tournament_id
  ORDER BY td.day_number ASC, td.created_at ASC
  LIMIT 1
)
WHERE sa.tournament_day_id IS NULL;

-- 5. Update unique constraints for day-scoped operation
-- Tables: unique table_number per day (not per tournament)
ALTER TABLE tournament_tables
  DROP CONSTRAINT IF EXISTS tournament_tables_tournament_id_table_number_key;

ALTER TABLE tournament_tables
  ADD CONSTRAINT tournament_tables_day_table_number_key
  UNIQUE (tournament_day_id, table_number);

-- Allocations: unique player per day (not per tournament)
ALTER TABLE seat_allocations
  DROP CONSTRAINT IF EXISTS seat_allocations_tournament_id_player_id_key;

ALTER TABLE seat_allocations
  ADD CONSTRAINT seat_allocations_day_player_key
  UNIQUE (tournament_day_id, player_id);

-- 6. Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_tournament_tables_day_id
  ON tournament_tables(tournament_day_id);

CREATE INDEX IF NOT EXISTS idx_seat_allocations_day_id
  ON seat_allocations(tournament_day_id);

-- 7. RLS policies for new columns (if RLS enabled)
-- The existing RLS policies on tournament_tables and seat_allocations
-- should still work since they check tournament_id which remains.
-- No additional RLS changes needed.
