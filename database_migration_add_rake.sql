-- Migration: Add rake percentage to tournaments table
-- This allows configuring what percentage of buy-ins/rebuys goes to the house vs prize pool

-- Add rake_percentage column (default 0% - all goes to prize pool)
ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS rake_percentage DECIMAL(5, 2) DEFAULT 0 CHECK (rake_percentage >= 0 AND rake_percentage <= 100);

-- Add comment explaining the field
COMMENT ON COLUMN tournaments.rake_percentage IS 'Percentage of buy-ins/rebuys that goes to the house (0-100). The rest goes to prize pool.';

-- Update existing tournaments to have 0% rake (all goes to prize pool)
UPDATE tournaments SET rake_percentage = 0 WHERE rake_percentage IS NULL;

-- Update the prize pool calculation function to account for rake
CREATE OR REPLACE FUNCTION update_tournament_prize_pool()
RETURNS TRIGGER AS $$
DECLARE
    total_entries DECIMAL(10, 2);
    rake_pct DECIMAL(5, 2);
    prize_amount DECIMAL(10, 2);
BEGIN
    -- Get tournament rake percentage
    SELECT COALESCE(rake_percentage, 0) INTO rake_pct
    FROM tournaments
    WHERE id = NEW.tournament_id;

    -- Calculate total from entries (buy-ins, rebuys, addons)
    SELECT COALESCE(SUM(amount), 0) INTO total_entries
    FROM transactions
    WHERE tournament_id = NEW.tournament_id
    AND type IN ('buy_in', 'rebuy', 'addon');

    -- Calculate prize pool after rake
    -- prize_pool = total_entries * (1 - rake_percentage/100)
    prize_amount := total_entries * (1 - (rake_pct / 100));

    -- Update tournament prize pool
    UPDATE tournaments
    SET prize_pool = prize_amount
    WHERE id = NEW.tournament_id;

    RETURN NEW;
END;
$$ language 'plpgsql';

-- Recreate the trigger (just to ensure it's using the updated function)
DROP TRIGGER IF EXISTS on_transaction_prize_pool_update ON transactions;
CREATE TRIGGER on_transaction_prize_pool_update
    AFTER INSERT OR UPDATE OR DELETE ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_tournament_prize_pool();
