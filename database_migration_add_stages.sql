-- Migration: Add stages (etapas) table and link tournaments to stages
-- Run this in Supabase SQL Editor

-- Step 1: Create stages table
CREATE TABLE IF NOT EXISTS stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255) NOT NULL,
    start_date DATE,
    end_date DATE,
    description TEXT,
    status VARCHAR(50) DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'active', 'completed', 'cancelled')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 2: Add stage_id column to tournaments table
ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS stage_id UUID REFERENCES stages(id) ON DELETE SET NULL;

-- Step 3: Create index on stage_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_tournaments_stage_id ON tournaments(stage_id);

-- Step 4: Create a default stage for existing tournaments
INSERT INTO stages (id, name, location, description, status)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Etapa Padrão',
    'Local Padrão',
    'Etapa padrão para torneios existentes',
    'active'
)
ON CONFLICT (id) DO NOTHING;

-- Step 5: Link existing tournaments to default stage
UPDATE tournaments
SET stage_id = '00000000-0000-0000-0000-000000000001'
WHERE stage_id IS NULL;

-- Step 6: Add trigger to update updated_at on stages
CREATE OR REPLACE FUNCTION update_stages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_stages_updated_at
    BEFORE UPDATE ON stages
    FOR EACH ROW
    EXECUTE FUNCTION update_stages_updated_at();

-- Step 7: Add comments
COMMENT ON TABLE stages IS 'Tournament stages/events (etapas) that group multiple tournaments';
COMMENT ON COLUMN stages.name IS 'Stage name (e.g., "Etapa Bogotá")';
COMMENT ON COLUMN stages.location IS 'Stage location/city';
COMMENT ON COLUMN stages.start_date IS 'Stage start date';
COMMENT ON COLUMN stages.end_date IS 'Stage end date';
COMMENT ON COLUMN stages.status IS 'Stage status: upcoming, active, completed, cancelled';
COMMENT ON COLUMN tournaments.stage_id IS 'Reference to the stage this tournament belongs to';
