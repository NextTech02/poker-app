-- Migration: Create blind_templates table for reusable blind structures
-- Date: 2025-02-05

-- Create blind_templates table
CREATE TABLE IF NOT EXISTS blind_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,

    -- Blind configuration
    blind_duration INTEGER NOT NULL DEFAULT 15,
    initial_small_blind INTEGER NOT NULL DEFAULT 25,
    initial_big_blind INTEGER NOT NULL DEFAULT 50,
    blind_increase_type VARCHAR(20) NOT NULL DEFAULT 'double',
    bb_ante_start_level INTEGER DEFAULT 3,

    -- Optional: Custom levels (if not using auto-generation)
    -- Each level: { level, small_blind, big_blind, ante, duration }
    custom_levels JSONB,

    -- Break configuration
    break_interval INTEGER DEFAULT 60,
    break_duration INTEGER DEFAULT 10,

    -- Metadata
    stage_id UUID REFERENCES stages(id) ON DELETE SET NULL,
    created_by UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Ensure unique names within a stage (or globally if no stage)
    CONSTRAINT unique_template_name_per_stage UNIQUE (name, stage_id)
);

-- Index for faster lookups
CREATE INDEX idx_blind_templates_stage_id ON blind_templates(stage_id);
CREATE INDEX idx_blind_templates_created_by ON blind_templates(created_by);

-- Add RLS policies
ALTER TABLE blind_templates ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can read templates
CREATE POLICY "Anyone can read blind templates"
    ON blind_templates FOR SELECT
    USING (true);

-- Policy: Authenticated users can create templates
CREATE POLICY "Authenticated users can create blind templates"
    ON blind_templates FOR INSERT
    WITH CHECK (true);

-- Policy: Users can update their own templates
CREATE POLICY "Users can update blind templates"
    ON blind_templates FOR UPDATE
    USING (true);

-- Policy: Users can delete their own templates
CREATE POLICY "Users can delete blind templates"
    ON blind_templates FOR DELETE
    USING (true);

-- Comment on table
COMMENT ON TABLE blind_templates IS 'Stores reusable blind structure templates for tournaments';
COMMENT ON COLUMN blind_templates.custom_levels IS 'Optional JSON array of custom blind levels: [{level, small_blind, big_blind, ante, duration}]';
