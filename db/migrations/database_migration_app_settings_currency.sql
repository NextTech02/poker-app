-- Migration: app_settings (global currency)
-- Description: Singleton settings row holding the app-wide DISPLAY currency.
--   The frontend reads/writes it directly via the Supabase client (RLS:
--   authenticated read+update; anon read so the public broadcast view can show
--   the right symbol). Display-only — it changes the symbol/formatting, not the
--   stored amounts.

CREATE TABLE IF NOT EXISTS app_settings (
  id int PRIMARY KEY DEFAULT 1,
  currency varchar(3) NOT NULL DEFAULT 'BRL',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_settings_singleton CHECK (id = 1)
);

INSERT INTO app_settings (id, currency) VALUES (1, 'BRL')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_read_app_settings ON app_settings;
CREATE POLICY auth_read_app_settings ON app_settings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS auth_update_app_settings ON app_settings;
CREATE POLICY auth_update_app_settings ON app_settings
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Public broadcast view (anon) needs to read the currency.
DROP POLICY IF EXISTS anon_read_app_settings ON app_settings;
CREATE POLICY anon_read_app_settings ON app_settings
  FOR SELECT TO anon USING (true);
