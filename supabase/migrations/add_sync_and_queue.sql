-- Salesforce ↔ monday sync + Hope's Queue engine — data model.
-- Spec: Product Spec/project-tools-sync-and-queue-spec.md (§2 config layer, §3 data
-- model, §7 cleanliness). Plan: Product Spec/sync-and-queue-implementation-plan.md §2.
--
-- Run manually in the SQL Editor (house convention). Re-runnable: every create is
-- IF NOT EXISTS / OR REPLACE and every seed is ON CONFLICT DO NOTHING, so a re-run
-- never clobbers mapping rows Hope has edited.
--
-- ── TARGET SCHEMA ────────────────────────────────────────────────────────────────
-- Production: leave as `public`. For the sandbox engine (instrata-sync-engine-staging)
-- run the file a second time with BOTH lines below changed to `sync_sandbox`, then
-- point that schema's config_boards.presales row at the board copy. The shared pieces
-- (profiles flag, helper + trigger functions, the sync_engine role) live in `public`
-- and are idempotent, so running twice is safe.
create schema if not exists public;
select set_config('search_path', 'public, extensions', false);
--
-- House-style notes:
--   * Enums are text + CHECK, as elsewhere.
--   * Trigger functions are schema-agnostic (they write to TG_TABLE_SCHEMA.event_log)
--     so one definition in `public` serves both schemas.
--   * The engine connects as the least-privilege login role `sync_engine` over a
--     direct Postgres connection (plan §1.2). It gets explicit `to sync_engine`
--     policies instead of BYPASSRLS. After running this file, set its password once:
--         alter role sync_engine with login password '<generate a long random one>';
--     and build DATABASE_URL from the pooler host with user `sync_engine.<project-ref>`.
--   * App access: admins and ops coordinators (profiles.is_ops_coordinator — Hope) can
--     read everything. Coordinators may edit mapping tables, cleanliness rules,
--     settings and task.status. Board/column/label config is admin-only. Nobody but
--     the engine writes sf_link, event_log, webhook_inbox or the engine-owned task fields.

-- ═════════════════════════════════════════════════════════════════════════════════
-- Shared pieces (always in public)
-- ═════════════════════════════════════════════════════════════════════════════════

-- ── Ops-coordinator capability flag ───────────────────────────────────────────────
alter table public.profiles
  add column if not exists is_ops_coordinator boolean not null default false;

create or replace function public.is_ops_coordinator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_ops_coordinator from public.profiles where id = auth.uid()), false);
$$;

-- Admin OR coordinator: the read gate on every sync/queue table.
create or replace function public.is_sync_viewer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or public.is_ops_coordinator();
$$;

-- Extend the role-escalation guard (fix_profile_role_escalation.sql) so a user can't
-- grant themselves the coordinator flag either. Same exemptions as before: admins,
-- and backend contexts where auth.uid() is null (service role / SQL editor).
create or replace function public.enforce_profile_role_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role is distinct from old.role then
      raise exception 'Only admins can change a profile role'
        using errcode = 'insufficient_privilege';
    end if;
    if new.is_ops_coordinator is distinct from old.is_ops_coordinator then
      raise exception 'Only admins can change the ops coordinator flag'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

-- ── Engine role ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sync_engine') then
    create role sync_engine nologin noinherit;
  end if;
end $$;

-- The engine reads projects (pre ↔ post-sales item link, for open_job) and profiles
-- (engineer names on failure tasks). Read-only.
grant usage on schema public to sync_engine;
grant select on public.projects, public.profiles to sync_engine;
drop policy if exists "sync_engine reads projects" on public.projects;
create policy "sync_engine reads projects" on public.projects
  for select to sync_engine using (true);
drop policy if exists "sync_engine reads profiles" on public.profiles;
create policy "sync_engine reads profiles" on public.profiles
  for select to sync_engine using (true);

-- ── Schema-agnostic trigger functions ────────────────────────────────────────────

