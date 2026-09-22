-- Project Wiki — per-project knowledge base: project-level context, one record
-- per room / subsystem (the "index guarantee"), addressable decisions with
-- rationale, an escalation-aware questions log, per-room labor buckets, and
-- link tables to the BoM and Project Files. Written by engineers in the app
-- and by agents over MCP (wikiTools.ts) — both are first-class; `origin` is
-- provenance only and never gates validity. Spec: Product Spec/project-tools-wiki-spec.md.
--
-- House-style notes vs the spec:
--   * Enums are text + CHECK (matches status/doc_type/category elsewhere) so
--     values can be added without an ALTER TYPE.
--   * Table names carry a wiki_ prefix (project_wiki, wiki_rooms, wiki_decisions,
--     wiki_questions, wiki_labor, wiki_room_bom_lines, wiki_room_files).
--   * Every child table carries project_id (denormalised, kept in sync by a
--     trigger from the room) so RLS and project-wide queries never need a join.
--   * Full-text search is a generated tsvector per table + the
--     search_project_wiki() RPC (SECURITY INVOKER → RLS applies).
--
-- Access model matches open_project_view_access.sql: any authenticated user
-- can read; writes are gated to project-team members via is_project_member().

-- ── project_wiki ──────────────────────────────────────────────────────────────
create table if not exists public.project_wiki (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null unique references public.projects(id) on delete cascade,
  summary          text,            -- project-level orientation, markdown
  scope_summary    text,            -- what the AV scope covers, prose
  design_basis     text,            -- consultant docs the design derives from + rev/date
  status           text not null default 'draft'
                   check (status in ('draft', 'in_progress', 'awaiting_review', 'reviewed', 'final')),
  pipeline_run_at  timestamptz,     -- null on hand-authored wikis
  created_by       uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  search_tsv       tsvector generated always as (
                     to_tsvector('english',
                       coalesce(summary, '') || ' ' || coalesce(scope_summary, '') || ' ' || coalesce(design_basis, ''))
                   ) stored
);

-- ── wiki_rooms — one row per room or subsystem; the unit of the index guarantee ─
create table if not exists public.wiki_rooms (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects(id) on delete cascade,
  room_number        text,          -- e.g. '311'; null for non-room subsystems
  room_name          text not null, -- e.g. 'Md Conference 2'
  floor              text,          -- e.g. '2nd Floor'
  dtools_location    text,          -- full D-Tools location string; the idempotency key for agent upserts
  sort_order         integer not null default 0,
  entry_kind         text not null default 'room'
                     check (entry_kind in ('room', 'subsystem', 'head_end', 'zone', 'project_wide')),
  room_type          text,          -- free text, groups typicals (e.g. 'Small Conference')
  area_sqft          numeric,
  size_class         text check (size_class is null or size_class in ('small_medium', 'large_xl', 'oversize')),
  size_basis         text check (size_basis is null or size_basis in ('sqft', 'seat_count', 'display_count', 'stated', 'undetermined')),
  has_conferencing   boolean,
  typical_of_count   integer check (typical_of_count is null or typical_of_count >= 1),
  typical_of_rooms   text[],        -- explicit roster of covered room numbers
  -- NOT NULL status + headline is what makes "unindexed room" structurally impossible.
  status             text not null default 'authored'
                     check (status in ('pending', 'clean', 'noted', 'escalated', 'resolved', 'authored')),
  headline           text not null check (btrim(headline) <> ''),
  detail             text,          -- long-form design notes, markdown
  validation_notes   text,          -- the math: counts, coverage, headroom, power
  origin             text not null default 'human'
                     check (origin in ('agent', 'human', 'agent_human_edited')),
  created_by         uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  search_tsv         tsvector generated always as (
                       setweight(to_tsvector('english', coalesce(room_number, '') || ' ' || coalesce(room_name, '') || ' ' || coalesce(room_type, '')), 'A') ||
                       setweight(to_tsvector('english', coalesce(headline, '')), 'A') ||
                       setweight(to_tsvector('english', coalesce(detail, '')), 'B') ||
                       setweight(to_tsvector('english', coalesce(validation_notes, '')), 'C')
                     ) stored
);

-- One record per D-Tools location per project. Partial, so hand-authored rooms
-- with no D-Tools location are unconstrained. (PostgREST can't infer a partial
-- index for ON CONFLICT, so the MCP upsert does select-then-insert/update.)
create unique index if not exists uq_wiki_rooms_project_location
  on public.wiki_rooms (project_id, dtools_location)
  where dtools_location is not null;

