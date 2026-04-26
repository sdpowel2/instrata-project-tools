-- Monday.com phase + status sync — schema changes.
--
-- Adds:
--   project_code              : INST-YYYY-NNNN, the persistent link between
--                               Project Tools and Monday across both pre-sales
--                               and post-sales boards. UNIQUE.
--   monday_presales_item_id   : Monday item id on the AV Pre-Sales Summary
--                               board (3477536693). Cached for deep-linking.
--   monday_postsales_item_id  : Monday item id on the post-sales board
--                               (3523133226). Cached for deep-linking.
--   generate_project_code()   : SQL function that returns the next available
--                               INST-YYYY-NNNN for the current year.
--
-- Status column stays free-text — Monday can add new status values without
-- a schema migration breaking sync. App layer enforces the union type.
--
-- Note: monday_item_id (legacy single-board pointer) is retained for now so
-- nothing breaks during cutover. It can be dropped after the backfill runs
-- and the codebase is fully migrated to project_code.

-- ============================================================================
-- 1. New columns on projects
-- ============================================================================

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS project_code             text UNIQUE,
  ADD COLUMN IF NOT EXISTS monday_presales_item_id  bigint UNIQUE,
  ADD COLUMN IF NOT EXISTS monday_postsales_item_id bigint UNIQUE;

CREATE INDEX IF NOT EXISTS projects_project_code_idx
  ON public.projects (project_code);

-- ============================================================================
-- 2. Project code generator
-- ============================================================================
-- Format: INST-YYYY-NNNN (e.g. INST-2026-0042)
-- Sequence resets each year. Uses a transaction-level advisory lock keyed on
-- the year so concurrent inserts can't collide on the same suffix.
CREATE OR REPLACE FUNCTION public.generate_project_code()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_year int := EXTRACT(YEAR FROM now())::int;
  v_next int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('project_code:' || v_year));

  SELECT COALESCE(
    MAX((regexp_match(project_code, '^INST-' || v_year || '-(\d+)$'))[1]::int),
    0
  ) + 1
    INTO v_next
    FROM public.projects
   WHERE project_code LIKE 'INST-' || v_year || '-%';

  RETURN 'INST-' || v_year || '-' || lpad(v_next::text, 4, '0');
END;
$$;

-- ============================================================================
-- 3. Phase default fix
-- ============================================================================
-- Previous default was 'Post-Sales' which caused every newly-created project
-- to land in post-sales regardless of its real Monday board. New projects
-- should start in Pre-Sales; the webhook flips them to Post-Sales when they
-- appear on the post-sales board.
ALTER TABLE public.projects
  ALTER COLUMN phase SET DEFAULT 'Pre-Sales';

-- ============================================================================
-- 4. Status default
-- ============================================================================
-- Default of 'Active' was a legacy carry-over. New projects now default to
-- 'Not Started' (a real Monday pre-sales status).
ALTER TABLE public.projects
  ALTER COLUMN status SET DEFAULT 'Not Started';
