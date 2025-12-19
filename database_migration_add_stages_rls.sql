-- Migration: Add RLS policies for stages table
-- Description: Adds Row Level Security policies to allow authenticated users to manage stages
-- Date: 2025-11-12

-- Enable RLS on stages table (if not already enabled)
ALTER TABLE stages ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Allow authenticated users to read stages" ON stages;
DROP POLICY IF EXISTS "Allow authenticated users to create stages" ON stages;
DROP POLICY IF EXISTS "Allow authenticated users to update stages" ON stages;
DROP POLICY IF EXISTS "Allow authenticated users to delete stages" ON stages;

-- Create policy to allow authenticated users to read stages
CREATE POLICY "Allow authenticated users to read stages"
ON stages FOR SELECT
TO authenticated
USING (true);

-- Create policy to allow authenticated users to create stages
CREATE POLICY "Allow authenticated users to create stages"
ON stages FOR INSERT
TO authenticated
WITH CHECK (true);

-- Create policy to allow authenticated users to update stages
CREATE POLICY "Allow authenticated users to update stages"
ON stages FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

-- Create policy to allow authenticated users to delete stages
CREATE POLICY "Allow authenticated users to delete stages"
ON stages FOR DELETE
TO authenticated
USING (true);

-- Allow anonymous users to read stages (optional, for public displays)
DROP POLICY IF EXISTS "Allow anonymous users to read stages" ON stages;
CREATE POLICY "Allow anonymous users to read stages"
ON stages FOR SELECT
TO anon
USING (true);
