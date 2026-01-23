-- Migration: Add broadcast display settings to tournaments table
-- This allows customization of the tournament broadcast/TV display

-- Add broadcast configuration columns to tournaments table
ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS broadcast_bg_color VARCHAR(20) DEFAULT '#0a0e13',
ADD COLUMN IF NOT EXISTS broadcast_bg_image_url TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS broadcast_display_name VARCHAR(255) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS broadcast_show_logo BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS broadcast_show_title BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS broadcast_show_prizepool BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS broadcast_show_level BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS broadcast_show_players BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS broadcast_show_interval BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS broadcast_show_timer BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS broadcast_show_blinds BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS broadcast_show_ante BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS broadcast_show_next_blind BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS broadcast_font_size INTEGER DEFAULT 100;

-- Add comments explaining the fields
COMMENT ON COLUMN tournaments.broadcast_bg_color IS 'Background color for broadcast display (hex color code)';
COMMENT ON COLUMN tournaments.broadcast_bg_image_url IS 'Optional background image URL for broadcast display';
COMMENT ON COLUMN tournaments.broadcast_display_name IS 'Custom display name for broadcast (overrides tournament name)';
COMMENT ON COLUMN tournaments.broadcast_show_logo IS 'Show logo on broadcast display';
COMMENT ON COLUMN tournaments.broadcast_show_title IS 'Show tournament title on broadcast display';
COMMENT ON COLUMN tournaments.broadcast_show_prizepool IS 'Show prizepool on broadcast display';
COMMENT ON COLUMN tournaments.broadcast_show_level IS 'Show current blind level on broadcast display';
COMMENT ON COLUMN tournaments.broadcast_show_players IS 'Show player count on broadcast display';
COMMENT ON COLUMN tournaments.broadcast_show_interval IS 'Show time until next break on broadcast display';
COMMENT ON COLUMN tournaments.broadcast_show_timer IS 'Show countdown timer on broadcast display';
COMMENT ON COLUMN tournaments.broadcast_show_blinds IS 'Show current blinds on broadcast display';
COMMENT ON COLUMN tournaments.broadcast_show_ante IS 'Show ante value on broadcast display';
COMMENT ON COLUMN tournaments.broadcast_show_next_blind IS 'Show next blind level on broadcast display';
COMMENT ON COLUMN tournaments.broadcast_font_size IS 'Font size percentage for broadcast display (50-200, default 100)';
