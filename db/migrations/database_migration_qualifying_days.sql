-- Migration: Add qualifying days support
-- This migration adds support for multi-day tournaments with qualifying rounds

-- =============================================================================
-- 1. Add columns to tournament_days table
-- =============================================================================

-- Day type: regular (default), qualifying (advances to another day), or final
ALTER TABLE tournament_days
ADD COLUMN IF NOT EXISTS day_type VARCHAR(20) DEFAULT 'regular';

-- Reference to the day that this qualifying day advances to
ALTER TABLE tournament_days
ADD COLUMN IF NOT EXISTS qualifies_to_day_id UUID REFERENCES tournament_days(id) ON DELETE SET NULL;

-- Add constraint for valid day_type values
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'valid_day_type'
    ) THEN
        ALTER TABLE tournament_days
        ADD CONSTRAINT valid_day_type CHECK (day_type IN ('regular', 'qualifying', 'final'));
    END IF;
END $$;

-- Create index for the foreign key
CREATE INDEX IF NOT EXISTS idx_tournament_days_qualifies_to ON tournament_days(qualifies_to_day_id);

-- =============================================================================
-- 2. Add columns to tournament_players table
-- =============================================================================

-- Final chip count at end of day (for carrying over to next day)
ALTER TABLE tournament_players
ADD COLUMN IF NOT EXISTS final_chip_count INTEGER DEFAULT NULL;

-- Reference to which day this player qualified from (for players in final day)
ALTER TABLE tournament_players
ADD COLUMN IF NOT EXISTS qualified_from_day_id UUID REFERENCES tournament_days(id) ON DELETE SET NULL;

-- Flag indicating this is a qualified entry (no buy-in charged)
ALTER TABLE tournament_players
ADD COLUMN IF NOT EXISTS is_qualified_entry BOOLEAN DEFAULT FALSE;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_tournament_players_qualified_from ON tournament_players(qualified_from_day_id);
CREATE INDEX IF NOT EXISTS idx_tournament_players_final_chips ON tournament_players(tournament_day_id, final_chip_count) WHERE final_chip_count IS NOT NULL;

-- =============================================================================
-- 3. Add comments for documentation
-- =============================================================================

COMMENT ON COLUMN tournament_days.day_type IS 'Type of day: regular (standalone), qualifying (advances to another day), or final (receives qualifiers)';
COMMENT ON COLUMN tournament_days.qualifies_to_day_id IS 'For qualifying days, reference to the day that survivors advance to';
COMMENT ON COLUMN tournament_players.final_chip_count IS 'Chip count at end of day, used for advancing to next day';
COMMENT ON COLUMN tournament_players.qualified_from_day_id IS 'Reference to the qualifying day this player came from';
COMMENT ON COLUMN tournament_players.is_qualified_entry IS 'TRUE if player entered via qualification (no buy-in), FALSE if regular buy-in';
