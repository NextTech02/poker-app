-- Migration: Add rebuy level limit to tournaments

-- Add column for rebuy level limit
ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS rebuy_level_limit INTEGER DEFAULT NULL;

-- Add comment
COMMENT ON COLUMN tournaments.rebuy_level_limit IS 'Maximum blind level where rebuys are allowed (NULL = unlimited)';
