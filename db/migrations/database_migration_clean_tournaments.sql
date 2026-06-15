-- Migration: Clean tournaments table - Remove fields moved to tournament_days
-- This migration removes all configuration fields from tournaments table
-- since they now belong to tournament_days table

-- First, drop the view that depends on these columns
DROP VIEW IF EXISTS tournament_summary CASCADE;

-- Remove columns that were moved to tournament_days
ALTER TABLE tournaments DROP COLUMN IF EXISTS buy_in;
ALTER TABLE tournaments DROP COLUMN IF EXISTS rebuy_amount;
ALTER TABLE tournaments DROP COLUMN IF EXISTS addon_amount;
ALTER TABLE tournaments DROP COLUMN IF EXISTS max_players;
ALTER TABLE tournaments DROP COLUMN IF EXISTS blind_duration;
ALTER TABLE tournaments DROP COLUMN IF EXISTS starting_chips;
ALTER TABLE tournaments DROP COLUMN IF EXISTS rebuy_chips;
ALTER TABLE tournaments DROP COLUMN IF EXISTS addon_chips;
ALTER TABLE tournaments DROP COLUMN IF EXISTS rebuy_level_limit;
ALTER TABLE tournaments DROP COLUMN IF EXISTS rake_percentage;
ALTER TABLE tournaments DROP COLUMN IF EXISTS initial_small_blind;
ALTER TABLE tournaments DROP COLUMN IF EXISTS initial_big_blind;
ALTER TABLE tournaments DROP COLUMN IF EXISTS blind_increase_type;
ALTER TABLE tournaments DROP COLUMN IF EXISTS bb_ante_start_level;
ALTER TABLE tournaments DROP COLUMN IF EXISTS break_interval;
ALTER TABLE tournaments DROP COLUMN IF EXISTS break_duration;
ALTER TABLE tournaments DROP COLUMN IF EXISTS allocation_type;
ALTER TABLE tournaments DROP COLUMN IF EXISTS tournament_date;

-- Remove status-related columns since status is now per-day
ALTER TABLE tournaments DROP COLUMN IF EXISTS status;
ALTER TABLE tournaments DROP COLUMN IF EXISTS registered_players;
ALTER TABLE tournaments DROP COLUMN IF EXISTS prize_pool;
ALTER TABLE tournaments DROP COLUMN IF EXISTS start_time;

-- Comment on table
COMMENT ON TABLE tournaments IS 'Tournament container - holds only name and stage. Configuration per day is in tournament_days table.';
