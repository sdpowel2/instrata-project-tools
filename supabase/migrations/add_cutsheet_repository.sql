-- Cutsheet repository — SharePoint-backed canonical catalog of approved
-- product cutsheets, plus a staging triage queue for new uploads.
--
-- Lookups during submittal generation match BoM rows by manufacturer +
-- model number. Lookups are case-insensitive (DTools data is inconsistent
-- about case and spacing), so the unique index is on lower(...).
--
-- See docs in supabase/functions/sharepoint-cutsheet/ for the Graph API
-- side. SharePoint item IDs in this table are the durable IDs returned by
-- Graph, NOT the human-readable paths — paths are stored separately for
-- display only and aren't used for fetching.

-- ─── Repository (approved, canonical) ────────────────────────────────────────
create table if not exists public.cutsheet_repository (
  id                    uuid primary key default gen_random_uuid(),
  manufacturer          text not null,
  model_number          text not null,
  display_name          text,
  category              text,
  sharepoint_item_id    text not null,
  sharepoint_path       text not null,   -- e.g. /Repository/Biamp/TesiraFORTE-AI.pdf
  file_size_bytes       integer,
  uploaded_by_user_id   uuid references auth.users(id) on delete set null,
  approved_by_user_id   uuid references auth.users(id) on delete set null,
  source_project_id     text,
  approved_at           timestamptz,
  created_at            timestamptz not null default now()
);

create unique index if not exists cutsheet_repository_mfr_model_idx
  on public.cutsheet_repository (lower(manufacturer), lower(model_number));

-- ─── Staging (pending admin review) ──────────────────────────────────────────
create table if not exists public.cutsheet_staging (
  id                    uuid primary key default gen_random_uuid(),
  manufacturer          text,             -- nullable: admin can correct at approval
  model_number          text,
  display_name          text,
  category              text,
  sharepoint_item_id    text not null,
  sharepoint_path       text not null,
  file_size_bytes       integer,
  original_filename     text,
  uploaded_by_user_id   uuid references auth.users(id) on delete set null,
  source_project_id     text,
  source_context        text,             -- 'submittal_builder', 'manual_upload', 'product_lookup'
  status                text not null default 'pending'
                        check (status in ('pending', 'approved', 'rejected', 'duplicate')),
  reviewed_by_user_id   uuid references auth.users(id) on delete set null,
  reviewed_at           timestamptz,
  review_notes          text,
  duplicate_of          uuid references public.cutsheet_repository(id) on delete set null,
  created_at            timestamptz not null default now()
);

create index if not exists cutsheet_staging_status_idx on public.cutsheet_staging (status);
create index if not exists cutsheet_staging_uploader_idx on public.cutsheet_staging (uploaded_by_user_id);

-- ─── Project usage (analytics: which projects use which cutsheets) ───────────
create table if not exists public.cutsheet_project_usage (
  id                uuid primary key default gen_random_uuid(),
  cutsheet_id       uuid not null references public.cutsheet_repository(id) on delete cascade,
  project_id        text not null,        -- internal project id (uuid as text) or Monday item id
  used_in           text,                 -- 'submittal', 'om_manual', 'product_lookup'
  used_at           timestamptz not null default now(),
  used_by_user_id   uuid references auth.users(id) on delete set null
);

create index if not exists cutsheet_usage_cutsheet_idx on public.cutsheet_project_usage (cutsheet_id);
create index if not exists cutsheet_usage_project_idx  on public.cutsheet_project_usage (project_id);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
alter table public.cutsheet_repository      enable row level security;
alter table public.cutsheet_staging         enable row level security;
alter table public.cutsheet_project_usage   enable row level security;

-- Helper: is the current user an admin? Mirrors the same role check used
-- elsewhere (profiles.role = 'admin'). Defined locally so this migration
-- is self-contained.
create or replace function public.cutsheet_is_admin() returns boolean
language sql security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Repository: any authenticated user reads (lookups during submittal build).
-- Inserts and mutations are admin-only — repo grows via the approval flow.
drop policy if exists "cutsheet_repository_select_all"   on public.cutsheet_repository;
drop policy if exists "cutsheet_repository_admin_write"  on public.cutsheet_repository;

create policy "cutsheet_repository_select_all"
  on public.cutsheet_repository for select to authenticated
  using (true);

create policy "cutsheet_repository_admin_write"
  on public.cutsheet_repository for all to authenticated
  using (public.cutsheet_is_admin())
  with check (public.cutsheet_is_admin());

-- Staging: uploaders see their own pending items so they can track status.
-- Admins see everything. Inserts allowed for any signed-in user (uploads
-- come from the submittal flow). Updates/deletes are admin-only.
drop policy if exists "cutsheet_staging_select_own_or_admin"  on public.cutsheet_staging;
drop policy if exists "cutsheet_staging_insert_authenticated" on public.cutsheet_staging;
drop policy if exists "cutsheet_staging_admin_update"         on public.cutsheet_staging;
drop policy if exists "cutsheet_staging_admin_delete"         on public.cutsheet_staging;

create policy "cutsheet_staging_select_own_or_admin"
  on public.cutsheet_staging for select to authenticated
  using (uploaded_by_user_id = auth.uid() or public.cutsheet_is_admin());

create policy "cutsheet_staging_insert_authenticated"
  on public.cutsheet_staging for insert to authenticated
  with check (uploaded_by_user_id = auth.uid());

create policy "cutsheet_staging_admin_update"
  on public.cutsheet_staging for update to authenticated
  using (public.cutsheet_is_admin())
  with check (public.cutsheet_is_admin());

create policy "cutsheet_staging_admin_delete"
  on public.cutsheet_staging for delete to authenticated
  using (public.cutsheet_is_admin());

-- Usage: any authenticated user records and reads usage.
drop policy if exists "cutsheet_usage_select_all"    on public.cutsheet_project_usage;
drop policy if exists "cutsheet_usage_insert_authd"  on public.cutsheet_project_usage;

create policy "cutsheet_usage_select_all"
  on public.cutsheet_project_usage for select to authenticated
  using (true);

create policy "cutsheet_usage_insert_authd"
  on public.cutsheet_project_usage for insert to authenticated
  with check (used_by_user_id = auth.uid());

-- ─── Submittal item link to repository ───────────────────────────────────────
-- When auto-attach finds a match in the repository, we record the link on
-- the submittal item so the UI can render a "Repository" badge and the PDF
-- export can fetch a fresh download URL from SharePoint at render time
-- without re-running the lookup.
alter table public.submittal_items
  add column if not exists cutsheet_repository_id
  uuid references public.cutsheet_repository(id) on delete set null;

create index if not exists submittal_items_cutsheet_repo_idx
  on public.submittal_items (cutsheet_repository_id);
