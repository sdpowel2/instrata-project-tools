-- Add DTools project tracking fields to projects table
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS dtools_project_id text,
  ADD COLUMN IF NOT EXISTS dtools_bom_status text NOT NULL DEFAULT '';
-- dtools_bom_status values: '' (not checked), 'found', 'not_found', 'error'
