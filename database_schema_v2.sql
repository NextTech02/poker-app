-- Torneios Poker - Enhanced Database Schema
-- This file contains the SQL schema for Supabase (PostgreSQL)
-- Version 2 - With dedicated Players table

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- PLAYERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS players (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(50),
    nickname VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- TOURNAMENTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS tournaments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    buy_in DECIMAL(10, 2) NOT NULL CHECK (buy_in > 0),
    rebuy_amount DECIMAL(10, 2),
    addon_amount DECIMAL(10, 2),
    max_players INTEGER NOT NULL CHECK (max_players > 0),
    blind_duration INTEGER NOT NULL DEFAULT 15 CHECK (blind_duration > 0),
    starting_chips INTEGER NOT NULL DEFAULT 10000 CHECK (starting_chips > 0),
    rebuy_chips INTEGER DEFAULT 10000,
    addon_chips INTEGER DEFAULT 10000,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'cancelled')),
    registered_players INTEGER NOT NULL DEFAULT 0 CHECK (registered_players >= 0),
    prize_pool DECIMAL(10, 2) DEFAULT 0,
    tournament_date TIMESTAMP WITH TIME ZONE,
    created_by UUID NOT NULL REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- TOURNAMENT_PLAYERS TABLE (Junction table)
-- Links players to tournaments and tracks their participation
-- ============================================
CREATE TABLE IF NOT EXISTS tournament_players (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,

    -- Entry tracking
    buy_in_count INTEGER NOT NULL DEFAULT 1 CHECK (buy_in_count >= 0),
    rebuy_count INTEGER NOT NULL DEFAULT 0 CHECK (rebuy_count >= 0),
    addon_count INTEGER NOT NULL DEFAULT 0 CHECK (addon_count >= 0),

    -- Financial tracking
    total_buy_in_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
    total_rebuy_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
    total_addon_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
    total_spent DECIMAL(10, 2) NOT NULL DEFAULT 0,

    -- Chip tracking
    total_chips INTEGER NOT NULL DEFAULT 0,

    -- Results
    final_position INTEGER,
    prize_won DECIMAL(10, 2) DEFAULT 0,
    eliminated_at TIMESTAMP WITH TIME ZONE,

    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'active', 'eliminated', 'winner')),

    -- Metadata
    registered_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,

    -- Unique constraint: one player can only be in a tournament once
    UNIQUE(tournament_id, player_id)
);

-- ============================================
-- TRANSACTIONS TABLE
-- Detailed transaction log for audit trail
-- ============================================
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    tournament_player_id UUID REFERENCES tournament_players(id) ON DELETE CASCADE,

    type VARCHAR(20) NOT NULL CHECK (type IN ('buy_in', 'rebuy', 'addon', 'prize')),
    amount DECIMAL(10, 2) NOT NULL,

    payment_method VARCHAR(50), -- 'cash', 'pix', 'card', etc.
    reference_number VARCHAR(100), -- For tracking payments

    notes TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- INDEXES for performance
-- ============================================

-- Players indexes
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
CREATE INDEX IF NOT EXISTS idx_players_email ON players(email);

-- Tournaments indexes
CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);
CREATE INDEX IF NOT EXISTS idx_tournaments_created_by ON tournaments(created_by);
CREATE INDEX IF NOT EXISTS idx_tournaments_created_at ON tournaments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tournaments_date ON tournaments(tournament_date DESC);

