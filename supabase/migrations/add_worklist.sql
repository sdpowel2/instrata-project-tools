-- My Day worklist — storage for the morning-worklist skill and the /my-day page.
--
--   worklist_briefings  one row per user per day: run health, schedule, read-me,
--                       set-aside summary. Re-running the same day replaces it.
--   worklist_items      the tasks. One row per source_key per user, so a re-run
--                       updates an item instead of duplicating it. Carryover is
--                       just "still open"; carried days = briefing date - first_seen.
--   worklist_feedback   append-only log of what the user does on the page
--                       (done, dismiss, snooze, urgency change, answer). The skill
--                       reads it as calibration. Written only by a trigger.
--
-- Rules the database enforces (not the prompt):
--   * Every row is private to its owner (user_id = auth.uid()). The MCP server
--     calls in as the signed-in user, so RLS applies to Claude too.
--   * save_briefing() never reopens an item the user closed, never touches the
--     user's urgency override (user_urgency), never edits a manual task's text,
--     and only reopens a snoozed item once its snooze date arrives.
--   * Store summaries and links only. Never email or chat bodies.
--
-- Additive only: new tables, functions and triggers. Nothing existing changes.
-- Run in the Supabase SQL Editor (house convention). Safe to re-run.

-- ── worklist_briefings ────────────────────────────────────────────────────────
create table if not exists public.worklist_briefings (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  briefing_date  date not null,                                   -- Eastern calendar day
  ran_at         timestamptz not null default now(),
  window_since   timestamptz,                                     -- start of the mail/chat window
  missing        jsonb not null default '[]'::jsonb,              -- [{source, error}]
  source_counts  jsonb not null default '{}'::jsonb,              -- {mail, teams, monday, manual}
  schedule       jsonb not null default '[]'::jsonb,              -- CalendarEvent[]
  open_blocks    jsonb not null default '[]'::jsonb,              -- ["10:00–11:00", ...]
  read_me        jsonb not null default '[]'::jsonb,              -- ReadMeItem[]
  set_aside      jsonb not null default '{"categories": [], "items": []}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, briefing_date),
  check (jsonb_typeof(missing) = 'array'),
  check (jsonb_typeof(source_counts) = 'object'),
  check (jsonb_typeof(schedule) = 'array'),
  check (jsonb_typeof(open_blocks) = 'array'),
  check (jsonb_typeof(read_me) = 'array'),
  check (jsonb_typeof(set_aside) = 'object')
);

-- ── worklist_items ────────────────────────────────────────────────────────────
create table if not exists public.worklist_items (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  source             text not null
                     check (source in ('email', 'teams', 'monday', 'manual', 'claude')),
  -- Idempotency key. email:<normalized subject>|<counterpart>, teams:<chatId>:<messageId>,
  -- monday:<itemId>, monday-update:<updateId>, claude:<slug>. Manual tasks get a random one.
  source_key         text not null default ('manual:' || gen_random_uuid()::text)
                     check (btrim(source_key) <> '' and char_length(source_key) <= 300),
  kind               text not null
                     check (kind in ('respond', 'do', 'decide', 'question')),
  title              text not null check (btrim(title) <> '' and char_length(title) <= 300),
  from_label         text check (char_length(from_label) <= 200),
  summary            text check (char_length(summary) <= 2000),   -- short context, never a body
  link               text check (char_length(link) <= 2000),
  due                date,
  due_basis          text not null default 'none'
                     check (due_basis in ('stated', 'inferred', 'none')),
  urgency            smallint not null default 3 check (urgency between 1 and 4),   -- Claude's call
  urgency_reason     text check (char_length(urgency_reason) <= 300),
  user_urgency       smallint check (user_urgency between 1 and 4),                 -- the user's override
  effective_urgency  smallint generated always as (coalesce(user_urgency, urgency)) stored,
  status             text not null default 'open'
                     check (status in ('open', 'done', 'snoozed', 'dismissed')),
  snoozed_until      date,
  closed_at          timestamptz,
  closed_by          text check (closed_by in ('user', 'briefing')),
  first_seen         date not null default (now() at time zone 'America/New_York')::date,
  last_seen          date not null default (now() at time zone 'America/New_York')::date,
  times_seen         integer not null default 1 check (times_seen >= 1),
  options            jsonb check (options is null or jsonb_typeof(options) = 'array'),  -- question choices
  answer             text check (char_length(answer) <= 2000),
  answered_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, source_key),
  check (status <> 'snoozed' or snoozed_until is not null)
);

