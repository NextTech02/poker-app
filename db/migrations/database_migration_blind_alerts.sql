-- Migration: Per-day toggle for the audio alerts that fire 60s/30s/1s before
-- a blind change on the broadcast screen. The frontend reads
-- `broadcast_blind_alerts_enabled` and skips playBeep() when false.
-- Defaults to TRUE so existing rows keep current behavior.

ALTER TABLE tournament_days
    ADD COLUMN IF NOT EXISTS broadcast_blind_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;
