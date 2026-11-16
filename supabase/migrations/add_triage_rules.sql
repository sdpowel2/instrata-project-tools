-- My Day 2.2: tuning rules.
-- Roadmap: Product Spec/my-day-roadmap.md, section 2.2.
--
--   triage_rules           Seth's rules for the morning run, made from the
--                          reviewed drawer ("More like this" / "Less like this")
--                          or by hand. Two kinds:
--                            hard    a match (sender, domain, subject words,
--                                    chat or board) plus an effect. Matched in
--                                    SQL, so it's applied the same way every run.
--                            lesson  a judgment call in Seth's words, with an
--                                    example row. The skill reads it as an
--                                    example; nothing enforces it.
--   worklist_reviewed      gains sender, channel and rule_ids (which rules
--                          fired on the row).
--   triage_rule_matches()  the one matcher. match_triage_rules(),
--                          save_reviewed() and preview_triage_rule() all use it,
--                          so the preview, the run and the drawer agree.
--   match_triage_rules()   the run asks which hard rules apply to its
--                          candidate conversations before it saves.
--   save_reviewed()        (replaced) stores sender/channel, records the rules
--                          that fired, and returns `violations`: rows whose
--                          outcome breaks a hard rule, so the run can fix them.
--   preview_triage_rule()  the modal's preview: what a hard rule would catch in
--                          the latest run, and how often in the last 30 days.
--   triage_rules_with_hits view: each rule with its 30-day hit count.
--
-- Effects: min_task (always on the list), min_read_me (at least a Read me
-- line), suppress (Set aside). When rules disagree, the floor wins: a
-- min_task or min_read_me rule beats a suppress rule. Suppress never moves an
-- item that's already open from an earlier run (outcome 'carried').
--
-- Additive except save_reviewed(), which keeps its signature and result keys
-- and adds new ones. Owner-only RLS. Run in the Supabase SQL Editor after
-- add_worklist_reviewed.sql. Safe to re-run.

