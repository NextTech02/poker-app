-- Migration: Add broadcast_show_prizes column to tournaments table
-- This allows toggling the display of prize allocations in the tournament broadcast

ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS broadcast_show_prizes BOOLEAN DEFAULT TRUE;

COMMENT ON COLUMN tournaments.broadcast_show_prizes IS 'Whether to show prize allocations on the broadcast display';
