-- Smoke test for add_brain_raw.sql (My Day 2.5). Run in the SQL Editor AFTER the
-- migration. Runs as Seth on a fake day (2000-01-01), then raises an error carrying
-- the results, which rolls EVERYTHING back. Nothing is left behind.
-- Every line should end in "true".
do $$
declare
  v_uid  uuid;
  r      jsonb;
  v_out  text[] := '{}';
  d      date := '2000-01-01';
  n      int;
  s      text;
begin
  select id into v_uid from public.profiles where email = 'seth.powell@instrata.com';
  if v_uid is null then raise exception 'profile not found'; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- ── Log ──
  r := public.set_readme_state(d, 'r1', 'logged', 'GC moved the walkthrough to Friday.', 'email', 'https://example.invalid/1');
  v_out := v_out || ('log: ' || r::text);
  select count(*) into n from public.brain_raw
   where user_id = v_uid and briefing_date = d and readme_id = 'r1' and status = 'new' and source = 'readme'
     and readme_source = 'email' and link = 'https://example.invalid/1';
  v_out := v_out || ('logged line lands in the inbox as new: ' || (n = 1))::text;
  perform public.set_readme_state(d, 'r1', 'logged', 'GC moved the walkthrough to Friday.', 'email', 'https://example.invalid/1');
  select count(*) into n from public.brain_raw where user_id = v_uid and briefing_date = d and readme_id = 'r1';
  v_out := v_out || ('logging twice keeps one inbox row: ' || (n = 1))::text;

  -- ── Hide after log, then undo ──
  perform public.set_readme_state(d, 'r1', 'hidden', 'GC moved the walkthrough to Friday.', 'email', null);
  select state into s from public.worklist_readme_state where user_id = v_uid and briefing_date = d and readme_id = 'r1';
  select count(*) into n from public.brain_raw where user_id = v_uid and briefing_date = d and readme_id = 'r1';
  v_out := v_out || ('hide replaces log and takes the unfiled note back out: ' || (s = 'hidden' and n = 0))::text;
  perform public.set_readme_state(d, 'r1', null, 'GC moved the walkthrough to Friday.');
  select count(*) into n from public.worklist_readme_state where user_id = v_uid and briefing_date = d;
  v_out := v_out || ('undo clears the state: ' || (n = 0))::text;

  -- ── A same-day re-run reuses r2 for a different line ──
  perform public.set_readme_state(d, 'r2', 'logged', 'Line A', 'teams', null);
  perform public.set_readme_state(d, 'r2', 'logged', 'Line B (re-run reused r2)', 'monday', null);
  select count(*) into n from public.brain_raw where user_id = v_uid and briefing_date = d and readme_id = 'r2';
  select readme_text into s from public.worklist_readme_state where user_id = v_uid and briefing_date = d and readme_id = 'r2';
  v_out := v_out || ('reused id: both lines kept in the inbox, state follows the new text: ' || (n = 2 and s = 'Line B (re-run reused r2)'))::text;

  -- ── Filed notes are never pulled back ──
  update public.brain_raw set status = 'filed', filed_at = now()
   where user_id = v_uid and briefing_date = d and readme_id = 'r2' and text = 'Line B (re-run reused r2)';
  perform public.set_readme_state(d, 'r2', null, 'Line B (re-run reused r2)');
  select count(*) into n from public.brain_raw where user_id = v_uid and briefing_date = d and readme_id = 'r2' and status = 'filed';
  v_out := v_out || ('undo leaves a filed note alone: ' || (n = 1))::text;

  -- ── Quick note ──
  insert into public.brain_raw (source, text) values ('note', 'Ask Lee about the Docker host timeline');
  select count(*) into n from public.brain_raw where user_id = v_uid and source = 'note' and text like 'Ask Lee%' and status = 'new';
  v_out := v_out || ('quick note insert (user_id defaults to Seth): ' || (n = 1))::text;

  -- ── Rejections ──
  begin
    perform public.set_readme_state(d, 'r3', 'starred', 'x');
    v_out := v_out || 'unknown state rejected: false'::text;
  exception when raise_exception then
    v_out := v_out || 'unknown state rejected: true'::text;
  end;
  begin
    perform public.set_readme_state(d, 'r3', 'logged', '   ');
    v_out := v_out || 'blank text rejected: false'::text;
  exception when raise_exception then
    v_out := v_out || 'blank text rejected: true'::text;
  end;
  begin
    insert into public.brain_raw (source, text) values ('readme', 'no date or id');
    v_out := v_out || 'readme row without date/id rejected: false'::text;
  exception when check_violation then
    v_out := v_out || 'readme row without date/id rejected: true'::text;
  end;
  begin
    insert into public.brain_raw (user_id, source, text)
    values ((select id from public.profiles where id <> v_uid limit 1), 'note', 'someone else''s note');
    v_out := v_out || 'writing into someone else''s inbox refused: false'::text;
  exception when insufficient_privilege then
    v_out := v_out || 'writing into someone else''s inbox refused: true'::text;
  end;

  raise exception E'BRAIN RAW SMOKE TEST (all rolled back):\n%', array_to_string(v_out, E'\n');
end $$;