create index if not exists idx_wiki_rooms_project_sort on public.wiki_rooms (project_id, sort_order);
create index if not exists idx_wiki_rooms_project_status on public.wiki_rooms (project_id, status);
create index if not exists idx_wiki_rooms_search on public.wiki_rooms using gin (search_tsv);

-- ── wiki_decisions — the queryable rationale layer ────────────────────────────
create table if not exists public.wiki_decisions (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects(id) on delete cascade,
  room_id               uuid references public.wiki_rooms(id) on delete cascade, -- null = project-level
  kind                  text not null default 'rationale'
                        check (kind in ('validated', 'deviation_accepted', 'assumption', 'rationale', 'escalation_outcome')),
  title                 text not null check (btrim(title) <> ''),   -- the decision, one line
  rationale             text not null default '',                     -- why; markdown; the retrieval field
  source_ref            text,                                          -- consultant doc / sheet / spec section
  assumption_confirmed  boolean,                                       -- only meaningful when kind = 'assumption'
  origin                text not null default 'human'
                        check (origin in ('agent', 'human', 'agent_human_edited')),
  created_by            uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  search_tsv            tsvector generated always as (
                          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                          setweight(to_tsvector('english', coalesce(rationale, '')), 'B') ||
                          setweight(to_tsvector('english', coalesce(source_ref, '')), 'C')
                        ) stored
);

create index if not exists idx_wiki_decisions_project on public.wiki_decisions (project_id, created_at);
create index if not exists idx_wiki_decisions_room on public.wiki_decisions (room_id, created_at);
create index if not exists idx_wiki_decisions_search on public.wiki_decisions using gin (search_tsv);

-- ── wiki_questions — the questions log, with the two-tier escalation split ────
create table if not exists public.wiki_questions (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references public.projects(id) on delete cascade,
  room_id                uuid references public.wiki_rooms(id) on delete cascade, -- null = project-level
  -- functional_conflict interrupts a pipeline run one at a time;
  -- estimating_escalation batches into one "needs your input" list.
  severity               text not null default 'estimating_escalation'
                         check (severity in ('functional_conflict', 'estimating_escalation')),
  question               text not null check (btrim(question) <> ''),
  context                text,          -- what prompted it
  status                 text not null default 'open'
                         check (status in ('open', 'answered', 'resolved', 'withdrawn')),
  answer                 text,          -- the human's answer, verbatim
  resolution             text,          -- the resulting decision, prose
  resulting_decision_id  uuid references public.wiki_decisions(id) on delete set null,
  raised_by              uuid references public.profiles(id) on delete set null default auth.uid(),
  answered_by            uuid references public.profiles(id) on delete set null,
  raised_at              timestamptz not null default now(),
  answered_at            timestamptz,
  updated_at             timestamptz not null default now(),
  search_tsv             tsvector generated always as (
                           setweight(to_tsvector('english', coalesce(question, '')), 'A') ||
                           setweight(to_tsvector('english', coalesce(answer, '') || ' ' || coalesce(resolution, '')), 'B') ||
                           setweight(to_tsvector('english', coalesce(context, '')), 'C')
                         ) stored
);

create index if not exists idx_wiki_questions_project_status on public.wiki_questions (project_id, status, severity);
create index if not exists idx_wiki_questions_room on public.wiki_questions (room_id, raised_at);
create index if not exists idx_wiki_questions_search on public.wiki_questions using gin (search_tsv);

