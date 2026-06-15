-- Torneios Poker - Database Schema
-- This file contains the SQL schema for Supabase (PostgreSQL)

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Tournaments table
CREATE TABLE IF NOT EXISTS tournaments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    buy_in DECIMAL(10, 2) NOT NULL CHECK (buy_in > 0),
    max_players INTEGER NOT NULL CHECK (max_players > 0),
    blind_duration INTEGER NOT NULL DEFAULT 15 CHECK (blind_duration > 0),
    starting_chips INTEGER NOT NULL DEFAULT 10000 CHECK (starting_chips > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed')),
    registered_players INTEGER NOT NULL DEFAULT 0 CHECK (registered_players >= 0),
    created_by UUID NOT NULL REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_name VARCHAR(255) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('buy_in', 'rebuy', 'addon')),
    amount DECIMAL(10, 2) NOT NULL CHECK (amount > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);
CREATE INDEX IF NOT EXISTS idx_tournaments_created_by ON tournaments(created_by);
CREATE INDEX IF NOT EXISTS idx_tournaments_created_at ON tournaments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_tournament_id ON transactions(tournament_id);
CREATE INDEX IF NOT EXISTS idx_transactions_player_name ON transactions(player_name);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-update updated_at
CREATE TRIGGER update_tournaments_updated_at
    BEFORE UPDATE ON tournaments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security (RLS) Policies

-- Enable RLS
ALTER TABLE tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Tournaments policies
-- Allow authenticated users to read all tournaments
CREATE POLICY "Allow authenticated users to read tournaments"
    ON tournaments FOR SELECT
    TO authenticated
    USING (true);

-- Allow users to create tournaments
CREATE POLICY "Allow authenticated users to create tournaments"
    ON tournaments FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = created_by);

-- Allow users to update their own tournaments
CREATE POLICY "Allow users to update own tournaments"
    ON tournaments FOR UPDATE
    TO authenticated
    USING (auth.uid() = created_by);

-- Allow users to delete their own tournaments
CREATE POLICY "Allow users to delete own tournaments"
    ON tournaments FOR DELETE
    TO authenticated
    USING (auth.uid() = created_by);

-- Transactions policies
-- Allow authenticated users to read all transactions
CREATE POLICY "Allow authenticated users to read transactions"
    ON transactions FOR SELECT
    TO authenticated
    USING (true);

-- Allow authenticated users to create transactions
CREATE POLICY "Allow authenticated users to create transactions"
    ON transactions FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- Function to increment registered_players count
CREATE OR REPLACE FUNCTION increment_registered_players()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.type = 'buy_in' THEN
        UPDATE tournaments
        SET registered_players = registered_players + 1
        WHERE id = NEW.tournament_id;
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-increment registered players on buy-in
CREATE TRIGGER on_buy_in_increment_players
    AFTER INSERT ON transactions
    FOR EACH ROW
    WHEN (NEW.type = 'buy_in')
    EXECUTE FUNCTION increment_registered_players();

-- Sample data (optional, for testing)
-- Uncomment to insert sample data

/*
-- Insert a sample tournament (replace user_id with actual Supabase auth user ID)
INSERT INTO tournaments (name, buy_in, max_players, created_by)
VALUES ('Torneio de Teste', 100.00, 50, 'replace-with-user-uuid');

-- Get the tournament ID
-- Replace 'tournament-uuid' with the actual UUID from above
INSERT INTO transactions (tournament_id, player_name, type, amount)
VALUES
    ('tournament-uuid', 'João Silva', 'buy_in', 100.00),
    ('tournament-uuid', 'Maria Santos', 'buy_in', 100.00),
    ('tournament-uuid', 'João Silva', 'rebuy', 100.00);
*/
