-- Torneios Poker - Migration to V2 Schema
-- Run this if you have existing tables from the old schema
-- This will safely migrate your data to the new structure

-- ============================================
-- STEP 1: Drop old views if they exist
-- ============================================
DROP VIEW IF EXISTS player_statistics CASCADE;
DROP VIEW IF EXISTS tournament_summary CASCADE;

-- ============================================
-- STEP 2: Create new tables (if they don't exist)
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create players table
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
-- STEP 3: Modify tournaments table (add new columns)
-- ============================================

-- Add new columns to tournaments if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='tournaments' AND column_name='rebuy_amount') THEN
        ALTER TABLE tournaments ADD COLUMN rebuy_amount DECIMAL(10, 2);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='tournaments' AND column_name='addon_amount') THEN
        ALTER TABLE tournaments ADD COLUMN addon_amount DECIMAL(10, 2);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='tournaments' AND column_name='rebuy_chips') THEN
        ALTER TABLE tournaments ADD COLUMN rebuy_chips INTEGER DEFAULT 10000;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='tournaments' AND column_name='addon_chips') THEN
        ALTER TABLE tournaments ADD COLUMN addon_chips INTEGER DEFAULT 10000;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='tournaments' AND column_name='prize_pool') THEN
        ALTER TABLE tournaments ADD COLUMN prize_pool DECIMAL(10, 2) DEFAULT 0;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='tournaments' AND column_name='tournament_date') THEN
        ALTER TABLE tournaments ADD COLUMN tournament_date TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- Update status constraint to include 'cancelled'
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_status_check;
ALTER TABLE tournaments ADD CONSTRAINT tournaments_status_check
    CHECK (status IN ('pending', 'active', 'completed', 'cancelled'));

-- ============================================
-- STEP 4: Create tournament_players table
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
-- STEP 5: Migrate existing transaction data to new structure
-- ============================================

-- First, create players from existing transaction data
INSERT INTO players (name)
SELECT DISTINCT player_name
FROM transactions
WHERE player_name IS NOT NULL
ON CONFLICT DO NOTHING;

-- ============================================
-- STEP 6: Backup old transactions table
-- ============================================
DO $$
BEGIN
    -- Check if old transactions table exists and rename it
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'transactions') THEN
        ALTER TABLE transactions RENAME TO transactions_old_backup;
    END IF;
END $$;

-- ============================================
-- STEP 7: Create new transactions table
-- ============================================
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    tournament_player_id UUID REFERENCES tournament_players(id) ON DELETE CASCADE,

    type VARCHAR(20) NOT NULL CHECK (type IN ('buy_in', 'rebuy', 'addon', 'prize')),
    amount DECIMAL(10, 2) NOT NULL,

    payment_method VARCHAR(50),
    reference_number VARCHAR(100),

    notes TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- STEP 8: Migrate old transaction data
-- ============================================
-- This creates tournament_players entries and new transactions from old data
DO $$
DECLARE
    old_trans RECORD;
    v_player_id UUID;
    v_tournament_player_id UUID;
BEGIN
    -- Loop through old transactions
    FOR old_trans IN SELECT * FROM transactions_old_backup LOOP
        -- Get player_id from player name
        SELECT id INTO v_player_id FROM players WHERE name = old_trans.player_name LIMIT 1;

        IF v_player_id IS NOT NULL THEN
            -- Check if tournament_player record exists
            SELECT id INTO v_tournament_player_id
            FROM tournament_players
            WHERE tournament_id = old_trans.tournament_id
            AND player_id = v_player_id;

            -- Create tournament_player if doesn't exist
            IF v_tournament_player_id IS NULL THEN
                INSERT INTO tournament_players (tournament_id, player_id, buy_in_count, total_buy_in_amount)
                VALUES (old_trans.tournament_id, v_player_id, 0, 0)
                RETURNING id INTO v_tournament_player_id;
            END IF;

            -- Update tournament_player based on transaction type
            IF old_trans.type = 'buy_in' THEN
                UPDATE tournament_players
                SET buy_in_count = buy_in_count + 1,
                    total_buy_in_amount = total_buy_in_amount + old_trans.amount
                WHERE id = v_tournament_player_id;
            ELSIF old_trans.type = 'rebuy' THEN
                UPDATE tournament_players
                SET rebuy_count = rebuy_count + 1,
                    total_rebuy_amount = total_rebuy_amount + old_trans.amount
                WHERE id = v_tournament_player_id;
            ELSIF old_trans.type = 'addon' THEN
                UPDATE tournament_players
                SET addon_count = addon_count + 1,
                    total_addon_amount = total_addon_amount + old_trans.amount
                WHERE id = v_tournament_player_id;
            END IF;

            -- Insert new transaction
            INSERT INTO transactions (tournament_id, player_id, tournament_player_id, type, amount, created_at)
            VALUES (old_trans.tournament_id, v_player_id, v_tournament_player_id, old_trans.type, old_trans.amount, old_trans.created_at);
        END IF;
    END LOOP;
END $$;

-- ============================================
-- STEP 9: Create indexes
-- ============================================
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
CREATE INDEX IF NOT EXISTS idx_players_email ON players(email);

CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);
CREATE INDEX IF NOT EXISTS idx_tournaments_created_by ON tournaments(created_by);
CREATE INDEX IF NOT EXISTS idx_tournaments_created_at ON tournaments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tournaments_date ON tournaments(tournament_date DESC);

CREATE INDEX IF NOT EXISTS idx_tournament_players_tournament ON tournament_players(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_players_player ON tournament_players(player_id);
CREATE INDEX IF NOT EXISTS idx_tournament_players_status ON tournament_players(status);

CREATE INDEX IF NOT EXISTS idx_transactions_tournament ON transactions(tournament_id);
CREATE INDEX IF NOT EXISTS idx_transactions_player ON transactions(player_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);

-- ============================================
-- STEP 10: Create functions
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE OR REPLACE FUNCTION calculate_total_spent()
RETURNS TRIGGER AS $$
BEGIN
    NEW.total_spent = NEW.total_buy_in_amount + NEW.total_rebuy_amount + NEW.total_addon_amount;
    RETURN NEW;
END;
$$ language 'plpgsql';

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

CREATE OR REPLACE FUNCTION update_tournament_prize_pool()
RETURNS TRIGGER AS $$
DECLARE
    total_pool DECIMAL(10, 2);
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO total_pool
    FROM transactions
    WHERE tournament_id = NEW.tournament_id
    AND type IN ('buy_in', 'rebuy', 'addon');

    UPDATE tournaments
    SET prize_pool = total_pool
    WHERE id = NEW.tournament_id;

    RETURN NEW;
END;
$$ language 'plpgsql';

-- ============================================
-- STEP 11: Create triggers
-- ============================================

DROP TRIGGER IF EXISTS update_players_updated_at ON players;
CREATE TRIGGER update_players_updated_at
    BEFORE UPDATE ON players
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_tournaments_updated_at ON tournaments;
CREATE TRIGGER update_tournaments_updated_at
    BEFORE UPDATE ON tournaments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS calculate_tournament_player_total ON tournament_players;
CREATE TRIGGER calculate_tournament_player_total
    BEFORE INSERT OR UPDATE ON tournament_players
    FOR EACH ROW
    EXECUTE FUNCTION calculate_total_spent();

DROP TRIGGER IF EXISTS on_tournament_player_insert ON tournament_players;
CREATE TRIGGER on_tournament_player_insert
    AFTER INSERT ON tournament_players
    FOR EACH ROW
    EXECUTE FUNCTION update_tournament_player_count();

DROP TRIGGER IF EXISTS on_tournament_player_delete ON tournament_players;
CREATE TRIGGER on_tournament_player_delete
    AFTER DELETE ON tournament_players
    FOR EACH ROW
    EXECUTE FUNCTION update_tournament_player_count();

DROP TRIGGER IF EXISTS on_transaction_insert_update_pool ON transactions;
CREATE TRIGGER on_transaction_insert_update_pool
    AFTER INSERT ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_tournament_prize_pool();

-- ============================================
-- STEP 12: Enable RLS
-- ============================================

ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Allow authenticated users to read players" ON players;
DROP POLICY IF EXISTS "Allow authenticated users to create players" ON players;
DROP POLICY IF EXISTS "Allow authenticated users to update players" ON players;

DROP POLICY IF EXISTS "Allow authenticated users to read tournaments" ON tournaments;
DROP POLICY IF EXISTS "Allow authenticated users to create tournaments" ON tournaments;
DROP POLICY IF EXISTS "Allow users to update own tournaments" ON tournaments;
DROP POLICY IF EXISTS "Allow users to delete own tournaments" ON tournaments;

DROP POLICY IF EXISTS "Allow authenticated users to read tournament_players" ON tournament_players;
DROP POLICY IF EXISTS "Allow authenticated users to manage tournament_players" ON tournament_players;

DROP POLICY IF EXISTS "Allow authenticated users to read transactions" ON transactions;
DROP POLICY IF EXISTS "Allow authenticated users to create transactions" ON transactions;

-- Create new policies
CREATE POLICY "Allow authenticated users to read players"
    ON players FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users to create players"
    ON players FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update players"
    ON players FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Allow authenticated users to read tournaments"
    ON tournaments FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users to create tournaments"
    ON tournaments FOR INSERT TO authenticated WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Allow users to update own tournaments"
    ON tournaments FOR UPDATE TO authenticated USING (auth.uid() = created_by);

CREATE POLICY "Allow users to delete own tournaments"
    ON tournaments FOR DELETE TO authenticated USING (auth.uid() = created_by);

CREATE POLICY "Allow authenticated users to read tournament_players"
    ON tournament_players FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users to manage tournament_players"
    ON tournament_players FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow authenticated users to read transactions"
    ON transactions FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users to create transactions"
    ON transactions FOR INSERT TO authenticated WITH CHECK (true);

-- ============================================
-- STEP 13: Create views
-- ============================================

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
-- DONE!
-- ============================================

SELECT 'Migration completed successfully!' as status;
SELECT 'Old transactions backed up to: transactions_old_backup' as note;
