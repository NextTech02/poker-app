-- Migration: Per-day toggle for the broadcast prizes layout.
-- 'bottom'  = horizontal scrolling ticker at the bottom of the screen (current default)
-- 'sidebar' = vertical column on the right side of the screen (PokerWeb-like)
-- Defaults to 'bottom' so existing rows keep current behavior.

ALTER TABLE tournament_days
    ADD COLUMN IF NOT EXISTS broadcast_prizes_layout VARCHAR(16) NOT NULL DEFAULT 'bottom';
