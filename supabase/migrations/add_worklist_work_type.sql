-- My Day 2.3: work-type tagging (phase 3 groundwork).
-- Roadmap: Product Spec/my-day-roadmap.md, section 2.3.
-- Spec:    Product Spec/work-engine-phase-3-spec.md, "Data model changes" and
--          build order step 1 (gate: work type matches Seth's judgment on at
--          least 90% of a hand-checked sample).
--
-- Every task the morning run creates gets a work type: which phase 3 worker
-- could pick it up. Nothing acts on the tag yet.
--
--   worklist_items      work_type        the run's tag: reply | dtools_report | ipt_change | none
--                       work_confidence  the run's confidence, 0-1 (low = skip dispatch later)
--                       user_work_type   Seth's check: set when he confirms OR corrects the
--                                        tag (same pattern as urgency / user_urgency)
--                       effective_work_type  coalesce(user_work_type, work_type)
--                       source_ref       ids a worker will need beyond source_key/link
--                                        (thread / message / chat ids). Ids only, never text.
--   worklist_feedback   'work_type' rows: from_value = the run's tag at the time, to_value =
--                       Seth's pick. Equal = confirmed. These rows ARE the hand-checked
--                       sample, and the skill reads them as calibration.
--   save_work_tags()    the run's tags, written right after save_briefing(), by source_key.
--   work_type_accuracy() the gate number: of the tags Seth checked, how many he agreed with.
--
-- Additive except worklist_log_feedback(), which keeps every existing branch and adds
-- one. Run in the Supabase SQL Editor after add_worklist_reviewed.sql. Safe to re-run.

-- ── worklist_items: the tag ───────────────────────────────────────────────────
alter table public.worklist_items
  add column if not exists work_type text
    check (work_type in ('reply', 'dtools_report', 'ipt_change', 'none')),
  add column if not exists work_confidence numeric(3, 2)
    check (work_confidence between 0 and 1),
  add column if not exists user_work_type text
    check (user_work_type in ('reply', 'dtools_report', 'ipt_change', 'none')),
  add column if not exists source_ref jsonb
    check (source_ref is null or (jsonb_typeof(source_ref) = 'object' and octet_length(source_ref::text) <= 2000));

alter table public.worklist_items
  add column if not exists effective_work_type text
    generated always as (coalesce(user_work_type, work_type)) stored;

-- ── worklist_feedback: allow 'work_type', keep the run's confidence ──────────
alter table public.worklist_feedback
  add column if not exists claude_confidence numeric(3, 2);

alter table public.worklist_feedback drop constraint if exists worklist_feedback_action_check;
alter table public.worklist_feedback add constraint worklist_feedback_action_check
  check (action in ('done', 'dismissed', 'snoozed', 'reopened', 'urgency', 'answered', 'surfaced', 'work_type'));

-- ── Feedback trigger: one 'work_type' row each time Seth checks a tag ────────
-- Same as add_worklist.sql's version, plus the work_type branch at the end.
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

  -- Seth checked the work type (confirm or correct). from = the run's tag right
  -- now ('untagged' if it had none), to = his pick.
  if new.user_work_type is distinct from old.user_work_type and new.user_work_type is not null then
    insert into public.worklist_feedback
      (user_id, item_id, action, from_value, to_value,
       item_source, item_kind, item_title, item_from, claude_urgency, claude_confidence)
    values
      (new.user_id, new.id, 'work_type', coalesce(new.work_type, 'untagged'), new.user_work_type,
       new.source, new.kind, left(new.title, 200), left(new.from_label, 200), new.urgency,
       new.work_confidence);
  end if;

  return null;
end;
$$;

revoke all on function public.worklist_log_feedback() from public, anon, authenticated;

-- ── save_work_tags(): the run's tags, by source_key ──────────────────────────
-- p_tags: [{source_key, work_type, work_confidence, source_ref}]  (max 100)
-- Call after save_briefing() in the same run. Only the run's own columns
-- change; Seth's user_work_type is never touched. SECURITY INVOKER: RLS applies.
-- The briefing writer flag keeps these updates out of the feedback log.
create or replace function public.save_work_tags(p_tags jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_total    int;
  v_tagged   int := 0;
  v_missing  text[];
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
         source_ref      = coalesce(t->'source_ref', i.source_ref)
    from jsonb_array_elements(p_tags) t
   where i.user_id = v_uid
     and i.source_key = btrim(t->>'source_key');
  get diagnostics v_tagged = row_count;

  select coalesce(array_agg(btrim(t->>'source_key')), '{}')
    into v_missing
    from jsonb_array_elements(p_tags) t
   where not exists (
     select 1 from public.worklist_items i
      where i.user_id = v_uid and i.source_key = btrim(t->>'source_key'));

  perform set_config('worklist.writer', '', true);

  return jsonb_build_object('tagged', v_tagged, 'missing', to_jsonb(v_missing));
end;
$$;

revoke all on function public.save_work_tags(jsonb) from public, anon;
grant execute on function public.save_work_tags(jsonb) to authenticated;

-- ── work_type_accuracy(): the phase 3 gate number ────────────────────────────
-- Seth's latest check per item in the window. agreed = he picked the run's tag.
-- Untagged items he tagged himself count separately (no run tag to grade).
create or replace function public.work_type_accuracy(p_days int default 30)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with latest as (
    -- An item deleted since keeps its rows (item_id null): count each row on its own.
    select distinct on (coalesce(f.item_id, f.id)) f.item_id, f.from_value, f.to_value, f.claude_confidence
      from public.worklist_feedback f
     where f.user_id = auth.uid()
       and f.action = 'work_type'
       and f.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)))
     order by coalesce(f.item_id, f.id), f.created_at desc
  ),
  graded as (
    select * from latest where from_value <> 'untagged'
  )
  select jsonb_build_object(
    'days', greatest(1, least(coalesce(p_days, 30), 365)),
    'checked', (select count(*) from graded),
    'agreed', (select count(*) from graded where from_value = to_value),
    'untagged', (select count(*) from latest where from_value = 'untagged'),
    'by_type', coalesce((
      select jsonb_object_agg(from_value, jsonb_build_object('checked', n, 'agreed', a))
        from (select from_value, count(*) as n, count(*) filter (where from_value = to_value) as a
                from graded group by from_value) s), '{}'::jsonb),
    'misses', coalesce((
      select jsonb_agg(jsonb_build_object('tagged', from_value, 'was', to_value, 'n', n) order by n desc)
        from (select from_value, to_value, count(*) as n
                from graded where from_value <> to_value group by from_value, to_value) m), '[]'::jsonb)
  );
$$;

revoke all on function public.work_type_accuracy(int) from public, anon;
grant execute on function public.work_type_accuracy(int) to authenticated;
