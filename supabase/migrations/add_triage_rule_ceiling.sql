-- My Day 2.2 follow-up: a ceiling effect for tuning rules.
-- Roadmap: Product Spec/my-day-roadmap.md, section 2.2.
--
-- New effect max_read_me ("Read me at most"): a matching conversation is
-- never a task. It may be a Read me line, Set aside, or dropped. Unlike
-- suppress, it also applies to items already open from an earlier run:
-- once the run lands such an item as Read me / Set aside / dropped,
-- save_reviewed() dismisses the open item (closed_by = 'briefing').
--
-- Rules now combine instead of one winner taking all:
--   floors    min_task (a task), min_read_me (at least Read me)
--   ceilings  max_read_me (Read me at most), suppress (Set aside)
-- Every matching rule is enforced, except a ceiling that conflicts with a
-- higher floor (the floor wins, as before). So min_read_me + max_read_me on
-- the same conversation means exactly a Read me line, while min_task still
-- beats either ceiling and min_read_me still beats suppress.
--
--   triage_effect_rank()        adds max_read_me (orders `effects`).
--   triage_effect_broken()      adds max_read_me.
--   triage_effect_overridden()  new: is this effect beaten by a matching floor?
--   triage_reviewed_enforced()  new: each reviewed row's enforced hard rules.
--   match_triage_rules()        returns `effects` (every enforced effect) as
--                               well as `effect` (the first of them).
--   save_reviewed()             violations check every enforced rule, and
--                               open items demoted by max_read_me are dismissed.
--   preview_triage_rule()       accepts max_read_me.
--
-- Run in the Supabase SQL Editor after add_triage_rules.sql. Safe to re-run.

-- ── The effect list ───────────────────────────────────────────────────────────
alter table public.triage_rules drop constraint if exists triage_rules_effect_check;
alter table public.triage_rules add constraint triage_rules_effect_check
  check (effect in ('min_task', 'min_read_me', 'max_read_me', 'suppress'));

-- Order effects are listed in: floors first, then the looser ceiling.
create or replace function public.triage_effect_rank(p_effect text)
returns int
language sql
immutable
as $$
  select case p_effect
    when 'min_task' then 4 when 'min_read_me' then 3 when 'max_read_me' then 2 else 1 end;
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
    when 'max_read_me' then public.triage_outcome_rank(p_outcome) >= 3   -- includes 'carried'
    when 'suppress'    then p_outcome in ('respond', 'do', 'decide', 'read_me')
    else false end;
$$;

-- A ceiling is overridden when a matching floor asks for more than it allows:
-- min_task beats both ceilings, min_read_me beats suppress. Floors never are.
create or replace function public.triage_effect_overridden(p_effect text, p_all text[])
returns boolean
language sql
immutable
as $$
  select case p_effect
    when 'max_read_me' then 'min_task' = any(p_all)
    when 'suppress'    then 'min_task' = any(p_all) or 'min_read_me' = any(p_all)
    else false end;
$$;

grant execute on function public.triage_effect_rank(text) to authenticated;
grant execute on function public.triage_effect_broken(text, text) to authenticated;
grant execute on function public.triage_effect_overridden(text, text[]) to authenticated;

-- ── match_triage_rules(): now with every enforced effect ─────────────────────
-- Returns {hard_rules, candidates, matched: [{key, effect, effects, rule_ids, notes}]}.
-- effects = every effect the run must honour, floors first; effect = effects[1].
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
           'key', e.key, 'effect', e.effects[1], 'effects', to_jsonb(e.effects),
           'rule_ids', to_jsonb(e.rule_ids), 'notes', to_jsonb(e.notes))
           order by e.key), '[]'::jsonb)
    into v_out
    from (
      select g.key, g.rule_ids, g.notes,
             array(select d.eff
                     from (select distinct unnest(g.all_effects) as eff) d
                    where not public.triage_effect_overridden(d.eff, g.all_effects)
                    order by public.triage_effect_rank(d.eff) desc) as effects
        from (
          select c->>'key' as key,
                 array_agg(t.effect) as all_effects,
                 array_agg(t.id order by t.created_at) as rule_ids,
                 array_remove(array_agg(t.note order by t.created_at), null) as notes
            from jsonb_array_elements(p_candidates) c
            join public.triage_rules t
              on t.user_id = v_uid and t.active and t.kind = 'hard'
             and public.triage_rule_matches(t.match, c->>'source', c->>'sender', c->>'title', c->>'channel')
           where coalesce(c->>'key', '') <> ''
           group by c->>'key'
        ) g
    ) e;

  return jsonb_build_object('hard_rules', v_rules, 'candidates', v_total, 'matched', v_out);
