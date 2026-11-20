-- My Day 2.6: the second brain organizes itself, and project notes go to the wiki.
-- Roadmap: Product Spec/my-day-roadmap.md, section 2.6 (2.6.0 scopes + project notes).
--
--   brain_raw (2.5)        gains scope (personal | project | general), project_id and a
--                          discard reason. A 'project' note without a project falls back
--                          to personal: never more shared than its owner chose.
--   worklist_readme_state  remembers the scope / project Seth logged a line under.
--   brain_pages            personal pages (owner-only) and general pages (every signed-in
--                          user reads and can append; author or admin deletes).
--   brain_page_versions    the old content before every page edit, so any edit can be
--                          undone. All versions for 90 days, then one per week.
--   project_notes          the project wiki's Notes section: dated summaries anyone can
--                          read, written by the nightly filing or by hand.
--
--   set_readme_state()     replaced: logs under a scope / project.
--   file_brain_notes()     nightly filing into a personal or general page (append only).
--   file_project_notes()   nightly filing of project notes into project_notes.
--   discard_brain_raw()    drop duplicates / noise from the inbox, with a reason.
--   search_brain()         full-text search over visible pages + your unfiled notes.
--   restore_brain_page()   undo: put a page back to an earlier version.
--   search_project_wiki()  replaced: also searches project notes.
--
-- Additive only. Run in the Supabase SQL Editor AFTER add_brain_raw.sql. Safe to re-run.

-- ── brain_raw: scope + project ───────────────────────────────────────────────
alter table public.brain_raw
  add column if not exists scope          text not null default 'personal',
  add column if not exists project_id     uuid references public.projects(id) on delete set null,
  add column if not exists discard_reason text check (char_length(discard_reason) <= 300);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'brain_raw_scope_check') then
    alter table public.brain_raw
      add constraint brain_raw_scope_check check (scope in ('personal', 'project', 'general'));
  end if;
end $$;

create index if not exists idx_brain_raw_project
  on public.brain_raw (project_id) where project_id is not null;

-- A 'project' note with no project (never given, or the project was deleted) becomes
-- personal. Falling back to the most private scope is always safe.
create or replace function public.brain_raw_scope_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.scope = 'project' and new.project_id is null then
    new.scope := 'personal';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_brain_raw_scope_guard on public.brain_raw;
create trigger trg_brain_raw_scope_guard
  before insert or update on public.brain_raw
  for each row execute function public.brain_raw_scope_guard();

-- ── worklist_readme_state: where a logged line was filed to ─────────────────
alter table public.worklist_readme_state
  add column if not exists scope      text not null default 'personal',
  add column if not exists project_id uuid references public.projects(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'worklist_readme_state_scope_check') then
    alter table public.worklist_readme_state
      add constraint worklist_readme_state_scope_check check (scope in ('personal', 'project', 'general'));
  end if;
end $$;

-- ── brain_pages ───────────────────────────────────────────────────────────────
-- array_to_string() is only STABLE, and a generated column needs IMMUTABLE parts.
-- Joining a text[] with a space has no outside dependencies, so this wrapper is safe.
create or replace function public.brain_tags_text(p_tags text[])
returns text
language sql
immutable
parallel safe
set search_path = public
as $$ select coalesce(array_to_string(p_tags, ' '), '') $$;

create table if not exists public.brain_pages (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references public.profiles(id) on delete cascade,  -- author / owner
  scope        text not null default 'personal' check (scope in ('personal', 'general')),
  slug         text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  title        text not null check (btrim(title) <> '' and char_length(title) <= 200),
  kind         text not null default 'topic' check (kind in ('topic', 'person', 'project', 'company', 'index', 'note')),
  summary      text check (char_length(summary) <= 1000),   -- 1-3 sentences, kept current
  body         text not null default '' check (char_length(body) <= 200000),  -- markdown; [[slug]] links
  tags         text[] not null default '{}',
  project_id   uuid references public.projects(id) on delete set null,  -- a tag for search, not sharing
  last_writer  text not null default 'user' check (last_writer in ('user', 'claude')),
  updated_by   uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  search_tsv   tsvector generated always as (
                 setweight(to_tsvector('english', coalesce(title, '') || ' ' || replace(slug, '-', ' ')), 'A') ||
                 setweight(to_tsvector('english', coalesce(summary, '') || ' ' || public.brain_tags_text(tags)), 'B') ||
                 setweight(to_tsvector('english', coalesce(body, '')), 'C')
               ) stored
);

