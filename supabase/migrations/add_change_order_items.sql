-- Change order line items — signed deltas pulled from published DTools CO
-- payloads. Adds are positive, removals carry DTools' own negated unit
-- prices/hours (Qty stays positive). Wiped + re-inserted on every sync, same
-- as change_orders.

create table if not exists public.change_order_items (
  id               uuid primary key default gen_random_uuid(),
  change_order_id  uuid not null references public.change_orders on delete cascade,
  change_type      text not null check (change_type in ('Added','Removed','Adjusted','Other')),
  manufacturer     text not null default '',
  model            text not null default '',
  description      text not null default '',
  qty              numeric not null default 0,
  unit_cost        numeric not null default 0,  -- signed, as DTools publishes
  unit_price       numeric not null default 0,
  labor_hours      numeric not null default 0,  -- signed line-total raw hours
  labor_cost       numeric not null default 0,  -- signed line $ at parent project rates
  labor_price      numeric not null default 0,
  labor_breakdown  jsonb   not null default '[]'::jsonb,
  sort_order       int     not null default 0
);

alter table public.change_order_items enable row level security;

-- Matches change_orders' visibility (opened org-wide by
-- open_project_view_access.sql): any authenticated user can view.
create policy "Authenticated users can view change order items"
  on public.change_order_items for select using (auth.uid() is not null);

create policy "Service role can manage change order items"
  on public.change_order_items for all to service_role using (true) with check (true);

create index if not exists idx_co_items_change_order on public.change_order_items (change_order_id);

-- Extend change_orders with the CO payload's net cost/hours and the
-- transform's reconciliation flag (priced lines vs the CO's own root fields).
alter table public.change_orders
  add column if not exists cost           numeric,
  add column if not exists labor_hours    numeric,
  add column if not exists dtools_verified boolean,
  add column if not exists items_synced   boolean not null default false;
