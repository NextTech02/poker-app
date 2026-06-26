-- Migration: staff_payments (Funcionários → aba Pagamentos)
-- Description: Per-stage staff payments. The admin sets each staff member's
--   amount manually; the reserved-staff prize % across the stage's tournaments
--   is shown only as a budget reference. Paying debits the single general cash
--   register (caixa geral), mirroring prize payouts. The frontend reads/writes
--   these tables directly via the Supabase client (no backend redeploy needed).

CREATE TABLE IF NOT EXISTS staff_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id uuid NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  status varchar(12) NOT NULL DEFAULT 'pending', -- 'pending' | 'paid'
  paid_at timestamptz,
  paid_by uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_payments_stage_staff_unique UNIQUE (stage_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_payments_stage ON staff_payments(stage_id);

ALTER TABLE staff_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_all_staff_payments ON staff_payments;
CREATE POLICY auth_all_staff_payments ON staff_payments
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Allow the frontend (authenticated) to debit the single general cash register
-- when paying staff, the same way the backend does for prize payouts.
DROP POLICY IF EXISTS auth_update_general_cash ON general_cash_register;
CREATE POLICY auth_update_general_cash ON general_cash_register
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
