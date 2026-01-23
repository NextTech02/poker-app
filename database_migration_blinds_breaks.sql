-- Migration: Add break support to blinds table
-- Breaks are special entries in the blind structure that pause the tournament

-- Add is_break column to blinds table
ALTER TABLE blinds
ADD COLUMN IF NOT EXISTS is_break BOOLEAN DEFAULT FALSE;

-- Add comment explaining the field
COMMENT ON COLUMN blinds.is_break IS 'When true, this level represents a break/interval. Small blind, big blind, and ante are ignored during breaks.';

-- Create index for faster filtering
CREATE INDEX IF NOT EXISTS idx_blinds_is_break ON blinds(is_break);

-- Remove old check constraints that prevent 0 values for breaks
ALTER TABLE blinds DROP CONSTRAINT IF EXISTS blinds_small_blind_check;
ALTER TABLE blinds DROP CONSTRAINT IF EXISTS blinds_big_blind_check;
ALTER TABLE blinds DROP CONSTRAINT IF EXISTS blinds_ante_check;

-- Add new check constraints that allow 0 for breaks
-- Small blind must be > 0 unless it's a break
ALTER TABLE blinds ADD CONSTRAINT blinds_small_blind_check
CHECK (is_break = TRUE OR small_blind > 0);

-- Big blind must be > 0 unless it's a break
ALTER TABLE blinds ADD CONSTRAINT blinds_big_blind_check
CHECK (is_break = TRUE OR big_blind > 0);

-- Ante can always be >= 0 (no constraint needed, but adding for consistency)
ALTER TABLE blinds ADD CONSTRAINT blinds_ante_check
CHECK (ante >= 0);
