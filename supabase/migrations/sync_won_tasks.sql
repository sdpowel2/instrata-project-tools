-- Sync: Won tasks for Hope's Queue, 2026-10-20 (Seth; open items O-3, O-5). Both schemas.
-- Run once in the SQL Editor; safe to re-run. Needs sync_hopes_queue.sql first.
--
--   Won – Handoff   due 5 business days after Won, 5 pm ET (handoff_sla_business_days).
--   Won – Open Job  no due date: sits in the new "Job Opening" group on Hope's Queue
--                   while the deal is confirmed-to-win but not contracted (often
--                   months), and closes itself once the deal's Post-Sales item has a
--                   Project Number. The Post-Sales item is found through the Project ID
--                   text column that monday's Won → Post-Sales duplication copies.
-- "Job Opening" groups created 2026-10-20 after As Needed on both boards:
--   Hope's Queue group_mm8a39ns, Hope's Queue - Sandbox group_mm8adk75.
do $$
declare
  s text;
begin
  foreach s in array array['public', 'sync_sandbox'] loop
    if to_regclass(format('%I.config_groups', s)) is null then
      continue;
    end if;

    execute format($q$
      insert into %I.config_groups (board_key, group_key, monday_group_id, title)
      values ('queue', 'job_opening', %L, 'Job Opening')
      on conflict (board_key, group_key) do update set monday_group_id = excluded.monday_group_id, title = excluded.title, updated_at = now()
    $q$, s, case when s = 'public' then 'group_mm8a39ns' else 'group_mm8adk75' end);

    execute format($q$
      update %I.config_settings set value = '5'::jsonb, updated_at = now(),
             description = 'Won – Handoff is due this many business days after Won, 5 pm ET (Seth 2026-10-20).'
       where key = 'handoff_sla_business_days'
    $q$, s);

    execute format($q$
      insert into %I.config_field_registry (semantic_key, board_key, monday_column_id, column_type, owner, title) values
        ('postsales.project_id',     'postsales', 'text_mm2rsn', 'text', 'monday', 'Project ID (copied from Pre-Sales)'),
        ('postsales.project_number', 'postsales', 'text',        'text', 'monday', 'Project Number')
      on conflict (semantic_key) do update
        set monday_column_id = excluded.monday_column_id, title = excluded.title, updated_at = now()
    $q$, s);
  end loop;
end $$;
