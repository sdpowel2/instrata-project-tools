-- Sync: Win/Loss Notes, Triage decisions, Estimator writeback. 2026-10-15.
-- Run once in the SQL Editor; safe to re-run. Run it BEFORE deploying the engine
-- that reads map_estimator. Needs sync_intake_boards.sql first.
--
-- 1. Win/Loss Notes. A Long Text column created through the API with the FIXED id
--    'win_loss_notes' on every pre-sales board, so a cross-board move keeps the
--    value. Created on the 3 sandbox boards 2026-10-15. The production boards get
--    it at the production rollout (same id), so only sync_sandbox is pointed at it
--    here; the production checklist sets public.
--
-- 2. Bid Decision (Triage board only; Seth 2026-10-15). Status column with the FIXED
--    id 'bid_decision' and labels 1 = Bid, 2 = No-Bid. No-Bid → the engine moves the
--    item to the Pre-Sales Summary's Declined to Bid (R5); Bid → a native monday
--    automation moves it to New Assignment (R6); Bid + an engineer → the engine moves
--    it to the Pre-Sales Summary's New Requests (R7). The column exists on Triage
--    only, so it drops off at the move; the decision is kept in event_log.
--    Sandbox column created 2026-10-15; public gets its column id at the rollout.
--
-- 3. map_estimator: monday Pre-Sales Engineer → Salesforce user, matched by NAME
--    (emails differ; several monday accounts are @kane.com). The engine resolves
--    sf_user_name to an active user in whichever org it talks to. ignore = a person
--    who is never an estimator of record (retired / left / not pre-sales); the
--    engine skips them without a task. A monday user with no row, or a row with no
--    sf_user_name, raises one "map this engineer" task for Hope.
--
-- 4. Settings: estimator_writeback (on/off switch; sandbox on, production off until
--    the rollout) and estimator_rep_email (email the Sales Rep on each assignment).
do $$
declare
  s text;
