-- Migration: Prize payout with document validation
-- Run this in the Supabase SQL Editor
-- NOTE: players table already has document_type and document_number columns.

-- Add document and payout tracking fields to prize_allocations
ALTER TABLE prize_allocations
  ADD COLUMN IF NOT EXISTS document_type   VARCHAR(30),   -- 'passport', 'national_id', 'driver_license'
  ADD COLUMN IF NOT EXISTS document_number VARCHAR(100),  -- document number entered at payout
  ADD COLUMN IF NOT EXISTS paid_by         VARCHAR(255);  -- staff member who processed payment
