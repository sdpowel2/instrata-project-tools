-- Quick Start Guide — per-room operating instructions inside the closeout
-- package. Each closeout has zero or more rooms; each room has zero or more
-- ordered steps. A step has a base text plus an optional clarifying note.
--
-- Tables follow the warranties / punch_items / sign_off_sheets pattern: child
-- of closeout_packages, RLS gated by is_project_member().

create table if not exists public.quick_start_rooms (
  id          uuid primary key default gen_random_uuid(),
  closeout_id uuid not null references public.closeout_packages on delete cascade,
  name        text not null default '',
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.quick_start_steps (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.quick_start_rooms on delete cascade,
  text       text not null default '',
  note       text not null default '',
  sort_order int  not null default 0
);

alter table public.quick_start_rooms enable row level security;
alter table public.quick_start_steps enable row level security;

-- ---- quick_start_rooms ----
create policy "Members can view quick start rooms"
  on public.quick_start_rooms for select using (
    public.is_project_member((select project_id from public.closeout_packages where id = closeout_id))
  );

create policy "Members can manage quick start rooms"
  on public.quick_start_rooms for all using (
    public.is_project_member((select project_id from public.closeout_packages where id = closeout_id))
  );

-- ---- quick_start_steps ----
create policy "Members can view quick start steps"
  on public.quick_start_steps for select using (
    public.is_project_member((
      select cp.project_id
      from public.closeout_packages cp
      join public.quick_start_rooms r on r.closeout_id = cp.id
      where r.id = room_id
    ))
  );

create policy "Members can manage quick start steps"
  on public.quick_start_steps for all using (
    public.is_project_member((
      select cp.project_id
      from public.closeout_packages cp
      join public.quick_start_rooms r on r.closeout_id = cp.id
      where r.id = room_id
    ))
  );

-- Indexes for the common filter paths
create index if not exists idx_quick_start_rooms_closeout on public.quick_start_rooms (closeout_id);
create index if not exists idx_quick_start_steps_room    on public.quick_start_steps (room_id);
