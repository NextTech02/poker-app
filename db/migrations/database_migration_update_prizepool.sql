-- Migration: Auto-update tournament prize pool based on buy-ins and rebuys

-- Function to calculate and update prize pool
CREATE OR REPLACE FUNCTION update_tournament_prize_pool()
RETURNS TRIGGER AS $$
DECLARE
    total_amount DECIMAL;
BEGIN
    -- Calculate total from all tournament players
    SELECT
        COALESCE(SUM(total_buy_in_amount + total_rebuy_amount + total_addon_amount), 0)
    INTO total_amount
    FROM tournament_players
    WHERE tournament_id = COALESCE(NEW.tournament_id, OLD.tournament_id);

    -- Update tournament prize pool
    UPDATE tournaments
    SET prize_pool = total_amount
    WHERE id = COALESCE(NEW.tournament_id, OLD.tournament_id);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for INSERT
DROP TRIGGER IF EXISTS tournament_player_insert_update_prize ON tournament_players;
CREATE TRIGGER tournament_player_insert_update_prize
    AFTER INSERT ON tournament_players
    FOR EACH ROW
    EXECUTE FUNCTION update_tournament_prize_pool();

-- Create trigger for UPDATE
DROP TRIGGER IF EXISTS tournament_player_update_update_prize ON tournament_players;
CREATE TRIGGER tournament_player_update_update_prize
    AFTER UPDATE ON tournament_players
    FOR EACH ROW
    EXECUTE FUNCTION update_tournament_prize_pool();

-- Create trigger for DELETE
DROP TRIGGER IF EXISTS tournament_player_delete_update_prize ON tournament_players;
CREATE TRIGGER tournament_player_delete_update_prize
    AFTER DELETE ON tournament_players
    FOR EACH ROW
    EXECUTE FUNCTION update_tournament_prize_pool();

-- Initial calculation for existing tournaments
UPDATE tournaments t
SET prize_pool = (
    SELECT COALESCE(SUM(total_buy_in_amount + total_rebuy_amount + total_addon_amount), 0)
    FROM tournament_players tp
    WHERE tp.tournament_id = t.id
);
