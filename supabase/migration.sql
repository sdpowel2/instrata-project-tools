-- ============================================================================
-- Instrata Project Tools — Full Database Migration
-- Run this in the Supabase SQL Editor to set up the entire schema.
-- ============================================================================

-- ======================== TABLES ========================

-- 1. profiles
create table public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  email      text not null,
  full_name  text default '',
  role       text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now()
);

-- 2. projects
create table public.projects (
  id              uuid primary key default gen_random_uuid(),
  name            text not null default '',
  number          text not null default '',
  client          text not null default '',
  address         text not null default '',
  business_unit   text not null default '',
  status          text not null default 'Active',
  monday_item_id  bigint unique,
  created_by      uuid references public.profiles on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 3. project_members (junction)
create table public.project_members (
  project_id uuid not null references public.projects on delete cascade,
  user_id    uuid not null references public.profiles on delete cascade,
  primary key (project_id, user_id)
);

-- 4. project_bom_items
create table public.project_bom_items (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects on delete cascade,
  manufacturer   text not null default '',
  model          text not null default '',
  description    text not null default '',
  category       text not null default 'Other',
  qty            numeric not null default 0,
  notes          text not null default '',
  cut_sheet_url  text,
  cut_sheet_name text,
  sort_order     int  not null default 0,
  locations      jsonb not null default '[]'::jsonb,
  item_type         text    not null default 'Product',
  unit_cost         numeric not null default 0,
  unit_price        numeric not null default 0,
  labor_hours       numeric not null default 0,
  labor_unit_cost   numeric not null default 0,
  labor_unit_price  numeric not null default 0,
  fixed_labor_cost  numeric not null default 0,
  fixed_labor_price numeric not null default 0,
  margin_pct        numeric not null default 0,
  owner_furnished   boolean not null default false,
  optional          boolean not null default false
);

-- 5. submittals
create table public.submittals (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects on delete cascade,
  title         text not null default '',
  revision      text not null default '',
  prepared_by   text not null default '',
  submitted_to  text not null default '',
  status        text not null default 'Draft',
  notes         text not null default '',
  created_at    timestamptz not null default now()
);

-- 6. submittal_items
create table public.submittal_items (
  id             uuid primary key default gen_random_uuid(),
  submittal_id   uuid not null references public.submittals on delete cascade,
  manufacturer   text not null default '',
  model          text not null default '',
  description    text not null default '',
  category       text not null default 'Other',
  qty            numeric not null default 0,
  notes          text not null default '',
  cut_sheet_url  text,
  cut_sheet_name text,
  locations      jsonb not null default '[]'::jsonb,
  sort_order     int  not null default 0
);

-- 7. rfis
create table public.rfis (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects on delete cascade,
  number           text not null default '',
  subject          text not null default '',
  spec_section     text not null default '',
  description      text not null default '',
  status           text not null default 'Open',
  response_due     text not null default '',
  answered_at      text,
  answered_by      text,
  response_summary text,
  location_ref     text,
  product_ref      text,
  created_at       timestamptz not null default now(),
  attachments      jsonb not null default '[]'::jsonb
);

-- 8. closeout_packages
create table public.closeout_packages (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  status     text not null default 'Draft',
  created_at timestamptz not null default now()
);

-- 9. warranties
create table public.warranties (
  id              uuid primary key default gen_random_uuid(),
  closeout_id     uuid not null references public.closeout_packages on delete cascade,
  bom_item_id     text,
  system          text not null default '',
  manufacturer    text not null default '',
  model           text not null default '',
  vendor          text not null default '',
  start_date      text not null default '',
  duration_months int  not null default 0,
  contact_name    text not null default '',
  contact_email   text not null default '',
  contact_phone   text not null default '',
  coverage_notes  text not null default ''
);

-- 10. punch_items
create table public.punch_items (
  id          uuid primary key default gen_random_uuid(),
  closeout_id uuid not null references public.closeout_packages on delete cascade,
  description text not null default '',
  location    text not null default '',
  assigned_to text not null default '',
  status      text not null default 'Open',
  priority    text not null default 'Standard',
  resolved_at text,
  product_ref text
);

-- 11. sign_off_sheets
create table public.sign_off_sheets (
  id           uuid primary key default gen_random_uuid(),
  closeout_id  uuid not null references public.closeout_packages on delete cascade,
  zone         text not null default '',
  system       text not null default '',
  tested_by    text not null default '',
  tested_date  text not null default '',
  witnessed_by text not null default '',
  status       text not null default 'Pending',
  notes        text not null default '',
  custom_items jsonb not null default '[]'::jsonb
);

-- 12. as_built_drawings
create table public.as_built_drawings (
  id          uuid primary key default gen_random_uuid(),
  closeout_id uuid not null references public.closeout_packages on delete cascade,
  title       text not null default '',
  file_name   text not null default '',
  file_url    text not null default '',
  revision    text not null default '',
  uploaded_at timestamptz not null default now()
);

-- 13. owner_manuals
create table public.owner_manuals (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects on delete cascade,
  title         text not null default '',
  revision      text not null default '',
  overview_text text not null default '',
  created_at    timestamptz not null default now(),
  sections      jsonb not null default '[]'::jsonb
);

-- ======================== FUNCTIONS (after tables exist) ========================

-- Check: is current user an org-level admin?
-- Must be SECURITY DEFINER so the subquery on profiles bypasses RLS
-- (inline EXISTS inside a profiles policy causes infinite recursion otherwise).
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- Reusable check: is current user an admin, the project creator, or a member?
create or replace function public.is_project_member(_project_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  )
  or exists (
    select 1 from public.projects where id = _project_id and created_by = auth.uid()
  )
  or exists (
    select 1 from public.project_members where project_id = _project_id and user_id = auth.uid()
  );
$$;

-- Generic updated_at trigger function
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Auto-create a profile row when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  );
  return new;