-- Personal slugs are unique per owner; general slugs are one shared namespace.
create unique index if not exists uq_brain_pages_personal_slug
  on public.brain_pages (user_id, slug) where scope = 'personal';
create unique index if not exists uq_brain_pages_general_slug
  on public.brain_pages (slug) where scope = 'general';
create index if not exists idx_brain_pages_search on public.brain_pages using gin (search_tsv);
create index if not exists idx_brain_pages_recent on public.brain_pages (user_id, updated_at desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'brain_raw_page_fk') then
    alter table public.brain_raw
      add constraint brain_raw_page_fk foreign key (page_id) references public.brain_pages(id) on delete set null;
  end if;
end $$;

-- ── brain_page_versions: the content before each edit ────────────────────────
create table if not exists public.brain_page_versions (
  id           bigserial primary key,
  page_id      uuid not null references public.brain_pages(id) on delete cascade,
  title        text not null,
  summary      text,
  body         text not null,
  tags         text[] not null default '{}',
  written_by   text not null check (written_by in ('user', 'claude')),  -- who wrote THIS content
  written_at   timestamptz not null,                                     -- when it was written
  replaced_at  timestamptz not null default now()                        -- when an edit replaced it
);
create index if not exists idx_brain_page_versions_page on public.brain_page_versions (page_id, replaced_at desc);

-- One trigger does the bookkeeping: scope and owner never change, every real edit
-- saves the old content, and the writer comes from the transaction-local flag
-- brain.writer ('claude' inside the filing RPCs, 'user' otherwise).
-- SECURITY DEFINER because nobody gets a direct insert grant on the versions table.
create or replace function public.brain_pages_bookkeeping()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_writer text := case when current_setting('brain.writer', true) = 'claude' then 'claude' else 'user' end;
begin
  if tg_op = 'UPDATE' then
    if new.scope is distinct from old.scope or new.user_id is distinct from old.user_id then
      raise exception 'brain_pages: a page''s scope and owner can''t change';
    end if;
    if new.body is not distinct from old.body and new.summary is not distinct from old.summary
       and new.title is not distinct from old.title and new.tags is not distinct from old.tags then
      return new;   -- nothing worth a version (e.g. only project_id changed)
    end if;
    insert into public.brain_page_versions (page_id, title, summary, body, tags, written_by, written_at)
    values (old.id, old.title, old.summary, old.body, old.tags, old.last_writer, old.updated_at);

    -- Thin this page's history: everything from the last 90 days, then the newest per week.
    delete from public.brain_page_versions v
     where v.page_id = old.id
       and v.replaced_at < now() - interval '90 days'
       and v.id not in (
         select max(v2.id) from public.brain_page_versions v2
          where v2.page_id = old.id and v2.replaced_at < now() - interval '90 days'
          group by date_trunc('week', v2.replaced_at)
       );
  end if;
  new.last_writer := v_writer;
  new.updated_by  := coalesce(auth.uid(), new.updated_by);
  new.updated_at  := now();
  return new;
end;
$$;

revoke all on function public.brain_pages_bookkeeping() from public, anon, authenticated;

drop trigger if exists trg_brain_pages_bookkeeping on public.brain_pages;
create trigger trg_brain_pages_bookkeeping
  before insert or update on public.brain_pages
  for each row execute function public.brain_pages_bookkeeping();

