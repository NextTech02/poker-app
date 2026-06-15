-- Migration: Add allocation_mode to tournament_days
-- Run this in the Supabase SQL Editor

-- Add allocation_mode column to tournament_days
-- Values: 'balanced' (default), 'sequential', 'random_balanced'
ALTER TABLE tournament_days
  ADD COLUMN IF NOT EXISTS allocation_mode VARCHAR(20) NOT NULL DEFAULT 'balanced';

-- Optional: add a check constraint to restrict to known values
ALTER TABLE tournament_days
  ADD CONSTRAINT chk_allocation_mode
  CHECK (allocation_mode IN ('balanced', 'sequential', 'random_balanced'));
