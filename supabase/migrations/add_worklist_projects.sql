-- My Day 2.4: connect a task to a project, and a per-project activity log.
-- Roadmap: Product Spec/my-day-roadmap.md, section 2.4.
--
--   worklist_items     project_id            the project Seth linked the task to (his call only)
--                      suggested_project_id  the morning run's suggestion, shown as "Link to ...?"
--                      dismissed_project_id  a suggestion Seth said no to; the run won't repeat it
--   project_activity   one row per linked / unlinked / done / reopened, written only by a
--                      trigger on worklist_items, so the log can't drift from the list.
--                      Owner-only for now (roadmap open decision 1).
--   worklist_guard_project_link()  the run can never set or change project_id or
--                      dismissed_project_id, even through an RPC: any change made while
--                      worklist.writer = 'briefing' is put back.
--   save_work_tags()   now also takes suggested_project_id (skipped when the task is already
--                      linked, when Seth dismissed that project, or when the id isn't a project).
--
-- Additive except save_work_tags(), which keeps its 2.3 behaviour and adds the suggestion.
-- Run in the Supabase SQL Editor after add_worklist_work_type.sql. Safe to re-run.

-- ── worklist_items: the link ──────────────────────────────────────────────────
alter table public.worklist_items
  add column if not exists project_id           uuid references public.projects(id) on delete set null,
  add column if not exists suggested_project_id uuid references public.projects(id) on delete set null,
  add column if not exists dismissed_project_id uuid references public.projects(id) on delete set null;

create index if not exists idx_worklist_items_project
  on public.worklist_items (project_id) where project_id is not null;

-- ── project_activity ──────────────────────────────────────────────────────────
create table if not exists public.project_activity (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  user_id      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  item_id      uuid references public.worklist_items(id) on delete set null,
  kind         text not null check (kind in ('linked', 'unlinked', 'done', 'reopened', 'note')),
  title        text not null check (char_length(title) <= 300),
  detail       text check (char_length(detail) <= 2000),
  occurred_at  timestamptz not null default now()
);

create index if not exists idx_project_activity_project
  on public.project_activity (project_id, occurred_at desc);
create index if not exists idx_project_activity_user
  on public.project_activity (user_id, occurred_at desc);

alter table public.project_activity enable row level security;
revoke all on public.project_activity from anon, authenticated;
grant select on public.project_activity to authenticated;

drop policy if exists "Owner reads own project activity" on public.project_activity;
create policy "Owner reads own project activity" on public.project_activity
  for select to authenticated
  using (user_id = auth.uid());

-- ── Guard: linking is Seth's call, never the run's ───────────────────────────
-- BEFORE trigger. While the briefing writer flag is set (save_briefing,
-- save_work_tags, save_reviewed), project_id and dismissed_project_id keep their
-- old values. A linked task needs no suggestion, so linking clears it.
create or replace function public.worklist_guard_project_link()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('worklist.writer', true), '') = 'briefing' then
    if tg_op = 'INSERT' then
      new.project_id := null;
      new.dismissed_project_id := null;
    else
      new.project_id := old.project_id;
      new.dismissed_project_id := old.dismissed_project_id;
    end if;
  end if;

  if new.project_id is not null then
    new.suggested_project_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists worklist_guard_project_link on public.worklist_items;
create trigger worklist_guard_project_link before insert or update on public.worklist_items
  for each row execute function public.worklist_guard_project_link();

