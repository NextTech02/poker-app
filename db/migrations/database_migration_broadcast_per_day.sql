-- Migration: Move broadcast settings from tournaments to tournament_days
-- Each day can have its own broadcast configuration

ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_bg_color VARCHAR DEFAULT '#0a0e13';
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_bg_image_url TEXT DEFAULT NULL;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_display_name VARCHAR DEFAULT NULL;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_font_size INTEGER DEFAULT 100;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_show_logo BOOLEAN DEFAULT TRUE;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_show_title BOOLEAN DEFAULT TRUE;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_show_prizepool BOOLEAN DEFAULT TRUE;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_show_level BOOLEAN DEFAULT TRUE;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_show_players BOOLEAN DEFAULT TRUE;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_show_interval BOOLEAN DEFAULT TRUE;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_show_timer BOOLEAN DEFAULT TRUE;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_show_blinds BOOLEAN DEFAULT TRUE;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_show_ante BOOLEAN DEFAULT TRUE;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_show_next_blind BOOLEAN DEFAULT TRUE;
ALTER TABLE tournament_days ADD COLUMN IF NOT EXISTS broadcast_show_prizes BOOLEAN DEFAULT TRUE;

-- Copy existing broadcast settings from tournaments to their days
UPDATE tournament_days td
SET
  broadcast_bg_color = t.broadcast_bg_color,
  broadcast_bg_image_url = t.broadcast_bg_image_url,
  broadcast_display_name = t.broadcast_display_name,
  broadcast_font_size = COALESCE(t.broadcast_font_size, 100),
  broadcast_show_logo = COALESCE(t.broadcast_show_logo, TRUE),
  broadcast_show_title = COALESCE(t.broadcast_show_title, TRUE),
  broadcast_show_prizepool = COALESCE(t.broadcast_show_prizepool, TRUE),
  broadcast_show_level = COALESCE(t.broadcast_show_level, TRUE),
  broadcast_show_players = COALESCE(t.broadcast_show_players, TRUE),
  broadcast_show_interval = COALESCE(t.broadcast_show_interval, TRUE),
  broadcast_show_timer = COALESCE(t.broadcast_show_timer, TRUE),
  broadcast_show_blinds = COALESCE(t.broadcast_show_blinds, TRUE),
  broadcast_show_ante = COALESCE(t.broadcast_show_ante, TRUE),
  broadcast_show_next_blind = COALESCE(t.broadcast_show_next_blind, TRUE),
  broadcast_show_prizes = COALESCE(t.broadcast_show_prizes, TRUE)
FROM tournaments t
WHERE td.tournament_id = t.id;