end;
$$;

-- ======================== TRIGGERS ========================

create trigger projects_set_updated_at
  before update on public.projects
  for each row
  execute function public.set_updated_at();

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- ======================== ROW LEVEL SECURITY ========================

alter table public.profiles          enable row level security;
alter table public.projects          enable row level security;
alter table public.project_members   enable row level security;
alter table public.project_bom_items enable row level security;
alter table public.submittals        enable row level security;
alter table public.submittal_items   enable row level security;
alter table public.rfis              enable row level security;
alter table public.closeout_packages enable row level security;
alter table public.warranties        enable row level security;
alter table public.punch_items       enable row level security;
alter table public.sign_off_sheets   enable row level security;
alter table public.as_built_drawings enable row level security;
alter table public.owner_manuals     enable row level security;

-- ---- profiles ----
create policy "Users can view their own profile"
  on public.profiles for select using (id = auth.uid());

create policy "Admins can view all profiles"
  on public.profiles for select using (public.is_admin());

create policy "Users can update their own profile"
  on public.profiles for update using (id = auth.uid());

create policy "Admins full access to profiles"
  on public.profiles for all using (public.is_admin());

-- ---- projects ----
create policy "Authenticated users can view all projects"
  on public.projects for select using (auth.uid() is not null);

create policy "Authenticated users can create projects"
  on public.projects for insert with check (auth.uid() is not null);

create policy "Members can update their projects"
  on public.projects for update using (public.is_project_member(id));

create policy "Admins can delete projects"
  on public.projects for delete using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- ---- project_members ----
create policy "Members can view project membership"
  on public.project_members for select using (public.is_project_member(project_id));

create policy "Project access users can manage members"
  on public.project_members for all using (public.is_project_member(project_id));

-- Self-add: any authenticated user can insert their own membership row.
-- Pairs with the open project visibility model — every user sees every
-- project, and every user can opt into one without admin intervention.
create policy "Users can add themselves to projects"
  on public.project_members for insert with check (user_id = auth.uid());

-- ---- project_bom_items ----
create policy "Members can view bom items"
  on public.project_bom_items for select using (public.is_project_member(project_id));

create policy "Members can manage bom items"
  on public.project_bom_items for all using (public.is_project_member(project_id));

-- ---- submittals ----
create policy "Members can view submittals"
  on public.submittals for select using (public.is_project_member(project_id));

create policy "Members can manage submittals"
  on public.submittals for all using (public.is_project_member(project_id));

-- ---- submittal_items ----
create policy "Members can view submittal items"
  on public.submittal_items for select using (
    public.is_project_member((select project_id from public.submittals where id = submittal_id))
  );

create policy "Members can manage submittal items"
  on public.submittal_items for all using (
    public.is_project_member((select project_id from public.submittals where id = submittal_id))
  );