-- Every edit to a mapping / config table is an event (spec §3.2) and wakes the
-- engine so it reloads config without waiting for the next sweep.
create or replace function public.sync_audit_config_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  j       jsonb := to_jsonb(coalesce(new, old));
  key     text;
  src     text;
begin
  key := coalesce(j->>'sf_value', j->>'stage', j->>'key', j->>'semantic_key', j->>'board_key', j->>'id');
  if j ? 'label_key' then key := (j->>'semantic_key') || '.' || (j->>'label_key'); end if;
  if j ? 'group_key' then key := (j->>'board_key') || '.' || (j->>'group_key'); end if;

  -- session_user, not current_user: inside a SECURITY DEFINER function current_user
  -- is the owner. The engine logs in directly as sync_engine; PostgREST sessions
  -- log in as `authenticator`.
  src := case
           when session_user = 'sync_engine' then 'engine'
           when auth.uid() is null           then 'admin'   -- SQL editor / service role
           when public.is_admin()            then 'admin'
           else 'hope'
         end;

  execute format(
    'insert into %I.event_log (source, entity_type, entity_id, event_type, field, old_value, new_value, actor)
     values ($1, ''mapping'', $2, ''field_changed'', $3, $4, $5, $6)',
    tg_table_schema)
  using src, tg_table_name || ':' || coalesce(key, '?'), tg_op,
        case when tg_op = 'INSERT' then null else to_jsonb(old) end,
        case when tg_op = 'DELETE' then null else to_jsonb(new) end,
        coalesce(auth.uid()::text, current_user);

  perform pg_notify('sync_config_changed', tg_table_schema);
  return null;
end;
$$;

-- event_log is append-only (spec §3.5): no UPDATE / DELETE, from anyone.
create or replace function public.sync_event_log_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'event_log is append-only' using errcode = 'insufficient_privilege';
end;
$$;

-- A status change on a task from the app or MCP (anyone but the engine) marks it
-- for push to the Hope's Queue board and wakes the engine (plan §6.1). The engine
-- compares status against synced_status to run the close/reopen bookkeeping.
create or replace function public.sync_task_before_update()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if current_user <> 'sync_engine' and new.status is distinct from old.status then
    new.monday_dirty := true;
    perform pg_notify('sync_task_changed', tg_table_schema || ':' || new.id::text);
  end if;
  return new;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════════
-- Per-schema tables (created in the target schema set at the top)
-- ═════════════════════════════════════════════════════════════════════════════════

-- ── §2 Configuration layer — no board/column/group/label id in business logic ────
create table if not exists config_boards (
  board_key        text primary key
                   check (board_key in ('presales', 'postsales', 'programming', 'queue')),
  monday_board_id  bigint,            -- null = not configured yet (writes to it are skipped)
  title            text not null default '',
  updated_at       timestamptz not null default now()
);

create table if not exists config_field_registry (
  semantic_key      text primary key,  -- e.g. 'presales.due_date'
  board_key         text not null references config_boards(board_key),
  monday_column_id  text,              -- null = not configured yet
  column_type       text not null
                    check (column_type in ('date', 'datetime', 'text', 'long_text', 'numbers',
                                           'status', 'dropdown', 'people', 'link', 'button')),
  owner             text not null check (owner in ('salesforce', 'monday', 'shared', 'engine')),
  title             text not null default '',
  updated_at        timestamptz not null default now()
);

create table if not exists config_groups (
  board_key        text not null references config_boards(board_key),
  group_key        text not null,     -- e.g. 'new_requests'
  monday_group_id  text,              -- null = not configured yet
  title            text not null default '',
  updated_at       timestamptz not null default now(),
  primary key (board_key, group_key)
);

-- Labels are referenced by ID, never by text (spec §2.2). Verified every sweep.
create table if not exists config_labels (
  semantic_key     text not null references config_field_registry(semantic_key),
  label_key        text not null,     -- e.g. 'won'
  monday_label_id  integer,           -- null = not configured yet
  title            text not null default '',
  updated_at       timestamptz not null default now(),
  primary key (semantic_key, label_key)
);

