-- Migration: Broadcast display language per tournament day
-- Run this in Supabase SQL Editor

ALTER TABLE tournament_days
  ADD COLUMN IF NOT EXISTS broadcast_language TEXT DEFAULT 'pt-BR';
