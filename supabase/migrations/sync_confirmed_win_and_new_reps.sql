-- Sync mapping update, 2026-10-12. Run once in the SQL Editor; safe to re-run.
-- Applies to every schema that has the sync tables (public and sync_sandbox).
--
--   1. 99% AND 100% Win Likelihood mean "Confirmed to Win" → the sync sets
--      status Won instead of writing a Win % label (Seth, 2026-10-12). No "99%"
--      label is created in monday; the old map_win_pct '99%' row is retired.
--   2. 13 sales reps added to monday's Sales Person dropdown on BOTH pre-sales
--      boards (prod 3477536693 and sandbox 18435017528) — same label ids 67–79
--      on both — mapped here. Found by comparing every rep on an open or
--      last-12-months AV opportunity in production Salesforce with the labels.
--   3. Unmapped-value failure tasks are now one per missing VALUE (grouped
--      across opportunities) instead of one per opportunity. Old-format tasks
--      (keyed by opportunity id) are closed here; the engine re-opens them in
--      the new format on its next reconcile if the value is still unmapped.
do $$
declare s text;
begin
  foreach s in array array['public', 'sync_sandbox'] loop
    if to_regclass(format('%I.map_sales_rep', s)) is null then
      continue;
    end if;

    execute format($q$
      insert into %I.config_settings (key, value, description) values
        ('confirmed_win_pcts', '["99%%", "100%%"]',
         'Win %% values that mean Confirmed to Win: the sync sets status Won and writes no Win %% label.')
      on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = now()
    $q$, s);

    execute format($q$
      update %I.map_win_pct
         set active = false, monday_label_id = null,
             notes = '99%% = Confirmed to Win (status Won) via config_settings.confirmed_win_pcts, not a label'
       where sf_value = '99%%'
    $q$, s);

    execute format($q$
      insert into %I.map_sales_rep (sf_value, monday_label_id, notes) values
        ('Johnny Price', 67, ''), ('Jerry Bates', 68, ''), ('Scott Woodlief', 69, ''),
        ('David Poore', 70, ''), ('Rithom Success', 71, ''), ('Gilbert Romo', 72, ''),
        ('Mike Schaffer', 73, ''), ('Dave Jobe', 74, ''), ('Jim McKenna', 75, ''),
        ('Joe Collis', 76, ''), ('Tanner Duren', 77, ''), ('Paul Norris', 78, ''),
        ('Robert Lewis', 79, '')
      on conflict (sf_value) do update
        set monday_label_id = excluded.monday_label_id, active = true,
            notes = 'Label added 2026-10-12', updated_at = now()
    $q$, s);

    execute format($q$
      update %I.task
         set status = 'done', synced_status = 'done', close_mode = 'auto', closed_at = now(),
             total_open_seconds = total_open_seconds + greatest(0, extract(epoch from now() - coalesce(open_since, now())))::bigint,
             open_since = null
       where dedupe_key ~ '^sync_failure:unmapped_value:006' and status <> 'done'
    $q$, s);

    raise notice 'updated schema %', s;
  end loop;
end $$;
