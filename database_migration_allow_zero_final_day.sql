-- Migration: Allow zero values for final day fields
-- Final days don't have buy-in, starting chips, rebuy/addon chips of their own
-- (values come from qualifying days), so these fields need to accept 0.

-- buy_in: allow >= 0
ALTER TABLE tournament_days DROP CONSTRAINT tournament_days_buy_in_check;
ALTER TABLE tournament_days ADD CONSTRAINT tournament_days_buy_in_check CHECK (buy_in >= 0);

-- starting_chips: allow >= 0
ALTER TABLE tournament_days DROP CONSTRAINT tournament_days_starting_chips_check;
ALTER TABLE tournament_days ADD CONSTRAINT tournament_days_starting_chips_check CHECK (starting_chips >= 0);

-- rebuy_chips: allow >= 0
ALTER TABLE tournament_days DROP CONSTRAINT tournament_days_rebuy_chips_check;
ALTER TABLE tournament_days ADD CONSTRAINT tournament_days_rebuy_chips_check CHECK (rebuy_chips >= 0);

-- addon_chips: allow >= 0
ALTER TABLE tournament_days DROP CONSTRAINT tournament_days_addon_chips_check;
ALTER TABLE tournament_days ADD CONSTRAINT tournament_days_addon_chips_check CHECK (addon_chips >= 0);