-- ── project_notes: the project wiki's Notes section ─────────────────────────
create table if not exists public.project_notes (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  text        text not null check (btrim(text) <> '' and char_length(text) <= 2000),  -- a summary, never a message body
  link        text check (char_length(link) <= 2000),
  source      text not null default 'manual' check (source in ('my_day', 'manual')),
  noted_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  noted_at    timestamptz not null default now(),   -- when it happened (the logged line's capture time)
  raw_id      uuid references public.brain_raw(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  search_tsv  tsvector generated always as (to_tsvector('english', coalesce(text, ''))) stored
);
create index if not exists idx_project_notes_project on public.project_notes (project_id, noted_at desc);
create index if not exists idx_project_notes_search on public.project_notes using gin (search_tsv);
create unique index if not exists uq_project_notes_raw on public.project_notes (raw_id) where raw_id is not null;

drop trigger if exists trg_project_notes_updated_at on public.project_notes;
create trigger trg_project_notes_updated_at
  before update on public.project_notes
  for each row execute function public.set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.brain_pages         enable row level security;
alter table public.brain_page_versions enable row level security;
alter table public.project_notes       enable row level security;

revoke all on public.brain_pages         from anon, authenticated;
revoke all on public.brain_page_versions from anon, authenticated;
revoke all on public.project_notes       from anon, authenticated;

grant select, insert, update, delete on public.brain_pages   to authenticated;
grant select                         on public.brain_page_versions to authenticated;
grant select, insert, update, delete on public.project_notes to authenticated;

-- brain_pages: personal = owner only. general = everyone reads and can edit (a team
-- wiki; every edit keeps a version), the author or an admin deletes.
drop policy if exists "Read own or general brain pages" on public.brain_pages;
create policy "Read own or general brain pages" on public.brain_pages
  for select to authenticated
  using (user_id = auth.uid() or scope = 'general');

drop policy if exists "Create own brain pages" on public.brain_pages;
create policy "Create own brain pages" on public.brain_pages
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Edit own or general brain pages" on public.brain_pages;
create policy "Edit own or general brain pages" on public.brain_pages
  for update to authenticated
  using (user_id = auth.uid() or scope = 'general')
  with check (user_id = auth.uid() or scope = 'general');

drop policy if exists "Delete own brain pages, admins general" on public.brain_pages;
create policy "Delete own brain pages, admins general" on public.brain_pages
  for delete to authenticated
  using (
    user_id = auth.uid()
    or (scope = 'general' and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  );

-- Versions are visible exactly when their page is (the subquery runs under brain_pages' RLS).
drop policy if exists "Read versions of visible pages" on public.brain_page_versions;
create policy "Read versions of visible pages" on public.brain_page_versions
  for select to authenticated
  using (exists (select 1 from public.brain_pages p where p.id = page_id));

-- project_notes: everyone signed in reads (same as the rest of the project) and can
-- add a note in their own name; the author or an admin edits or deletes.
drop policy if exists "Authenticated users can view project notes" on public.project_notes;
create policy "Authenticated users can view project notes" on public.project_notes
  for select to authenticated
  using (true);

drop policy if exists "Add project notes in your own name" on public.project_notes;
create policy "Add project notes in your own name" on public.project_notes
  for insert to authenticated
  with check (noted_by = auth.uid());

drop policy if exists "Author or admin edits project notes" on public.project_notes;
create policy "Author or admin edits project notes" on public.project_notes
  for update to authenticated
  using (noted_by = auth.uid() or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (noted_by = auth.uid() or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

drop policy if exists "Author or admin deletes project notes" on public.project_notes;
create policy "Author or admin deletes project notes" on public.project_notes
  for delete to authenticated
  using (noted_by = auth.uid() or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ── set_readme_state(): now with a scope / project ──────────────────────────
-- Same as 2.5, plus: p_scope ('personal' | 'project' | 'general'; null = project when a
-- project is given, else personal) and p_project_id. Logging again with a different
-- scope moves the inbox row if it isn't filed yet. Returns {state, raw_id, filed, scope,
-- project_id}: filed = true when the line's note was already filed, so a scope change came
-- too late; scope / project_id are where the logged line actually is.
drop function if exists public.set_readme_state(date, text, text, text, text, text);

create or replace function public.set_readme_state(
  p_date        date,
  p_readme_id   text,
  p_state       text,
  p_text        text,
  p_source      text default null,
  p_link        text default null,
  p_scope       text default null,
  p_project_id  uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_text    text := btrim(coalesce(p_text, ''));
  v_id      text := btrim(coalesce(p_readme_id, ''));
  v_scope   text := coalesce(p_scope, case when p_project_id is not null then 'project' else 'personal' end);
  v_project uuid := case when coalesce(p_scope, 'project') = 'project' then p_project_id end;
  v_raw     uuid;
  v_status  text;
begin
  if v_uid is null then
    raise exception 'set_readme_state: not signed in';
  end if;
  if p_date is null or v_id = '' or v_text = '' then
    raise exception 'set_readme_state: date, read-me id and text are required';
  end if;
  if p_state is not null and p_state not in ('logged', 'hidden') then
    raise exception 'set_readme_state: state must be logged, hidden or null (undo), not %', p_state;
  end if;
  if v_scope not in ('personal', 'project', 'general') then
    raise exception 'set_readme_state: scope must be personal, project or general, not %', v_scope;
  end if;
  if v_scope = 'project' and v_project is null then
    v_scope := 'personal';
  end if;

  -- Whatever the new state, an unfiled inbox row from this line goes, unless we're logging it.
  if p_state is distinct from 'logged' then
    delete from public.brain_raw
     where user_id = v_uid and source = 'readme' and status = 'new'
       and briefing_date = p_date and readme_id = v_id and text = v_text;
  end if;

  if p_state is null then
    delete from public.worklist_readme_state
     where user_id = v_uid and briefing_date = p_date and readme_id = v_id;
    return jsonb_build_object('state', null, 'raw_id', null, 'filed', false, 'scope', null, 'project_id', null);
  end if;

  if p_state = 'logged' then
    select id, status into v_raw, v_status
      from public.brain_raw
     where user_id = v_uid and source = 'readme' and status <> 'discarded'
       and briefing_date = p_date and readme_id = v_id and text = v_text
     order by (status = 'new') desc
     limit 1;
    -- Already filed: too late to move it. The state keeps where it actually went.
    if v_status = 'filed' then
      select r.scope, r.project_id into v_scope, v_project from public.brain_raw r where r.id = v_raw;
    end if;
  end if;

  insert into public.worklist_readme_state as s
    (user_id, briefing_date, readme_id, state, readme_text, readme_source, readme_link, scope, project_id, at)
  values
    (v_uid, p_date, v_id, p_state, left(v_text, 500), p_source, left(p_link, 2000),
     case when p_state = 'logged' then v_scope else 'personal' end,
     case when p_state = 'logged' then v_project end, now())
  on conflict (user_id, briefing_date, readme_id) do update set
    state         = excluded.state,
    readme_text   = excluded.readme_text,
    readme_source = excluded.readme_source,
    readme_link   = excluded.readme_link,
    scope         = excluded.scope,
    project_id    = excluded.project_id,
    at            = excluded.at;

  if p_state = 'logged' then
    if v_raw is null then
      insert into public.brain_raw (user_id, source, text, link, briefing_date, readme_id, readme_source, scope, project_id)
      values (v_uid, 'readme', v_text, left(p_link, 2000), p_date, v_id,
              case when p_source in ('email', 'teams', 'monday', 'manual', 'claude') then p_source end,
              v_scope, v_project)
      returning id into v_raw;
      v_status := 'new';
    elsif v_status = 'new' then
      update public.brain_raw set scope = v_scope, project_id = v_project where id = v_raw;
    end if;
  end if;

  return jsonb_build_object('state', p_state, 'raw_id', v_raw, 'filed', coalesce(v_status = 'filed', false),
                            'scope', case when p_state = 'logged' then v_scope end,
                            'project_id', case when p_state = 'logged' then v_project end);
end;
$$;

revoke all on function public.set_readme_state(date, text, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.set_readme_state(date, text, text, text, text, text, text, uuid) to authenticated;

-- ── file_brain_notes(): the nightly filing into a personal or general page ──
-- p_page: {scope, slug, title?, kind?, summary?, append?, body?, tags?, project_id?}
--   append  markdown added to the end of the body (the normal case)
--   body    replaces the body: ONLY for kind 'index' pages, which are lists kept current
--   summary replaces the 1-3 sentence summary
-- p_raw_ids: inbox notes this write files (max 20). They must be yours, still 'new', and
-- of the page's scope. Project notes go through file_project_notes() instead.
-- Never deletes content from a non-index page. Every edit leaves a version row.
create or replace function public.file_brain_notes(p_page jsonb, p_raw_ids uuid[] default '{}')
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_scope    text := coalesce(p_page->>'scope', 'personal');
  v_slug     text := lower(btrim(coalesce(p_page->>'slug', '')));
  v_title    text := nullif(btrim(coalesce(p_page->>'title', '')), '');
  v_kind     text := nullif(btrim(coalesce(p_page->>'kind', '')), '');
  v_summary  text := nullif(btrim(coalesce(p_page->>'summary', '')), '');
  v_append   text := nullif(btrim(coalesce(p_page->>'append', '')), '');
  v_body     text := p_page->>'body';
  v_project  uuid := nullif(p_page->>'project_id', '')::uuid;
  v_tags     text[] := coalesce(array(select lower(btrim(t)) from jsonb_array_elements_text(coalesce(p_page->'tags', '[]'::jsonb)) t where btrim(t) <> ''), '{}');
  v_ids      uuid[] := coalesce(p_raw_ids, '{}');
  v_page     public.brain_pages%rowtype;
  v_created  boolean := false;
  v_bad      int;
  v_filed    int := 0;
begin
  if v_uid is null then
    raise exception 'file_brain_notes: not signed in';
  end if;
  if v_scope not in ('personal', 'general') then
    raise exception 'file_brain_notes: scope must be personal or general (project notes use file_project_notes)';
  end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{0,99}$' then
    raise exception 'file_brain_notes: slug must be lowercase letters, digits and dashes, not "%"', v_slug;
  end if;
  if coalesce(array_length(v_ids, 1), 0) > 20 then
    raise exception 'file_brain_notes: at most 20 notes per call';
  end if;
  if char_length(coalesce(v_append, '')) > 8000 then
    raise exception 'file_brain_notes: append is limited to 8000 characters per call';
  end if;

  -- The notes must be yours, unfiled, and of this page's scope.
  select count(*) into v_bad
    from unnest(v_ids) as x(id)
    left join public.brain_raw r on r.id = x.id and r.user_id = v_uid and r.status = 'new'
   where r.id is null or r.scope <> v_scope;
  if v_bad > 0 then
    raise exception 'file_brain_notes: % note(s) are not yours, already filed or discarded, or of another scope than "%"', v_bad, v_scope;
  end if;

  perform set_config('brain.writer', 'claude', true);

  if v_scope = 'personal' then
    select * into v_page from public.brain_pages where user_id = v_uid and scope = 'personal' and slug = v_slug for update;
  else
    select * into v_page from public.brain_pages where scope = 'general' and slug = v_slug for update;
  end if;

  if v_page.id is null then
    if v_title is null then
      raise exception 'file_brain_notes: a new page needs a title';
    end if;
    if v_body is not null and coalesce(v_kind, 'topic') <> 'index' then
      raise exception 'file_brain_notes: body can only be set on index pages; use append';
    end if;
    insert into public.brain_pages (user_id, scope, slug, title, kind, summary, body, tags, project_id)
    values (v_uid, v_scope, v_slug, v_title, coalesce(v_kind, 'topic'), v_summary,
            coalesce(v_body, coalesce(v_append, '')), v_tags, v_project)
    returning * into v_page;
    v_created := true;
  else
    if v_body is not null and v_page.kind <> 'index' then
      raise exception 'file_brain_notes: "%" is not an index page, so its body can only be appended to', v_slug;
    end if;
    update public.brain_pages set
      title      = coalesce(v_title, title),
      summary    = coalesce(v_summary, summary),
      body       = case
                     when v_body is not null then v_body
                     when v_append is null then body
                     when body = '' then v_append
                     else body || E'\n\n' || v_append
                   end,
      tags       = (select coalesce(array_agg(distinct t order by t), '{}') from unnest(tags || v_tags) t),
      project_id = coalesce(project_id, v_project)
     where id = v_page.id
    returning * into v_page;
  end if;

  update public.brain_raw
     set status = 'filed', filed_at = now(), page_id = v_page.id
   where id = any(v_ids) and user_id = v_uid and status = 'new';
  get diagnostics v_filed = row_count;

  return jsonb_build_object('page_id', v_page.id, 'slug', v_page.slug, 'scope', v_page.scope,
                            'created', v_created, 'filed', v_filed);
end;
$$;

revoke all on function public.file_brain_notes(jsonb, uuid[]) from public, anon;
grant execute on function public.file_brain_notes(jsonb, uuid[]) to authenticated;

-- ── file_project_notes(): project-scope inbox notes → the project wiki ──────
-- p_notes: [{raw_id, text, link?}], max 20. text is the tidied one- or two-line summary.
-- Each note must be yours, 'new' and of scope 'project'; it lands on ITS project.
create or replace function public.file_project_notes(p_notes jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  n       jsonb;
  r       public.brain_raw%rowtype;
  v_text  text;
  v_note  uuid;
  v_out   jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'file_project_notes: not signed in';
  end if;
  if jsonb_typeof(p_notes) is distinct from 'array' then
    raise exception 'file_project_notes: p_notes must be an array';
  end if;
  if jsonb_array_length(p_notes) > 20 then
    raise exception 'file_project_notes: at most 20 notes per call';
  end if;

  for n in select * from jsonb_array_elements(p_notes) loop
    select * into r from public.brain_raw
     where id = nullif(n->>'raw_id', '')::uuid and user_id = v_uid and status = 'new' and scope = 'project'
     for update;
    if r.id is null then
      raise exception 'file_project_notes: note % is not yours, not new, or not a project note', n->>'raw_id';
    end if;
    v_text := btrim(coalesce(n->>'text', r.text));
    if v_text = '' or char_length(v_text) > 2000 then
      raise exception 'file_project_notes: note text must be 1-2000 characters';
    end if;

    insert into public.project_notes (project_id, text, link, source, noted_by, noted_at, raw_id)
    values (r.project_id, v_text, left(coalesce(nullif(n->>'link', ''), r.link), 2000), 'my_day', v_uid, r.captured_at, r.id)
    returning id into v_note;

    update public.brain_raw set status = 'filed', filed_at = now() where id = r.id;
    v_out := v_out || jsonb_build_object('raw_id', r.id, 'note_id', v_note, 'project_id', r.project_id);
  end loop;

  return jsonb_build_object('filed', jsonb_array_length(v_out), 'notes', v_out);
end;
$$;

revoke all on function public.file_project_notes(jsonb) from public, anon;
grant execute on function public.file_project_notes(jsonb) to authenticated;

-- ── discard_brain_raw(): duplicates and noise, with a reason ────────────────
create or replace function public.discard_brain_raw(p_ids uuid[], p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_n int;
begin
  if auth.uid() is null then
    raise exception 'discard_brain_raw: not signed in';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'discard_brain_raw: a reason is required';
  end if;
  if coalesce(array_length(p_ids, 1), 0) > 50 then
    raise exception 'discard_brain_raw: at most 50 notes per call';
  end if;
  update public.brain_raw
     set status = 'discarded', discard_reason = left(btrim(p_reason), 300), filed_at = now()
   where id = any(coalesce(p_ids, '{}')) and user_id = auth.uid() and status = 'new';
  get diagnostics v_n = row_count;
  return jsonb_build_object('discarded', v_n);
end;
$$;

revoke all on function public.discard_brain_raw(uuid[], text) from public, anon;
grant execute on function public.discard_brain_raw(uuid[], text) to authenticated;

-- ── search_brain(): pages you can see + your unfiled notes ──────────────────
-- SECURITY INVOKER: RLS decides. kind = 'page' | 'inbox'.
create or replace function public.search_brain(p_query text, p_limit int default 20)
returns table (
  kind        text,
  id          uuid,
  slug        text,
  title       text,
  scope       text,
  page_kind   text,
  summary     text,
  project_id  uuid,
  snippet     text,
  rank        real,
  updated_at  timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with q as (select websearch_to_tsquery('english', coalesce(p_query, '')) as tsq),
  hits as (
    select 'page'::text as kind, p.id, p.slug, p.title, p.scope, p.kind as page_kind, p.summary, p.project_id,
           concat_ws(E'\n', p.summary, p.body) as body, ts_rank_cd(p.search_tsv, q.tsq) as rank, p.updated_at
      from public.brain_pages p, q
     where p.search_tsv @@ q.tsq
    union all
    select 'inbox', r.id, null, left(r.text, 120), r.scope, null, null, r.project_id,
           r.text, ts_rank_cd(to_tsvector('english', r.text), q.tsq) * 0.8::real, r.captured_at
      from public.brain_raw r, q
     where r.user_id = auth.uid() and r.status = 'new' and to_tsvector('english', r.text) @@ q.tsq
  )
  select h.kind, h.id, h.slug, h.title, h.scope, h.page_kind, h.summary, h.project_id,
         ts_headline('english', h.body, q.tsq,
           'MaxWords=40, MinWords=15, ShortWord=3, MaxFragments=2, FragmentDelimiter=" … "'),
         h.rank, h.updated_at
    from hits h, q
   where numnode(q.tsq) > 0
   order by h.rank desc, h.updated_at desc
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

revoke all on function public.search_brain(text, int) from public, anon;
grant execute on function public.search_brain(text, int) to authenticated;

-- ── restore_brain_page(): undo, by putting an earlier version back ──────────
-- The current content is saved as a version first (by the trigger), so a restore can
-- itself be undone.
create or replace function public.restore_brain_page(p_version_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v public.brain_page_versions%rowtype;
  n int;
begin
  select * into v from public.brain_page_versions where id = p_version_id;
  if v.id is null then
    raise exception 'restore_brain_page: version % not found', p_version_id;
  end if;
  update public.brain_pages
     set title = v.title, summary = v.summary, body = v.body, tags = v.tags
   where id = v.page_id;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'restore_brain_page: you can''t edit that page';
  end if;
  return jsonb_build_object('page_id', v.page_id, 'restored_version', v.id);
end;
$$;

revoke all on function public.restore_brain_page(bigint) from public, anon;
grant execute on function public.restore_brain_page(bigint) to authenticated;

-- ── search_project_wiki(): now also searches project notes ──────────────────
-- Same as add_project_wiki.sql, plus a 'note' branch.
create or replace function public.search_project_wiki(
  p_project_id uuid,
  p_query      text,
  p_limit      int default 25
)
returns table (
  kind        text,      -- 'wiki' | 'room' | 'decision' | 'question' | 'note'
  id          uuid,
  room_id     uuid,
  room_label  text,
  title       text,
  snippet     text,
  rank        real
)
language sql
stable
set search_path = public
as $$
  with q as (
    select websearch_to_tsquery('english', coalesce(p_query, '')) as tsq
  ),
  hits as (
    select 'room'::text as kind, r.id, r.id as room_id, r.headline as title, r.search_tsv as tsv,
           concat_ws(E'\n', r.headline, r.detail, r.validation_notes) as body
    from public.wiki_rooms r, q
    where r.project_id = p_project_id and r.search_tsv @@ q.tsq
    union all
    select 'decision', d.id, d.room_id, d.title, d.search_tsv,
           concat_ws(E'\n', d.title, d.rationale, d.source_ref)
    from public.wiki_decisions d, q
    where d.project_id = p_project_id and d.search_tsv @@ q.tsq
    union all
    select 'question', qs.id, qs.room_id, qs.question, qs.search_tsv,
           concat_ws(E'\n', qs.question, qs.context, qs.answer, qs.resolution)
    from public.wiki_questions qs, q
    where qs.project_id = p_project_id and qs.search_tsv @@ q.tsq
    union all
    select 'wiki', w.id, null::uuid, 'Project context', w.search_tsv,
           concat_ws(E'\n', w.summary, w.scope_summary, w.design_basis)
    from public.project_wiki w, q
    where w.project_id = p_project_id and w.search_tsv @@ q.tsq
    union all
    select 'note', n.id, null::uuid, 'Note · ' || to_char(n.noted_at at time zone 'America/New_York', 'Mon DD, YYYY'),
           n.search_tsv, n.text
    from public.project_notes n, q
    where n.project_id = p_project_id and n.search_tsv @@ q.tsq
  )
  select
    h.kind,
    h.id,
    h.room_id,
    (select concat_ws(' ', nullif(r.room_number, ''), r.room_name) from public.wiki_rooms r where r.id = h.room_id) as room_label,
    h.title,
    ts_headline('english', h.body, q.tsq,
      'MaxWords=45, MinWords=20, ShortWord=3, MaxFragments=2, FragmentDelimiter=" … "') as snippet,
    ts_rank(h.tsv, q.tsq) as rank
  from hits h, q
  where numnode(q.tsq) > 0
  order by rank desc, h.kind
  limit greatest(1, least(coalesce(p_limit, 25), 200));
$$;

grant execute on function public.search_project_wiki(uuid, text, int) to authenticated;
