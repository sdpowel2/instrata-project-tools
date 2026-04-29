-- Warehouses — org-wide ship-to destinations used by the Purchasing module.
-- Any authenticated member can read; only admins can create / update / delete.
-- Soft-delete via is_active so historical purchasing rows can still resolve a
-- warehouse name even after the row is deactivated.

create table if not exists public.warehouses (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  address_line1  text not null default '',
  address_line2  text not null default '',
  city           text not null default '',
  state          text not null default '',
  postal_code    text not null default '',
  notes          text not null default '',
  is_active      boolean not null default true,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.warehouses enable row level security;

create policy "Any member can view warehouses"
  on public.warehouses for select
  using (auth.uid() is not null);

create policy "Admins can manage warehouses"
  on public.warehouses for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create index if not exists idx_warehouses_active on public.warehouses (is_active);
