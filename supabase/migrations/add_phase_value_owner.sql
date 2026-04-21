-- Phase 1 design refresh — add phase / contracted value / owner to projects.
--
-- phase     : Pre-Sales | Post-Sales (drives sidebar tool grouping + accent colors)
-- value     : human-formatted contracted/quoted value, e.g. "$482K", "$1.2M"
-- owner_id  : auth.users.id of the engineer this project is assigned to
--             (used by Dashboard "My Projects" filter)

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'Post-Sales',
  ADD COLUMN IF NOT EXISTS value text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Constrain phase to the two known values; leaves room to add later.
ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_phase_check;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_phase_check
  CHECK (phase IN ('Pre-Sales', 'Post-Sales'));

-- Index for "My Projects" lookups.
CREATE INDEX IF NOT EXISTS projects_owner_id_idx ON public.projects (owner_id);
