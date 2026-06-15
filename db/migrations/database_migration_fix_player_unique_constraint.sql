-- Migration: Fix tournament_players unique constraint for day-based registration
-- This allows the same player to register for multiple days of the same tournament
-- but prevents duplicate registration in the same day

-- Drop the old constraint (tournament_id, player_id)
ALTER TABLE tournament_players
DROP CONSTRAINT IF EXISTS tournament_players_tournament_id_player_id_key;

-- Create new constraint (tournament_day_id, player_id)
-- This ensures a player can only register once per tournament day
ALTER TABLE tournament_players
ADD CONSTRAINT tournament_players_tournament_day_id_player_id_key
UNIQUE (tournament_day_id, player_id);
