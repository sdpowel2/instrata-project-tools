-- My Day 2.5: Log / Hide on read-me lines, and the second brain's inbox.
-- Roadmap: Product Spec/my-day-roadmap.md, section 2.5 ("add_brain.sql part 1").
--
--   brain_raw               the second brain's inbox: read-me lines Seth logged and quick
--                           notes he jotted. Status 'new' until 2.6's nightly filing moves
--                           them into pages ('filed') or drops them ('discarded').
--   worklist_readme_state   Seth's call on a read-me line: 'logged' (more like this) or
--                           'hidden' (less like this). The skill reads these as calibration.
--   set_readme_state()      Log / Hide / Undo in one transaction, so the state and the inbox
--                           never disagree.
--
-- Read-me ids (r1, r2, ...) are only unique within one run, and a same-day re-run reuses
-- them for different lines. So the state keeps a snapshot of the line's text, the page
-- applies a state only when the text still matches, and inbox rows are matched on
-- date + id + text.
--
-- Additive only. Run in the Supabase SQL Editor. Safe to re-run.

-- ── brain_raw ─────────────────────────────────────────────────────────────────
create table if not exists public.brain_raw (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  captured_at    timestamptz not null default now(),
  source         text not null check (source in ('readme', 'note', 'task', 'claude')),
  text           text not null check (btrim(text) <> '' and char_length(text) <= 4000),
  link           text check (char_length(link) <= 2000),
  briefing_date  date,                 -- source 'readme': the briefing the line came from
  readme_id      text check (char_length(readme_id) <= 200),
  readme_source  text check (readme_source in ('email', 'teams', 'monday', 'manual', 'claude')),
  status         text not null default 'new' check (status in ('new', 'filed', 'discarded')),
  filed_at       timestamptz,
  page_id        uuid,                 -- FK to brain_pages added in 2.6
  check (source <> 'readme' or (briefing_date is not null and readme_id is not null))
);

create index if not exists idx_brain_raw_inbox
  on public.brain_raw (user_id, status, captured_at);
create index if not exists idx_brain_raw_readme
  on public.brain_raw (user_id, briefing_date, readme_id) where source = 'readme';

-- ── worklist_readme_state ─────────────────────────────────────────────────────
create table if not exists public.worklist_readme_state (
  user_id        uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  briefing_date  date not null,
  readme_id      text not null check (char_length(readme_id) <= 200),
  state          text not null check (state in ('logged', 'hidden')),
  readme_text    text not null check (char_length(readme_text) <= 500),   -- snapshot: calibration + re-run check
  readme_source  text,
  readme_link    text check (char_length(readme_link) <= 2000),
  at             timestamptz not null default now(),
  primary key (user_id, briefing_date, readme_id)
);

create index if not exists idx_readme_state_recent
  on public.worklist_readme_state (user_id, at desc);

-- ── RLS: owner-only ───────────────────────────────────────────────────────────
alter table public.brain_raw             enable row level security;
alter table public.worklist_readme_state enable row level security;

revoke all on public.brain_raw             from anon, authenticated;
revoke all on public.worklist_readme_state from anon, authenticated;

grant select, insert, update, delete on public.brain_raw             to authenticated;
grant select, insert, update, delete on public.worklist_readme_state to authenticated;

drop policy if exists "Owner manages own brain inbox" on public.brain_raw;
create policy "Owner manages own brain inbox" on public.brain_raw
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "Owner manages own read-me state" on public.worklist_readme_state;
create policy "Owner manages own read-me state" on public.worklist_readme_state
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── set_readme_state(): Log / Hide / Undo ────────────────────────────────────
-- p_state 'logged' → state row + one inbox row (not duplicated on a second Log)
--         'hidden' → state row; an inbox row this line put there is removed if not filed yet
--         null     → undo: state row and any unfiled inbox row for the line are removed
-- Filed inbox rows are never touched: once 2.6 has filed a note, it's part of a page.
-- SECURITY INVOKER: RLS applies. Returns {state, raw_id}.
create or replace function public.set_readme_state(
  p_date       date,
  p_readme_id  text,
  p_state      text,
  p_text       text,
  p_source     text default null,
  p_link       text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_text  text := btrim(coalesce(p_text, ''));
  v_id    text := btrim(coalesce(p_readme_id, ''));
  v_raw   uuid;
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

  -- Whatever the new state, an unfiled inbox row from this line goes, unless we're logging it.
  if p_state is distinct from 'logged' then
    delete from public.brain_raw
     where user_id = v_uid and source = 'readme' and status = 'new'
       and briefing_date = p_date and readme_id = v_id and text = v_text;
  end if;

  if p_state is null then
    delete from public.worklist_readme_state
     where user_id = v_uid and briefing_date = p_date and readme_id = v_id;
    return jsonb_build_object('state', null, 'raw_id', null);
  end if;

  insert into public.worklist_readme_state as s
    (user_id, briefing_date, readme_id, state, readme_text, readme_source, readme_link, at)
  values
    (v_uid, p_date, v_id, p_state, left(v_text, 500), p_source, left(p_link, 2000), now())
  on conflict (user_id, briefing_date, readme_id) do update set
    state         = excluded.state,
    readme_text   = excluded.readme_text,
    readme_source = excluded.readme_source,
    readme_link   = excluded.readme_link,
    at            = excluded.at;

  if p_state = 'logged' then
    select id into v_raw
      from public.brain_raw
     where user_id = v_uid and source = 'readme' and status <> 'discarded'
       and briefing_date = p_date and readme_id = v_id and text = v_text
     limit 1;
    if v_raw is null then
      insert into public.brain_raw (user_id, source, text, link, briefing_date, readme_id, readme_source)
      values (v_uid, 'readme', v_text, left(p_link, 2000), p_date, v_id,
              case when p_source in ('email', 'teams', 'monday', 'manual', 'claude') then p_source end)
      returning id into v_raw;
    end if;
  end if;

  return jsonb_build_object('state', p_state, 'raw_id', v_raw);
end;
$$;

revoke all on function public.set_readme_state(date, text, text, text, text, text) from public, anon;
grant execute on function public.set_readme_state(date, text, text, text, text, text) to authenticated;
