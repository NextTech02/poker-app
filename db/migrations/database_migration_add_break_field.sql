-- Migration: Add is_break field to blinds table
-- This allows marking blind levels as breaks (intervals)

-- Add is_break column to blinds table
ALTER TABLE blinds
ADD COLUMN IF NOT EXISTS is_break BOOLEAN DEFAULT false;

-- Add comment for documentation
COMMENT ON COLUMN blinds.is_break IS 'Indicates if this level is a break/interval instead of a blind level';

-- Example of creating a break level:
-- INSERT INTO blinds (tournament_id, level, small_blind, big_blind, ante, duration, is_break)
-- VALUES ('tournament-uuid', 5, NULL, NULL, NULL, 15, true);

-- Migration completed successfully