-- ---- rfis ----
create policy "Members can view rfis"
  on public.rfis for select using (public.is_project_member(project_id));

create policy "Members can manage rfis"
  on public.rfis for all using (public.is_project_member(project_id));

-- ---- closeout_packages ----
create policy "Members can view closeout packages"
  on public.closeout_packages for select using (public.is_project_member(project_id));

create policy "Members can manage closeout packages"
  on public.closeout_packages for all using (public.is_project_member(project_id));

-- ---- warranties ----
create policy "Members can view warranties"
  on public.warranties for select using (
    public.is_project_member((select project_id from public.closeout_packages where id = closeout_id))
  );

create policy "Members can manage warranties"
  on public.warranties for all using (
    public.is_project_member((select project_id from public.closeout_packages where id = closeout_id))
  );

-- ---- punch_items ----
create policy "Members can view punch items"
  on public.punch_items for select using (
    public.is_project_member((select project_id from public.closeout_packages where id = closeout_id))
  );

create policy "Members can manage punch items"
  on public.punch_items for all using (
    public.is_project_member((select project_id from public.closeout_packages where id = closeout_id))
  );

-- ---- sign_off_sheets ----
create policy "Members can view sign off sheets"
  on public.sign_off_sheets for select using (
    public.is_project_member((select project_id from public.closeout_packages where id = closeout_id))
  );

create policy "Members can manage sign off sheets"
  on public.sign_off_sheets for all using (
    public.is_project_member((select project_id from public.closeout_packages where id = closeout_id))
  );

-- ---- as_built_drawings ----
create policy "Members can view as-built drawings"
  on public.as_built_drawings for select using (
    public.is_project_member((select project_id from public.closeout_packages where id = closeout_id))
  );

create policy "Members can manage as-built drawings"
  on public.as_built_drawings for all using (
    public.is_project_member((select project_id from public.closeout_packages where id = closeout_id))
  );

-- ---- owner_manuals ----
create policy "Members can view owner manuals"
  on public.owner_manuals for select using (public.is_project_member(project_id));

create policy "Members can manage owner manuals"
  on public.owner_manuals for all using (public.is_project_member(project_id));

-- ======================== STORAGE BUCKETS ========================

insert into storage.buckets (id, name, public)
values ('cutsheets', 'cutsheets', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('as-builts', 'as-builts', false)
on conflict (id) do nothing;

create policy "Authenticated users can upload cutsheets"
  on storage.objects for insert
  with check (bucket_id = 'cutsheets' and auth.uid() is not null);

create policy "Project members can read cutsheets"
  on storage.objects for select
  using (
    bucket_id = 'cutsheets'
    and public.is_project_member((string_to_array(name, '/'))[1]::uuid)
  );

create policy "Project members can delete cutsheets"
  on storage.objects for delete
  using (
    bucket_id = 'cutsheets'
    and public.is_project_member((string_to_array(name, '/'))[1]::uuid)
  );

create policy "Authenticated users can upload as-builts"
  on storage.objects for insert
  with check (bucket_id = 'as-builts' and auth.uid() is not null);

create policy "Project members can read as-builts"
  on storage.objects for select
  using (
    bucket_id = 'as-builts'
    and public.is_project_member((string_to_array(name, '/'))[1]::uuid)
  );

create policy "Project members can delete as-builts"
  on storage.objects for delete
  using (
    bucket_id = 'as-builts'
    and public.is_project_member((string_to_array(name, '/'))[1]::uuid)
  );

-- ======================== INDEXES ========================

create index idx_projects_created_by      on public.projects (created_by);
create index idx_project_members_user     on public.project_members (user_id);
create index idx_project_bom_project      on public.project_bom_items (project_id);
create index idx_submittals_project       on public.submittals (project_id);
create index idx_submittal_items_sub      on public.submittal_items (submittal_id);
create index idx_rfis_project             on public.rfis (project_id);
create index idx_closeout_project         on public.closeout_packages (project_id);
create index idx_warranties_closeout      on public.warranties (closeout_id);
create index idx_punch_items_closeout     on public.punch_items (closeout_id);
create index idx_sign_off_closeout        on public.sign_off_sheets (closeout_id);
create index idx_as_built_closeout        on public.as_built_drawings (closeout_id);
create index idx_owner_manuals_project    on public.owner_manuals (project_id);
