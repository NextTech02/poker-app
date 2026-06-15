-- Migration: Add currency field to tournament_days
-- Run this in Supabase SQL Editor

ALTER TABLE tournament_days
  ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'BRL';

-- Backfill existing rows
UPDATE tournament_days SET currency = 'BRL' WHERE currency IS NULL;

-- Add prize ticker size setting to tournament_days
ALTER TABLE tournament_days
  ADD COLUMN IF NOT EXISTS broadcast_prize_size INTEGER NOT NULL DEFAULT 100;

-- Add prizepool widget configuration to tournament_days
ALTER TABLE tournament_days
  ADD COLUMN IF NOT EXISTS broadcast_prizepool_label_color VARCHAR(20) NOT NULL DEFAULT '#ffffff',
  ADD COLUMN IF NOT EXISTS broadcast_prizepool_value_color VARCHAR(20) NOT NULL DEFAULT '#ffffff',
  ADD COLUMN IF NOT EXISTS broadcast_prizepool_size      INTEGER NOT NULL DEFAULT 100;

-- Add per-element color configuration for broadcast screen
ALTER TABLE tournament_days
  ADD COLUMN IF NOT EXISTS broadcast_timer_color         VARCHAR(20) NOT NULL DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_title_color         VARCHAR(20) NOT NULL DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_blinds_label_color  VARCHAR(20) NOT NULL DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_blinds_value_color  VARCHAR(20) NOT NULL DEFAULT '#ffffff',
  ADD COLUMN IF NOT EXISTS broadcast_ante_label_color    VARCHAR(20) NOT NULL DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_ante_value_color    VARCHAR(20) NOT NULL DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_next_label_color    VARCHAR(20) NOT NULL DEFAULT '#d4af37',
  ADD COLUMN IF NOT EXISTS broadcast_next_value_color    VARCHAR(20) NOT NULL DEFAULT '#9ca3af',
  ADD COLUMN IF NOT EXISTS broadcast_sidebar_label_color VARCHAR(20) NOT NULL DEFAULT '#9ca3af',
  ADD COLUMN IF NOT EXISTS broadcast_sidebar_value_color VARCHAR(20) NOT NULL DEFAULT '#d4af37';
