-- Migration: Add broadcast color + chipcount/average columns to tournament_days
-- Run this in Supabase SQL Editor

ALTER TABLE tournament_days
  ADD COLUMN IF NOT EXISTS broadcast_prizepool_label_color  TEXT DEFAULT '#ffffff',
  ADD COLUMN IF NOT EXISTS broadcast_prizepool_value_color  TEXT DEFAULT '#ffffff',
  ADD COLUMN IF NOT EXISTS broadcast_prizepool_size         INTEGER DEFAULT 100,
  ADD COLUMN IF NOT EXISTS broadcast_timer_color            TEXT DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_title_color            TEXT DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_blinds_label_color     TEXT DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_blinds_value_color     TEXT DEFAULT '#ffffff',
  ADD COLUMN IF NOT EXISTS broadcast_ante_label_color       TEXT DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_ante_value_color       TEXT DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_next_label_color       TEXT DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_next_value_color       TEXT DEFAULT '#9ca3af',
  ADD COLUMN IF NOT EXISTS broadcast_sidebar_label_color    TEXT DEFAULT '#9ca3af',
  ADD COLUMN IF NOT EXISTS broadcast_sidebar_value_color    TEXT DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_show_chipcount         BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS broadcast_show_average           BOOLEAN DEFAULT true;
