-- Migration: Create prize_allocations table for tournament prize distribution
-- This table stores the prize amounts for each finishing position

-- Drop old table if it exists (it had tournament_day_id, we need tournament_id)
DROP TABLE IF EXISTS prize_allocations CASCADE;

-- Create prize_allocations table
CREATE TABLE prize_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    position INT NOT NULL CHECK (position > 0),
    prize_amount DECIMAL(10, 2) NOT NULL CHECK (prize_amount >= 0),
    player_id UUID REFERENCES players(id) ON DELETE SET NULL,
    paid BOOLEAN DEFAULT FALSE,
    paid_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tournament_id, position)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_prize_allocations_tournament ON prize_allocations(tournament_id);
CREATE INDEX IF NOT EXISTS idx_prize_allocations_player ON prize_allocations(player_id);

-- Add guaranteed_prize field to tournaments if it doesn't exist
ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS guaranteed_prize DECIMAL(10, 2) DEFAULT 0;

-- Add comment explaining the fields
COMMENT ON TABLE prize_allocations IS 'Stores prize distribution for each finishing position in a tournament';
COMMENT ON COLUMN prize_allocations.position IS 'Finishing position (1 = winner, 2 = runner-up, etc.)';
COMMENT ON COLUMN prize_allocations.prize_amount IS 'Prize amount in currency for this position';
COMMENT ON COLUMN prize_allocations.player_id IS 'Player who finished in this position (assigned when tournament ends)';
COMMENT ON COLUMN prize_allocations.paid IS 'Whether the prize has been paid out';
COMMENT ON COLUMN tournaments.guaranteed_prize IS 'Guaranteed minimum prize pool for this tournament';

-- Enable RLS
ALTER TABLE prize_allocations ENABLE ROW LEVEL SECURITY;

-- RLS Policies (adjust based on your auth setup)
CREATE POLICY "Allow authenticated users to view prize_allocations"
ON prize_allocations FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Allow authenticated users to insert prize_allocations"
ON prize_allocations FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update prize_allocations"
ON prize_allocations FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow authenticated users to delete prize_allocations"
ON prize_allocations FOR DELETE
TO authenticated
USING (true);
