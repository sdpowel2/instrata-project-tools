-- My Day 2.1: the reviewed log and "Surface this".
-- Roadmap: Product Spec/my-day-roadmap.md, section 2.1.
--
--   worklist_reviewed   one row per conversation the morning run looked at
--                       (email thread, Teams chat ask, monday item), whether or
--                       not it made the list: where it landed and a one-line
--                       reason. Summaries and links only, never message text.
--                       30-day retention; rows Seth surfaced are kept as the
--                       regression set.
--   save_reviewed()     the run's write, right after save_briefing(). A same-day
--                       re-run replaces that day's rows, except surfaced ones.
--   surface_reviewed()  "Surface this": creates (or reopens) the worklist item
--                       with the same source_key and links it back. A trigger
--                       logs it to worklist_feedback as 'surfaced', so the next
--                       run sees every miss.
--
-- Additive: one new table, three functions, one trigger, and one more allowed
-- value in worklist_feedback.action. Owner-only RLS like the other worklist
-- tables. Run in the Supabase SQL Editor. Safe to re-run.

-- ── worklist_reviewed ─────────────────────────────────────────────────────────
create table if not exists public.worklist_reviewed (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  briefing_id   uuid not null references public.worklist_briefings(id) on delete cascade,
  source        text not null check (source in ('email', 'teams', 'monday')),
  source_key    text not null check (btrim(source_key) <> '' and char_length(source_key) <= 300),
  title         text not null check (btrim(title) <> '' and char_length(title) <= 300),
  from_label    text check (char_length(from_label) <= 200),
  link          text check (char_length(link) <= 2000),
  outcome       text not null
                check (outcome in ('respond', 'do', 'decide', 'read_me', 'set_aside', 'dropped', 'carried')),
  reason        text not null check (btrim(reason) <> '' and char_length(reason) <= 300),
  reason_group  text not null check (btrim(reason_group) <> '' and char_length(reason_group) <= 80),
  item_id       uuid references public.worklist_items(id) on delete set null,
  surfaced_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (briefing_id, source_key)
);

create index if not exists idx_worklist_reviewed_user_briefing
  on public.worklist_reviewed (user_id, briefing_id);
create index if not exists idx_worklist_reviewed_surfaced
  on public.worklist_reviewed (user_id, surfaced_at desc) where surfaced_at is not null;

alter table public.worklist_reviewed enable row level security;
revoke all on public.worklist_reviewed from anon, authenticated;
grant select, insert, update, delete on public.worklist_reviewed to authenticated;

drop policy if exists "Owner manages own reviewed rows" on public.worklist_reviewed;
create policy "Owner manages own reviewed rows" on public.worklist_reviewed
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Feedback: allow 'surfaced' ────────────────────────────────────────────────
alter table public.worklist_feedback drop constraint if exists worklist_feedback_action_check;
alter table public.worklist_feedback add constraint worklist_feedback_action_check
  check (action in ('done', 'dismissed', 'snoozed', 'reopened', 'urgency', 'answered', 'surfaced'));

-- One 'surfaced' feedback row when Seth pulls a conversation out of the
-- reviewed list. from_value = where the run had put it; to_value = the kind he
-- chose. SECURITY DEFINER because users can't insert feedback directly.
create or replace function public.worklist_reviewed_log_surfaced()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.worklist_items%rowtype;
begin
  if old.surfaced_at is null and new.surfaced_at is not null then
    select * into v_item from public.worklist_items where id = new.item_id;
    insert into public.worklist_feedback
      (user_id, item_id, action, from_value, to_value,
       item_source, item_kind, item_title, item_from, claude_urgency)
    values
      (new.user_id, new.item_id, 'surfaced',
       left(new.outcome || ': ' || new.reason_group, 200),
       v_item.kind,
       new.source, v_item.kind, left(new.title, 200), left(new.from_label, 200), null);
  end if;
  return null;
end;
$$;

revoke all on function public.worklist_reviewed_log_surfaced() from public, anon, authenticated;

drop trigger if exists worklist_reviewed_log_surfaced on public.worklist_reviewed;
create trigger worklist_reviewed_log_surfaced after update on public.worklist_reviewed
  for each row execute function public.worklist_reviewed_log_surfaced();

