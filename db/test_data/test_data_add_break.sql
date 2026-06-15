-- Test Script: Add a break to the active tournament for testing
-- Execute this in Supabase SQL Editor

-- Add a 15-minute break at level 9
INSERT INTO blinds (tournament_day_id, level, small_blind, big_blind, ante, duration, is_break)
VALUES ('11713280-0f0d-4450-9d11-c49d384ed848', 9, NULL, NULL, NULL, 15, true);

-- Verify it was created
SELECT id, level, small_blind, big_blind, ante, duration, is_break
FROM blinds
WHERE tournament_day_id = '11713280-0f0d-4450-9d11-c49d384ed848'
ORDER BY level;
