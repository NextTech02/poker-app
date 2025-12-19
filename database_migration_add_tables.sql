-- Migration: Add Tournament Tables System
-- Description: Creates tournament_tables table for managing poker tables in tournaments
-- Date: 2025-11-12

-- Create tournament_tables table
CREATE TABLE IF NOT EXISTS tournament_tables (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    table_number INTEGER NOT NULL,
    seats INTEGER NOT NULL CHECK (seats > 0 AND seats <= 10),
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    occupied_seats INTEGER NOT NULL DEFAULT 0 CHECK (occupied_seats >= 0 AND occupied_seats <= seats),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(tournament_id, table_number)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_tournament_tables_tournament ON tournament_tables(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_tables_status ON tournament_tables(status);

-- Add comment to table
COMMENT ON TABLE tournament_tables IS 'Manages poker tables for tournaments with seat allocation';

-- Add comments to columns
COMMENT ON COLUMN tournament_tables.id IS 'Unique identifier for the table';
COMMENT ON COLUMN tournament_tables.tournament_id IS 'Foreign key to tournaments table';
COMMENT ON COLUMN tournament_tables.table_number IS 'Table number within the tournament (1, 2, 3, etc.)';
COMMENT ON COLUMN tournament_tables.seats IS 'Total number of seats available at this table (max 10)';
COMMENT ON COLUMN tournament_tables.status IS 'Table status: active, broken, or closed';
COMMENT ON COLUMN tournament_tables.occupied_seats IS 'Number of seats currently occupied by players';
COMMENT ON COLUMN tournament_tables.created_at IS 'Timestamp when the table was created';
COMMENT ON COLUMN tournament_tables.updated_at IS 'Timestamp when the table was last updated';

-- Grant permissions
GRANT ALL ON TABLE tournament_tables TO authenticated;
GRANT SELECT ON TABLE tournament_tables TO anon;
