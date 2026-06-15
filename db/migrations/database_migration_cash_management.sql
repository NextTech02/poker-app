-- Migration: Cash Management System with Sangria and Rake
-- Description: Adds cash register functionality with daily cash, general cash, and rake tracking

-- Table: stage_cash_register (Caixa do Dia)
-- One record per stage to track daily cash before sangria
CREATE TABLE IF NOT EXISTS stage_cash_register (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stage_id UUID NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    current_balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    total_received DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    total_sangrias DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stage_id)
);

-- Table: general_cash_register (Caixa Geral)
-- Accumulates cash from all sangrias (after rake deduction)
CREATE TABLE IF NOT EXISTS general_cash_register (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    current_balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    total_received DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table: rake_register (Registro de Rake)
-- Tracks accumulated rake (house profit)
CREATE TABLE IF NOT EXISTS rake_register (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    total_rake DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table: sangria_transactions (Histórico de Sangrias)
-- Records each sangria operation with rake calculation
CREATE TABLE IF NOT EXISTS sangria_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stage_id UUID NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    stage_name VARCHAR(255) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL, -- Total amount before rake
    rake_percentage DECIMAL(5, 2) NOT NULL DEFAULT 20.00, -- Rake percentage (default 20%)
    rake_amount DECIMAL(10, 2) NOT NULL, -- Rake amount deducted
    net_amount DECIMAL(10, 2) NOT NULL, -- Amount after rake (goes to general cash)
    notes TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert initial general cash register if not exists
INSERT INTO general_cash_register (current_balance, total_received)
SELECT 0.00, 0.00
WHERE NOT EXISTS (SELECT 1 FROM general_cash_register LIMIT 1);

-- Insert initial rake register if not exists
INSERT INTO rake_register (total_rake)
SELECT 0.00
WHERE NOT EXISTS (SELECT 1 FROM rake_register LIMIT 1);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_sangria_transactions_stage_id ON sangria_transactions(stage_id);
CREATE INDEX IF NOT EXISTS idx_sangria_transactions_created_at ON sangria_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stage_cash_register_stage_id ON stage_cash_register(stage_id);

-- Function to automatically create stage_cash_register when a new stage is created
CREATE OR REPLACE FUNCTION create_stage_cash_register()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO stage_cash_register (stage_id, current_balance, total_received, total_sangrias)
    VALUES (NEW.id, 0.00, 0.00, 0.00)
    ON CONFLICT (stage_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to create cash register for new stages
DROP TRIGGER IF EXISTS trigger_create_stage_cash_register ON stages;
CREATE TRIGGER trigger_create_stage_cash_register
    AFTER INSERT ON stages
    FOR EACH ROW
    EXECUTE FUNCTION create_stage_cash_register();

-- Create cash registers for existing stages
INSERT INTO stage_cash_register (stage_id, current_balance, total_received, total_sangrias)
SELECT id, 0.00, 0.00, 0.00
FROM stages
ON CONFLICT (stage_id) DO NOTHING;

-- Function to update stage_cash_register when transactions are added
CREATE OR REPLACE FUNCTION update_stage_cash_on_transaction()
RETURNS TRIGGER AS $$
DECLARE
    v_stage_id UUID;
BEGIN
    -- Get stage_id from tournament
    SELECT t.stage_id INTO v_stage_id
    FROM tournaments t
    WHERE t.id = NEW.tournament_id;

    -- Only update if stage exists
    IF v_stage_id IS NOT NULL THEN
        -- Update or create cash register for this stage
        INSERT INTO stage_cash_register (stage_id, current_balance, total_received, total_sangrias)
        VALUES (v_stage_id, NEW.amount, NEW.amount, 0.00)
        ON CONFLICT (stage_id)
        DO UPDATE SET
            current_balance = stage_cash_register.current_balance + NEW.amount,
            total_received = stage_cash_register.total_received + NEW.amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE NEW.type IN ('buy_in', 'rebuy', 'addon');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update cash register when transactions are created
DROP TRIGGER IF EXISTS trigger_update_stage_cash_on_transaction ON transactions;
CREATE TRIGGER trigger_update_stage_cash_on_transaction
    AFTER INSERT ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_stage_cash_on_transaction();

-- Add comments for documentation
COMMENT ON TABLE stage_cash_register IS 'Caixa do dia - tracks daily cash per stage before sangria';
COMMENT ON TABLE general_cash_register IS 'Caixa geral - accumulates cash from all sangrias after rake deduction';
COMMENT ON TABLE rake_register IS 'Registro de rake - tracks total house profit (rake)';
COMMENT ON TABLE sangria_transactions IS 'Histórico de sangrias - records all sangria operations with rake calculation';

-- Grant permissions (adjust according to your RLS policies)
ALTER TABLE stage_cash_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE general_cash_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE rake_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE sangria_transactions ENABLE ROW LEVEL SECURITY;

-- RLS Policies (authenticated users can read, only admins can modify)
CREATE POLICY "Enable read access for authenticated users" ON stage_cash_register
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Enable read access for authenticated users" ON general_cash_register
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Enable read access for authenticated users" ON rake_register
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Enable read access for authenticated users" ON sangria_transactions
    FOR SELECT USING (auth.role() = 'authenticated');

-- Insert policies for creating sangria transactions (authenticated users)
CREATE POLICY "Enable insert for authenticated users" ON sangria_transactions
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');