-- ── save_reviewed(): the run's reviewed log ───────────────────────────────────
-- p_rows: [{source_key, source, title, from_label, link, outcome, reason, reason_group}]  (max 400)
-- Call after save_briefing() for the same date. SECURITY INVOKER: RLS applies.
create or replace function public.save_reviewed(p_date date, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_briefing_id  uuid;
  v_purged       int := 0;
  v_replaced     int := 0;
  v_saved        int := 0;
  v_total        int;
begin
  if v_uid is null then
    raise exception 'save_reviewed: not signed in';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'save_reviewed: p_rows must be an array';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total > 400 then
    raise exception 'save_reviewed: % rows is over the 400-row limit', v_total;
  end if;

  select id into v_briefing_id
    from public.worklist_briefings
   where user_id = v_uid and briefing_date = p_date;
  if v_briefing_id is null then
    raise exception 'save_reviewed: no briefing saved for % (call save_briefing first)', p_date;
  end if;

  -- 30-day retention; surfaced rows are the regression set and stay.
  delete from public.worklist_reviewed
   where user_id = v_uid and surfaced_at is null and created_at < now() - interval '30 days';
  get diagnostics v_purged = row_count;

  -- A same-day re-run replaces the day's rows, except ones Seth surfaced.
  delete from public.worklist_reviewed
   where briefing_id = v_briefing_id and surfaced_at is null;
  get diagnostics v_replaced = row_count;

  insert into public.worklist_reviewed
    (user_id, briefing_id, source, source_key, title, from_label, link, outcome, reason, reason_group)
  select v_uid, v_briefing_id,
         r->>'source', btrim(r->>'source_key'), r->>'title', r->>'from_label', r->>'link',
         r->>'outcome', r->>'reason', r->>'reason_group'
    from jsonb_array_elements(p_rows) as r
  on conflict (briefing_id, source_key) do nothing;
  get diagnostics v_saved = row_count;

  return jsonb_build_object(
    'briefing_date', p_date,
    'saved', v_saved,
    'skipped', v_total - v_saved,   -- duplicates, or already surfaced today
    'replaced', v_replaced,
    'purged', v_purged
  );
end;
$$;

revoke all on function public.save_reviewed(date, jsonb) from public, anon;
grant execute on function public.save_reviewed(date, jsonb) to authenticated;

-- ── surface_reviewed(): "Surface this" ────────────────────────────────────────
-- Creates the worklist item for a reviewed conversation (or reopens it if it
-- exists), with Seth's kind and urgency. The urgency is stored as his override,
-- so later runs can't lower it. Returns the item id.
create or replace function public.surface_reviewed(
  p_id       uuid,
  p_kind     text,
  p_urgency  smallint default 2
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_row   public.worklist_reviewed%rowtype;
  v_item  uuid;
begin
  if v_uid is null then
    raise exception 'surface_reviewed: not signed in';
  end if;
  if p_kind not in ('respond', 'do', 'decide') then
    raise exception 'surface_reviewed: kind must be respond, do or decide';
  end if;
  if p_urgency not between 1 and 4 then
    raise exception 'surface_reviewed: urgency must be 1-4';
  end if;

  select * into v_row
    from public.worklist_reviewed
   where id = p_id and user_id = v_uid
   for update;
  if not found then
    raise exception 'surface_reviewed: reviewed row not found';
  end if;

  insert into public.worklist_items as i
    (user_id, source, source_key, kind, title, from_label, link,
     urgency, user_urgency, urgency_reason, due_basis)
  values
    (v_uid, v_row.source, v_row.source_key, p_kind, v_row.title, v_row.from_label, v_row.link,
     p_urgency, p_urgency, 'Surfaced by you from the reviewed list', 'none')
  on conflict (user_id, source_key) do update set
    kind         = excluded.kind,
    status       = 'open',
    user_urgency = excluded.user_urgency
  returning i.id into v_item;

  update public.worklist_reviewed
     set item_id = v_item,
         surfaced_at = coalesce(surfaced_at, now())
   where id = p_id;

  return v_item;
end;
$$;

revoke all on function public.surface_reviewed(uuid, text, smallint) from public, anon;
grant execute on function public.surface_reviewed(uuid, text, smallint) to authenticated;
