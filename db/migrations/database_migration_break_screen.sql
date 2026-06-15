-- Migration: Break screen settings for tournament broadcast
-- Run this in Supabase SQL Editor

ALTER TABLE tournament_days
  ADD COLUMN IF NOT EXISTS broadcast_break_layout          TEXT    DEFAULT 'split',
  ADD COLUMN IF NOT EXISTS broadcast_break_bg_color        TEXT    DEFAULT '#0a0e13',
  ADD COLUMN IF NOT EXISTS broadcast_break_bg_image_url    TEXT,
  ADD COLUMN IF NOT EXISTS broadcast_break_youtube_url     TEXT,
  ADD COLUMN IF NOT EXISTS broadcast_break_show_video      BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS broadcast_break_show_next_level BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS broadcast_break_show_players    BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS broadcast_break_show_chipcount  BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS broadcast_break_show_average    BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS broadcast_break_overlay_opacity INTEGER DEFAULT 70,
  ADD COLUMN IF NOT EXISTS broadcast_break_timer_color     TEXT    DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_break_label_color     TEXT    DEFAULT '#9ca3af',
  ADD COLUMN IF NOT EXISTS broadcast_break_value_color     TEXT    DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_break_title_color     TEXT    DEFAULT '#ffffff';