create index if not exists idx_worklist_items_open
  on public.worklist_items (user_id, status, effective_urgency, due);
create index if not exists idx_worklist_items_closed
  on public.worklist_items (user_id, closed_at desc) where closed_at is not null;

-- ── worklist_feedback ─────────────────────────────────────────────────────────
create table if not exists public.worklist_feedback (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  item_id         uuid references public.worklist_items(id) on delete set null,
  action          text not null
                  check (action in ('done', 'dismissed', 'snoozed', 'reopened', 'urgency', 'answered')),
  from_value      text,
  to_value        text,
  -- Snapshot of the item at the time, so calibration survives item cleanup.
  item_source     text,
  item_kind       text,
  item_title      text,
  item_from       text,
  claude_urgency  smallint,
  created_at      timestamptz not null default now()
);

create index if not exists idx_worklist_feedback_user_time
  on public.worklist_feedback (user_id, created_at desc);

-- ── updated_at ────────────────────────────────────────────────────────────────
drop trigger if exists set_updated_at on public.worklist_briefings;
create trigger set_updated_at before update on public.worklist_briefings
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.worklist_items;
create trigger set_updated_at before update on public.worklist_items
  for each row execute function public.set_updated_at();

-- ── Item bookkeeping: closed_at / closed_by / answered_at ────────────────────
-- closed_by is 'briefing' when the change comes from save_briefing() (which sets
-- the transaction-local worklist.writer flag), otherwise 'user'.
create or replace function public.worklist_items_bookkeeping()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_writer text := coalesce(current_setting('worklist.writer', true), '');
begin
  if tg_op = 'INSERT' then
    if new.status in ('done', 'dismissed') then
      new.closed_at := now();
      new.closed_by := case when v_writer = 'briefing' then 'briefing' else 'user' end;
    end if;
    if new.answer is not null then
      new.answered_at := now();
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status in ('done', 'dismissed') then
      new.closed_at := now();
      new.closed_by := case when v_writer = 'briefing' then 'briefing' else 'user' end;
      new.snoozed_until := null;
    else
      new.closed_at := null;
      new.closed_by := null;
      if new.status = 'open' then
        new.snoozed_until := null;
      end if;
    end if;
  end if;

  if new.answer is distinct from old.answer then
    new.answered_at := case when new.answer is null then null else now() end;
  end if;

  return new;
end;
$$;

drop trigger if exists worklist_items_bookkeeping on public.worklist_items;
create trigger worklist_items_bookkeeping before insert or update on public.worklist_items
  for each row execute function public.worklist_items_bookkeeping();

-- ── Feedback log: one row per user action on an item ─────────────────────────
-- SECURITY DEFINER so the log stays append-only: users can read their feedback
-- but have no insert/update/delete grant on it. Changes made by save_briefing()
-- are not user feedback and are skipped.
create or replace function public.worklist_log_feedback()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('worklist.writer', true), '') = 'briefing' then
    return null;
  end if;

  if new.status is distinct from old.status then
    insert into public.worklist_feedback
      (user_id, item_id, action, from_value, to_value,
       item_source, item_kind, item_title, item_from, claude_urgency)
    values
      (new.user_id, new.id,
       case when new.status = 'open' then 'reopened' else new.status end,
       old.status,
       case when new.status = 'snoozed' then new.snoozed_until::text else new.status end,
       new.source, new.kind, left(new.title, 200), left(new.from_label, 200), new.urgency);
  end if;

  if new.user_urgency is distinct from old.user_urgency then
    insert into public.worklist_feedback
      (user_id, item_id, action, from_value, to_value,
       item_source, item_kind, item_title, item_from, claude_urgency)
    values
      (new.user_id, new.id, 'urgency',
       old.effective_urgency::text, new.effective_urgency::text,
       new.source, new.kind, left(new.title, 200), left(new.from_label, 200), new.urgency);
  end if;

  if new.answer is distinct from old.answer and new.answer is not null then
    insert into public.worklist_feedback
      (user_id, item_id, action, from_value, to_value,
       item_source, item_kind, item_title, item_from, claude_urgency)
    values
      (new.user_id, new.id, 'answered', null, left(new.answer, 200),
       new.source, new.kind, left(new.title, 200), left(new.from_label, 200), new.urgency);
  end if;

  return null;
end;
$$;

revoke all on function public.worklist_log_feedback() from public, anon, authenticated;

drop trigger if exists worklist_log_feedback on public.worklist_items;
create trigger worklist_log_feedback after update on public.worklist_items
  for each row execute function public.worklist_log_feedback();

