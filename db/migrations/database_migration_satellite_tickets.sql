-- Migration: Satellite Tournament Tickets (simplified)
-- Description: Simple ticket system — satellite name is free text, target is a real tournament

-- =============================================
-- 1. Satellite Tickets
-- =============================================
CREATE TABLE IF NOT EXISTS satellite_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    satellite_name VARCHAR(255) NOT NULL,
    target_tournament_id UUID NOT NULL REFERENCES tournaments(id),
    target_tournament_day_id UUID REFERENCES tournament_days(id),
    player_id UUID NOT NULL REFERENCES players(id),
    ticket_value DECIMAL(10, 2) NOT NULL CHECK (ticket_value >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'awarded'
        CHECK (status IN ('awarded', 'redeemed', 'expired', 'cancelled')),
    redeemed_at TIMESTAMP WITH TIME ZONE,
    redeemed_tournament_player_id UUID REFERENCES tournament_players(id),
    stage_id UUID REFERENCES stages(id),
    notes TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- 2. Add ticket_id to transactions
-- =============================================
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ticket_id UUID REFERENCES satellite_tickets(id);

-- Update payment_source constraint to include 'ticket'
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_payment_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_payment_source_check
    CHECK (payment_source IN ('cash', 'credit', 'mixed', 'ticket'));

-- =============================================
-- 3. Indexes
-- =============================================
CREATE INDEX IF NOT EXISTS idx_satellite_tickets_player ON satellite_tickets(player_id);
CREATE INDEX IF NOT EXISTS idx_satellite_tickets_target ON satellite_tickets(target_tournament_id);
CREATE INDEX IF NOT EXISTS idx_satellite_tickets_status ON satellite_tickets(status);
CREATE INDEX IF NOT EXISTS idx_satellite_tickets_stage ON satellite_tickets(stage_id);

-- =============================================
-- 4. RLS Policies
-- =============================================
ALTER TABLE satellite_tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_tickets" ON satellite_tickets FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_manage_tickets" ON satellite_tickets FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update_tickets" ON satellite_tickets FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_delete_tickets" ON satellite_tickets FOR DELETE TO authenticated USING (true);
