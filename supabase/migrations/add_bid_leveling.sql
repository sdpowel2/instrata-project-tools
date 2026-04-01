-- ============================================================================
-- Bid Leveling Sheet Generator — Schema Migration
-- Run in the Supabase SQL Editor after the base migration.
-- ============================================================================

-- ======================== MAPPING TEMPLATES ========================

create table if not exists public.bid_leveling_mapping_templates (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  gc_consultant_name text,
  cell_mappings      jsonb not null default '[]'::jsonb,
  org_id             uuid,
  created_by         uuid references public.profiles on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.bid_leveling_mapping_templates enable row level security;

create policy "Authenticated users can read mapping templates"
  on public.bid_leveling_mapping_templates for select
  to authenticated using (true);

create policy "Authenticated users can insert mapping templates"
  on public.bid_leveling_mapping_templates for insert
  to authenticated with check (true);

create policy "Creator or admin can update mapping templates"
  on public.bid_leveling_mapping_templates for update
  to authenticated using (
    created_by = auth.uid()
    or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

create policy "Creator or admin can delete mapping templates"
  on public.bid_leveling_mapping_templates for delete
  to authenticated using (
    created_by = auth.uid()
    or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- ======================== BID LEVELING SESSIONS ========================

create table if not exists public.bid_leveling_sessions (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references public.projects on delete cascade,
  bom_csv_url             text,
  template_xlsx_url       text,
  mapping_template_id     uuid references public.bid_leveling_mapping_templates on delete set null,
  cell_mappings_snapshot  jsonb,
  generated_xlsx_url      text,
  generation_report       jsonb,
  status                  text not null default 'draft'
    check (status in ('draft', 'mapped', 'generated')),
  created_by              uuid references public.profiles on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.bid_leveling_sessions enable row level security;

create policy "Project members can read bid leveling sessions"
  on public.bid_leveling_sessions for select
  to authenticated using (true);

create policy "Authenticated users can insert bid leveling sessions"
  on public.bid_leveling_sessions for insert
  to authenticated with check (true);

create policy "Authenticated users can update bid leveling sessions"
  on public.bid_leveling_sessions for update
  to authenticated using (true);

create policy "Creator or admin can delete bid leveling sessions"
  on public.bid_leveling_sessions for delete
  to authenticated using (
    created_by = auth.uid()
    or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );
