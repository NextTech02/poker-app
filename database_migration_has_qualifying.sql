-- Migration: Add has_qualifying flag to tournaments
-- Allows splitting the TournamentDetail layout into qualifying days + final day

ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS has_qualifying BOOLEAN DEFAULT false;
