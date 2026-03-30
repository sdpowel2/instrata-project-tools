-- ============================================================================
-- Auto Reviewer — Schema Migration
-- Run in the Supabase SQL Editor after the base migration.
-- ============================================================================

-- ======================== PRODUCT CATALOG ========================

create table if not exists public.product_catalog (
  id            uuid primary key default gen_random_uuid(),
  manufacturer  text not null,
  model_number  text not null,
  description   text not null default '',
  list_price    numeric,
  category      text not null default '',
  last_updated  date,
  created_at    timestamptz not null default now(),
  unique(manufacturer, model_number)
);

-- ======================== REVIEW RUNS ========================

create table if not exists public.review_runs (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects on delete cascade,
  run_number     integer not null default 1,
  triggered_at   timestamptz not null default now(),
  csv_snapshot   text,
  monday_payload jsonb,
  status         text not null default 'pending_review'
    check (status in ('pending_review','in_review','changes_requested','quick_fix','approved')),
  reviewed_by    uuid references public.profiles on delete set null,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now()
);

-- ======================== REVIEW FLAGS ========================

create table if not exists public.review_flags (
  id              uuid primary key default gen_random_uuid(),
  review_run_id   uuid not null references public.review_runs on delete cascade,
  rule_id         text not null,
  severity        text not null check (severity in ('high','moderate','low')),
  category        text not null check (category in ('margin','pricing','labor','data','catalog','project')),
  flag_name       text not null,
  description     text not null,
  line_item_ref   text,
  status          text not null default 'open'
    check (status in ('open','resolved','waived','commented')),
  manager_comment text,
  resolved_by     uuid references public.profiles on delete set null,
  resolved_at     timestamptz,
  diff_status     text check (diff_status in ('new','recurring','resolved')),
  created_at      timestamptz not null default now()
);

-- ======================== REVIEW CONFIG ========================

create table if not exists public.review_config (
  key        text primary key,
  value      text not null,
  label      text not null,
  data_type  text not null check (data_type in ('number','percent','days','text','list')),
  updated_by uuid references public.profiles on delete set null,
  updated_at timestamptz
);

-- Seed defaults (safe to re-run)
insert into public.review_config (key, value, label, data_type) values
  ('margin_floor_project',   '30', 'Project Margin Floor (%)',                   'percent'),
  ('margin_floor_phase',     '25', 'Phase Margin Floor (%)',                     'percent'),
  ('pricing_staleness_days', '90', 'Pricing Staleness Threshold (days)',          'days'),
  ('cost_deviation_pct',     '15', 'Cost Deviation from Catalog (%)',             'percent'),
  ('preferred_vendors',      '',   'Preferred Vendor List (comma-separated)',     'list'),
  ('free_item_models',       '',   'Free Item Model Whitelist (comma-separated)', 'list')
on conflict (key) do nothing;

-- ======================== LABOR RATES ========================

create table if not exists public.labor_rates (
  id             uuid primary key default gen_random_uuid(),
  labor_type     text not null unique,
  rate_per_hour  numeric not null,
  hours_ceiling  numeric,
  is_active      boolean not null default true,
  updated_at     timestamptz not null default now()
);

-- ======================== ROW LEVEL SECURITY ========================

alter table public.product_catalog enable row level security;
alter table public.review_runs     enable row level security;
alter table public.review_flags    enable row level security;
alter table public.review_config   enable row level security;
alter table public.labor_rates     enable row level security;

-- product_catalog
create policy "catalog_read"   on public.product_catalog for select using (auth.role() = 'authenticated');
create policy "catalog_admin"  on public.product_catalog for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- review_runs: all authenticated can read; admins can update; service role inserts via webhook
create policy "runs_read"    on public.review_runs for select using (auth.role() = 'authenticated');
create policy "runs_admin"   on public.review_runs for update
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
create policy "runs_insert"  on public.review_runs for insert with check (true);

-- review_flags: all authenticated can read; admins can update (resolve/waive/comment)
create policy "flags_read"   on public.review_flags for select using (auth.role() = 'authenticated');
create policy "flags_admin"  on public.review_flags for update
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
create policy "flags_insert" on public.review_flags for insert with check (true);

-- review_config: all authenticated can read; admins can write
create policy "config_read"  on public.review_config for select using (auth.role() = 'authenticated');
create policy "config_admin" on public.review_config for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- labor_rates: all authenticated can read; admins can write
create policy "labor_read"   on public.labor_rates for select using (auth.role() = 'authenticated');
create policy "labor_admin"  on public.labor_rates for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
