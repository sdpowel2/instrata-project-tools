-- Adds `legacy_engineer_id` to projects.
--
-- Context: each real-world project lives as two rows (one per phase) because
-- Monday's pre-sales→post-sales automation duplicates the item onto the
-- post-sales board, and the monday-webhook creates a separate Project Tools
-- row for each Monday item. The two rows share `project_code`.
--
-- On a post-sales row, `owner_id` is the post-sales engineer. The legacy
-- pre-sales engineer remains attached because they retain some effort on the
-- project post-contract (institutional knowledge, hand-off, etc.). This
-- column carries that assignment forward for the bandwidth view on the
-- management dashboard.
--
-- Populated by the (future) monday sync of the post-sales board's pre-sales
-- engineer person column. Null until that sync lands.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS legacy_engineer_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS projects_legacy_engineer_id_idx
  ON public.projects (legacy_engineer_id);
