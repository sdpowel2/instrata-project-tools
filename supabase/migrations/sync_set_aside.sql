-- Sync: set-aside items, 2026-10-23. Run once in the SQL Editor; safe to re-run.
-- Needs add_sync_and_queue.sql first.
--
-- Some monday items can never agree with a Salesforce record — mostly change orders,
-- which sales doesn't log in Salesforce (they come after Closed Won). The coordinator
-- sets such an item aside from the Coordinator page instead of fixing it (Seth
-- 2026-10-23; the Proposal Type column stays untouched because Lee reports on it).
--
-- A set-aside item is skipped by the engine:
--   - Data Cleanliness: not counted (the count shows how many were set aside)
--   - backfill: never linked, never a problem task; a link it holds is handed to the
--     other item that carries the same Salesforce ID, if there is one
--   - reconcile: no writes to it; writeback: no "isn't linked" task
-- Restore = delete the row. Every change is audited into event_log (mapping events).
-- The reason 'change_order' is the migration list for the future change order board.
do $$
declare
  s text;
begin
  foreach s in array array['public', 'sync_sandbox'] loop
    if to_regclass(format('%I.task', s)) is null then
      continue;
    end if;

    execute format($q$
      create table if not exists %I.item_set_aside (
        id              uuid primary key default gen_random_uuid(),
        monday_item_id  bigint not null unique,
        board_key       text not null default 'presales',
        item_name       text not null default '',
        reason          text not null check (reason in ('change_order', 'other')),
        note            text not null default '',
        set_by          uuid default auth.uid(),
        set_by_name     text not null default '',
        set_at          timestamptz not null default now()
      )
    $q$, s);

    execute format('drop trigger if exists sync_audit_config_change on %I.item_set_aside', s);
    execute format('create trigger sync_audit_config_change after insert or update or delete on %I.item_set_aside
                    for each row execute function public.sync_audit_config_change()', s);

    -- Same access as the coordinator-editable map_* tables.
    execute format('alter table %I.item_set_aside enable row level security', s);
    execute format('revoke all on %I.item_set_aside from anon, authenticated', s);
    execute format('grant select, insert, update, delete on %I.item_set_aside to authenticated', s);
    execute format('drop policy if exists "sync viewers read" on %I.item_set_aside', s);
    execute format('create policy "sync viewers read" on %I.item_set_aside for select to authenticated using (public.is_sync_viewer())', s);
    execute format('drop policy if exists "sync viewers write" on %I.item_set_aside', s);
    execute format('create policy "sync viewers write" on %I.item_set_aside for all to authenticated
                    using (public.is_sync_viewer()) with check (public.is_sync_viewer())', s);
    execute format('grant select, insert, update, delete on %I.item_set_aside to sync_engine', s);
    execute format('drop policy if exists "sync_engine full access" on %I.item_set_aside', s);
    execute format('create policy "sync_engine full access" on %I.item_set_aside for all to sync_engine using (true) with check (true)', s);
  end loop;
end $$;