-- ── Activity log: the trigger is the only writer ─────────────────────────────
-- SECURITY DEFINER (users have select only on project_activity), like
-- worklist_log_feedback(). Runs for the briefing too: a linked task the run
-- closes as resolved is real activity, marked in detail.
create or replace function public.worklist_log_project_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_by_run boolean := coalesce(current_setting('worklist.writer', true), '') = 'briefing';
begin
  if tg_op = 'INSERT' then
    if new.project_id is not null then
      insert into public.project_activity (project_id, user_id, item_id, kind, title)
      values (new.project_id, new.user_id, new.id, 'linked', left(new.title, 300));
    end if;
    return null;
  end if;

  if new.project_id is distinct from old.project_id then
    if old.project_id is not null then
      insert into public.project_activity (project_id, user_id, item_id, kind, title)
      values (old.project_id, new.user_id, new.id, 'unlinked', left(new.title, 300));
    end if;
    if new.project_id is not null then
      insert into public.project_activity (project_id, user_id, item_id, kind, title)
      values (new.project_id, new.user_id, new.id, 'linked', left(new.title, 300));
    end if;
  end if;

  if new.project_id is not null and new.status is distinct from old.status then
    if new.status = 'done' then
      insert into public.project_activity (project_id, user_id, item_id, kind, title, detail)
      values (new.project_id, new.user_id, new.id, 'done', left(new.title, 300),
              case when v_by_run then 'Closed by the morning run (resolved)' end);
    elsif old.status = 'done' and new.status in ('open', 'snoozed') then
      insert into public.project_activity (project_id, user_id, item_id, kind, title, detail)
      values (new.project_id, new.user_id, new.id, 'reopened', left(new.title, 300),
              case when v_by_run then 'Reopened by the morning run' end);
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.worklist_log_project_activity() from public, anon, authenticated;

drop trigger if exists worklist_log_project_activity on public.worklist_items;
create trigger worklist_log_project_activity after insert or update on public.worklist_items
  for each row execute function public.worklist_log_project_activity();

-- ── save_work_tags(): the run's tags, now with a project suggestion ──────────
-- p_tags: [{source_key, work_type, work_confidence, source_ref, suggested_project_id}]  (max 100)
-- Same as the 2.3 version, plus suggested_project_id. A suggestion is skipped when
-- the task is already linked, when Seth dismissed that project for it, or when the
-- id isn't a project. Any project_id in a tag is ignored (and the guard trigger would
-- put it back anyway). Returns {tagged, missing, suggested}.
create or replace function public.save_work_tags(p_tags jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid        uuid := auth.uid();
  v_total      int;
  v_tagged     int := 0;
  v_suggested  int := 0;
  v_missing    text[];
begin
  if v_uid is null then
    raise exception 'save_work_tags: not signed in';
  end if;
  if p_tags is null or jsonb_typeof(p_tags) <> 'array' then
    raise exception 'save_work_tags: p_tags must be an array';
  end if;
  v_total := jsonb_array_length(p_tags);
  if v_total > 100 then
    raise exception 'save_work_tags: % tags is over the 100 limit', v_total;
  end if;

  perform set_config('worklist.writer', 'briefing', true);

  update public.worklist_items i
     set work_type       = coalesce(t->>'work_type', i.work_type),
         work_confidence = case when t ? 'work_confidence' then (t->>'work_confidence')::numeric(3, 2)
                                else i.work_confidence end,
         source_ref      = coalesce(t->'source_ref', i.source_ref),
         suggested_project_id = case
           when i.project_id is null
            and p.id is not null
            and p.id is distinct from i.dismissed_project_id
           then p.id
           else i.suggested_project_id end
    from jsonb_array_elements(p_tags) t
    left join public.projects p on p.id::text = lower(btrim(t->>'suggested_project_id'))
   where i.user_id = v_uid
     and i.source_key = btrim(t->>'source_key');
  get diagnostics v_tagged = row_count;

  select count(*) into v_suggested
    from jsonb_array_elements(p_tags) t
    join public.worklist_items i
      on i.user_id = v_uid and i.source_key = btrim(t->>'source_key')
   where i.suggested_project_id::text = lower(btrim(t->>'suggested_project_id'));

  select coalesce(array_agg(btrim(t->>'source_key')), '{}')
    into v_missing
    from jsonb_array_elements(p_tags) t
   where not exists (
     select 1 from public.worklist_items i
      where i.user_id = v_uid and i.source_key = btrim(t->>'source_key'));

  perform set_config('worklist.writer', '', true);

  return jsonb_build_object('tagged', v_tagged, 'missing', to_jsonb(v_missing), 'suggested', v_suggested);
end;
$$;

revoke all on function public.save_work_tags(jsonb) from public, anon;
grant execute on function public.save_work_tags(jsonb) to authenticated;
