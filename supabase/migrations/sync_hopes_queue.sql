-- Sync: Hope's Queue board, 2026-10-20. Run once in the SQL Editor; safe to re-run.
--
-- Boards created through the API in the Pre-Qualification workspace (private;
-- owners Seth + AV Integrations; Hope a member of production):
--   Hope's Queue            18436259969  (public schema)
--   Hope's Queue - Sandbox  18436259977  (sync_sandbox)
-- Same FIXED column ids and label ids on both; group ids differ (monday picks them).
-- The engine owns the board: it creates, updates, places (every minute) and closes
-- items; Hope changes Status only. No monday automations on these boards.
--
-- Task Type labels (Seth 2026-10-19) group the engine's task kinds by what Hope
-- does: Fix Mapping / Review / Sync Problem / Stage Check / Won – Handoff /
-- Won – Open Job / Report / Triage / Data Cleanliness.
--
-- Setting queue_push: false = the engine doesn't touch the board (production stays
-- off until the rollout).
do $$
declare
  s text;
  queue_id bigint;
begin
  foreach s in array array['public', 'sync_sandbox'] loop
    if to_regclass(format('%I.config_boards', s)) is null then
      continue;
    end if;
    queue_id := case when s = 'public' then 18436259969 else 18436259977 end;

    execute format('update %I.config_boards set monday_board_id = %s, title = %L, updated_at = now() where board_key = %L',
                   s, queue_id, case when s = 'public' then 'Hope''s Queue' else 'Hope''s Queue - Sandbox' end, 'queue');

    if s = 'public' then
      execute format($q$
        update %I.config_groups g set monday_group_id = v.gid, updated_at = now()
          from (values ('today_overdue', 'group_mm8a4edz'), ('this_week', 'group_mm8av6n3'), ('as_needed', 'group_mm8akjek'),
                       ('background', 'group_mm8aa9q0'), ('done', 'group_mm8a4bf9')) as v(gkey, gid)
         where g.board_key = 'queue' and g.group_key = v.gkey
      $q$, s);
    else
      execute format($q$
        update %I.config_groups g set monday_group_id = v.gid, updated_at = now()
          from (values ('today_overdue', 'group_mm8azjnm'), ('this_week', 'group_mm8apynx'), ('as_needed', 'group_mm8a1xhx'),
                       ('background', 'group_mm8a5rs0'), ('done', 'group_mm8amk5k')) as v(gkey, gid)
         where g.board_key = 'queue' and g.group_key = v.gkey
      $q$, s);
    end if;

    execute format($q$
      insert into %I.config_field_registry (semantic_key, board_key, monday_column_id, column_type, owner, title) values
        ('queue.status',      'queue', 'queue_status', 'status',    'shared', 'Status'),
        ('queue.task_type',   'queue', 'task_type',    'dropdown',  'engine', 'Task Type'),
        ('queue.due',         'queue', 'due_at',       'datetime',  'engine', 'Due'),
        ('queue.project',     'queue', 'project',      'text',      'engine', 'Project'),
        ('queue.details',     'queue', 'details',      'long_text', 'engine', 'Details'),
        ('queue.monday_link', 'queue', 'monday_link',  'link',      'engine', 'monday item'),
        ('queue.sf_link',     'queue', 'sf_link',      'link',      'engine', 'Salesforce'),
        ('queue.count',       'queue', 'count',        'numbers',   'engine', 'Count'),
        ('queue.opened',      'queue', 'opened',       'date',      'engine', 'Opened'),
        ('queue.reopens',     'queue', 'reopens',      'numbers',   'engine', 'Reopens'),
        ('queue.engine_key',  'queue', 'engine_key',   'text',      'engine', 'Engine Key')
      on conflict (semantic_key) do update
        set monday_column_id = excluded.monday_column_id, column_type = excluded.column_type,
            owner = excluded.owner, title = excluded.title, updated_at = now()
    $q$, s);

    execute format($q$
      insert into %I.config_labels (semantic_key, label_key, monday_label_id, title) values
        ('queue.status', 'not_started', 5, 'Not Started'),
        ('queue.status', 'in_progress', 0, 'In Progress'),
        ('queue.status', 'waiting',     3, 'Waiting on Someone'),
        ('queue.status', 'done',        1, 'Done'),
        ('queue.task_type', 'fix_mapping',      1, 'Fix Mapping'),
        ('queue.task_type', 'review',           2, 'Review'),
        ('queue.task_type', 'sync_problem',     3, 'Sync Problem'),
        ('queue.task_type', 'stage_check',      4, 'Stage Check'),
        ('queue.task_type', 'won_handoff',      5, 'Won – Handoff'),
        ('queue.task_type', 'won_open_job',     6, 'Won – Open Job'),
        ('queue.task_type', 'report',           7, 'Report'),
        ('queue.task_type', 'triage',           8, 'Triage'),
        ('queue.task_type', 'data_cleanliness', 9, 'Data Cleanliness')
      on conflict (semantic_key, label_key) do update set monday_label_id = excluded.monday_label_id, title = excluded.title, updated_at = now()
    $q$, s);

    execute format($q$
      insert into %I.config_settings (key, value, description) values
        ('queue_push', %L::jsonb, 'true = the engine keeps the Hope''s Queue monday board in step with the task table.')
      on conflict (key) do nothing
    $q$, s, case when s = 'sync_sandbox' then 'true' else 'false' end);
  end loop;
end $$;
