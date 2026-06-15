-- Migration: Prize reserved %, release gate, and per-tier visibility
-- Feature 4.1: reserved prize percentage (blocked from payout, destined to ranking/staff)
-- Feature 4.3: release gate (prize can only be paid after being released)
-- Feature 4.4: per-tier public visibility toggle (hide without deleting)

-- Tournament-level reserved prize config
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS reserved_prize_percentage NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (reserved_prize_percentage >= 0 AND reserved_prize_percentage <= 100),
  ADD COLUMN IF NOT EXISTS reserved_purpose VARCHAR(20);  -- 'ranking' | 'staff' | NULL

COMMENT ON COLUMN tournaments.reserved_prize_percentage IS
  'Percentual da premiação reservado (bloqueado do pagamento aos jogadores), destinado a ranking/staff.';
COMMENT ON COLUMN tournaments.reserved_purpose IS 'Destino da premiação reservada: ranking | staff.';

-- Per-allocation release + visibility
ALTER TABLE prize_allocations
  ADD COLUMN IF NOT EXISTS released     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS released_at  TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS released_by  UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS visible      BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN prize_allocations.released IS
  'Premiação liberada para pagamento. Só pode ser paga quando released = true (aba de liberação).';
COMMENT ON COLUMN prize_allocations.visible IS
  'Visibilidade pública da faixa. Faixas com visible=false somem da exibição pública sem apagar o dado.';
