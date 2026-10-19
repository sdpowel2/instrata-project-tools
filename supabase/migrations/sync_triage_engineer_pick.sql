-- Sync: Triage engineer pick, 2026-10-19. Run once in the SQL Editor; safe to re-run.
-- Needs sync_triage_and_estimator.sql first.
--
-- Engineers are no longer members of the Pre-Qualification and Triage boards (so
-- they can't grab work before it's triaged), and a people column can only assign
-- board members. So the Triage board's people column is replaced by a single-select
-- DROPDOWN, "Pre-Sales Engineer" (fixed column id 'engineer_pick'), whose labels are
-- engineer names. At R7 (Bid + a pick) the engine moves the item to the Pre-Sales
-- Summary and sets the real Pre-Sales Engineer people column there.
--
-- map_estimator.triage_label_id links a dropdown label to the engineer's monday
-- account (and, through sf_user_name, their Salesforce user). A label with no row
-- holds the item on Triage and raises a "map this engineer" task for Hope.
--
-- Sandbox Triage column created 2026-10-19 (labels 1-12 below); the people
-- columns were removed from the sandbox Triage and Pre-Qualification boards.
-- Production gets the same column (same id and label ids) at the rollout, so only
-- sync_sandbox gets the column id here; the label links are seeded in both.
do $$
declare
  s text;
begin
  foreach s in array array['public', 'sync_sandbox'] loop
    if to_regclass(format('%I.map_estimator', s)) is null then
      continue;
    end if;

    execute format('alter table %I.map_estimator add column if not exists triage_label_id integer', s);
    execute format('create unique index if not exists map_estimator_triage_label_idx on %I.map_estimator (triage_label_id)
                    where triage_label_id is not null', s);

    -- The 12 engineers assigned on the Pre-Sales board in the last 180 days (Seth, 2026-10-19).
    execute format($q$
      update %I.map_estimator m
         set triage_label_id = v.label_id
        from (values (109150514, 1),  -- Cameron Bell
                     (55791344,  2),  -- Erik Benson
                     (55791346,  3),  -- Garry Gilchrist
                     (57462479,  4),  -- Isaac Garner
                     (96918221,  5),  -- Jason Price
                     (52972596,  6),  -- Jerry Bates
                     (36489672,  7),  -- Johnny Price
                     (74504734,  8),  -- Kelina Bauman
                     (33940238,  9),  -- Lee Thompson
                     (33940282,  10), -- Seth Powell
                     (36489661,  11), -- Shaun Lee
                     (103878275, 12)  -- Tim Giguere
             ) as v(monday_user_id, label_id)
       where m.monday_user_id = v.monday_user_id
         and m.triage_label_id is distinct from v.label_id
    $q$, s);

    execute format($q$
      insert into %I.config_field_registry (semantic_key, board_key, monday_column_id, column_type, owner, title)
      select 'triage.engineer_pick', 'triage', %L, 'dropdown', 'monday', 'Pre-Sales Engineer (Triage pick)'
       where exists (select 1 from %I.config_boards where board_key = 'triage')
      on conflict (semantic_key) do update
        set monday_column_id = coalesce(%I.config_field_registry.monday_column_id, excluded.monday_column_id), updated_at = now()
    $q$, s, case when s = 'sync_sandbox' then 'engineer_pick' end, s, s);
  end loop;
end $$;