-- ── Matching helpers ──────────────────────────────────────────────────────────
-- A match is a jsonb object with any of:
--   source         'email' | 'teams' | 'monday'
--   sender         exact address (case-insensitive)
--   domain         sender's domain, subdomains included ("gc.com" matches "mail.gc.com")
--   subject_terms  1-6 words; every one must appear in the title (case-insensitive)
--   channel        text the Teams chat / channel name or monday board must contain
-- and needs at least one of sender, domain, subject_terms, channel (source
-- alone would match everything from that source). Twin: app/src/components/worklist/rules.ts.
create or replace function public.triage_match_valid(p_match jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce(
    jsonb_typeof(p_match) = 'object'
    and (p_match - array['source', 'sender', 'domain', 'subject_terms', 'channel']) = '{}'::jsonb
    and p_match ?| array['sender', 'domain', 'subject_terms', 'channel']
    and (not p_match ? 'source' or p_match->>'source' in ('email', 'teams', 'monday'))
    and (not p_match ? 'sender'
         or (btrim(p_match->>'sender') <> '' and char_length(p_match->>'sender') <= 200))
    and (not p_match ? 'domain'
         or (p_match->>'domain') ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$')
    and (not p_match ? 'channel'
         or (btrim(p_match->>'channel') <> '' and char_length(p_match->>'channel') <= 200))
    and (not p_match ? 'subject_terms'
         or (jsonb_typeof(p_match->'subject_terms') = 'array'
             and jsonb_array_length(p_match->'subject_terms') between 1 and 6
             and not exists (
               select 1 from jsonb_array_elements(p_match->'subject_terms') t
                where jsonb_typeof(t) <> 'string'
                   or char_length(btrim(t #>> '{}')) not between 2 and 60))),
    false);
$$;

create or replace function public.triage_rule_matches(
  p_match   jsonb,
  p_source  text,
  p_sender  text,
  p_title   text,
  p_channel text
)
returns boolean
language sql
immutable
as $$
  select coalesce(
    public.triage_match_valid(p_match)
    and (not p_match ? 'source' or p_match->>'source' = p_source)
    and (not p_match ? 'sender'
         or lower(btrim(p_sender)) = lower(btrim(p_match->>'sender')))
    and (not p_match ? 'domain'
         or split_part(lower(btrim(p_sender)), '@', 2) = p_match->>'domain'
         or right(split_part(lower(btrim(p_sender)), '@', 2), char_length(p_match->>'domain') + 1)
            = '.' || (p_match->>'domain'))
    and (not p_match ? 'subject_terms'
         or not exists (
           select 1 from jsonb_array_elements_text(p_match->'subject_terms') t
            where strpos(lower(coalesce(p_title, '')), lower(btrim(t))) = 0))
    and (not p_match ? 'channel'
         or strpos(lower(coalesce(p_channel, '')), lower(btrim(p_match->>'channel'))) > 0),
    false);
$$;

-- Higher = closer to the top of the list.
create or replace function public.triage_outcome_rank(p_outcome text)
returns int
language sql
immutable
as $$
  select case p_outcome
    when 'respond' then 3 when 'do' then 3 when 'decide' then 3 when 'carried' then 3
    when 'read_me' then 2 when 'set_aside' then 1 else 0 end;
$$;

-- Which effect wins when several rules match: the floor beats suppress.
create or replace function public.triage_effect_rank(p_effect text)
returns int
language sql
immutable
as $$
  select case p_effect when 'min_task' then 3 when 'min_read_me' then 2 else 1 end;
$$;

-- Does this outcome break this effect?
create or replace function public.triage_effect_broken(p_effect text, p_outcome text)
returns boolean
language sql
immutable
as $$
  select case p_effect
    when 'min_task'    then public.triage_outcome_rank(p_outcome) < 3
    when 'min_read_me' then public.triage_outcome_rank(p_outcome) < 2
    when 'suppress'    then p_outcome in ('respond', 'do', 'decide', 'read_me')
    else false end;
$$;

grant execute on function public.triage_match_valid(jsonb) to authenticated;
grant execute on function public.triage_rule_matches(jsonb, text, text, text, text) to authenticated;
grant execute on function public.triage_outcome_rank(text) to authenticated;
grant execute on function public.triage_effect_rank(text) to authenticated;
grant execute on function public.triage_effect_broken(text, text) to authenticated;

-- ── worklist_reviewed: sender, channel, rule_ids ──────────────────────────────
alter table public.worklist_reviewed
  add column if not exists sender   text check (char_length(sender) <= 200),
  add column if not exists channel  text check (char_length(channel) <= 200),
  add column if not exists rule_ids uuid[] not null default '{}';

create index if not exists idx_worklist_reviewed_rule_ids
  on public.worklist_reviewed using gin (rule_ids);

-- ── triage_rules ──────────────────────────────────────────────────────────────
create table if not exists public.triage_rules (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  kind          text not null check (kind in ('hard', 'lesson')),
  match         jsonb,
  effect        text not null check (effect in ('min_task', 'min_read_me', 'suppress')),
  example_id    uuid references public.worklist_reviewed(id) on delete set null,
  note          text check (char_length(note) <= 500),
  active        boolean not null default true,
  created_from  text not null check (created_from in ('surface_more', 'surface_less', 'manual')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Hard rules need a valid match; lessons may carry one as a hint.
  constraint triage_rules_match_ok check (
    (kind = 'hard' and public.triage_match_valid(match))
    or (kind = 'lesson' and (match is null or public.triage_match_valid(match)))),
  -- A lesson is Seth's words; without them there's nothing to learn.
  constraint triage_rules_lesson_note check (kind <> 'lesson' or btrim(coalesce(note, '')) <> '')
);

create index if not exists idx_triage_rules_user on public.triage_rules (user_id, active, kind);

alter table public.triage_rules enable row level security;
revoke all on public.triage_rules from anon, authenticated;
grant select, insert, update, delete on public.triage_rules to authenticated;

drop policy if exists "Owner manages own triage rules" on public.triage_rules;
create policy "Owner manages own triage rules" on public.triage_rules
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop trigger if exists triage_rules_updated_at on public.triage_rules;
create trigger triage_rules_updated_at before update on public.triage_rules
  for each row execute function public.set_updated_at();

-- Each rule with how often it fired in the last 30 days (the reviewed log's
-- retention window). security_invoker: RLS on both tables applies.
create or replace view public.triage_rules_with_hits
with (security_invoker = true) as
select t.*,
       coalesce(h.hits, 0)::int as hits_30d,
       h.last_hit_at
  from public.triage_rules t
  left join lateral (
    select count(*) as hits, max(r.created_at) as last_hit_at
      from public.worklist_reviewed r
     where r.user_id = t.user_id
       and r.rule_ids @> array[t.id]
       and r.created_at > now() - interval '30 days'
  ) h on true;

revoke all on public.triage_rules_with_hits from anon, authenticated;
grant select on public.triage_rules_with_hits to authenticated;

-- ── match_triage_rules(): which hard rules apply to the run's candidates ─────
-- p_candidates: [{key, source, sender, title, channel}]  (max 500)
-- Returns {hard_rules, candidates, matched: [{key, effect, rule_ids, notes}]},
-- one entry per candidate with at least one matching active hard rule. effect
-- is the winning one (floor beats suppress).
create or replace function public.match_triage_rules(p_candidates jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_total  int;
  v_rules  int;
  v_out    jsonb;
begin
  if v_uid is null then
    raise exception 'match_triage_rules: not signed in';
  end if;
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' then
    raise exception 'match_triage_rules: p_candidates must be an array';
  end if;
  v_total := jsonb_array_length(p_candidates);
  if v_total > 500 then
    raise exception 'match_triage_rules: % candidates is over the 500 limit', v_total;
  end if;

  select count(*) into v_rules
    from public.triage_rules
   where user_id = v_uid and active and kind = 'hard';

  select coalesce(jsonb_agg(jsonb_build_object(
           'key', g.key, 'effect', g.effect, 'rule_ids', to_jsonb(g.rule_ids), 'notes', to_jsonb(g.notes))
           order by g.key), '[]'::jsonb)
    into v_out
    from (
      select c->>'key' as key,
             (array_agg(t.effect order by public.triage_effect_rank(t.effect) desc))[1] as effect,
             array_agg(t.id order by t.created_at) as rule_ids,
             array_remove(array_agg(t.note order by t.created_at), null) as notes
        from jsonb_array_elements(p_candidates) c
        join public.triage_rules t
          on t.user_id = v_uid and t.active and t.kind = 'hard'
         and public.triage_rule_matches(t.match, c->>'source', c->>'sender', c->>'title', c->>'channel')
       where coalesce(c->>'key', '') <> ''
       group by c->>'key'
    ) g;

  return jsonb_build_object('hard_rules', v_rules, 'candidates', v_total, 'matched', v_out);
end;
$$;

revoke all on function public.match_triage_rules(jsonb) from public, anon;
grant execute on function public.match_triage_rules(jsonb) to authenticated;

-- ── save_reviewed(): now with sender, channel, rule_ids and violations ───────
-- p_rows: [{source_key, source, title, from_label, link, outcome, reason,
--           reason_group, sender, channel, lesson_ids}]  (max 400)
-- rule_ids = every active hard rule that matches the row (computed here, not
-- trusted from the run) plus the lessons the run says it applied.
-- violations = rows whose outcome breaks the winning hard rule.
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
  v_violations   jsonb;
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

  -- 30-day retention. Kept: surfaced rows (the regression set) and rows a rule
  -- points to as its example.
  delete from public.worklist_reviewed r
   where r.user_id = v_uid and r.surfaced_at is null and r.created_at < now() - interval '30 days'
     and not exists (select 1 from public.triage_rules t where t.example_id = r.id);
  get diagnostics v_purged = row_count;

  -- A same-day re-run replaces the day's rows, with the same exceptions.
  delete from public.worklist_reviewed r
   where r.briefing_id = v_briefing_id and r.surfaced_at is null
     and not exists (select 1 from public.triage_rules t where t.example_id = r.id);
  get diagnostics v_replaced = row_count;

  insert into public.worklist_reviewed
    (user_id, briefing_id, source, source_key, title, from_label, link, outcome, reason, reason_group,
     sender, channel, rule_ids)
  select v_uid, v_briefing_id,
         r->>'source', btrim(r->>'source_key'), r->>'title', r->>'from_label', r->>'link',
         r->>'outcome', r->>'reason', r->>'reason_group',
         lower(nullif(btrim(r->>'sender'), '')), nullif(btrim(r->>'channel'), ''),
         coalesce((
           select array_agg(t.id order by t.created_at)
             from public.triage_rules t
            where t.user_id = v_uid and t.active
              and ((t.kind = 'hard'
                    and public.triage_rule_matches(t.match, r->>'source', r->>'sender', r->>'title', r->>'channel'))
                or (t.kind = 'lesson'
                    and jsonb_typeof(r->'lesson_ids') = 'array'
                    and r->'lesson_ids' ? t.id::text))
         ), '{}')
    from jsonb_array_elements(p_rows) as r
  on conflict (briefing_id, source_key) do nothing;
  get diagnostics v_saved = row_count;

  select coalesce(jsonb_agg(jsonb_build_object(
           'source_key', w.source_key, 'title', w.title, 'outcome', w.outcome,
           'required', e.effect, 'rule_id', e.id)), '[]'::jsonb)
    into v_violations
    from public.worklist_reviewed w
    cross join lateral (
      select t.id, t.effect
        from public.triage_rules t
       where t.id = any(w.rule_ids) and t.kind = 'hard'
       order by public.triage_effect_rank(t.effect) desc, t.created_at
       limit 1
    ) e
   where w.briefing_id = v_briefing_id
     and w.surfaced_at is null
     and public.triage_effect_broken(e.effect, w.outcome);

  return jsonb_build_object(
    'briefing_date', p_date,
    'saved', v_saved,
    'skipped', v_total - v_saved,   -- duplicates, or kept from earlier today
    'replaced', v_replaced,
    'purged', v_purged,
    'violations', v_violations
  );
end;
$$;

revoke all on function public.save_reviewed(date, jsonb) from public, anon;
grant execute on function public.save_reviewed(date, jsonb) to authenticated;

-- ── preview_triage_rule(): the modal's "what would this catch?" ──────────────
-- Runs a draft hard rule against one run's reviewed rows (p_date, default the
-- latest run). `changes` is true where the rule would move the row.
-- matched_30d counts every reviewed row in the retention window.
create or replace function public.preview_triage_rule(p_match jsonb, p_effect text, p_date date default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_briefing  public.worklist_briefings%rowtype;
  v_rows      jsonb;
  v_matched   int;
  v_change    int;
  v_30d       int;
begin
  if v_uid is null then
    raise exception 'preview_triage_rule: not signed in';
  end if;
  if not public.triage_match_valid(p_match) then
    raise exception 'preview_triage_rule: pick at least one of sender, domain, subject words, or chat/board';
  end if;
  if p_effect not in ('min_task', 'min_read_me', 'suppress') then
    raise exception 'preview_triage_rule: unknown effect %', p_effect;
  end if;

  select * into v_briefing
    from public.worklist_briefings
   where user_id = v_uid and (p_date is null or briefing_date = p_date)
   order by briefing_date desc
   limit 1;

  select count(*), count(*) filter (where public.triage_effect_broken(p_effect, r.outcome)),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'source', r.source, 'title', r.title, 'from_label', r.from_label,
           'outcome', r.outcome, 'reason_group', r.reason_group,
           'changes', public.triage_effect_broken(p_effect, r.outcome))
           order by public.triage_effect_broken(p_effect, r.outcome) desc, r.title), '[]'::jsonb)
    into v_matched, v_change, v_rows
    from public.worklist_reviewed r
   where r.user_id = v_uid
     and r.briefing_id = v_briefing.id
     and public.triage_rule_matches(p_match, r.source, r.sender, r.title, r.channel);

  select count(*) into v_30d
    from public.worklist_reviewed r
   where r.user_id = v_uid
     and r.created_at > now() - interval '30 days'
     and public.triage_rule_matches(p_match, r.source, r.sender, r.title, r.channel);

  return jsonb_build_object(
    'briefing_date', v_briefing.briefing_date,
    'matched', v_matched,
    'would_change', v_change,
    'matched_30d', v_30d,
    'rows', v_rows
  );
end;
$$;

revoke all on function public.preview_triage_rule(jsonb, text, date) from public, anon;
grant execute on function public.preview_triage_rule(jsonb, text, date) to authenticated;
