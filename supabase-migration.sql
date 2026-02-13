-- Mubadla Photo Booth - Photos Table Migration
-- Run this in your Supabase SQL Editor

-- Create the photos table
CREATE TABLE IF NOT EXISTS photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_url TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security (optional, but recommended)
ALTER TABLE photos ENABLE ROW LEVEL SECURITY;

-- Create a policy to allow public read access (for the landing page)
CREATE POLICY "Allow public read access" ON photos
  FOR SELECT
  USING (true);

-- Create a policy to allow service role to insert
CREATE POLICY "Allow service role insert" ON photos
  FOR INSERT
  WITH CHECK (true);

-- Create an index on created_at for efficient queries
CREATE INDEX IF NOT EXISTS photos_created_at_idx ON photos(created_at DESC);
