-- Migration: Sangi — chip consignment (isolated ledger)
-- Feature 1: a "sangi" sells chips around the room from a bag.
--   Cashier releases a chip value to the sangi as a consignment balance; the
--   sangi registers each sale (amount + buyer); on return the cashier reconciles
--   sold vs released and flags divergences.
-- Decisions: isolated ledger (no cashboxes/transactions); buyer = registered player.

-- 1. chip_consignments — one open cycle per (sangi, stage)
CREATE TABLE IF NOT EXISTS chip_consignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sangi_staff_id  UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
    stage_id        UUID NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    released_amount DECIMAL(10, 2) NOT NULL CHECK (released_amount > 0),
    total_sold      DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (total_sold >= 0),
    divergence      DECIMAL(10, 2),
    status          VARCHAR(12) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'reconciled')),
    opened_by     UUID REFERENCES auth.users(id),
    opened_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reconciled_by UUID REFERENCES auth.users(id),
    reconciled_at TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chip_consignments_sangi ON chip_consignments(sangi_staff_id);
CREATE INDEX IF NOT EXISTS idx_chip_consignments_stage ON chip_consignments(stage_id);
CREATE INDEX IF NOT EXISTS idx_chip_consignments_status ON chip_consignments(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chip_consignment_open
    ON chip_consignments(sangi_staff_id, stage_id) WHERE status = 'open';

-- 2. chip_consignment_sales — each sale, buyer = registered player (audit)
CREATE TABLE IF NOT EXISTS chip_consignment_sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consignment_id  UUID NOT NULL REFERENCES chip_consignments(id) ON DELETE CASCADE,
    amount          DECIMAL(10, 2) NOT NULL CHECK (amount > 0),
    buyer_player_id UUID NOT NULL REFERENCES players(id),
    sold_by         UUID REFERENCES auth.users(id),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chip_sales_consignment ON chip_consignment_sales(consignment_id);
CREATE INDEX IF NOT EXISTS idx_chip_sales_buyer ON chip_consignment_sales(buyer_player_id);

-- 3. Trigger — keep total_sold in sync; block sales on reconciled consignments
CREATE OR REPLACE FUNCTION chip_consignment_apply_sale()
RETURNS TRIGGER AS $$
DECLARE
    v_status VARCHAR(12);
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT status INTO v_status FROM chip_consignments WHERE id = NEW.consignment_id;
        IF v_status IS NULL THEN
            RAISE EXCEPTION 'Consignação não encontrada';
        END IF;
        IF v_status <> 'open' THEN
            RAISE EXCEPTION 'Consignação já reconciliada; não aceita novas vendas';
        END IF;
        UPDATE chip_consignments
            SET total_sold = total_sold + NEW.amount, updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.consignment_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE chip_consignments
            SET total_sold = GREATEST(total_sold - OLD.amount, 0), updated_at = CURRENT_TIMESTAMP
            WHERE id = OLD.consignment_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_chip_consignment_apply_sale ON chip_consignment_sales;
CREATE TRIGGER trigger_chip_consignment_apply_sale
    AFTER INSERT OR DELETE ON chip_consignment_sales
    FOR EACH ROW EXECUTE FUNCTION chip_consignment_apply_sale();

-- 4. RLS — authenticated read (writes via service role, like the rest of the app)
ALTER TABLE chip_consignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chip_consignment_sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_chip_consignments" ON chip_consignments FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_chip_sales" ON chip_consignment_sales FOR SELECT TO authenticated USING (true);

-- 5. Permissions: new keys 'sangi' and 'prizes_release' + dedicated Sangi group
UPDATE permission_groups SET permissions = array_append(permissions, 'sangi')
WHERE name = 'Admin' AND NOT ('sangi' = ANY(permissions));
UPDATE permission_groups SET permissions = array_append(permissions, 'prizes_release')
WHERE name = 'Admin' AND NOT ('prizes_release' = ANY(permissions));
INSERT INTO permission_groups (name, description, permissions)
VALUES ('Sangi', 'Vendedora de fichas em consignação (acesso restrito à venda)', ARRAY['sangi'])
ON CONFLICT (name) DO NOTHING;
