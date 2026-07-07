-- Migration: buy_types (Financeiro → Tipos de Buy, por ETAPA) — FASE 1
-- Description: Per-stage configurable buy types. The tournament director defines
--   name, category (buy_in/rebuy/addon), amount and rake % per type (each can
--   differ). Each transaction stores the chosen buy_type and the rake computed
--   from that type's % (real per-transaction rake). Phase 1 = catalog + columns
--   + backfill (+ frontend catalog/Caixa + reports). Phase 2 = sangria derives
--   rake from the per-transaction rakes. Managed by the frontend via Supabase.

CREATE TABLE IF NOT EXISTS buy_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id uuid NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  category varchar(12) NOT NULL CHECK (category IN ('buy_in','rebuy','addon')),
  amount numeric(12,2) NOT NULL DEFAULT 0,
  rake_percentage numeric(5,2) NOT NULL DEFAULT 0 CHECK (rake_percentage >= 0 AND rake_percentage <= 100),
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buy_types_stage ON buy_types(stage_id);

ALTER TABLE buy_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_all_buy_types ON buy_types;
CREATE POLICY auth_all_buy_types ON buy_types
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Per-transaction rake columns.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS buy_type_id uuid REFERENCES buy_types(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rake_percentage numeric(5,2),
  ADD COLUMN IF NOT EXISTS rake_amount numeric(12,2);

-- Backfill existing entry transactions with their day's rake % so historical
-- reports stay consistent when reports switch to summing per-transaction rake.
UPDATE transactions t
SET rake_percentage = COALESCE(td.rake_percentage, 0),
    rake_amount = ROUND(t.amount * COALESCE(td.rake_percentage,0) / 100.0, 2)
FROM tournament_players tp
JOIN tournament_days td ON td.id = tp.tournament_day_id
WHERE t.tournament_player_id = tp.id
  AND t.type IN ('buy_in','rebuy','addon')
  AND t.rake_amount IS NULL;
