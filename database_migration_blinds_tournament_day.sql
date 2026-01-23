-- Migration: Link blinds to tournament_days instead of tournaments
-- This allows different blind structures for each day of a multi-day tournament

-- Add tournament_day_id column to blinds table
ALTER TABLE blinds
ADD COLUMN IF NOT EXISTS tournament_day_id UUID REFERENCES tournament_days(id) ON DELETE CASCADE;

-- Create index for tournament_day_id
CREATE INDEX IF NOT EXISTS idx_blinds_tournament_day_id ON blinds(tournament_day_id);

-- Create unique constraint for blind levels per tournament day
-- First, drop the old unique constraint if it exists
ALTER TABLE blinds DROP CONSTRAINT IF EXISTS blinds_tournament_id_level_key;

-- Create new unique constraint for tournament_day_id + level
-- Note: This allows blinds to be either tournament-level OR tournament_day-level
CREATE UNIQUE INDEX IF NOT EXISTS idx_blinds_day_level_unique
ON blinds(tournament_day_id, level)
WHERE tournament_day_id IS NOT NULL;

-- Keep the tournament-level unique constraint for backward compatibility
CREATE UNIQUE INDEX IF NOT EXISTS idx_blinds_tournament_level_unique
ON blinds(tournament_id, level)
WHERE tournament_day_id IS NULL;

-- Add comment explaining the relationship
COMMENT ON COLUMN blinds.tournament_day_id IS 'Tournament day this blind structure belongs to. If set, tournament_id is ignored for this blind.';

-- Update RLS policies to include tournament_day_id access
DROP POLICY IF EXISTS "Users can read blinds" ON blinds;
DROP POLICY IF EXISTS "Users can insert blinds" ON blinds;
DROP POLICY IF EXISTS "Users can update blinds" ON blinds;
DROP POLICY IF EXISTS "Users can delete blinds" ON blinds;

CREATE POLICY "Users can read blinds" ON blinds
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Users can insert blinds" ON blinds
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Users can update blinds" ON blinds
    FOR UPDATE USING (auth.role() = 'authenticated');

CREATE POLICY "Users can delete blinds" ON blinds
    FOR DELETE USING (auth.role() = 'authenticated');
