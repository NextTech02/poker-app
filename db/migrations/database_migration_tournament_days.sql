-- Migration: Create tournament_days table
-- This migration creates the tournament_days table to support hierarchical tournament structure
-- where each tournament can have multiple days with individual configurations

-- Create tournament_days table
CREATE TABLE IF NOT EXISTS tournament_days (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    day_name VARCHAR(255) NOT NULL, -- e.g., "Dia 1A", "Dia 1B", "Dia Final"
    day_number INTEGER NOT NULL DEFAULT 1, -- Sequential number for ordering

    -- Financial configuration
    buy_in DECIMAL(10, 2) NOT NULL CHECK (buy_in > 0),
    rebuy_amount DECIMAL(10, 2) CHECK (rebuy_amount > 0),
    addon_amount DECIMAL(10, 2) CHECK (addon_amount > 0),
    rake_percentage DECIMAL(5, 2) NOT NULL DEFAULT 0 CHECK (rake_percentage >= 0 AND rake_percentage <= 100),

    -- Player limits
    max_players INTEGER NOT NULL CHECK (max_players > 0),
    registered_players INTEGER NOT NULL DEFAULT 0,

    -- Chip configuration
    starting_chips INTEGER NOT NULL DEFAULT 10000 CHECK (starting_chips > 0),
    rebuy_chips INTEGER NOT NULL DEFAULT 10000 CHECK (rebuy_chips > 0),
    addon_chips INTEGER NOT NULL DEFAULT 10000 CHECK (addon_chips > 0),

    -- Blind structure
    blind_duration INTEGER NOT NULL DEFAULT 15 CHECK (blind_duration > 0),
    initial_small_blind INTEGER NOT NULL DEFAULT 50 CHECK (initial_small_blind > 0),
    initial_big_blind INTEGER NOT NULL DEFAULT 100 CHECK (initial_big_blind > 0),
    blind_increase_type VARCHAR(50) NOT NULL DEFAULT 'double',
    bb_ante_start_level INTEGER NOT NULL DEFAULT 3 CHECK (bb_ante_start_level > 0),
    rebuy_level_limit INTEGER, -- NULL = unlimited rebuys

    -- Break configuration
    break_interval INTEGER NOT NULL DEFAULT 60 CHECK (break_interval > 0),
    break_duration INTEGER NOT NULL DEFAULT 10 CHECK (break_duration > 0),

    -- Allocation
    allocation_type VARCHAR(50) NOT NULL DEFAULT 'automatic',

    -- Status and tracking
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    total_entries INTEGER NOT NULL DEFAULT 0,
    prize_pool DECIMAL(10, 2) NOT NULL DEFAULT 0,
    start_time TIMESTAMP WITH TIME ZONE,
    tournament_date TIMESTAMP WITH TIME ZONE,

    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE,

    -- Ensure unique day names within a tournament
    CONSTRAINT unique_tournament_day_name UNIQUE (tournament_id, day_name),

    -- Check constraints for valid status values
    CONSTRAINT valid_status CHECK (status IN ('pending', 'active', 'completed', 'cancelled')),
    CONSTRAINT valid_blind_increase CHECK (blind_increase_type IN ('double', 'triple', '1.5x', '2x', '3x')),
    CONSTRAINT valid_allocation CHECK (allocation_type IN ('automatic', 'manual'))
);

-- Create indexes for performance
CREATE INDEX idx_tournament_days_tournament_id ON tournament_days(tournament_id);
CREATE INDEX idx_tournament_days_status ON tournament_days(status);
CREATE INDEX idx_tournament_days_day_number ON tournament_days(tournament_id, day_number);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_tournament_days_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tournament_days_updated_at
    BEFORE UPDATE ON tournament_days
    FOR EACH ROW
    EXECUTE FUNCTION update_tournament_days_updated_at();

-- Update tournament_players to reference tournament_day instead of just tournament
-- Add new column for tournament_day_id (nullable for backward compatibility during migration)
ALTER TABLE tournament_players
ADD COLUMN IF NOT EXISTS tournament_day_id UUID REFERENCES tournament_days(id) ON DELETE CASCADE;

-- Create index for the new foreign key
CREATE INDEX IF NOT EXISTS idx_tournament_players_tournament_day_id ON tournament_players(tournament_day_id);

-- Comment on table and key columns
COMMENT ON TABLE tournament_days IS 'Stores individual tournament days with their specific configurations. Each tournament can have multiple days (e.g., Day 1A, Day 1B, Final Day).';
COMMENT ON COLUMN tournament_days.tournament_id IS 'Reference to parent tournament';
COMMENT ON COLUMN tournament_days.day_name IS 'Display name for the day (e.g., "Dia 1A", "Dia 1B", "Dia Final")';
COMMENT ON COLUMN tournament_days.day_number IS 'Sequential number for ordering days within a tournament';
COMMENT ON COLUMN tournament_days.rebuy_level_limit IS 'Maximum blind level where rebuys are allowed. NULL means unlimited rebuys.';
COMMENT ON COLUMN tournament_days.rake_percentage IS 'Percentage of total revenue that goes to the house (0-100). Rest goes to prize pool.';
