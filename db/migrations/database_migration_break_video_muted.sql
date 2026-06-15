-- Migration: Per-day toggle for whether the break-screen video plays muted.
-- The frontend reads `broadcast_break_video_muted` and switches the YouTube
-- embed between mute=1 and mute=0. Defaults to TRUE so existing rows keep
-- the current behavior (autoplay only works reliably while muted).

ALTER TABLE tournament_days
    ADD COLUMN IF NOT EXISTS broadcast_break_video_muted BOOLEAN NOT NULL DEFAULT TRUE;
