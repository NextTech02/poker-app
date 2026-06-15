-- Create blinds table for tournament blind structure management
CREATE TABLE IF NOT EXISTS public.blinds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
    level INTEGER NOT NULL CHECK (level > 0),
    small_blind INTEGER NOT NULL CHECK (small_blind > 0),
    big_blind INTEGER NOT NULL CHECK (big_blind > 0),
    ante INTEGER NOT NULL DEFAULT 0 CHECK (ante >= 0),
    duration INTEGER NOT NULL DEFAULT 15 CHECK (duration > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Ensure unique blind levels per tournament
    UNIQUE(tournament_id, level)
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_blinds_tournament_id ON public.blinds(tournament_id);
CREATE INDEX IF NOT EXISTS idx_blinds_tournament_level ON public.blinds(tournament_id, level);

-- Add RLS policies
ALTER TABLE public.blinds ENABLE ROW LEVEL SECURITY;

-- Policy: Allow authenticated users to read all blinds
CREATE POLICY "Allow authenticated users to read blinds"
    ON public.blinds
    FOR SELECT
    TO authenticated
    USING (true);

-- Policy: Allow authenticated users to insert blinds
CREATE POLICY "Allow authenticated users to insert blinds"
    ON public.blinds
    FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- Policy: Allow authenticated users to update blinds
CREATE POLICY "Allow authenticated users to update blinds"
    ON public.blinds
    FOR UPDATE
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- Policy: Allow authenticated users to delete blinds
CREATE POLICY "Allow authenticated users to delete blinds"
    ON public.blinds
    FOR DELETE
    TO authenticated
    USING (true);

-- Add comment to table
COMMENT ON TABLE public.blinds IS 'Stores blind structure configurations for tournaments';
COMMENT ON COLUMN public.blinds.level IS 'Blind level number (1, 2, 3, ...)';
COMMENT ON COLUMN public.blinds.small_blind IS 'Small blind amount for this level';
COMMENT ON COLUMN public.blinds.big_blind IS 'Big blind amount for this level';
COMMENT ON COLUMN public.blinds.ante IS 'Ante amount for this level (0 if no ante)';
COMMENT ON COLUMN public.blinds.duration IS 'Duration of this blind level in minutes';
