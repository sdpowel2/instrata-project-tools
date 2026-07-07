-- Project Files — per-project document repository backed by SharePoint.
-- SharePoint holds the bytes (company-browsable "Projects" site, one folder
-- per project); this table is the canonical index the app and MCP server
-- browse. Rows are written by the sharepoint-project-files edge function
-- (uploads, auto-filed generated docs) and by its `sync` op, which reconciles
-- files people dropped into SharePoint directly (source = 'sharepoint_sync').
-- See Product Spec/04-project-files.md.

-- ── projects: cached Graph folder pointer ────────────────────────────────────
-- Set on first ensureProjectFolder so subsequent ops skip the path lookup.
-- The folder is tracked by immutable Graph item id, so renaming the project
-- in the app doesn't break anything (the folder just keeps its old name).
alter table public.projects
  add column if not exists sharepoint_folder_id text;

-- ── project_files ─────────────────────────────────────────────────────────────
create table if not exists public.project_files (
  id                       uuid primary key default gen_random_uuid(),
  project_id               uuid not null references public.projects(id) on delete cascade,
  -- Standard subfolder the file lives in. Kept as text (app-typed) to match
  -- the status/doc_type convention elsewhere; values: contracts, drawings,
  -- submittals, meeting_notes, photos, closeout, general.
  category                 text not null default 'general',
  filename                 text not null,
  sharepoint_item_id       text not null unique,  -- Graph driveItem id — canonical pointer
  sharepoint_path          text not null,         -- human-readable drive path for display
  sharepoint_web_url       text,                  -- direct browser link ("Open in SharePoint")
  size_bytes               bigint,
  mime_type                text,
  -- upload = through the app; generated = auto-filed export;
  -- sharepoint_sync = discovered by reconcile (added outside the app).
  source                   text not null default 'upload',
  -- For generated docs: submittal_package, rfi, closeout, sign_off,
  -- warranty, punch_list, manuals. Null for plain uploads.
  doc_type                 text,
  uploaded_by              uuid references public.profiles(id) on delete set null,
  sharepoint_modified_at   timestamptz,           -- Graph lastModifiedDateTime; drives reconcile
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.project_files enable row level security;

-- Reads open org-wide (matches open_project_view_access.sql — and the backing
-- SharePoint site is company-browsable anyway, so hiding index rows would be
-- theater). Writes gated to project-team members; the edge function runs
-- service-role and re-checks membership in code.
create policy "Authenticated users can view project files"
  on public.project_files for select
  using (auth.uid() is not null);

create policy "Members can add project files"
  on public.project_files for insert
  with check (public.is_project_member(project_id));

create policy "Members can update project files"
  on public.project_files for update
  using (public.is_project_member(project_id))
  with check (public.is_project_member(project_id));

create policy "Members can delete project files"
  on public.project_files for delete
  using (public.is_project_member(project_id));

create index if not exists idx_project_files_project_category
  on public.project_files (project_id, category);
create index if not exists idx_project_files_project_created
  on public.project_files (project_id, created_at desc);

-- Keep updated_at fresh (reuses the generic trigger fn from migration.sql).
drop trigger if exists set_project_files_updated_at on public.project_files;
create trigger set_project_files_updated_at
  before update on public.project_files
  for each row execute function public.set_updated_at();

-- ── project-files-temp: pass-through staging bucket ──────────────────────────
-- The browser uploads here, then calls the edge function with the storage
-- path; the function downloads the bytes, PUTs them to SharePoint, and
-- deletes the temp object. This bypasses the edge-function body-size limit
-- (same pattern as cutsheet-temp). Private bucket: clients only need INSERT;
-- the edge function reads/deletes with the service role, which bypasses RLS.
insert into storage.buckets (id, name, public, file_size_limit)
values ('project-files-temp', 'project-files-temp', false, 104857600)  -- 100 MB
on conflict (id) do nothing;

create policy "Authenticated users can stage project files"
  on storage.objects for insert
  with check (bucket_id = 'project-files-temp' and auth.uid() is not null);
