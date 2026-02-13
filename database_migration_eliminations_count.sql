-- Add eliminations_count to tournament_days for simple elimination tracking
-- Active players = total_entries - eliminations_count
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS eliminations_count INTEGER DEFAULT 0;
