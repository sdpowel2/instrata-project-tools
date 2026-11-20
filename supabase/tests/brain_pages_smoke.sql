-- Smoke test for add_brain_pages.sql (My Day 2.6). Run in the SQL Editor AFTER the
-- migration. Runs as Seth on a fake day (2000-01-01), briefly as another signed-in
-- user, then raises an error carrying the results, which rolls EVERYTHING back.
-- Nothing is left behind. Every line should end in "true" (or say "skipped").
do $$
declare
  v_uid    uuid;
  v_other  uuid;
  v_proj   uuid;
  v_proj2  uuid;
  r        jsonb;
  v_out    text[] := '{}';
  d        date := '2000-01-01';
  n        int;
  s        text;
  b        boolean;
  v_raw1   uuid;
  v_raw2   uuid;
  v_raw3   uuid;
  v_page   uuid;
  v_gen    uuid;
  v_ver    bigint;
begin
  select id into v_uid from public.profiles where email = 'seth.powell@instrata.com';
  if v_uid is null then raise exception 'profile not found'; end if;
  select id into v_other from public.profiles where id <> v_uid and role <> 'admin' limit 1;
  select id into v_proj  from public.projects order by created_at limit 1;
  select id into v_proj2 from public.projects where id <> v_proj order by created_at limit 1;
  if v_proj is null or v_proj2 is null then raise exception 'need two projects'; end if;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- ── Read-me lines under a scope ──
  r := public.set_readme_state(d, 'r1', 'logged', 'GC moved the walkthrough to Friday.', 'email', null, null, v_proj);
  select count(*) into n from public.brain_raw
   where user_id = v_uid and briefing_date = d and readme_id = 'r1' and scope = 'project' and project_id = v_proj and status = 'new';
  select scope into s from public.worklist_readme_state where user_id = v_uid and briefing_date = d and readme_id = 'r1';
  v_out := v_out || ('logging with a project files it as a project note: ' || (n = 1 and s = 'project'))::text;

  perform public.set_readme_state(d, 'r1', 'logged', 'GC moved the walkthrough to Friday.', 'email', null, 'personal', null);
  select count(*) into n from public.brain_raw
   where user_id = v_uid and briefing_date = d and readme_id = 'r1' and scope = 'personal' and project_id is null;
  v_out := v_out || ('changing it to "just me" moves the unfiled note: ' || (n = 1))::text;

  perform public.set_readme_state(d, 'r2', 'logged', 'Crestron raises pricing Jan 1.', 'email', null, 'project', null);
  select scope into s from public.brain_raw where user_id = v_uid and briefing_date = d and readme_id = 'r2';
  v_out := v_out || ('"project" with no project falls back to personal: ' || (s = 'personal'))::text;

  insert into public.brain_raw (source, text, scope) values ('note', 'Project note with no project', 'project') returning id into v_raw3;
  select scope into s from public.brain_raw where id = v_raw3;
  v_out := v_out || ('quick note: project scope without a project becomes personal: ' || (s = 'personal'))::text;

  -- ── Filing into a personal page ──
  select id into v_raw1 from public.brain_raw where user_id = v_uid and briefing_date = d and readme_id = 'r1';
  r := public.file_brain_notes(jsonb_build_object(
         'scope', 'personal', 'slug', 'smoke-walkthroughs', 'title', 'Walkthroughs', 'kind', 'topic',
         'summary', 'Site walkthrough dates.', 'append', E'### 2000-01-01\n- GC moved the walkthrough to Friday.',
         'tags', jsonb_build_array('Site', 'site')), array[v_raw1]);
  v_page := (r->>'page_id')::uuid;
  select count(*) into n from public.brain_raw where id = v_raw1 and status = 'filed' and page_id = v_page;
  select last_writer into s from public.brain_pages where id = v_page;
  v_out := v_out || ('new page created, note filed, written by claude: ' || ((r->>'created')::boolean and n = 1 and s = 'claude'))::text;

  r := public.file_brain_notes(jsonb_build_object(
         'scope', 'personal', 'slug', 'smoke-walkthroughs', 'append', E'### 2000-01-02\n- Second walkthrough set.'), array[v_raw3]);
  select (body like '%Friday%' and body like '%Second walkthrough%') into b from public.brain_pages where id = v_page;
  select count(*) into n from public.brain_page_versions where page_id = v_page;
  v_out := v_out || ('append keeps the old text and saves a version: ' || (b and n = 1 and not (r->>'created')::boolean))::text;

  begin
    perform public.file_brain_notes(jsonb_build_object('scope', 'personal', 'slug', 'smoke-walkthroughs', 'body', 'wiped'), '{}');
    v_out := v_out || 'body replace refused on a non-index page: false'::text;
  exception when raise_exception then
    v_out := v_out || 'body replace refused on a non-index page: true'::text;
  end;

  -- ── Undo ──
  select id into v_ver from public.brain_page_versions where page_id = v_page order by id limit 1;
  perform public.restore_brain_page(v_ver);
  select (body not like '%Second walkthrough%') into b from public.brain_pages where id = v_page;
  select count(*) into n from public.brain_page_versions where page_id = v_page;
  v_out := v_out || ('restore puts the old body back and is itself undoable: ' || (b and n = 2))::text;

  begin
    update public.brain_pages set scope = 'general' where id = v_page;
    v_out := v_out || 'a page''s scope can''t change: false'::text;
  exception when raise_exception then
    v_out := v_out || 'a page''s scope can''t change: true'::text;
  end;

  -- ── Project notes ──
  perform public.set_readme_state(d, 'r3', 'logged', 'Owner approved the Room 311 display upgrade.', 'teams', 'https://example.invalid/3', null, v_proj);
  select id into v_raw2 from public.brain_raw where user_id = v_uid and briefing_date = d and readme_id = 'r3';
  begin
    perform public.file_brain_notes(jsonb_build_object('scope', 'personal', 'slug', 'smoke-wrong', 'title', 'Wrong'), array[v_raw2]);
    v_out := v_out || 'a project note can''t be filed into a personal page: false'::text;
  exception when raise_exception then
    v_out := v_out || 'a project note can''t be filed into a personal page: true'::text;
  end;

  r := public.file_project_notes(jsonb_build_array(jsonb_build_object(
         'raw_id', v_raw2, 'text', 'Owner approved the Room 311 display upgrade (Teams).')));
  select count(*) into n from public.project_notes
   where project_id = v_proj and raw_id = v_raw2 and source = 'my_day' and noted_by = v_uid and link = 'https://example.invalid/3';
  select status into s from public.brain_raw where id = v_raw2;
  v_out := v_out || ('project note lands in the project''s notes, inbox row filed: ' || (n = 1 and s = 'filed'))::text;

  r := public.set_readme_state(d, 'r3', 'logged', 'Owner approved the Room 311 display upgrade.', 'teams', null, null, v_proj2);
  select count(*) into n from public.project_notes where raw_id = v_raw2 and project_id = v_proj;
  select count(*) + n into n from public.worklist_readme_state
   where user_id = v_uid and briefing_date = d and readme_id = 'r3' and project_id = v_proj;
  v_out := v_out || ('re-pointing a filed line says "filed" and leaves the note and state alone: '
    || ((r->>'filed')::boolean and (r->>'project_id')::uuid = v_proj and n = 2))::text;

  select count(*) into n from public.search_project_wiki(v_proj, 'display upgrade', 10) where kind = 'note';
  v_out := v_out || ('search_project_wiki finds the note: ' || (n >= 1))::text;

  -- ── Search the brain ──
  select count(*) into n from public.search_brain('walkthrough', 10) where kind = 'page' and id = v_page;
  v_out := v_out || ('search_brain finds the page: ' || (n = 1))::text;
  select count(*) into n from public.search_brain('Crestron pricing', 10) where kind = 'inbox';
  v_out := v_out || ('search_brain finds an unfiled note: ' || (n >= 1))::text;

  -- ── Discard ──
  select id into v_raw1 from public.brain_raw where user_id = v_uid and briefing_date = d and readme_id = 'r2';
  r := public.discard_brain_raw(array[v_raw1], 'duplicate of an existing page');
  select status into s from public.brain_raw where id = v_raw1;
  v_out := v_out || ('discard marks the note with a reason: ' || ((r->>'discarded')::int = 1 and s = 'discarded'))::text;

  -- ── General page, and what someone else sees ──
  insert into public.brain_raw (source, text, scope) values ('note', 'Crestron raised pricing on Jan 1.', 'general') returning id into v_raw3;
  r := public.file_brain_notes(jsonb_build_object('scope', 'general', 'slug', 'smoke-crestron', 'title', 'Crestron', 'kind', 'company',
         'append', '- Pricing up Jan 1.'), array[v_raw3]);
  v_gen := (r->>'page_id')::uuid;

  if v_other is null then
    v_out := v_out || 'other-user checks: skipped (no non-admin profile)'::text;
  else
    perform set_config('brain.writer', '', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
    select count(*) into n from public.brain_pages where id in (v_page, v_gen);
    v_out := v_out || ('someone else sees the general page but not the personal one: ' || (n = 1 and exists (select 1 from public.brain_pages where id = v_gen)))::text;
    select count(*) into n from public.brain_raw where user_id = v_uid;
    v_out := v_out || ('someone else can''t read your inbox: ' || (n = 0))::text;
    select count(*) into n from public.project_notes where raw_id = v_raw2;
    v_out := v_out || ('someone else can read the project note: ' || (n = 1))::text;
    update public.project_notes set text = 'tampered' where raw_id = v_raw2;
    get diagnostics n = row_count;
    v_out := v_out || ('someone else can''t edit your project note: ' || (n = 0))::text;
    delete from public.brain_pages where id = v_gen;
    get diagnostics n = row_count;
    v_out := v_out || ('a non-admin can''t delete someone else''s general page: ' || (n = 0))::text;
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  end if;

  raise exception E'BRAIN PAGES SMOKE TEST (all rolled back):\n%', array_to_string(v_out, E'\n');
end $$;