end;
$$;

revoke all on function public.match_triage_rules(jsonb) from public, anon;
grant execute on function public.match_triage_rules(jsonb) to authenticated;

-- ── triage_reviewed_enforced(): each reviewed row's enforced hard rules ───────
-- Every hard rule that fired on the row (rule_ids), minus ceilings a higher
-- floor overrides. Surfaced rows are left out, as in the violation check.
create or replace function public.triage_reviewed_enforced(p_briefing_id uuid)
returns table (row_id uuid, source_key text, title text, outcome text,
               rule_id uuid, effect text, rule_created_at timestamptz)
language sql
stable
security invoker
set search_path = public
as $$
  select w.id, w.source_key, w.title, w.outcome, t.id, t.effect, t.created_at
    from public.worklist_reviewed w
    join public.triage_rules t on t.id = any(w.rule_ids) and t.kind = 'hard'
   where w.briefing_id = p_briefing_id
     and w.surfaced_at is null
     and not public.triage_effect_overridden(t.effect, array(
           select t2.effect from public.triage_rules t2
            where t2.id = any(w.rule_ids) and t2.kind = 'hard'));
$$;

revoke all on function public.triage_reviewed_enforced(uuid) from public, anon;
grant execute on function public.triage_reviewed_enforced(uuid) to authenticated;

-- ── save_reviewed(): every enforced rule checked; demoted open items dismissed ─
-- Same signature and result keys as before, plus `dismissed` (count) and
-- `dismissed_keys`: open or snoozed items (never manual tasks) whose reviewed
-- row landed below the list under an enforced max_read_me rule.
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
  v_dismissed    text[];
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

  -- Violations: one per row, the highest-ranked enforced rule it breaks.
  select coalesce(jsonb_agg(jsonb_build_object(
           'source_key', v.source_key, 'title', v.title, 'outcome', v.outcome,
           'required', v.effect, 'rule_id', v.rule_id)), '[]'::jsonb)
    into v_violations
    from (
      select distinct on (e.row_id) e.*
        from public.triage_reviewed_enforced(v_briefing_id) e
       where public.triage_effect_broken(e.effect, e.outcome)
       order by e.row_id, public.triage_effect_rank(e.effect) desc, e.rule_created_at
    ) v;

  -- Open items a Read me ceiling took off the list. Only rows that comply
  -- (no violation), so a run that still has it as a task never closes it.
  perform set_config('worklist.writer', 'briefing', true);
  with enforced as (
    select * from public.triage_reviewed_enforced(v_briefing_id)
  ), demoted as (
    select distinct e.source_key
      from enforced e
     where e.effect = 'max_read_me'
       and e.outcome in ('read_me', 'set_aside', 'dropped')
       and not exists (
         select 1 from enforced x
          where x.row_id = e.row_id and public.triage_effect_broken(x.effect, x.outcome))
  ), closed as (
    update public.worklist_items i
       set status = 'dismissed'
      from demoted d
     where i.user_id = v_uid
       and i.source_key = d.source_key
       and i.source <> 'manual'
       and i.status in ('open', 'snoozed')
    returning i.source_key
  )
  select coalesce(array_agg(source_key order by source_key), '{}') into v_dismissed from closed;
  perform set_config('worklist.writer', '', true);

  return jsonb_build_object(
    'briefing_date', p_date,
    'saved', v_saved,
    'skipped', v_total - v_saved,   -- duplicates, or kept from earlier today
    'replaced', v_replaced,
    'purged', v_purged,
    'violations', v_violations,
    'dismissed', cardinality(v_dismissed),
    'dismissed_keys', to_jsonb(v_dismissed)
  );
end;
$$;

revoke all on function public.save_reviewed(date, jsonb) from public, anon;
grant execute on function public.save_reviewed(date, jsonb) to authenticated;

-- ── preview_triage_rule(): accepts the new effect ────────────────────────────
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
  if p_effect not in ('min_task', 'min_read_me', 'max_read_me', 'suppress') then
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
