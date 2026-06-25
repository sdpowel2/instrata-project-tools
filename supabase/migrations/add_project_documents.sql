-- Project Documentation — auto-generated reports built from a synced BoM.
-- Phase 1 ships one report type: the Gross Margin Form ('gross_margin'),
-- which accounting uses to open a project. The form auto-fills from the
-- DTools sync and is then hand-editable so the numbers can be nudged to
-- match the quote penny-for-penny without re-editing a PDF.
--
-- Design: the form's DEFAULT values are computed live from project_bom_items
-- + the projects DTools snapshot every render. This table stores ONLY the
-- per-field overrides a user has typed, so a re-sync keeps refreshing the
-- defaults underneath while preserving the operator's manual corrections.

-- ── projects: GM metadata snapshot ───────────────────────────────────────────
-- Captured at sync time from the DTools project payload — the project-level
-- fields the GM Form needs that aren't already on projects / project_bom_items:
--   header:  { quoteNumber, poNumber, salesRep, engineer, clientEmail,
--              siteAddress, billingAddress }
--   custom:  { subsidiary, branch, projectType, aiaInvoicing, prevailingWage,
--              timeAndMaterials, materialOnly }   (DTools CustomField 27/28/29/1/30/23/24)
--   tax:     { rate, materialsTax, laborTax, total }   (from DTools Taxes[])
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS dtools_gm_meta jsonb;

-- ── project_documents ────────────────────────────────────────────────────────
create table if not exists public.project_documents (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  doc_type    text not null,                       -- 'gross_margin' (extensible)
  overrides   jsonb not null default '{}'::jsonb,  -- { fieldKey: value } manual edits
  status      text not null default 'draft',       -- free-text; app-typed
  edited_by   uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, doc_type)
);

alter table public.project_documents enable row level security;

-- Reads open org-wide (matches the project access model — see
-- open_project_view_access.sql); writes gated to project-team members.
create policy "Authenticated users can view project documents"
  on public.project_documents for select
  using (auth.uid() is not null);

create policy "Members can manage project documents"
  on public.project_documents for all
  using (public.is_project_member(project_id));

create index if not exists idx_project_documents_project
  on public.project_documents (project_id);

-- Keep updated_at fresh (reuses the generic trigger fn from migration.sql).
drop trigger if exists set_project_documents_updated_at on public.project_documents;
create trigger set_project_documents_updated_at
  before update on public.project_documents
  for each row execute function public.set_updated_at();
