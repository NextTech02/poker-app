-- Migration: mesas com quantos assentos o clube quiser
-- Date: 2026-10-12
--
-- O CHECK original travava a mesa em 10 lugares e o assento em 10 — mas o
-- salão monta mesa de 11 na final, de 12 em evento especial. O teto some;
-- o que fica é o que o modelo precisa: número positivo, e `occupied_seats`
-- nunca acima de `seats` (esse CHECK, `tournament_tables_check`, não muda).
--
-- Quem confere se o assento cabe na mesa é o serviço de alocação, contra
-- `tournament_tables.seats` — regra que já existia e continua.
--
-- Nomes conferidos em produção (pg_constraint) em 2026-10-12:
--   tournament_tables_seats_check        CHECK (seats > 0 AND seats <= 10)
--   seat_allocations_seat_number_check   CHECK (seat_number > 0 AND seat_number <= 10)

ALTER TABLE tournament_tables
  DROP CONSTRAINT IF EXISTS tournament_tables_seats_check;
ALTER TABLE tournament_tables
  ADD CONSTRAINT tournament_tables_seats_check CHECK (seats > 0);

ALTER TABLE seat_allocations
  DROP CONSTRAINT IF EXISTS seat_allocations_seat_number_check;
ALTER TABLE seat_allocations
  ADD CONSTRAINT seat_allocations_seat_number_check CHECK (seat_number > 0);

COMMENT ON COLUMN tournament_tables.seats IS
  'Total de assentos da mesa (sem teto; a tela sugere 9)';
COMMENT ON COLUMN seat_allocations.seat_number IS
  'Assento na mesa (1..seats da mesa)';