-- Tournament Players indexes
CREATE INDEX IF NOT EXISTS idx_tournament_players_tournament ON tournament_players(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_players_player ON tournament_players(player_id);
CREATE INDEX IF NOT EXISTS idx_tournament_players_status ON tournament_players(status);

-- Transactions indexes
CREATE INDEX IF NOT EXISTS idx_transactions_tournament ON transactions(tournament_id);
CREATE INDEX IF NOT EXISTS idx_transactions_player ON transactions(player_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Function to calculate total spent for a tournament player
CREATE OR REPLACE FUNCTION calculate_total_spent()
RETURNS TRIGGER AS $$
BEGIN
    NEW.total_spent = NEW.total_buy_in_amount + NEW.total_rebuy_amount + NEW.total_addon_amount;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Function to update tournament registered players count
CREATE OR REPLACE FUNCTION update_tournament_player_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE tournaments
        SET registered_players = registered_players + 1
        WHERE id = NEW.tournament_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE tournaments
        SET registered_players = registered_players - 1
        WHERE id = OLD.tournament_id;
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Function to update tournament prize pool
CREATE OR REPLACE FUNCTION update_tournament_prize_pool()
RETURNS TRIGGER AS $$
DECLARE
    total_pool DECIMAL(10, 2);
BEGIN
    -- Calculate total prize pool for the tournament
    SELECT COALESCE(SUM(amount), 0) INTO total_pool
    FROM transactions
    WHERE tournament_id = NEW.tournament_id
    AND type IN ('buy_in', 'rebuy', 'addon');

    -- Update tournament prize pool
    UPDATE tournaments
    SET prize_pool = total_pool
    WHERE id = NEW.tournament_id;

    RETURN NEW;
END;
$$ language 'plpgsql';

-- ============================================
-- TRIGGERS
-- ============================================

-- Auto-update updated_at on players
CREATE TRIGGER update_players_updated_at
    BEFORE UPDATE ON players
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at on tournaments
CREATE TRIGGER update_tournaments_updated_at
    BEFORE UPDATE ON tournaments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-calculate total_spent on tournament_players
CREATE TRIGGER calculate_tournament_player_total
    BEFORE INSERT OR UPDATE ON tournament_players
    FOR EACH ROW
    EXECUTE FUNCTION calculate_total_spent();

-- Auto-update registered players count
CREATE TRIGGER on_tournament_player_insert
    AFTER INSERT ON tournament_players
    FOR EACH ROW
    EXECUTE FUNCTION update_tournament_player_count();

CREATE TRIGGER on_tournament_player_delete
    AFTER DELETE ON tournament_players
    FOR EACH ROW
    EXECUTE FUNCTION update_tournament_player_count();

-- Auto-update tournament prize pool
CREATE TRIGGER on_transaction_insert_update_pool
    AFTER INSERT ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_tournament_prize_pool();

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

-- Enable RLS
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Players policies
CREATE POLICY "Allow authenticated users to read players"
    ON players FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to create players"
    ON players FOR INSERT
    TO authenticated
    WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update players"
    ON players FOR UPDATE
    TO authenticated
    USING (true);

-- Tournaments policies
CREATE POLICY "Allow authenticated users to read tournaments"
    ON tournaments FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to create tournaments"
    ON tournaments FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Allow users to update own tournaments"
    ON tournaments FOR UPDATE
    TO authenticated
    USING (auth.uid() = created_by);

CREATE POLICY "Allow users to delete own tournaments"
    ON tournaments FOR DELETE
    TO authenticated
    USING (auth.uid() = created_by);

-- Tournament Players policies
CREATE POLICY "Allow authenticated users to read tournament_players"
    ON tournament_players FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to manage tournament_players"
    ON tournament_players FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- Transactions policies
CREATE POLICY "Allow authenticated users to read transactions"
    ON transactions FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to create transactions"
    ON transactions FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- ============================================
-- VIEWS (Helpful queries)
-- ============================================

-- View: Player Statistics
CREATE OR REPLACE VIEW player_statistics AS
SELECT
    p.id,
    p.name,
    p.nickname,
    COUNT(DISTINCT tp.tournament_id) as tournaments_played,
    SUM(tp.buy_in_count) as total_buy_ins,
    SUM(tp.rebuy_count) as total_rebuys,
    SUM(tp.addon_count) as total_addons,
    SUM(tp.total_spent) as total_spent,
    SUM(tp.prize_won) as total_prizes,
    SUM(tp.prize_won) - SUM(tp.total_spent) as net_profit,
    COUNT(CASE WHEN tp.final_position = 1 THEN 1 END) as first_places,
    COUNT(CASE WHEN tp.final_position <= 3 THEN 1 END) as top_3_finishes,
    AVG(tp.final_position) as avg_position
FROM players p
LEFT JOIN tournament_players tp ON p.id = tp.player_id
GROUP BY p.id, p.name, p.nickname;

-- View: Tournament Summary
CREATE OR REPLACE VIEW tournament_summary AS
SELECT
    t.id,
    t.name,
    t.status,
    t.buy_in,
    t.registered_players,
    t.max_players,
    t.prize_pool,
    t.tournament_date,
    COUNT(tp.id) as total_entries,
    SUM(tp.buy_in_count) as total_buy_ins,
    SUM(tp.rebuy_count) as total_rebuys,
    SUM(tp.addon_count) as total_addons,
    t.created_at
FROM tournaments t
LEFT JOIN tournament_players tp ON t.id = tp.tournament_id
GROUP BY t.id, t.name, t.status, t.buy_in, t.registered_players,
         t.max_players, t.prize_pool, t.tournament_date, t.created_at;

-- ============================================
-- SAMPLE DATA (for testing)
-- ============================================
-- Uncomment to insert sample data

/*
-- Create sample players
INSERT INTO players (name, nickname, email) VALUES
    ('João Silva', 'JoãoAce', 'joao@email.com'),
    ('Maria Santos', 'MariaPro', 'maria@email.com'),
    ('Pedro Costa', 'PedroShark', 'pedro@email.com'),
    ('Ana Oliveira', 'AnaQueen', 'ana@email.com');
*/