-- ── wiki_labor — calculated labor by bucket; zero rows are real rows ──────────
create table if not exists public.wiki_labor (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  room_id     uuid not null references public.wiki_rooms(id) on delete cascade,
  -- Exactly the D-Tools vocabulary. Travel is deliberately absent (human-quoted in D-Tools).
  labor_type  text not null
              check (labor_type in ('install', 'cabling', 'bench', 'commissioning', 'programming', 'engineering', 'mobilization', 'training')),
  hours       numeric(8,2) not null default 0 check (hours >= 0),   -- 0.00 is meaningful; store it
  basis       text,                                                  -- inputs that produced it
  origin      text not null default 'human'
              check (origin in ('agent', 'human', 'agent_human_edited')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (room_id, labor_type)
);

create index if not exists idx_wiki_labor_project on public.wiki_labor (project_id);

-- ── link tables ───────────────────────────────────────────────────────────────
create table if not exists public.wiki_room_bom_lines (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  room_id      uuid not null references public.wiki_rooms(id) on delete cascade,
  bom_item_id  uuid not null references public.project_bom_items(id) on delete cascade,
  note         text,
  created_at   timestamptz not null default now(),
  unique (room_id, bom_item_id)
);

create table if not exists public.wiki_room_files (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  room_id     uuid not null references public.wiki_rooms(id) on delete cascade,
  file_id     uuid not null references public.project_files(id) on delete cascade,
  note        text,
  created_at  timestamptz not null default now(),
  unique (room_id, file_id)
);

create index if not exists idx_wiki_room_bom_lines_project on public.wiki_room_bom_lines (project_id);
create index if not exists idx_wiki_room_files_project on public.wiki_room_files (project_id);

-- ── Keep child project_id consistent with the room it points at ──────────────
-- Callers may omit project_id when room_id is set; when both are given and
-- disagree, the room wins. Rows with a null room_id (project-level decisions /
-- questions) must supply project_id themselves (NOT NULL enforces it).
create or replace function public.wiki_sync_project_id_from_room()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  room_project uuid;
begin
  if new.room_id is not null then
    select project_id into room_project from public.wiki_rooms where id = new.room_id;
    if room_project is null then
      raise exception 'wiki room % does not exist', new.room_id;
    end if;
    new.project_id := room_project;
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['wiki_decisions', 'wiki_questions', 'wiki_labor', 'wiki_room_bom_lines', 'wiki_room_files']
  loop
    execute format('drop trigger if exists %I on public.%I', 'sync_' || t || '_project_id', t);
    execute format(
      'create trigger %I before insert or update of room_id, project_id on public.%I for each row execute function public.wiki_sync_project_id_from_room()',
      'sync_' || t || '_project_id', t
    );
  end loop;
end $$;

-- ── updated_at triggers (reuses the generic fn from migration.sql) ────────────
do $$
declare
  t text;
begin
  foreach t in array array['project_wiki', 'wiki_rooms', 'wiki_decisions', 'wiki_questions', 'wiki_labor']
  loop
    execute format('drop trigger if exists %I on public.%I', 'set_' || t || '_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      'set_' || t || '_updated_at', t
    );
  end loop;
end $$;

-- ── RLS: open read, member-gated writes ───────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['project_wiki', 'wiki_rooms', 'wiki_decisions', 'wiki_questions', 'wiki_labor', 'wiki_room_bom_lines', 'wiki_room_files']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Authenticated users can view %s" on public.%I', t, t);
    execute format('drop policy if exists "Members can insert %s" on public.%I', t, t);
    execute format('drop policy if exists "Members can update %s" on public.%I', t, t);
    execute format('drop policy if exists "Members can delete %s" on public.%I', t, t);
    execute format(
      'create policy "Authenticated users can view %s" on public.%I for select using (auth.uid() is not null)', t, t);
    execute format(
      'create policy "Members can insert %s" on public.%I for insert with check (public.is_project_member(project_id))', t, t);
    execute format(
      'create policy "Members can update %s" on public.%I for update using (public.is_project_member(project_id)) with check (public.is_project_member(project_id))', t, t);
    execute format(
      'create policy "Members can delete %s" on public.%I for delete using (public.is_project_member(project_id))', t, t);
  end loop;
end $$;

-- ── Room index view (§5.1) — the one-line-per-room list is a query, so an
--    unindexed room cannot exist. security_invoker so the caller's RLS applies.
create or replace view public.wiki_room_index
with (security_invoker = true) as
select
  r.id,
  r.project_id,
  r.sort_order,
  r.room_number,
  r.room_name,
  r.floor,
  r.dtools_location,
  r.entry_kind,
  r.room_type,
  r.size_class,
  r.has_conferencing,
  r.typical_of_count,
  r.status,
  r.headline,
  r.origin,
  r.updated_at,
  (select count(*) from public.wiki_decisions d where d.room_id = r.id)::int                          as decision_count,
  (select count(*) from public.wiki_questions q where q.room_id = r.id and q.status = 'open')::int     as open_question_count,
  (select count(*) from public.wiki_questions q where q.room_id = r.id and q.status = 'answered')::int as answered_question_count,
  (select coalesce(sum(l.hours), 0) from public.wiki_labor l where l.room_id = r.id)                   as labor_hours
from public.wiki_rooms r;

grant select on public.wiki_room_index to authenticated;

-- ── Full-text search (§6 search_project_wiki) — the retrieval case ────────────
-- Searches rooms (headline / detail / validation_notes), decisions (title /
-- rationale), questions (question / answer / resolution) and the project-level
-- context. SECURITY INVOKER (default) so RLS decides what the caller can see.
create or replace function public.search_project_wiki(
  p_project_id uuid,
  p_query      text,
  p_limit      int default 25
)
returns table (
  kind        text,      -- 'wiki' | 'room' | 'decision' | 'question'
  id          uuid,
  room_id     uuid,
  room_label  text,      -- "311 Md Conference 2", null for project-level hits
  title       text,
  snippet     text,      -- ts_headline with <b>…</b> marks
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
