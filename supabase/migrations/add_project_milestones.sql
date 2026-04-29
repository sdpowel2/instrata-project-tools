-- Project Milestones — contractual + operational checkpoints per project.
-- Two tiers: 'project' (contractual: submittal due, substantial completion,
-- closeout) and 'phase' (operational: rough-in complete, programming sign-off).
-- Status is computed client-side from due_date / completed_date so we don't
-- need a stored status column to drift.

create table if not exists public.project_milestones (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects on delete cascade,
  title           text not null default '',
  description     text not null default '',
  milestone_type  text not null,
  tier            text not null check (tier in ('project','phase')),
  phase           text,
  due_date        date,
  completed_date  date,
  owner_id        uuid references public.profiles(id) on delete set null,
  notes           text not null default '',
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.project_milestones enable row level security;

create policy "Members can view milestones"
  on public.project_milestones for select using (public.is_project_member(project_id));

create policy "Members can manage milestones"
  on public.project_milestones for all using (public.is_project_member(project_id));

create index if not exists idx_project_milestones_project on public.project_milestones (project_id);
create index if not exists idx_project_milestones_due     on public.project_milestones (due_date);
