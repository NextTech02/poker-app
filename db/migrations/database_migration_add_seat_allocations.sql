-- Migration: Add Seat Allocations and Allocation Type
-- Description: Creates seat_allocations table and adds allocation_type to tournaments
-- Date: 2025-11-12

-- Add allocation_type column to tournaments table
ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS allocation_type VARCHAR(20) NOT NULL DEFAULT 'automatic'
CHECK (allocation_type IN ('automatic', 'manual'));

-- Add comment
COMMENT ON COLUMN tournaments.allocation_type IS 'Player allocation type: automatic (system assigns) or manual (admin assigns)';

-- Create seat_allocations table
CREATE TABLE IF NOT EXISTS seat_allocations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    table_id UUID NOT NULL REFERENCES tournament_tables(id) ON DELETE CASCADE,
    seat_number INTEGER NOT NULL CHECK (seat_number > 0 AND seat_number <= 10),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(tournament_id, player_id),
    UNIQUE(table_id, seat_number)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_seat_allocations_tournament ON seat_allocations(tournament_id);
CREATE INDEX IF NOT EXISTS idx_seat_allocations_player ON seat_allocations(player_id);
CREATE INDEX IF NOT EXISTS idx_seat_allocations_table ON seat_allocations(table_id);

-- Add comments to table and columns
COMMENT ON TABLE seat_allocations IS 'Tracks player seat assignments at tournament tables';
COMMENT ON COLUMN seat_allocations.id IS 'Unique identifier for the allocation';
COMMENT ON COLUMN seat_allocations.tournament_id IS 'Foreign key to tournaments table';
COMMENT ON COLUMN seat_allocations.player_id IS 'Foreign key to players table';
COMMENT ON COLUMN seat_allocations.table_id IS 'Foreign key to tournament_tables table';
COMMENT ON COLUMN seat_allocations.seat_number IS 'Seat number at the table (1-10)';
COMMENT ON COLUMN seat_allocations.created_at IS 'Timestamp when the allocation was created';
COMMENT ON COLUMN seat_allocations.updated_at IS 'Timestamp when the allocation was last updated';

-- Grant permissions
GRANT ALL ON TABLE seat_allocations TO authenticated;
GRANT SELECT ON TABLE seat_allocations TO anon;