-- §7 data-cleanliness rules: a row = "this field counts as an exception when blank,
-- on items outside the board's excluded groups, unless exempt_when matches".
create table if not exists config_cleanliness_rule (
  id            uuid primary key default gen_random_uuid(),
  board_key     text not null references config_boards(board_key),
  semantic_key  text not null references config_field_registry(semantic_key),
  applies_when  jsonb not null default '{}'::jsonb,
  exempt_when   jsonb not null default '{}'::jsonb,  -- e.g. {"presales.programming": ["No"]}
  active        boolean not null default true,
  notes         text not null default '',
  updated_by    uuid default auth.uid(),
  updated_at    timestamptz not null default now(),
  unique (board_key, semantic_key)
);

-- Tunables that change without a deploy: creation stages, excluded groups, report
-- schedules (O-6/O-7), handoff SLA (O-3), debounce. SYNC_MODE is NOT here — it is a
-- Fly secret so nobody can flip the engine live from the UI; the engine reports the
-- mode it is running in through engine_status.
create table if not exists config_settings (
  key          text primary key,
  value        jsonb,
  description  text not null default '',
  updated_by   uuid default auth.uid(),
  updated_at   timestamptz not null default now()
);

-- Written only by the engine: last sweep times, mode, inbox depth. Read by the dashboard.
create table if not exists engine_status (
  name        text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ── §3.2 Mapping tables (Hope maintains via Sync Admin) ──────────────────────────
-- monday_label_id null = known value, not mapped yet → failure task, field untouched.
create table if not exists map_business_unit (
  id               uuid primary key default gen_random_uuid(),
  sf_value         text not null unique,
  monday_label_id  integer,
  active           boolean not null default true,
  notes            text not null default '',
  updated_by       uuid default auth.uid(),
  updated_at       timestamptz not null default now()
);

create table if not exists map_win_pct (
  id               uuid primary key default gen_random_uuid(),
  sf_value         text not null unique,  -- normalized 'N%'. 100% is never mapped (→ Won)
  monday_label_id  integer,
  active           boolean not null default true,
  notes            text not null default '',
  updated_by       uuid default auth.uid(),
  updated_at       timestamptz not null default now()
);

-- sf_value = Opportunity.Sales_Rep__r.Name. The reserved row '(blank)' is what a
-- blank Sales_Rep__c maps to (seeded → House).
create table if not exists map_sales_rep (
  id               uuid primary key default gen_random_uuid(),
  sf_value         text not null unique,
  monday_label_id  integer,
  active           boolean not null default true,
  notes            text not null default '',
  updated_by       uuid default auth.uid(),
  updated_at       timestamptz not null default now()
);

create table if not exists map_stage_action (
  id          uuid primary key default gen_random_uuid(),
  stage       text not null unique,      -- Salesforce StageName
  action      text not null
              check (action in ('none', 'set_status', 'stage_check_delivered', 'stage_check_contract',
                                'won', 'lost', 'declined', 'canceled')),
  params      jsonb not null default '{}'::jsonb,  -- set_status: {"label_key": "rebid"}
  active      boolean not null default true,
  notes       text not null default '',
  updated_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now()
);

-- ── §3.1 Link table ───────────────────────────────────────────────────────────────
create table if not exists sf_link (
  id                  uuid primary key default gen_random_uuid(),
  monday_item_id      bigint not null unique,
  monday_board_key    text not null default 'presales' references config_boards(board_key),
  sf_opportunity_id   text not null,   -- 006…
  sf_line_item_id     text not null unique,  -- 00k… — the primary sync key
  link_state          text not null default 'active'
                      check (link_state in ('active', 'archived', 'conflict')),
  -- Per semantic_key: the last SALESFORCE-side value the sync wrote (normalized),
  -- plus 'sf.stage'. The comparison baseline (spec §4.5) — not the monday value.
  last_synced_values  jsonb not null default '{}'::jsonb,
  -- Same shape, used ONLY while SYNC_MODE = dry_run. Dry run must never advance the
  -- live baseline, or the changes it merely logged would be skipped once live.
  dry_run_synced_values jsonb not null default '{}'::jsonb,
  last_sf_modstamp    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists sf_link_opportunity_idx on sf_link (sf_opportunity_id);

-- ── §3.3 Hope's Queue tasks ──────────────────────────────────────────────────────
create table if not exists task (
  id                  uuid primary key default gen_random_uuid(),
  task_type           text not null
                      check (task_type in ('sync_failure', 'writeback_no_link', 'writeback_quantity',
                                           'stage_check_delivered', 'stage_check_contract',
                                           'won_handoff', 'open_job',
                                           'report_presales_weekly', 'report_pm_weekly', 'report_avss_monthly',
                                           'triage', 'data_cleanliness')),
  dedupe_key          text not null unique,  -- e.g. 'open_job:13092716583'
  title               text not null,
  details             text not null default '',
  source_ref          jsonb not null default '{}'::jsonb,  -- {board_key, monday_item_id, sf_opportunity_id}
  queue_item_id       bigint unique,         -- item on the Hope's Queue board
  status              text not null default 'not_started'
                      check (status in ('not_started', 'in_progress', 'waiting', 'done')),
  synced_status       text,                  -- last status the engine processed / pushed
  due_at              timestamptz,
  group_key           text,                  -- today_overdue / this_week / as_needed / background / done
  count_value         numeric,               -- data_cleanliness singleton's Count
  close_mode          text check (close_mode in ('auto', 'manual')),
  reopen_count        integer not null default 0,
  open_since          timestamptz default now(),
  total_open_seconds  bigint not null default 0,
  monday_dirty        boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  closed_at           timestamptz
);
create index if not exists task_status_idx on task (status, task_type);
create index if not exists task_dirty_idx on task (monday_dirty) where monday_dirty;

-- ── §3.4 Webhook inbox — persist first, process later ────────────────────────────
create table if not exists webhook_inbox (
  id               bigserial primary key,
  source           text not null check (source in ('salesforce', 'monday')),
  payload          jsonb not null,
  dedupe_hash      text not null unique,
  received_at      timestamptz not null default now(),
  status           text not null default 'pending' check (status in ('pending', 'done', 'error')),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  processed_at     timestamptz,
  error_text       text
);
create index if not exists webhook_inbox_pending_idx on webhook_inbox (next_attempt_at) where status = 'pending';

-- ── §3.5 Event log — append-only ─────────────────────────────────────────────────
create table if not exists event_log (
  id              bigserial primary key,
  occurred_at     timestamptz not null default now(),
  source          text not null check (source in ('salesforce', 'monday', 'engine', 'hope', 'admin')),
  entity_type     text not null check (entity_type in ('opportunity', 'line_item', 'monday_item', 'task', 'mapping')),
  entity_id       text not null,
  event_type      text not null
                  check (event_type in ('created', 'field_changed', 'status_changed', 'stage_changed',
                                        'writeback', 'task_opened', 'task_closed', 'task_reopened',
                                        'sync_failure', 'archived', 'notified', 'dry_run_write', 'group_moved')),
  field           text,
  old_value       jsonb,
  new_value       jsonb,
  applied         boolean not null default true,  -- false = observed but deliberately not written
  actor           text,                            -- SF user id, monday user id, auth uid, or 'engine'
  correlation_id  uuid,                            -- one reconcile pass
  details         jsonb
);
create index if not exists event_log_entity_idx on event_log (entity_type, entity_id, occurred_at desc);
create index if not exists event_log_type_idx on event_log (event_type, occurred_at desc);
create index if not exists event_log_correlation_idx on event_log (correlation_id) where correlation_id is not null;

-- ── §3.6 Watermarks ──────────────────────────────────────────────────────────────
create table if not exists watermark (
  name        text primary key,   -- e.g. 'sf_sweep'
  value       timestamptz not null,
  updated_at  timestamptz not null default now()
);

-- ── §7 Daily cleanliness snapshot (semantic_key '*' = board total) ───────────────
create table if not exists cleanliness_snapshot (
  snapshot_date    date not null,
  board_key        text not null references config_boards(board_key),
  semantic_key     text not null,
  exception_count  integer not null,
  primary key (snapshot_date, board_key, semantic_key)
);

-- ── Cutover step 4: daily dry-run diff vs. Zapier ────────────────────────────────
create table if not exists dry_run_report (
  report_date  date primary key,
  summary      jsonb not null,
  created_at   timestamptz not null default now()
);

-- ═════════════════════════════════════════════════════════════════════════════════
-- Triggers
-- ═════════════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['config_boards', 'config_field_registry', 'config_groups', 'config_labels',
                           'config_cleanliness_rule', 'config_settings',
                           'map_business_unit', 'map_win_pct', 'map_sales_rep', 'map_stage_action']
  loop
    execute format('drop trigger if exists sync_audit_config_change on %I', t);
    execute format('create trigger sync_audit_config_change after insert or update or delete on %I
                    for each row execute function public.sync_audit_config_change()', t);
    execute format('drop trigger if exists set_updated_at on %I', t);
    execute format('create trigger set_updated_at before update on %I
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

drop trigger if exists sync_event_log_append_only on event_log;
create trigger sync_event_log_append_only
  before update or delete on event_log
  for each row execute function public.sync_event_log_append_only();

drop trigger if exists sync_task_before_update on task;
create trigger sync_task_before_update
  before update on task
  for each row execute function public.sync_task_before_update();

drop trigger if exists set_updated_at on sf_link;
create trigger set_updated_at before update on sf_link
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════════
-- Grants + RLS
-- ═════════════════════════════════════════════════════════════════════════════════
do $$
declare
  t      text;
  all_t  text[] := array['config_boards', 'config_field_registry', 'config_groups', 'config_labels',
                         'config_cleanliness_rule', 'config_settings', 'engine_status',
                         'map_business_unit', 'map_win_pct', 'map_sales_rep', 'map_stage_action',
                         'sf_link', 'task', 'webhook_inbox', 'event_log', 'watermark',
                         'cleanliness_snapshot', 'dry_run_report'];
  -- coordinator-editable (Sync Admin screens)
  coord_t text[] := array['config_cleanliness_rule', 'config_settings',
                          'map_business_unit', 'map_win_pct', 'map_sales_rep', 'map_stage_action'];
  -- admin-editable (board restructure remaps)
  admin_t text[] := array['config_boards', 'config_field_registry', 'config_groups', 'config_labels'];
  schema_name text := current_schema();
begin
  execute format('grant usage on schema %I to sync_engine', schema_name);

  foreach t in array all_t loop
    execute format('alter table %I enable row level security', t);

    -- Supabase default privileges grant everything to anon/authenticated on new
    -- tables; start from nothing and grant back exactly what's needed.
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);

    execute format('drop policy if exists "sync viewers read" on %I', t);
    execute format('create policy "sync viewers read" on %I for select to authenticated
                    using (public.is_sync_viewer())', t);

    execute format('grant select, insert, update, delete on %I to sync_engine', t);
    execute format('drop policy if exists "sync_engine full access" on %I', t);
    execute format('create policy "sync_engine full access" on %I for all to sync_engine
                    using (true) with check (true)', t);
  end loop;

  foreach t in array coord_t loop
    execute format('grant insert, update, delete on %I to authenticated', t);
    execute format('drop policy if exists "sync viewers write" on %I', t);
    execute format('create policy "sync viewers write" on %I for all to authenticated
                    using (public.is_sync_viewer()) with check (public.is_sync_viewer())', t);
  end loop;

  foreach t in array admin_t loop
    execute format('grant insert, update, delete on %I to authenticated', t);
    execute format('drop policy if exists "admins write" on %I', t);
    execute format('create policy "admins write" on %I for all to authenticated
                    using (public.is_admin()) with check (public.is_admin())', t);
  end loop;

  -- task: app / MCP may change status only; everything else is engine-owned.
  grant update (status) on task to authenticated;
  drop policy if exists "sync viewers update task status" on task;
  create policy "sync viewers update task status" on task for update to authenticated
    using (public.is_sync_viewer()) with check (public.is_sync_viewer());

  -- event_log: append-only for the engine too (the trigger also enforces it).
  revoke update, delete, truncate on event_log from sync_engine;

  execute format('grant usage, select on all sequences in schema %I to sync_engine', schema_name);
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════
-- Seeds — label IDs read from the live Pre-Sales board (3477536693) on 2026-10-10.
-- ═════════════════════════════════════════════════════════════════════════════════
insert into config_boards (board_key, monday_board_id, title) values
  ('presales',    3477536693, 'AV Pre-Sales Project Summary'),
  ('postsales',   3523133226, 'AV Post-Sales Project Summary'),
  ('programming', null,       'Programming'),     -- O-2
  ('queue',       null,       'Hope''s Queue')    -- Build Guide §4
on conflict (board_key) do nothing;

insert into config_field_registry (semantic_key, board_key, monday_column_id, column_type, owner, title) values
  ('presales.due_date',          'presales', 'date7',             'datetime',  'salesforce', 'Due Date'),
  ('presales.quote_number',      'presales', 'text8',             'text',      'salesforce', 'Quote Number'),
  ('presales.win_pct',           'presales', 'dropdown__1',       'dropdown',  'salesforce', 'Win Percentage'),
  ('presales.business_unit',     'presales', 'dropdown2',         'dropdown',  'salesforce', 'Business Unit'),
  ('presales.sales_person',      'presales', 'dropdown3',         'dropdown',  'salesforce', 'Sales Person'),
  ('presales.sf_id',             'presales', 'text_mkv2656m',     'text',      'salesforce', 'Salesforce ID'),
  ('presales.project_id',        'presales', 'text_mm2rcnav',     'text',      'monday',     'Project ID'),
  ('presales.status',            'presales', 'status9',           'status',    'shared',     'Status'),
  ('presales.quoted_price',      'presales', 'numbers9',          'numbers',   'monday',     'Quoted Price'),
  ('presales.gm_pct',            'presales', 'numbers__1',        'numbers',   'monday',     'Estimated GM %'),
  ('presales.presales_engineer', 'presales', 'person',            'people',    'monday',     'Pre-Sales Engineer'),
  ('presales.contract_date',     'presales', 'date9',             'date',      'monday',     'Contract Date'),
  ('presales.win_loss_notes',    'presales', null,                'long_text', 'salesforce', 'Win/Loss Notes'),  -- Build Guide §2.1
  ('presales.premiere_protect',  'presales', 'numbers4__1',       'numbers',   'monday',     'Premiere Protect $'),
  ('presales.programming',       'presales', 'dropdown_mkt9zhb9', 'dropdown',  'monday',     'Programming')
on conflict (semantic_key) do nothing;

insert into config_groups (board_key, group_key, monday_group_id, title) values
  ('presales', 'new_requests',    'new_group12986', 'New Requests'),
  ('presales', 'follow_up',       'new_group66048', 'Follow Up'),
  ('presales', 'won',             'new_group52602', 'Won'),
  ('presales', 'lost',            'new_group64129', 'Lost'),
  ('presales', 'declined_to_bid', 'new_group',      'Declined to Bid'),
  ('presales', 'pre_engineering', null,             'Pre-Engineering'),  -- Build Guide §2.2
  ('queue', 'today_overdue', null, 'Today / Overdue'),
  ('queue', 'this_week',     null, 'This Week'),
  ('queue', 'as_needed',     null, 'As Needed'),
  ('queue', 'background',    null, 'Background'),
  ('queue', 'done',          null, 'Done')
on conflict (board_key, group_key) do nothing;

insert into config_labels (semantic_key, label_key, monday_label_id, title) values
  ('presales.status', 'in_progress',      0,  'In Progress'),
  ('presales.status', 'won',              1,  'Won'),
  ('presales.status', 'lost',             2,  'Lost'),
  ('presales.status', 'service_contract', 4,  'Service Contract'),
  ('presales.status', 'not_started',      5,  'Not Started'),
  ('presales.status', 'follow_up',        6,  'Follow Up'),
  ('presales.status', 'declined_to_bid',  7,  'Declined to Bid'),
  ('presales.status', 'rebid',            8,  'Rebid'),
  ('presales.status', 'on_hold',          9,  'ON HOLD'),
  ('presales.status', 'review',           10, 'Review')
on conflict (semantic_key, label_key) do nothing;

insert into config_settings (key, value, description) values
  ('creation_stages', '["Engineering", "Budget", "Rebid", "Delivered to Customer", "Contract In House"]',
   'Salesforce stages at which an AV opportunity first gets a monday item (spec §4.3).'),
  ('preengineering_stages', '["Lead", "Qualified Opportunity"]',
   'Stages that never create an item; linked items at these stages belong in Pre-Engineering (cutover step 3).'),
  ('cleanliness_excluded_groups', '{"presales": ["new_requests", "lost", "declined_to_bid", "pre_engineering"]}',
   'Groups whose items never count as data-cleanliness exceptions (spec §7).'),
  ('writeback_debounce_seconds', '30', 'Per-item debounce before pushing price / GM% to Salesforce (spec §5).'),
  ('report_pm_weekly',       '{"weekday": 4, "due_time": "17:00", "tz": "America/New_York"}', 'Thursday 5 pm ET.'),
  ('report_presales_weekly', 'null', 'Day of week — open item O-6. Generator stays off while null.'),
  ('report_avss_monthly',    'null', 'Which business day — open item O-7. Generator stays off while null.'),
  ('handoff_sla_business_days', 'null', 'Due-date rule for won_handoff / open_job — open item O-3. Null = no due date.')
on conflict (key) do nothing;

insert into map_win_pct (sf_value, monday_label_id, notes) values
  ('0%',  4,    'monday label is "0" until renamed to "0%" (Build Guide §1.1) — same id'),
  ('25%', 1,    ''),
  ('50%', 2,    ''),
  ('75%', 3,    ''),
  ('99%', null, 'Add the "99%" label in monday (Build Guide §1.1), then pick it here')
on conflict (sf_value) do nothing;

insert into map_business_unit (sf_value, monday_label_id, notes) values
  ('Northeast',    4,    'monday: Instrata NE'),
  ('Mid-Atlantic', 3,    'monday: Instrata MA'),
  ('Southeast',    2,    'monday: Instrata SE'),
  ('Southwest',    1,    'monday: Instrata SW'),
  ('Louisiana',    null, 'No monday label — raises a failure task until one is added and mapped')
on conflict (sf_value) do nothing;

-- Sales reps: every active, non-junk monday label maps to itself, plus the two known
-- Salesforce spellings and the reps missing from monday (Build Guide §1.3). Junk
-- labels ("c", "doug", "TON") and the deactivated "Matthew Krone" are deliberately absent.
insert into map_sales_rep (sf_value, monday_label_id, notes) values
  ('(blank)',                 4,  'Blank Sales_Rep__c → House'),
  ('Michelle Bravo',          25, 'Salesforce spelling → Michelle Scheller-Bravo'),
  ('Wm. Paul Nolan',          29, 'Salesforce spelling → Paul Nolan'),
  ('Luke Wood', 1, ''), ('Michael Pomaville', 2, ''), ('Marisa Wooten', 3, ''), ('House', 4, ''),
  ('Tyler Wiand', 5, ''), ('Mitch Keeler', 6, ''), ('Don Lash', 7, ''), ('Beth Remmelsberger', 8, ''),
  ('Greg Baxter', 9, ''), ('Courtney Erb', 11, ''), ('Ryan Ingle', 12, ''), ('Susan Kight', 13, ''),
  ('Mike Wilson', 14, ''), ('Lee Thompson', 15, ''), ('Mike Whalen', 16, ''), ('Ed Long', 17, ''),
  ('Angelo Romeo', 18, ''), ('Tim Orfe', 19, ''), ('Ed Welch', 20, ''), ('Mike Taylor', 21, ''),
  ('Chris Gardiner', 22, ''), ('Mike Wenhart', 23, ''), ('Matt Damico', 24, ''),
  ('Michelle Scheller-Bravo', 25, ''), ('Mike Bragg', 26, ''), ('Tim Cooney', 27, ''),
  ('Jamie Pratt', 28, ''), ('Paul Nolan', 29, ''), ('Frank Snyder', 30, ''), ('Frank Houston', 31, ''),
  ('Doug Gregory', 32, ''), ('Drew Tucker', 33, ''), ('James McKeon', 34, ''), ('Mike Fagan', 35, ''),
  ('Arthur Vanhouten', 36, ''), ('Frank Cavallaro', 37, ''), ('Onofrio DeCesare', 38, ''),
  ('Julian McGilloway', 39, ''), ('Anthony Marmentini', 40, ''), ('Raymond Lines', 41, ''),
  ('Chris Childress', 43, ''), ('Rob Thress', 44, ''), ('Doug Terry', 46, ''), ('Mike Munoz', 47, ''),
  ('Chris Morris', 48, ''), ('John Seitz', 49, ''), ('Jon Miller', 50, ''), ('Garrett Brown', 51, ''),
  ('Dionel Zapata', 52, ''), ('Bryan Houston', 53, ''), ('Joel Eller', 55, ''), ('Rob Gerlock', 56, ''),
  ('Mark Lawing', 57, ''), ('Paul Steudler', 58, ''), ('RB Dawson', 59, ''), ('Robi Hullner', 60, ''),
  ('Max Jaeger', 61, ''), ('Deron Powers', 62, ''), ('Dave Halpin', 63, ''), ('Alan Cherry', 64, ''),
  ('Joe Kirkner', 65, ''), ('Adam Martin', 66, ''),
  ('Johnny Price',    null, 'Add to monday Sales Person, then map'),
  ('Scott Woodlief',  null, 'Add to monday Sales Person, then map'),
  ('Jerry Bates',     null, 'Add to monday Sales Person, then map'),
  ('David Poore',     null, 'Add to monday Sales Person, then map'),
  ('Rithom Success',  null, 'Add to monday Sales Person, then map')
on conflict (sf_value) do nothing;

insert into map_stage_action (stage, action, params, notes) values
  ('Lead',                  'none',                  '{}', 'Pre-engineering — never creates an item'),
  ('Qualified Opportunity', 'none',                  '{}', 'Pre-engineering — never creates an item'),
  ('Engineering',           'none',                  '{}', ''),
  ('Budget',                'none',                  '{}', ''),
  ('Rebid',                 'set_status',            '{"label_key": "rebid"}', ''),
  ('On Hold',               'set_status',            '{"label_key": "on_hold"}', 'Group unchanged'),
  ('Delivered to Customer', 'stage_check_delivered', '{}', 'No write; task if item not in Follow Up'),
  ('Contract In House',     'stage_check_contract',  '{}', 'No write; task if status is not Won'),
  ('Closed Won',            'won',                   '{}', 'Status → Won; never touches Contract Date'),
  ('Closed Lost',           'lost',                  '{}', 'Win/Loss Notes + status Lost in one mutation'),
  ('Declined to Bid',       'declined',              '{}', 'Notes (if any) + status Declined to Bid'),
  ('Canceled',              'canceled',              '{}', 'Priced → notes + Lost; unpriced → notify engineer + archive')
on conflict (stage) do nothing;

insert into watermark (name, value) values ('sf_sweep', now() - interval '1 day')
on conflict (name) do nothing;
