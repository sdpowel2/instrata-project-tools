-- Fix race condition in generate_project_code().
--
-- The original function read MAX(project_code) from the `projects` table and
-- incremented. Even with pg_advisory_xact_lock, the lock released as soon as
-- the function returned — well before the caller actually INSERTed the new
-- project row. Parallel workers calling generate_project_code() back-to-back
-- (e.g. the monday-backfill function with 8 concurrent tasks) would all read
-- the same "max" and get the same code → unique-constraint violations on all
-- but the first INSERT.
--
-- This migration replaces that with a small counter table that increments
-- atomically via UPSERT-with-RETURNING. The counter is independent of insert
-- timing, so concurrent calls always get distinct codes.
--
-- A seeder function lets the backfill bump the counter past any codes that
-- were written directly to Monday during the failed partial run, so we don't
-- regenerate values that already exist on the Monday side.

CREATE TABLE IF NOT EXISTS public.project_code_counters (
  year     int PRIMARY KEY,
  last_seq int NOT NULL DEFAULT 0
);

-- Seed the counter for the current year from any existing project_codes in
-- the projects table, so the first call after this migration doesn't restart
-- from 1 and clash with rows already inserted.
INSERT INTO public.project_code_counters (year, last_seq)
SELECT
  EXTRACT(YEAR FROM now())::int,
  COALESCE(MAX((regexp_match(project_code, '^INST-' || EXTRACT(YEAR FROM now())::int || '-(\d+)$'))[1]::int), 0)
FROM public.projects
WHERE project_code IS NOT NULL
ON CONFLICT (year) DO NOTHING;

-- Atomic generator. UPSERT either inserts the year row at 1 or updates the
-- existing row by incrementing. Returns the new value in the same statement.
CREATE OR REPLACE FUNCTION public.generate_project_code()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_year int := EXTRACT(YEAR FROM now())::int;
  v_next int;
BEGIN
  INSERT INTO public.project_code_counters (year, last_seq)
  VALUES (v_year, 1)
  ON CONFLICT (year) DO UPDATE
    SET last_seq = public.project_code_counters.last_seq + 1
  RETURNING last_seq INTO v_next;

  RETURN 'INST-' || v_year || '-' || lpad(v_next::text, 4, '0');
END;
$$;

-- Bump the counter to at least p_min_seq for the given year. Idempotent —
-- never decreases the counter. Used by the backfill function to absorb any
-- codes that exist on Monday but not yet in Supabase.
CREATE OR REPLACE FUNCTION public.seed_project_code_counter(p_year int, p_min_seq int)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.project_code_counters (year, last_seq)
  VALUES (p_year, p_min_seq)
  ON CONFLICT (year) DO UPDATE
    SET last_seq = GREATEST(public.project_code_counters.last_seq, p_min_seq);
END;
$$;
