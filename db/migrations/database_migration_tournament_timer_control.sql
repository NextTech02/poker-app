-- ================================================
-- Migration: Add Tournament Timer Control Fields
-- ================================================
-- Adds fields to tournament_days table for manual timer control
-- Allows operators to pause/resume, adjust time, and change levels

-- Add timer control fields to tournament_days
ALTER TABLE tournament_days
ADD COLUMN IF NOT EXISTS current_level INTEGER DEFAULT 1,
ADD COLUMN IF NOT EXISTS elapsed_time INTEGER DEFAULT 0 COMMENT 'Total elapsed time in seconds',
ADD COLUMN IF NOT EXISTS is_paused BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS timer_started_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS manual_time_adjustment INTEGER DEFAULT 0 COMMENT 'Manual time adjustments in seconds (+/-)';

-- Add index for faster queries on timer status
CREATE INDEX IF NOT EXISTS idx_tournament_days_timer_status ON tournament_days(id, is_paused, current_level);

-- Add comment to table
COMMENT ON COLUMN tournament_days.current_level IS 'Current blind level (1-based index)';
COMMENT ON COLUMN tournament_days.elapsed_time IS 'Total elapsed time in seconds since tournament start';
COMMENT ON COLUMN tournament_days.is_paused IS 'Whether the tournament timer is currently paused';
COMMENT ON COLUMN tournament_days.timer_started_at IS 'Timestamp when the timer was last started/resumed';
COMMENT ON COLUMN tournament_days.manual_time_adjustment IS 'Cumulative manual time adjustments in seconds (positive = added time, negative = removed time)';
