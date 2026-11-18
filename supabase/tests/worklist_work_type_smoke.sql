-- Smoke test for add_worklist_work_type.sql (My Day 2.3). Run in the SQL Editor
-- AFTER the migration. Runs as Seth on a fake day (2000-01-01), then raises an
-- error carrying the results, which rolls EVERYTHING back. Nothing is left behind.
-- Every line should end in "true".
do $$
declare
  v_uid  uuid;
  r      jsonb;
  v_out  text[] := '{}';
  v_a    uuid;
  v_b    uuid;
  v_c    uuid;
  n      int;
  base   int;
begin
  select id into v_uid from public.profiles where email = 'seth.powell@instrata.com';
  if v_uid is null then raise exception 'profile not found'; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- Baseline for the accuracy check: Seth's real checks in the window.
  select (public.work_type_accuracy(30)->>'checked')::int into base;

  perform public.save_briefing('{"date":"2000-01-01"}', '[
    {"source_key":"wt:a","source":"email","kind":"respond","title":"Reply A","urgency":2},
    {"source_key":"wt:b","source":"email","kind":"do","title":"BoM for B","urgency":2},
    {"source_key":"wt:c","source":"teams","kind":"do","title":"Untagged C","urgency":3}
  ]');
  select id into v_a from public.worklist_items where source_key = 'wt:a';
  select id into v_b from public.worklist_items where source_key = 'wt:b';
  select id into v_c from public.worklist_items where source_key = 'wt:c';

  -- ── The run's tags ──
  r := public.save_work_tags('[
    {"source_key":"wt:a","work_type":"reply","work_confidence":0.9,"source_ref":{"conversation_id":"abc","message_id":"m1"}},
    {"source_key":"wt:b","work_type":"reply","work_confidence":0.55},
    {"source_key":"wt:nope","work_type":"none"}
  ]');
  v_out := v_out || ('tags: ' || r::text);
  v_out := v_out || ('tagged 2, 1 missing key reported: ' ||
    ((r->>'tagged')::int = 2 and r->'missing' = '["wt:nope"]'::jsonb))::text;
  select count(*) into n from public.worklist_items
   where id = v_a and work_type = 'reply' and work_confidence = 0.90
     and effective_work_type = 'reply' and source_ref->>'message_id' = 'm1';
  v_out := v_out || ('tag, confidence, effective type and source_ref stored: ' || (n = 1))::text;
  select count(*) into n from public.worklist_feedback where item_id in (v_a, v_b, v_c);
  v_out := v_out || ('the run tagging logs no feedback: ' || (n = 0))::text;

  begin
    perform public.save_work_tags('[{"source_key":"wt:a","work_type":"email_bot"}]');
    v_out := v_out || 'unknown work type rejected: false'::text;
  exception when check_violation then
    v_out := v_out || 'unknown work type rejected: true'::text;
  end;

  -- ── Seth checks tags ──
  update public.worklist_items set user_work_type = 'reply' where id = v_a;          -- confirms
  update public.worklist_items set user_work_type = 'dtools_report' where id = v_b;  -- corrects
  update public.worklist_items set user_work_type = 'ipt_change' where id = v_c;     -- tags an untagged one
  select count(*) into n from public.worklist_feedback
   where item_id = v_b and action = 'work_type' and from_value = 'reply' and to_value = 'dtools_report'
     and claude_confidence = 0.55;
  v_out := v_out || ('correction logged with the run''s tag and confidence: ' || (n = 1))::text;
  select count(*) into n from public.worklist_feedback
   where item_id = v_c and action = 'work_type' and from_value = 'untagged';
  v_out := v_out || ('untagged item logged as untagged: ' || (n = 1))::text;
  select count(*) into n from public.worklist_items where id = v_b and effective_work_type = 'dtools_report' and work_type = 'reply';
  v_out := v_out || ('Seth''s pick wins, run''s tag kept: ' || (n = 1))::text;

  -- A later run re-tags B; Seth's pick still wins and nothing new is logged.
  perform public.save_work_tags('[{"source_key":"wt:b","work_type":"none","work_confidence":0.4}]');
  select count(*) into n from public.worklist_items where id = v_b and effective_work_type = 'dtools_report';
  v_out := v_out || ('re-tag never overrides Seth: ' || (n = 1))::text;
  select count(*) into n from public.worklist_feedback where item_id = v_b and action = 'work_type';
  v_out := v_out || ('re-tag logs nothing: ' || (n = 1))::text;

  -- ── The gate number ──
  r := public.work_type_accuracy(30);
  v_out := v_out || ('accuracy: ' || r::text);
  v_out := v_out || ('accuracy: +2 checked, A agreed, B missed reply->dtools_report: ' || (
    (r->>'checked')::int = base + 2
    and (r->'by_type'->'reply'->>'checked')::int >= 2
    and exists (select 1 from jsonb_array_elements(r->'misses') m
                 where m->>'tagged' = 'reply' and m->>'was' = 'dtools_report')))::text;

  -- Other feedback still works.
  update public.worklist_items set status = 'done' where id = v_a;
  select count(*) into n from public.worklist_feedback where item_id = v_a and action = 'done';
  v_out := v_out || ('done still logged: ' || (n = 1))::text;

  raise exception E'WORK TYPE SMOKE TEST (all rolled back):\n%', array_to_string(v_out, E'\n');
end $$;
