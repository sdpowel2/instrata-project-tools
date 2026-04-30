-- Project Comments — chat thread on each project's overview page.
-- Any authenticated user (member or not) can read and post. Authors and
-- admins can edit / delete. Replies are flat — top-level comments have
-- parent_id = null; replies point at their top-level comment. The frontend
-- prevents reply-to-reply, so we don't enforce depth in SQL.

create table if not exists public.project_comments (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  parent_id   uuid references public.project_comments(id) on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  body        text not null default '',
  reactions   jsonb not null default '[]'::jsonb,
  edited      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.project_comments enable row level security;

-- Any authenticated user can read all project comments. Project membership
-- is intentionally NOT required so a teammate can drop in to help on a
-- project they aren't formally assigned to.
create policy "Authenticated users can view comments"
  on public.project_comments for select
  using (auth.uid() is not null);

-- Any authenticated user can post, but only as themselves.
create policy "Authenticated users can post comments"
  on public.project_comments for insert
  with check (auth.uid() = author_id);

-- Authors edit their own; admins can edit any (e.g. to remove abuse).
create policy "Authors and admins can edit comments"
  on public.project_comments for update
  using (
    auth.uid() = author_id
    or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- Same rule for delete. Cascades drop replies when a parent goes away.
create policy "Authors and admins can delete comments"
  on public.project_comments for delete
  using (
    auth.uid() = author_id
    or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

create index if not exists idx_project_comments_project_created
  on public.project_comments (project_id, created_at);
create index if not exists idx_project_comments_parent
  on public.project_comments (parent_id);