begin
  if to_regclass('sync_sandbox.config_field_registry') is not null then
    update sync_sandbox.config_field_registry
       set monday_column_id = 'win_loss_notes', updated_at = now()
     where semantic_key = 'presales.win_loss_notes';
  end if;

  foreach s in array array['public', 'sync_sandbox'] loop
    if to_regclass(format('%I.config_boards', s)) is null then
      continue;
    end if;

    -- 2. Bid Decision ---------------------------------------------------------
    execute format($q$
      insert into %I.config_field_registry (semantic_key, board_key, monday_column_id, column_type, owner, title)
      select 'triage.bid_decision', 'triage', %L, 'status', 'monday', 'Bid Decision'
       where exists (select 1 from %I.config_boards where board_key = 'triage')
      on conflict (semantic_key) do update
        set monday_column_id = coalesce(%I.config_field_registry.monday_column_id, excluded.monday_column_id), updated_at = now()
    $q$, s, case when s = 'sync_sandbox' then 'bid_decision' end, s, s);

    execute format($q$
      insert into %I.config_labels (semantic_key, label_key, monday_label_id, title)
      select v.semantic_key, v.label_key, v.monday_label_id, v.title
        from (values ('triage.bid_decision', 'bid', 1, 'Bid'), ('triage.bid_decision', 'no_bid', 2, 'No-Bid'))
               as v(semantic_key, label_key, monday_label_id, title)
       where exists (select 1 from %I.config_field_registry where semantic_key = 'triage.bid_decision')
      on conflict (semantic_key, label_key) do update set monday_label_id = excluded.monday_label_id, title = excluded.title, updated_at = now()
    $q$, s, s);

    -- 3. map_estimator ----------------------------------------------------------
    execute format($q$
      create table if not exists %I.map_estimator (
        id              uuid primary key default gen_random_uuid(),
        monday_user_id  bigint not null unique,
        monday_name     text not null default '',
        sf_user_name    text,                       -- null = known, not mapped yet → task
        ignore          boolean not null default false,
        active          boolean not null default true,
        notes           text not null default '',
        updated_by      uuid default auth.uid(),
        updated_at      timestamptz not null default now()
      )
    $q$, s);

    execute format('drop trigger if exists sync_audit_config_change on %I.map_estimator', s);
    execute format('create trigger sync_audit_config_change after insert or update or delete on %I.map_estimator
                    for each row execute function public.sync_audit_config_change()', s);
    execute format('drop trigger if exists set_updated_at on %I.map_estimator', s);
    execute format('create trigger set_updated_at before update on %I.map_estimator
                    for each row execute function public.set_updated_at()', s);

    -- Same access as the other coordinator-editable map_* tables.
    execute format('alter table %I.map_estimator enable row level security', s);
    execute format('revoke all on %I.map_estimator from anon, authenticated', s);
    execute format('grant select, insert, update, delete on %I.map_estimator to authenticated', s);
    execute format('drop policy if exists "sync viewers read" on %I.map_estimator', s);
    execute format('create policy "sync viewers read" on %I.map_estimator for select to authenticated using (public.is_sync_viewer())', s);
    execute format('drop policy if exists "sync viewers write" on %I.map_estimator', s);
    execute format('create policy "sync viewers write" on %I.map_estimator for all to authenticated
                    using (public.is_sync_viewer()) with check (public.is_sync_viewer())', s);
    execute format('grant select, insert, update, delete on %I.map_estimator to sync_engine', s);
    execute format('drop policy if exists "sync_engine full access" on %I.map_estimator', s);
    execute format('create policy "sync_engine full access" on %I.map_estimator for all to sync_engine using (true) with check (true)', s);

    -- Engineers seen in the production Pre-Sales Engineer column (2026-10-15). Every
    -- one with an active Salesforce user is mapped by name. The ignored four, per Seth:
    -- Mitch Barbato (retired), Dustin Fatherley (left), Chris Garrett (programmer, not
    -- pre-sales), and a monday "Deleted member".
    execute format($q$
      insert into %I.map_estimator (monday_user_id, monday_name, sf_user_name, ignore, notes) values
        (33940238,  'Lee Thompson',         'Lee Thompson',    false, ''),
        (33940282,  'Seth Powell',          'Seth Powell',     false, ''),
        (36489672,  'Johnny Price',         'Johnny Price',    false, ''),
        (57462479,  'Isaac Garner',         'Isaac Garner',    false, ''),
        (55791344,  'Erik Benson',          'Erik Benson',     false, ''),
        (74504734,  'Kelina Bauman',        'Kelina Bauman',   false, ''),
        (36489661,  'Shaun Lee',            'Shaun Lee',       false, ''),
        (54623234,  'Raymond Lines',        'Raymond Lines',   false, ''),
        (55791346,  'Garry Gilchrist',      'Garry Gilchrist', false, ''),
        (96918221,  'Jason Price',          'Jason Price',     false, ''),
        (103878275, 'Tim Giguere',          'Tim Giguere',     false, ''),
        (52972596,  'jerry.bates@kane.com', 'Jerry Bates',     false, 'monday account shows the email, not a name'),
        (109150514, 'Cameron Bell',         'Cameron Bell',    false, ''),
        (45847231,  'James Stuart',         'James Stuart',    false, ''),
        (42060621,  'Chris Dunegan',        'Chris Dunegan',   false, ''),
        (62177307,  'Matt Davis',           'Matt Davis',      false, ''),
        (36489667,  'Mitch Barbato',        null,              true,  'Retired; no Salesforce user'),
        (60158768,  'Dustin Fatherley',     null,              true,  'No longer with Instrata; inactive in Salesforce'),
        (36489666,  'Chris Garrett',        null,              true,  'Programmer, not a pre-sales engineer of record'),
        (36489663,  'Deleted member',       null,              true,  'Deleted monday account')
      on conflict (monday_user_id) do nothing
    $q$, s);

    -- 4. Settings -------------------------------------------------------------
    execute format($q$
      insert into %I.config_settings (key, value, description) values
        ('estimator_writeback', %L::jsonb,
         'true = a Pre-Sales Engineer change in monday writes the AV line''s Estimator in Salesforce.'),
        ('estimator_rep_email', 'true'::jsonb,
         'true = when the sync sets or changes an Estimator, it also emails the opportunity''s Sales Rep (not during the first pass).')
      on conflict (key) do nothing
    $q$, s, case when s = 'sync_sandbox' then 'true' else 'false' end);
  end loop;
end $$;
