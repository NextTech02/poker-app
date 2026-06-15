-- Migration: Add blind structure and start_time to tournaments
-- Run this in your Supabase SQL editor

-- Add new columns to tournaments table
ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS start_time TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS initial_small_blind INTEGER DEFAULT 50,
ADD COLUMN IF NOT EXISTS initial_big_blind INTEGER DEFAULT 100,
ADD COLUMN IF NOT EXISTS blind_increase_type VARCHAR(20) DEFAULT 'double' CHECK (blind_increase_type IN ('double', 'triple', '1.5x', '2x', '3x')),
ADD COLUMN IF NOT EXISTS bb_ante_start_level INTEGER DEFAULT 3,
ADD COLUMN IF NOT EXISTS break_interval INTEGER DEFAULT 60,
ADD COLUMN IF NOT EXISTS break_duration INTEGER DEFAULT 10;

-- Add comments for clarity
COMMENT ON COLUMN tournaments.start_time IS 'Timestamp when tournament was started (status changed to active)';
COMMENT ON COLUMN tournaments.initial_small_blind IS 'Starting small blind value';
COMMENT ON COLUMN tournaments.initial_big_blind IS 'Starting big blind value';
COMMENT ON COLUMN tournaments.blind_increase_type IS 'How blinds increase: double, triple, 1.5x, 2x, 3x';
COMMENT ON COLUMN tournaments.bb_ante_start_level IS 'Blind level when BB ante starts';
COMMENT ON COLUMN tournaments.break_interval IS 'Minutes between breaks';
COMMENT ON COLUMN tournaments.break_duration IS 'Duration of breaks in minutes';

-- Update existing active tournaments to set start_time from updated_at
UPDATE tournaments
SET start_time = updated_at
WHERE status = 'active' AND start_time IS NULL;
