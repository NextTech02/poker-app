-- Migration: Fix triggers to use tournament_days table instead of tournaments
-- Columns like registered_players, rake_percentage, prize_pool are now in tournament_days

-- Fix 1: update_tournament_player_count trigger
CREATE OR REPLACE FUNCTION update_tournament_player_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Update tournament_days if tournament_day_id is provided
        IF NEW.tournament_day_id IS NOT NULL THEN
            UPDATE tournament_days
            SET registered_players = COALESCE(registered_players, 0) + 1
            WHERE id = NEW.tournament_day_id;
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        -- Update tournament_days if tournament_day_id is provided
        IF OLD.tournament_day_id IS NOT NULL THEN
            UPDATE tournament_days
            SET registered_players = GREATEST(COALESCE(registered_players, 0) - 1, 0)
            WHERE id = OLD.tournament_day_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fix 2: update_tournament_prize_pool trigger
CREATE OR REPLACE FUNCTION update_tournament_prize_pool()
RETURNS TRIGGER AS $$
DECLARE
    total_entries DECIMAL(10, 2);
    rake_pct DECIMAL(5, 2);
    prize_amount DECIMAL(10, 2);
    day_id UUID;
BEGIN
    -- Get tournament_day_id from the tournament_player record
    IF TG_TABLE_NAME = 'tournament_players' THEN
        day_id := NEW.tournament_day_id;
    ELSIF TG_TABLE_NAME = 'transactions' THEN
        -- Get day_id from tournament_player if available
        SELECT tp.tournament_day_id INTO day_id
        FROM tournament_players tp
        WHERE tp.id = NEW.tournament_player_id;
    END IF;

    -- Only proceed if we have a tournament_day_id
    IF day_id IS NOT NULL THEN
        -- Get rake percentage from tournament_days
        SELECT COALESCE(rake_percentage, 0) INTO rake_pct
        FROM tournament_days
        WHERE id = day_id;

        -- Calculate total from entries for this day
        SELECT COALESCE(SUM(t.amount), 0) INTO total_entries
        FROM transactions t
        JOIN tournament_players tp ON t.tournament_player_id = tp.id
        WHERE tp.tournament_day_id = day_id
        AND t.type IN ('buy_in', 'rebuy', 'addon');

        -- Calculate prize pool after rake
        prize_amount := total_entries * (1 - (rake_pct / 100));

        -- Update tournament_days prize pool
        UPDATE tournament_days
        SET prize_pool = prize_amount
        WHERE id = day_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
