-- Migration: Simplified Ticket Flow
-- Description:
--   * Tickets are now bound to a player + target tournament + target day at
--     creation time (player_id NOT NULL going forward).
--   * Ticket value is derived from the target day's buy_in by the backend.
--   * `funded_by` (free text) is captured at redemption and identifies who
--     paid for the ticket (e.g. "Suprema", "GGPoker", "Empresa").
--   * `satellite_name` becomes optional so the legacy column does not block
--     creation under the new flow. Existing rows keep their values.

ALTER TABLE satellite_tickets
    ALTER COLUMN satellite_name DROP NOT NULL;

ALTER TABLE satellite_tickets
    ADD COLUMN IF NOT EXISTS funded_by TEXT;
