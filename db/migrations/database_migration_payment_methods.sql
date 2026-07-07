-- Migration: payment_methods (Financeiro → Métodos de Pagamento)
-- Description: Configurable payment methods per client/deployment. Each country
--   /client has different payment forms (cash, pix, card, transfer, yape, etc.).
--   The Caixa dropdown lists the ACTIVE methods; the financial statement resolves
--   the stored code -> label from here. Managed directly by the frontend via the
--   Supabase client (no backend redeploy needed). transactions.payment_method
--   stores the method `code`.

CREATE TABLE IF NOT EXISTS payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(40) NOT NULL UNIQUE,   -- stable code stored on transactions.payment_method
  label varchar(60) NOT NULL,          -- display label
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_all_payment_methods ON payment_methods;
CREATE POLICY auth_all_payment_methods ON payment_methods
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Seed with the current built-in methods (editable afterwards).
INSERT INTO payment_methods (code, label, sort_order)
VALUES ('cash','Dinheiro',1),('pix','PIX',2),('card','Cartão',3),('transfer','Transferência',4)
ON CONFLICT (code) DO NOTHING;