-- ── RLS: owner-only ───────────────────────────────────────────────────────────
alter table public.worklist_briefings enable row level security;
alter table public.worklist_items     enable row level security;
alter table public.worklist_feedback  enable row level security;

-- Supabase default privileges grant everything to anon/authenticated on new
-- tables; start from nothing and grant back exactly what's needed.
revoke all on public.worklist_briefings from anon, authenticated;
revoke all on public.worklist_items     from anon, authenticated;
revoke all on public.worklist_feedback  from anon, authenticated;

grant select, insert, update, delete on public.worklist_briefings to authenticated;
grant select, insert, update, delete on public.worklist_items     to authenticated;
grant select                         on public.worklist_feedback  to authenticated;

drop policy if exists "Owner manages own briefings" on public.worklist_briefings;
create policy "Owner manages own briefings" on public.worklist_briefings
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Owner manages own items" on public.worklist_items;
create policy "Owner manages own items" on public.worklist_items
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Owner reads own feedback" on public.worklist_feedback;
create policy "Owner reads own feedback" on public.worklist_feedback
  for select to authenticated
  using (user_id = auth.uid());

-- ── save_briefing(): the morning skill's single write ────────────────────────
-- One transaction: upsert the day's briefing, upsert items by source_key, and
-- close the items the skill found resolved (e.g. "you already replied").
-- SECURITY INVOKER, so RLS applies and it can only ever touch the caller's rows.
--
-- p_briefing: {date, ranAt, since, missing, sourceCounts, schedule, openBlocks, readMe, setAside}
-- p_items:    [{source_key, source, kind, title, from_label, summary, link, due,
--               due_basis, urgency, urgency_reason, options}]   (max 100)
-- p_resolved_keys: source_keys to close as done (closed_by = 'briefing')
--
-- Per existing item:
--   closed by the user (done/dismissed)      → left alone (counted as kept_closed)
--   closed by an earlier briefing             → reopened and refreshed
--   snoozed, snooze date has arrived          → reopened and refreshed
--   snoozed, still in the future              → refreshed, stays snoozed
--   manual task                               → only urgency / reason / last_seen change
-- user_urgency is never written here.
create or replace function public.save_briefing(
  p_briefing       jsonb,
  p_items          jsonb default '[]'::jsonb,
  p_resolved_keys  text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_date         date;
  v_briefing_id  uuid;
  v_item         jsonb;
  v_key          text;
  v_source       text;
  v_row          public.worklist_items%rowtype;
  v_new_status   text;
  v_inserted     int := 0;
  v_updated      int := 0;
  v_reopened     int := 0;
  v_kept_closed  int := 0;
  v_skipped      int := 0;
  v_resolved     int := 0;
begin
  if v_uid is null then
    raise exception 'save_briefing: not signed in';
  end if;
  if p_briefing is null or jsonb_typeof(p_briefing) <> 'object' then
    raise exception 'save_briefing: p_briefing must be an object';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'save_briefing: p_items must be an array';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'save_briefing: % items is over the 100-item limit', jsonb_array_length(p_items);
  end if;

  v_date := (p_briefing->>'date')::date;
  if v_date is null then
    raise exception 'save_briefing: p_briefing.date is required (YYYY-MM-DD)';
  end if;

  -- Marks every change in this transaction as the briefing's, not the user's.
  perform set_config('worklist.writer', 'briefing', true);

  -- 1. The day's briefing (re-running the same day replaces it).
  insert into public.worklist_briefings as b
    (user_id, briefing_date, ran_at, window_since, missing, source_counts,
     schedule, open_blocks, read_me, set_aside)
  values
    (v_uid, v_date,
     coalesce((p_briefing->>'ranAt')::timestamptz, now()),
     (p_briefing->>'since')::timestamptz,
     coalesce(p_briefing->'missing', '[]'::jsonb),
     coalesce(p_briefing->'sourceCounts', '{}'::jsonb),
     coalesce(p_briefing->'schedule', '[]'::jsonb),
     coalesce(p_briefing->'openBlocks', '[]'::jsonb),
     coalesce(p_briefing->'readMe', '[]'::jsonb),
     coalesce(p_briefing->'setAside', '{"categories": [], "items": []}'::jsonb))
  on conflict (user_id, briefing_date) do update set
    ran_at        = excluded.ran_at,
    window_since  = excluded.window_since,
    missing       = excluded.missing,
    source_counts = excluded.source_counts,
    schedule      = excluded.schedule,
    open_blocks   = excluded.open_blocks,
    read_me       = excluded.read_me,
    set_aside     = excluded.set_aside
  returning b.id into v_briefing_id;

  -- 2. Items, keyed by source_key.
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_key    := nullif(btrim(v_item->>'source_key'), '');
    v_source := v_item->>'source';
    if v_key is null then
      raise exception 'save_briefing: every item needs a source_key (title: %)', v_item->>'title';
    end if;

    select * into v_row
      from public.worklist_items
     where user_id = v_uid and source_key = v_key
     for update;

    if not found then
      -- The skill cannot invent manual tasks; those come from the user.
      if v_source = 'manual' then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      insert into public.worklist_items
        (user_id, source, source_key, kind, title, from_label, summary, link,
         due, due_basis, urgency, urgency_reason, options, first_seen, last_seen)
      values
        (v_uid, v_source, v_key, v_item->>'kind', v_item->>'title',
         v_item->>'from_label', v_item->>'summary', v_item->>'link',
         nullif(v_item->>'due', '')::date,
         coalesce(v_item->>'due_basis', 'none'),
         (v_item->>'urgency')::smallint,
         v_item->>'urgency_reason',
         v_item->'options',
         v_date, v_date);
      v_inserted := v_inserted + 1;
      continue;
    end if;

    -- Closed by the user: their call stands.
    if v_row.status in ('done', 'dismissed') and v_row.closed_by is distinct from 'briefing' then
      v_kept_closed := v_kept_closed + 1;
      continue;
    end if;

    v_new_status := case
      when v_row.status in ('done', 'dismissed')                         then 'open'  -- closed by a briefing
      when v_row.status = 'snoozed' and v_row.snoozed_until <= v_date   then 'open'
      else v_row.status
    end;

    if v_row.source = 'manual' then
      update public.worklist_items set
        urgency        = coalesce((v_item->>'urgency')::smallint, urgency),
        urgency_reason = coalesce(v_item->>'urgency_reason', urgency_reason),
        status         = v_new_status,
        times_seen     = times_seen + case when last_seen < v_date then 1 else 0 end,
        last_seen      = greatest(last_seen, v_date)
      where id = v_row.id;
    else
      update public.worklist_items set
        kind           = coalesce(v_item->>'kind', kind),
        title          = coalesce(v_item->>'title', title),
        from_label     = coalesce(v_item->>'from_label', from_label),
        summary        = coalesce(v_item->>'summary', summary),
        link           = coalesce(v_item->>'link', link),
        due            = case when v_item ? 'due' then nullif(v_item->>'due', '')::date else due end,
        due_basis      = coalesce(v_item->>'due_basis', due_basis),
        urgency        = coalesce((v_item->>'urgency')::smallint, urgency),
        urgency_reason = coalesce(v_item->>'urgency_reason', urgency_reason),
        options        = case when answer is null then coalesce(v_item->'options', options) else options end,
        status         = v_new_status,
        times_seen     = times_seen + case when last_seen < v_date then 1 else 0 end,
        last_seen      = greatest(last_seen, v_date)
      where id = v_row.id;
    end if;

    if v_new_status is distinct from v_row.status then
      v_reopened := v_reopened + 1;
    else
      v_updated := v_updated + 1;
    end if;
  end loop;

  -- 3. Items the skill found resolved. Only open or snoozed ones; a closed
  --    item stays as the user left it.
  if p_resolved_keys is not null and cardinality(p_resolved_keys) > 0 then
    update public.worklist_items
       set status = 'done'
     where user_id = v_uid
       and source_key = any (p_resolved_keys)
       and status in ('open', 'snoozed');
    get diagnostics v_resolved = row_count;
  end if;

  -- The flag is transaction-local; clear it so any later statement in the same
  -- transaction (a user action, another caller) is not mistaken for the briefing.
  perform set_config('worklist.writer', '', true);

  return jsonb_build_object(
    'briefing_id', v_briefing_id,
    'briefing_date', v_date,
    'inserted', v_inserted,
    'updated', v_updated,
    'reopened', v_reopened,
    'kept_closed', v_kept_closed,
    'skipped_manual', v_skipped,
    'resolved', v_resolved
  );
end;
$$;

revoke all on function public.save_briefing(jsonb, jsonb, text[]) from public, anon;
grant execute on function public.save_briefing(jsonb, jsonb, text[]) to authenticated;

-- ── Realtime: the page refreshes when the morning run lands ──────────────────
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['worklist_briefings', 'worklist_items'] loop
      if not exists (
        select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
