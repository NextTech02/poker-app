-- Migration: Modular cashboxes per staff member
-- Description: Adds per-employee cashboxes scoped by (staff_id, stage_id).
--   - `cashboxes`: 1 row per (staff, stage), mutable state (open|closed|archived) + running balance
--   - `cashbox_sessions`: history of open/close cycles with diff between expected vs actual
--   - `cashbox_transactions`: append-only ledger of movements per cashbox
--   - `transactions.cashbox_id`: nullable FK so existing trigger keeps working;
--     a parallel trigger mirrors INSERTs on `transactions` into `cashbox_transactions`
--   - New permission keys: `cashbox.operate`, `cashbox.admin`
-- Coexists with the existing stage_cash_register system: stage register is the
-- aggregated view (still updated by the existing trigger); cashboxes are the
-- per-operator audit layer.

-- =============================================
-- 1. cashboxes — one per (staff, stage)
-- =============================================
CREATE TABLE IF NOT EXISTS cashboxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
    stage_id UUID NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL DEFAULT 'closed'
        CHECK (status IN ('closed', 'open', 'archived')),
    current_balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    current_session_id UUID,
    last_opened_at TIMESTAMP WITH TIME ZONE,
    last_closed_at TIMESTAMP WITH TIME ZONE,
    archived_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (staff_id, stage_id)
);

CREATE INDEX IF NOT EXISTS idx_cashboxes_staff_id ON cashboxes(staff_id);
CREATE INDEX IF NOT EXISTS idx_cashboxes_stage_id ON cashboxes(stage_id);
CREATE INDEX IF NOT EXISTS idx_cashboxes_status ON cashboxes(status);

-- =============================================
-- 2. cashbox_sessions — open/close history with diff
-- =============================================
CREATE TABLE IF NOT EXISTS cashbox_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cashbox_id UUID NOT NULL REFERENCES cashboxes(id) ON DELETE CASCADE,
    opened_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    opened_by UUID REFERENCES auth.users(id),
    initial_balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    closed_at TIMESTAMP WITH TIME ZONE,
    closed_by UUID REFERENCES auth.users(id),
    expected_final_balance DECIMAL(10, 2),
    actual_final_balance DECIMAL(10, 2),
    difference DECIMAL(10, 2),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cashbox_sessions_cashbox_id ON cashbox_sessions(cashbox_id);
