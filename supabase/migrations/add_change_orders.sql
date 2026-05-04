-- Project Change Orders — pulled read-only from DTools alongside the BoM.
-- Sync overwrites this table from the source of truth on every Re-sync, so
-- we never edit COs locally. The (project_id, dtools_id) uniqueness lets the
-- Edge Function upsert without dup rows when the same CO comes back.
--
-- Status: Pending values are tracked but excluded from the contract total;
-- Approved values modify it; Rejected values are kept for the audit trail.
-- Category: Internal vs External — both kinds adjust the bottom line. The
-- flag is surfaced so PMs can see who owns it.

create table if not exists public.change_orders (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects on delete cascade,
  number          text not null default '',
  title           text not null default '',
  description     text not null default '',
  amount          numeric not null default 0,
  status          text not null check (status in ('Pending','Approved','Rejected')),
  category        text not null check (category in ('Internal','External')),
  requested_at    date,
  resolved_at     date,
  dtools_id       text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (project_id, dtools_id)
);

alter table public.change_orders enable row level security;

create policy "Members can view change orders"
  on public.change_orders for select using (public.is_project_member(project_id));

-- Writes go through the service-role key in the dtools-project-lookup Edge
-- Function — we keep the table read-only for end users so re-sync remains
-- the only path that mutates it.
create policy "Service role can manage change orders"
  on public.change_orders for all to service_role using (true) with check (true);

create index if not exists idx_change_orders_project on public.change_orders (project_id);
create index if not exists idx_change_orders_status  on public.change_orders (status);
