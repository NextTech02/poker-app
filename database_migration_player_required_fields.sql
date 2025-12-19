-- Migration: Add required fields to players table
-- Run this in Supabase SQL Editor

-- Step 1: Add new columns to players table (allow NULL initially)
ALTER TABLE players
ADD COLUMN IF NOT EXISTS email VARCHAR(255),
ADD COLUMN IF NOT EXISTS phone VARCHAR(50),
ADD COLUMN IF NOT EXISTS nationality VARCHAR(100),
ADD COLUMN IF NOT EXISTS document_type VARCHAR(50),
ADD COLUMN IF NOT EXISTS document_number VARCHAR(100);

-- Step 2: Update existing records with default values for required fields
-- This ensures existing players have valid data before applying NOT NULL constraints

-- Update name if null or empty
UPDATE players SET name = 'Nome Pendente' WHERE name IS NULL OR name = '';

-- Update email with a unique placeholder for existing players
UPDATE players
SET email = CONCAT('player_', id, '@placeholder.com')
WHERE email IS NULL OR email = '';

-- Update phone with placeholder
UPDATE players
SET phone = '+00 (00) 00000-0000'
WHERE phone IS NULL OR phone = '';

-- Update nationality with default value
UPDATE players
SET nationality = 'Brasil'
WHERE nationality IS NULL OR nationality = '';

-- Update document_type with default value
UPDATE players
SET document_type = 'national_id'
WHERE document_type IS NULL OR document_type = '';

-- Update document_number with unique placeholder
UPDATE players
SET document_number = CONCAT('DOC-', SUBSTRING(id::text, 1, 8))
WHERE document_number IS NULL OR document_number = '';

-- Step 3: Now apply NOT NULL constraints (data is populated)
ALTER TABLE players ALTER COLUMN name SET NOT NULL;
ALTER TABLE players ALTER COLUMN email SET NOT NULL;
ALTER TABLE players ALTER COLUMN phone SET NOT NULL;
ALTER TABLE players ALTER COLUMN nationality SET NOT NULL;
ALTER TABLE players ALTER COLUMN document_type SET NOT NULL;
ALTER TABLE players ALTER COLUMN document_number SET NOT NULL;

-- Add unique constraint on email
ALTER TABLE players ADD CONSTRAINT players_email_unique UNIQUE (email);

-- Add unique constraint on document (combination of type and number)
ALTER TABLE players ADD CONSTRAINT players_document_unique UNIQUE (document_type, document_number);

-- Add check constraint for document type
ALTER TABLE players ADD CONSTRAINT players_document_type_check
CHECK (document_type IN ('passport', 'national_id', 'driver_license'));

-- Create index on email for faster lookups
CREATE INDEX IF NOT EXISTS idx_players_email ON players(email);

-- Create index on document for faster lookups
CREATE INDEX IF NOT EXISTS idx_players_document ON players(document_type, document_number);

-- Add comment to table
COMMENT ON TABLE players IS 'Stores player information with required contact and identification details';
COMMENT ON COLUMN players.email IS 'Player email address (required, unique)';
COMMENT ON COLUMN players.phone IS 'Player phone number with country code (required)';
COMMENT ON COLUMN players.nationality IS 'Player nationality/country (required)';
COMMENT ON COLUMN players.document_type IS 'Type of identification document: passport, national_id, or driver_license';
COMMENT ON COLUMN players.document_number IS 'Document identification number (required, unique per type)';
