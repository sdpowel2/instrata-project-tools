-- Smoke test for add_worklist_projects.sql (My Day 2.4). Run in the SQL Editor
-- AFTER the migration. Runs as Seth on a fake day (2000-01-01), then raises an
-- error carrying the results, which rolls EVERYTHING back. Nothing is left behind.
-- Every line should end in "true".
do $$
declare
  v_uid  uuid;
  r      jsonb;
  v_out  text[] := '{}';
  v_p1   uuid;
  v_p2   uuid;
  v_a    uuid;
  v_b    uuid;
  v_c    uuid;
  n      int;
begin
  select id into v_uid from public.profiles where email = 'seth.powell@instrata.com';
  if v_uid is null then raise exception 'profile not found'; end if;
  select id into v_p1 from public.projects order by created_at, id limit 1;
  select id into v_p2 from public.projects order by created_at, id offset 1 limit 1;
  if v_p2 is null then raise exception 'need at least two projects'; end if;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- ── The run can't link ──
  -- save_briefing is sent a project_id; it must not land.
  perform public.save_briefing('{"date":"2000-01-01"}', jsonb_build_array(
    jsonb_build_object('source_key', 'pj:a', 'source', 'monday', 'kind', 'do', 'title', 'Task A', 'urgency', 2,
                       'project_id', v_p1),
    jsonb_build_object('source_key', 'pj:b', 'source', 'email', 'kind', 'respond', 'title', 'Task B', 'urgency', 2),
    jsonb_build_object('source_key', 'pj:c', 'source', 'teams', 'kind', 'do', 'title', 'Task C', 'urgency', 3)));
  select id into v_a from public.worklist_items where source_key = 'pj:a';
  select id into v_b from public.worklist_items where source_key = 'pj:b';
  select id into v_c from public.worklist_items where source_key = 'pj:c';
  select count(*) into n from public.worklist_items where id = v_a and project_id is null;
  v_out := v_out || ('save_briefing ignores project_id: ' || (n = 1))::text;

  -- save_work_tags is sent a project_id and suggestions (one is not a real project).
  r := public.save_work_tags(jsonb_build_array(
    jsonb_build_object('source_key', 'pj:a', 'work_type', 'none', 'project_id', v_p1, 'suggested_project_id', v_p1),
    jsonb_build_object('source_key', 'pj:b', 'suggested_project_id', upper(v_p2::text)),
    jsonb_build_object('source_key', 'pj:c', 'suggested_project_id', gen_random_uuid())));
  v_out := v_out || ('tags: ' || r::text);
  v_out := v_out || ('3 tagged, 2 suggested (unknown project skipped): ' ||
    ((r->>'tagged')::int = 3 and (r->>'suggested')::int = 2))::text;
  select count(*) into n from public.worklist_items
   where id = v_a and project_id is null and suggested_project_id = v_p1;
  v_out := v_out || ('save_work_tags suggests but never links: ' || (n = 1))::text;
  select count(*) into n from public.worklist_items where id = v_c and suggested_project_id is null;
  v_out := v_out || ('suggestion that is not a project ignored: ' || (n = 1))::text;

  -- Even a direct update under the briefing flag is put back by the guard.
  perform set_config('worklist.writer', 'briefing', true);
  update public.worklist_items set project_id = v_p1 where id = v_a;
  perform set_config('worklist.writer', '', true);
  select count(*) into n from public.worklist_items where id = v_a and project_id is null;
  v_out := v_out || ('guard puts back a link made under the briefing flag: ' || (n = 1))::text;
  select count(*) into n from public.project_activity where item_id = v_a;
  v_out := v_out || ('...and logs nothing: ' || (n = 0))::text;

  -- ── Seth links, finishes, reopens, unlinks ──
  update public.worklist_items set project_id = v_p1 where id = v_a;   -- confirms the suggestion
  select count(*) into n from public.worklist_items where id = v_a and project_id = v_p1 and suggested_project_id is null;
  v_out := v_out || ('linking clears the suggestion: ' || (n = 1))::text;
  update public.worklist_items set status = 'done' where id = v_a;
  update public.worklist_items set status = 'open' where id = v_a;

  -- A re-run keeps the link.
  perform public.save_briefing('{"date":"2000-01-01"}', jsonb_build_array(
    jsonb_build_object('source_key', 'pj:a', 'source', 'monday', 'kind', 'do', 'title', 'Task A (renamed)', 'urgency', 2)));
  perform public.save_work_tags(jsonb_build_array(jsonb_build_object('source_key', 'pj:a', 'suggested_project_id', v_p2)));
  select count(*) into n from public.worklist_items
   where id = v_a and project_id = v_p1 and suggested_project_id is null;
  v_out := v_out || ('re-run keeps the link, no suggestion on a linked task: ' || (n = 1))::text;

  update public.worklist_items set project_id = null where id = v_a;
  select count(*) into n from public.project_activity where item_id = v_a and project_id = v_p1;
  v_out := v_out || ('activity on the project: ' || coalesce((select string_agg(kind, ',') from public.project_activity where item_id = v_a), '-'));
  v_out := v_out || ('linked, done, reopened, unlinked logged (4 rows): ' || (n = 4 and
    (select count(distinct kind) from public.project_activity where item_id = v_a) = 4))::text;

  -- ── Dismissing a suggestion sticks ──
  update public.worklist_items set dismissed_project_id = v_p2, suggested_project_id = null where id = v_b;
  perform public.save_work_tags(jsonb_build_array(jsonb_build_object('source_key', 'pj:b', 'suggested_project_id', v_p2)));
  select count(*) into n from public.worklist_items where id = v_b and suggested_project_id is null;
  v_out := v_out || ('dismissed suggestion not repeated: ' || (n = 1))::text;
  perform public.save_work_tags(jsonb_build_array(jsonb_build_object('source_key', 'pj:b', 'suggested_project_id', v_p1)));
  select count(*) into n from public.worklist_items where id = v_b and suggested_project_id = v_p1 and dismissed_project_id = v_p2;
  v_out := v_out || ('a different project can still be suggested: ' || (n = 1))::text;

  -- ── The run resolving a linked task logs it as the run's ──
  update public.worklist_items set project_id = v_p2 where id = v_c;
  perform public.save_briefing('{"date":"2000-01-01"}', '[]', array['pj:c']);
  select count(*) into n from public.project_activity
   where item_id = v_c and kind = 'done' and project_id = v_p2 and detail like 'Closed by the morning run%';
  v_out := v_out || ('run-resolved linked task logged as done by the run: ' || (n = 1))::text;

  -- ── Only the trigger writes the log ──
  begin
    insert into public.project_activity (project_id, item_id, kind, title) values (v_p1, v_a, 'note', 'x');
    v_out := v_out || 'direct insert into project_activity refused: false'::text;
  exception when insufficient_privilege then
    v_out := v_out || 'direct insert into project_activity refused: true'::text;
  end;

  -- Linking is not feedback.
  select count(*) into n from public.worklist_feedback where item_id in (v_a, v_b, v_c) and action not in ('done', 'reopened');
  v_out := v_out || ('linking logs no feedback: ' || (n = 0))::text;

  raise exception E'PROJECTS SMOKE TEST (all rolled back):\n%', array_to_string(v_out, E'\n');
end $$;
