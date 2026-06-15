-- Fix: tournament_days.prize_pool was not recomputed when a transaction (or a
-- tournament_player) was DELETED.
--
-- Root cause: `update_tournament_prize_pool()` referenced only NEW.*, but on a
-- DELETE the NEW record is NULL, so `day_id` resolved to NULL and the function
-- exited without recomputing. The trigger `on_transaction_prize_pool_update`
-- (AFTER INSERT OR UPDATE OR DELETE ON transactions) fired, but the function was
-- a no-op on DELETE → prize_pool stayed inflated after a refund/correction.
--
-- Fix: resolve the row reference with COALESCE(NEW.*, OLD.*) so INSERT/UPDATE use
-- NEW and DELETE uses OLD; recompute from the surviving rows; RETURN OLD on DELETE.
-- This redefines the function only — existing triggers (on tournament_players and
-- transactions) keep calling it unchanged.

CREATE OR REPLACE FUNCTION update_tournament_prize_pool()
RETURNS TRIGGER AS $$
DECLARE
    total_entries DECIMAL(10, 2);
    rake_pct DECIMAL(5, 2);
    prize_amount DECIMAL(10, 2);
    day_id UUID;
BEGIN
    -- Resolve the relevant tournament_day_id for INSERT/UPDATE (NEW) or DELETE (OLD).
    IF TG_TABLE_NAME = 'tournament_players' THEN
        day_id := COALESCE(NEW.tournament_day_id, OLD.tournament_day_id);
    ELSIF TG_TABLE_NAME = 'transactions' THEN
        SELECT tp.tournament_day_id INTO day_id
        FROM tournament_players tp
        WHERE tp.id = COALESCE(NEW.tournament_player_id, OLD.tournament_player_id);
    END IF;

    -- Only proceed if we have a tournament_day_id
    IF day_id IS NOT NULL THEN
        -- Get rake percentage from tournament_days
        SELECT COALESCE(rake_percentage, 0) INTO rake_pct
        FROM tournament_days
        WHERE id = day_id;

        -- Recompute total from the surviving entries for this day
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

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- One-off backfill: recompute EVERY day's prize_pool to the canonical value the
-- trigger derives from current entries (heals rows left stale by past deletes,
-- including days whose entries were all removed → 0). This matches the trigger's
-- existing behaviour (prize_pool is always derived from buy_in/rebuy/addon).
UPDATE tournament_days td
SET prize_pool = (
    SELECT COALESCE(SUM(t.amount), 0)
    FROM transactions t
    JOIN tournament_players tp ON t.tournament_player_id = tp.id
    WHERE tp.tournament_day_id = td.id
      AND t.type IN ('buy_in', 'rebuy', 'addon')
) * (1 - (COALESCE(td.rake_percentage, 0) / 100));
