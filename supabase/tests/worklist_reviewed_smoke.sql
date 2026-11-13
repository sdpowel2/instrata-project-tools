-- Smoke test for add_worklist_reviewed.sql (My Day 2.1). Run in the SQL Editor
-- AFTER the migration. Runs as Seth on a fake day (2000-01-01), then raises an
-- error carrying the results, which rolls EVERYTHING back. Nothing is left behind.
do $$
declare
  v_uid   uuid;
  r       jsonb;
  v_out   text[] := '{}';
  v_drop  uuid;
  v_item  uuid;
  v_item2 uuid;
  n       int;
begin
  select id into v_uid from public.profiles where email = 'seth.powell@instrata.com';
  if v_uid is null then raise exception 'profile not found'; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- A briefing must exist first.
  begin
    perform public.save_reviewed('2000-01-01', '[]');
    v_out := v_out || 'reviewed without briefing rejected: false'::text;
  exception when others then
    v_out := v_out || ('reviewed without briefing rejected: true (' || sqlerrm || ')');
  end;

  perform public.save_briefing('{"date":"2000-01-01"}',
    '[{"source_key":"test:on-list","source":"email","kind":"respond","title":"On the list","urgency":2}]');

  -- Three rows, one duplicate key: expect 2 saved, 1 skipped.
  r := public.save_reviewed('2000-01-01', '[
    {"source_key":"test:on-list","source":"email","title":"On the list","outcome":"respond","reason":"asks you","reason_group":"Direct ask"},
    {"source_key":"test:dropped","source":"email","title":"Dropped one","from_label":"Vendor","outcome":"dropped","reason":"looked like marketing","reason_group":"Newsletters / marketing"},
    {"source_key":"test:dropped","source":"email","title":"Dropped dup","outcome":"dropped","reason":"dup","reason_group":"Newsletters / marketing"}
  ]');
  v_out := v_out || ('save 1: ' || r::text);
  v_out := v_out || ('saved 2, skipped 1: ' || ((r->>'saved')::int = 2 and (r->>'skipped')::int = 1));

  -- Surface the dropped one as a Respond at urgency 1.
  select id into v_drop from public.worklist_reviewed where source_key = 'test:dropped';
  v_item := public.surface_reviewed(v_drop, 'respond', 1::smallint);
  select count(*) into n from public.worklist_items
   where id = v_item and kind = 'respond' and status = 'open' and user_urgency = 1 and source_key = 'test:dropped';
  v_out := v_out || ('surfaced item created, override 1: ' || (n = 1));
  select count(*) into n from public.worklist_reviewed where id = v_drop and item_id = v_item and surfaced_at is not null;
  v_out := v_out || ('reviewed row linked + stamped: ' || (n = 1));
  select count(*) into n from public.worklist_feedback where item_id = v_item and action = 'surfaced'
     and from_value = 'dropped: Newsletters / marketing' and to_value = 'respond';
  v_out := v_out || ('one surfaced feedback row: ' || (n = 1));

  -- Surfacing again returns the same item and doesn't log twice.
  v_item2 := public.surface_reviewed(v_drop, 'respond', 1::smallint);
  select count(*) into n from public.worklist_feedback where item_id = v_item and action = 'surfaced';
  v_out := v_out || ('second surface: same item, still one feedback row: ' || (v_item2 = v_item and n = 1));

  -- Same-day re-run: the surfaced row is kept, the other replaced.
  r := public.save_reviewed('2000-01-01', '[
    {"source_key":"test:new","source":"teams","title":"New today","outcome":"set_aside","reason":"social","reason_group":"Social chats"}
  ]');
  v_out := v_out || ('save 2: ' || r::text);
  select count(*) into n from public.worklist_reviewed r2
    join public.worklist_briefings b on b.id = r2.briefing_id
   where b.briefing_date = '2000-01-01';
  v_out := v_out || ('after re-run: surfaced kept + 1 new = 2 rows: ' || (n = 2));

  -- Bad kind is rejected.
  begin
    perform public.surface_reviewed(v_drop, 'question', 2::smallint);
    v_out := v_out || 'kind "question" rejected: false';
  exception when others then
    v_out := v_out || 'kind "question" rejected: true';
  end;

  raise exception E'REVIEWED SMOKE TEST (all rolled back):\n%', array_to_string(v_out, E'\n');
end $$;