CREATE INDEX IF NOT EXISTS idx_cashbox_sessions_opened_at ON cashbox_sessions(opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_cashbox_sessions_open ON cashbox_sessions(cashbox_id) WHERE closed_at IS NULL;

-- FK from cashboxes.current_session_id → cashbox_sessions.id (deferred so the
-- two-way relationship survives session deletion / reset flows)
ALTER TABLE cashboxes
    DROP CONSTRAINT IF EXISTS fk_cashboxes_current_session;
ALTER TABLE cashboxes
    ADD CONSTRAINT fk_cashboxes_current_session
    FOREIGN KEY (current_session_id) REFERENCES cashbox_sessions(id)
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

-- =============================================
-- 3. cashbox_transactions — append-only ledger
-- =============================================
CREATE TABLE IF NOT EXISTS cashbox_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cashbox_id UUID NOT NULL REFERENCES cashboxes(id) ON DELETE RESTRICT,
    session_id UUID REFERENCES cashbox_sessions(id) ON DELETE SET NULL,
    type VARCHAR(20) NOT NULL
        CHECK (type IN ('buy_in', 'rebuy', 'addon', 'prize', 'supply', 'sangria', 'adjustment')),
    -- Always positive; direction is encoded by type (buy_in/rebuy/addon/supply = inflow;
    -- prize/sangria = outflow; adjustment = signed via `signed_amount` derived column).
    amount DECIMAL(10, 2) NOT NULL CHECK (amount >= 0),
    -- Signed view of `amount`: + for inflow, - for outflow. Adjustments may be
    -- negative when actual < expected.
    signed_amount DECIMAL(10, 2) NOT NULL,
    transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
    performed_by UUID REFERENCES auth.users(id),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cashbox_tx_cashbox_id ON cashbox_transactions(cashbox_id);
CREATE INDEX IF NOT EXISTS idx_cashbox_tx_session_id ON cashbox_transactions(session_id);
CREATE INDEX IF NOT EXISTS idx_cashbox_tx_type ON cashbox_transactions(type);
CREATE INDEX IF NOT EXISTS idx_cashbox_tx_created_at ON cashbox_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cashbox_tx_transaction_id ON cashbox_transactions(transaction_id);

-- =============================================
-- 4. transactions.cashbox_id — nullable FK
-- =============================================
-- Existing rows stay NULL (legacy). New rows get filled by the mirroring trigger.
ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS cashbox_id UUID REFERENCES cashboxes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_cashbox_id ON transactions(cashbox_id);

-- =============================================
-- 5. Triggers
-- =============================================
-- 5a. Maintain cashboxes.current_balance + updated_at on every cashbox_transactions insert
CREATE OR REPLACE FUNCTION update_cashbox_balance_on_transaction()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE cashboxes
    SET current_balance = current_balance + NEW.signed_amount,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.cashbox_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_cashbox_balance ON cashbox_transactions;
CREATE TRIGGER trigger_update_cashbox_balance
    AFTER INSERT ON cashbox_transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_cashbox_balance_on_transaction();

-- 5b. Resolve cashbox_id on transaction insert (BEFORE) and mirror to
-- cashbox_transactions (AFTER). Two separate triggers because the AFTER step
-- needs `transactions.id` to satisfy the cashbox_transactions FK.

CREATE OR REPLACE FUNCTION resolve_transaction_cashbox()
RETURNS TRIGGER AS $$
DECLARE
    v_stage_id UUID;
    v_cashbox_id UUID;
BEGIN
    -- Skip if explicitly assigned by service layer
    IF NEW.cashbox_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    -- Skip rows without an operator
    IF NEW.created_by IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT stage_id INTO v_stage_id
    FROM tournaments
    WHERE id = NEW.tournament_id;

    IF v_stage_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT c.id INTO v_cashbox_id
    FROM cashboxes c
    JOIN staff s ON s.id = c.staff_id
    WHERE s.auth_user_id = NEW.created_by
      AND c.stage_id = v_stage_id
      AND c.status = 'open';

    IF v_cashbox_id IS NOT NULL THEN
        NEW.cashbox_id := v_cashbox_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_resolve_transaction_cashbox ON transactions;
CREATE TRIGGER trigger_resolve_transaction_cashbox
    BEFORE INSERT ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION resolve_transaction_cashbox();

CREATE OR REPLACE FUNCTION mirror_transaction_to_cashbox()
RETURNS TRIGGER AS $$
DECLARE
    v_session_id UUID;
    v_signed DECIMAL(10, 2);
BEGIN
    IF NEW.cashbox_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT current_session_id INTO v_session_id
    FROM cashboxes
    WHERE id = NEW.cashbox_id;

    IF NEW.type = 'prize' THEN
        v_signed := -1 * NEW.amount;
    ELSE
        v_signed := NEW.amount;
    END IF;

    INSERT INTO cashbox_transactions
        (cashbox_id, session_id, type, amount, signed_amount, transaction_id, performed_by, notes)
    VALUES
        (NEW.cashbox_id, v_session_id, NEW.type, NEW.amount, v_signed, NEW.id, NEW.created_by, NEW.notes);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_mirror_transaction_to_cashbox ON transactions;
CREATE TRIGGER trigger_mirror_transaction_to_cashbox
    AFTER INSERT ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION mirror_transaction_to_cashbox();

-- =============================================
-- 6. RLS — authenticated read; writes via service role
-- =============================================
ALTER TABLE cashboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashbox_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashbox_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_cashboxes" ON cashboxes FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_cashbox_sessions" ON cashbox_sessions FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_cashbox_transactions" ON cashbox_transactions FOR SELECT TO authenticated USING (true);

-- =============================================
-- 7. Comments
-- =============================================
COMMENT ON TABLE cashboxes IS
    'Caixa por (funcionário, etapa). Coexiste com stage_cash_register: este é o nível granular por operador; aquele é o agregado por stage.';
COMMENT ON TABLE cashbox_sessions IS
    'Histórico de aberturas e fechamentos do caixa. Cada sessão registra saldo esperado vs contado, com diferença.';
COMMENT ON TABLE cashbox_transactions IS
    'Ledger append-only de movimentações do caixa. Tipos: buy_in/rebuy/addon/prize/supply/sangria/adjustment.';
COMMENT ON COLUMN cashbox_transactions.signed_amount IS
    'amount com sinal: + para entrada (buy_in/rebuy/addon/supply), - para saída (prize/sangria), ± para adjustment.';
COMMENT ON COLUMN transactions.cashbox_id IS
    'Caixa do operador que registrou esta transação. NULL para transações legadas anteriores à migration.';

-- =============================================
-- 8. Auto-create cashboxes for existing staff with cashier permission
-- =============================================
-- For every (staff with cashier permission, active stage) pair that doesn't
-- have a cashbox yet, create one in `closed` status. Safe to re-run.
INSERT INTO cashboxes (staff_id, stage_id, status)
SELECT s.id, st.id, 'closed'
FROM staff s
JOIN permission_groups pg ON pg.id = s.permission_group_id
CROSS JOIN stages st
WHERE s.active = true
  AND (
    'cashier' = ANY(pg.permissions)
    OR 'cashbox.operate' = ANY(pg.permissions)
    OR 'employees' = ANY(pg.permissions)   -- admin-like groups
  )
ON CONFLICT (staff_id, stage_id) DO NOTHING;

-- =============================================
-- 9. Add new permission keys to the Admin group
-- =============================================
UPDATE permission_groups
SET permissions = array_append(permissions, 'cashbox.operate')
WHERE name = 'Admin'
  AND NOT ('cashbox.operate' = ANY(permissions));

UPDATE permission_groups
SET permissions = array_append(permissions, 'cashbox.admin')
WHERE name = 'Admin'
  AND NOT ('cashbox.admin' = ANY(permissions));
