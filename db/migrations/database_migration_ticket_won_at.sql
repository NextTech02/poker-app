-- Migration: Add `won_at` to satellite_tickets so the audit trail captures
-- where a ticket was originally won. The value may be an internal tournament
-- name OR an external platform (PokerStars, GGPoker, etc.) — free text.
-- Combined with `funded_by` (already present after the previous migration),
-- this gives full provenance: who is responsible for the value AND where the
-- player won the right to that value.

ALTER TABLE satellite_tickets
    ADD COLUMN IF NOT EXISTS won_at TEXT;

-- Optional retro-fill: if any legacy rows stashed both fields into `notes`
-- using the "Ganho em: X | Financiado por: Y" convention, you can extract
-- them with the following statements (commented out — run only if needed):
--
-- UPDATE satellite_tickets
--     SET won_at = TRIM(SUBSTRING(notes FROM 'Ganho em:\s*([^|]+)'))
--     WHERE won_at IS NULL AND notes ILIKE 'Ganho em:%';
--
-- UPDATE satellite_tickets
--     SET funded_by = TRIM(SUBSTRING(notes FROM 'Financiado por:\s*([^|]+)'))
--     WHERE funded_by IS NULL AND notes ILIKE '%Financiado por:%';
