-- Sync intake boards, 2026-10-14. Run once in the SQL Editor; safe to re-run.
-- Applies to every schema that has the sync tables (public and sync_sandbox).
--
-- New intake flow (Seth + Lee, "SF to Monday Flow"): new AV opportunities start on
-- two new boards before the Pre-Sales Summary.
--   Pre-Qualification  Lead / Qualified Opportunity (one group per stage)
--   Triage             Engineering or later (Triage → Bid/No-Bid → New Assignment)
-- Both boards were duplicated from the Pre-Sales board, so column ids and label ids
-- are identical (config_field_registry / config_labels need no change). Group ids
-- are REUSED with different meanings, so groups are configured per board.
--
-- Settings:
--   prequal_stages  stages that create on / belong to Pre-Qualification
--   create_items    false = the engine creates nothing (everything else still syncs).
--                   Replaces emptying creation_stages as the off switch: sandbox starts
--                   OFF here and creation_stages gets its full list back.
do $$
declare
  s text;
  prequal_id bigint;
  triage_id bigint;
begin
  foreach s in array array['public', 'sync_sandbox'] loop
    if to_regclass(format('%I.config_boards', s)) is null then
      continue;
    end if;

    if s = 'public' then
      prequal_id := 18435527184; triage_id := 18435527543;
    else
      prequal_id := 18435527458; triage_id := 18435527768;
    end if;

    execute format('alter table %I.config_boards drop constraint if exists config_boards_board_key_check', s);
    execute format($q$alter table %I.config_boards add constraint config_boards_board_key_check
      check (board_key in ('presales', 'postsales', 'programming', 'queue', 'prequal', 'triage'))$q$, s);

    execute format($q$
      insert into %I.config_boards (board_key, monday_board_id, title) values
        ('prequal', %s, 'Pre-Qualification'),
        ('triage',  %s, 'Triage')
      on conflict (board_key) do update set monday_board_id = excluded.monday_board_id, title = excluded.title, updated_at = now()
    $q$, s, prequal_id, triage_id);

    execute format($q$
      insert into %I.config_groups (board_key, group_key, monday_group_id, title) values
        ('prequal', 'lead',                  'new_group12986', 'Lead'),
        ('prequal', 'qualified_opportunity', 'new_group66048', 'Qualified Opportunity'),
        ('triage',  'triage',                'new_group12986', 'Triage'),
        ('triage',  'bid_no_bid',            'new_group66048', 'Bid/No-Bid'),
        ('triage',  'new_assignment',        'group_mm84ys96', 'New Assignment')
      on conflict (board_key, group_key) do update set monday_group_id = excluded.monday_group_id, title = excluded.title, updated_at = now()
    $q$, s);

    execute format($q$
      insert into %I.config_settings (key, value, description) values
        ('prequal_stages', '["Lead", "Qualified Opportunity"]',
         'Pre-engineering stages: new AV opportunities at these stages are created on Pre-Qualification.')
      on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = now()
    $q$, s);

    -- Off switch. Sandbox starts OFF (turned on for the intake test); production ON.
    execute format($q$
      insert into %I.config_settings (key, value, description) values
        ('create_items', %L, 'false = the sync creates no monday items; field sync, moves and writeback still run.')
      on conflict (key) do nothing
    $q$, s, case when s = 'public' then 'true' else 'false' end);

    -- creation_stages is a stage list again, not the off switch (sandbox had it emptied 2026-10-14).
    execute format($q$
      update %I.config_settings
         set value = '["Engineering", "Budget", "Rebid", "Delivered to Customer", "Contract In House"]', updated_at = now()
       where key = 'creation_stages' and value = '[]'::jsonb
    $q$, s);
  end loop;
end $$;
