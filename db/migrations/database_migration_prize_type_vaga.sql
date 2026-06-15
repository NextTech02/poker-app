-- Migration: Prize type "Vaga" (ticket entry)
-- Feature 4.2: a prize tier that grants a tournament entry (ticket) instead of cash.
--   Value equals the target day's buy-in. Cannot be paid in cash; on release it
--   generates a satellite_ticket bound to the awarded player + target day.

ALTER TABLE prize_allocations
  ADD COLUMN IF NOT EXISTS prize_type VARCHAR(10) NOT NULL DEFAULT 'cash'
    CHECK (prize_type IN ('cash', 'vaga')),
  ADD COLUMN IF NOT EXISTS vaga_target_tournament_id UUID REFERENCES tournaments(id),
  ADD COLUMN IF NOT EXISTS vaga_target_day_id        UUID REFERENCES tournament_days(id),
  ADD COLUMN IF NOT EXISTS generated_ticket_id       UUID REFERENCES satellite_tickets(id);

COMMENT ON COLUMN prize_allocations.prize_type IS
  'Tipo de premiação: cash (dinheiro) ou vaga (ticket de entrada). Vaga não pode ser paga em dinheiro.';
COMMENT ON COLUMN prize_allocations.vaga_target_day_id IS
  'Dia alvo cujo buy-in define o valor da vaga e para onde o ticket dá entrada.';
COMMENT ON COLUMN prize_allocations.generated_ticket_id IS
  'satellite_ticket gerado quando a vaga foi liberada (evita duplicação).';
