-- Smoke test for add_triage_rules.sql (My Day 2.2). Run in the SQL Editor
-- AFTER the migration. Runs as Seth on a fake day (2000-01-01), then raises an
-- error carrying the results, which rolls EVERYTHING back. Nothing is left behind.
-- Every line should end in "true".
do $$
declare
  v_uid     uuid;
  r         jsonb;
  v_out     text[] := '{}';
  v_more    uuid;
  v_less    uuid;
  v_lesson  uuid;
  v_ex      uuid;
  n         int;
  ok        boolean;
begin
  select id into v_uid from public.profiles where email = 'seth.powell@instrata.com';
  if v_uid is null then raise exception 'profile not found'; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- ── The matcher ──
  v_out := v_out || ('sender match, any case: ' ||
    public.triage_rule_matches('{"sender":"Dana@GC.com"}', 'email', 'dana@gc.com', 'x', null))::text;
  v_out := v_out || ('domain matches subdomain, not lookalike: ' || (
    public.triage_rule_matches('{"domain":"gc.com"}', 'email', 'a@mail.gc.com', 'x', null)
    and not public.triage_rule_matches('{"domain":"gc.com"}', 'email', 'a@notgc.com', 'x', null)))::text;
  v_out := v_out || ('subject terms: all must appear: ' || (
    public.triage_rule_matches('{"subject_terms":["lobby","DISPLAY"]}', 'email', null, 'RE: Lobby displays', null)
    and not public.triage_rule_matches('{"subject_terms":["lobby","pricing"]}', 'email', null, 'Lobby displays', null)))::text;
  v_out := v_out || ('source narrows, channel contains: ' || (
    public.triage_rule_matches('{"source":"monday","channel":"post-sales"}', 'monday', null, 'x', 'AV Post-Sales Project Summary')
    and not public.triage_rule_matches('{"source":"teams","channel":"post-sales"}', 'monday', null, 'x', 'AV Post-Sales Project Summary')))::text;
  v_out := v_out || ('missing sender never matches: ' ||
    (not public.triage_rule_matches('{"domain":"gc.com"}', 'monday', null, 'x', null)))::text;
  v_out := v_out || ('source alone is not a valid match: ' ||
    (not public.triage_match_valid('{"source":"email"}') and not public.triage_match_valid('{"sender":"a","bogus":1}')))::text;

  -- ── Rules ──
  begin
    insert into public.triage_rules (kind, match, effect, created_from) values ('hard', '{"source":"email"}', 'suppress', 'manual');
    v_out := v_out || 'hard rule without a real match rejected: false'::text;
  exception when check_violation then
    v_out := v_out || 'hard rule without a real match rejected: true'::text;
  end;
  begin
    insert into public.triage_rules (kind, effect, created_from) values ('lesson', 'min_task', 'manual');
    v_out := v_out || 'lesson without a note rejected: false'::text;
  exception when check_violation then
    v_out := v_out || 'lesson without a note rejected: true'::text;
  end;

  insert into public.triage_rules (kind, match, effect, note, created_from)
    values ('hard', '{"domain":"client-smoke.com"}', 'min_task', 'client mail always matters', 'surface_more')
    returning id into v_more;
  insert into public.triage_rules (kind, match, effect, created_from)
    values ('hard', '{"domain":"vendor-smoke.com"}', 'suppress', 'surface_less')
    returning id into v_less;
  -- A conflicting suppress on the client domain: the floor must still win.
  insert into public.triage_rules (kind, match, effect, created_from)
    values ('hard', '{"domain":"client-smoke.com","subject_terms":["pricing"]}', 'suppress', 'manual');
  insert into public.triage_rules (kind, effect, note, created_from)
    values ('lesson', 'min_read_me', 'GC schedule changes matter even when sent FYI', 'manual')
    returning id into v_lesson;

  r := public.match_triage_rules('[
    {"key":"k1","source":"email","sender":"jo@client-smoke.com","title":"Lobby pricing"},
    {"key":"k2","source":"email","sender":"rep@vendor-smoke.com","title":"Promo"},
    {"key":"k3","source":"email","sender":"x@elsewhere.com","title":"Hello"}
  ]');
  v_out := v_out || ('match: ' || r::text);
  v_out := v_out || ('match: 2 matched, floor beats suppress on k1: ' || (
    jsonb_array_length(r->'matched') = 2
    and (select m->>'effect' from jsonb_array_elements(r->'matched') m where m->>'key' = 'k1') = 'min_task'
    and (select m->>'effect' from jsonb_array_elements(r->'matched') m where m->>'key' = 'k2') = 'suppress'))::text;

  -- ── save_reviewed with rules ──
  perform public.save_briefing('{"date":"2000-01-01"}', '[]');
  r := public.save_reviewed('2000-01-01', ('[
    {"source_key":"t:client","source":"email","title":"Lobby question","sender":"Jo@Client-Smoke.com","outcome":"set_aside","reason":"cc only","reason_group":"CC only, no ask"},
    {"source_key":"t:vendor","source":"email","title":"Promo","sender":"rep@vendor-smoke.com","outcome":"read_me","reason":"new product","reason_group":"Worth knowing"},
    {"source_key":"t:gc","source":"email","title":"Schedule moved","sender":"pm@gc-smoke.com","outcome":"read_me","reason":"schedule change","reason_group":"Worth knowing","lesson_ids":["' || v_lesson || '","00000000-0000-0000-0000-000000000000"]},
    {"source_key":"t:carried","source":"email","title":"Old thread","sender":"rep@vendor-smoke.com","outcome":"carried","reason":"still open","reason_group":"Waiting on you"}
  ]')::jsonb);
  v_out := v_out || ('save: ' || r::text);
  v_out := v_out || ('2 violations (client set aside, vendor read me), carried exempt: ' || (
    jsonb_array_length(r->'violations') = 2
    and (select v->>'required' from jsonb_array_elements(r->'violations') v where v->>'source_key' = 't:client') = 'min_task'
    and (select v->>'required' from jsonb_array_elements(r->'violations') v where v->>'source_key' = 't:vendor') = 'suppress'))::text;
  select count(*) into n from public.worklist_reviewed
   where source_key = 't:client' and sender = 'jo@client-smoke.com' and rule_ids @> array[v_more];
  v_out := v_out || ('sender lowercased, hard rule recorded: ' || (n = 1))::text;
  select count(*) into n from public.worklist_reviewed
   where source_key = 't:gc' and rule_ids = array[v_lesson];
  v_out := v_out || ('lesson recorded, unknown lesson id ignored: ' || (n = 1))::text;

  select hits_30d into n from public.triage_rules_with_hits where id = v_less;
  v_out := v_out || ('hits view: vendor suppress fired twice: ' || (n = 2))::text;

  -- ── Preview ──
  r := public.preview_triage_rule('{"domain":"vendor-smoke.com"}', 'suppress', '2000-01-01');
  v_out := v_out || ('preview: ' || (r - 'rows')::text);
  v_out := v_out || ('preview: 2 matched, 1 would change: ' ||
    ((r->>'matched')::int = 2 and (r->>'would_change')::int = 1 and (r->>'matched_30d')::int >= 2))::text;
  begin
    perform public.preview_triage_rule('{"source":"email"}', 'suppress');
    v_out := v_out || 'preview of an empty match rejected: false'::text;
  exception when others then
    v_out := v_out || 'preview of an empty match rejected: true'::text;
  end;

  -- ── A rule's example survives a same-day re-run ──
  select id into v_ex from public.worklist_reviewed where source_key = 't:vendor';
  update public.triage_rules set example_id = v_ex where id = v_less;
  r := public.save_reviewed('2000-01-01', '[]');
  select count(*) into n from public.worklist_reviewed where id = v_ex;
  select example_id = v_ex into ok from public.triage_rules where id = v_less;
  v_out := v_out || ('example row kept on re-run, others replaced: ' || (n = 1 and ok and (r->>'replaced')::int = 3))::text;

  -- ── Inactive rules don't fire ──
  update public.triage_rules set active = false where id = v_more;
  r := public.match_triage_rules('[{"key":"k1","source":"email","sender":"jo@client-smoke.com","title":"Lobby"}]');
  v_out := v_out || ('inactive rule ignored: ' || (jsonb_array_length(r->'matched') = 0))::text;

  raise exception E'TRIAGE RULES SMOKE TEST (all rolled back):\n%', array_to_string(v_out, E'\n');
end $$;
