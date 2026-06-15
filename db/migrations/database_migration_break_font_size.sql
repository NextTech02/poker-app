-- Migration: Break screen font size control
-- Run this in Supabase SQL Editor

ALTER TABLE tournament_days
  ADD COLUMN IF NOT EXISTS broadcast_break_font_size INTEGER DEFAULT 100;
