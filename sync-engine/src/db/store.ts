/**
 * Engine persistence: sf_link, event_log, task, watermark. Every function takes
 * a Queryable so callers choose the transaction. SQL is exercised against the
 * real migration in test/store.test.mts.
 */
import type { Queryable } from './pool.ts';
import type { SyncMode } from '../env.ts';
import type { Baseline, EventIntent, LinkRow, TaskIntent } from '../reconcile/types.ts';

/** In dry run the engine reads and advances its own baseline, never the live one. */
const baselineColumn = (mode: SyncMode) => (mode === 'live' ? 'last_synced_values' : 'dry_run_synced_values');

// ── sf_link ──────────────────────────────────────────────────────────────────
export async function loadLinksForOpportunities(q: Queryable, opportunityIds: string[], mode: SyncMode): Promise<LinkRow[]> {
  if (opportunityIds.length === 0) return [];
  const { rows } = await q.query<any>(
    `select monday_item_id::text, sf_opportunity_id, sf_line_item_id, link_state, ${baselineColumn(mode)} as baseline
       from sf_link where sf_opportunity_id = any($1::text[])`,
    [opportunityIds],
  );
  return rows.map((r) => ({
    mondayItemId: r.monday_item_id,
    sfOpportunityId: r.sf_opportunity_id,
    sfLineItemId: r.sf_line_item_id,
    linkState: r.link_state,
    baseline: r.baseline ?? {},
  }));
}

export async function insertLink(
  q: Queryable,
  link: { mondayItemId: string; sfOpportunityId: string; sfLineItemId: string; baseline: Baseline },
  mode: SyncMode,
): Promise<void> {
  await q.query(
    `insert into sf_link (monday_item_id, sf_opportunity_id, sf_line_item_id, ${baselineColumn(mode)})
     values ($1::bigint, $2, $3, $4::jsonb)`,
    [link.mondayItemId, link.sfOpportunityId, link.sfLineItemId, JSON.stringify(link.baseline)],
  );
}

export async function updateLink(
  q: Queryable,
  mondayItemId: string,
  baseline: Baseline,
  mode: SyncMode,
  opts: { linkState?: 'active' | 'archived' | 'conflict'; sfModstamp?: string } = {},
): Promise<void> {
  await q.query(
    `update sf_link
        set ${baselineColumn(mode)} = $2::jsonb,
            link_state = coalesce($3, link_state),
            last_sf_modstamp = coalesce($4::timestamptz, last_sf_modstamp)
      where monday_item_id = $1::bigint`,
    [mondayItemId, JSON.stringify(baseline), opts.linkState ?? null, opts.sfModstamp ?? null],
  );
}

// ── event_log ────────────────────────────────────────────────────────────────
export interface EventRow {
  source: 'salesforce' | 'monday' | 'engine' | 'hope' | 'admin';
  entity_type: 'opportunity' | 'line_item' | 'monday_item' | 'task' | 'mapping';
  entity_id: string;
  event_type: string;
  field?: string | null;
  old_value?: unknown;
  new_value?: unknown;
  applied?: boolean;
  actor?: string | null;
  details?: Record<string, unknown> | null;
}

export function eventRowFromIntent(e: EventIntent): EventRow {
  return {
    source: e.source,
    entity_type: e.entityType,
    entity_id: e.entityId,
    event_type: e.eventType,
    field: e.field ?? null,
    old_value: e.oldValue ?? null,
    new_value: e.newValue ?? null,
    applied: e.applied ?? true,
    actor: e.actor ?? null,
    details: e.details ?? null,
  };
}

/** One round trip for any number of events. */
export async function appendEvents(q: Queryable, events: EventRow[], correlationId: string | null): Promise<void> {
  if (events.length === 0) return;
  const payload = events.map((e) => ({
    source: e.source,
    entity_type: e.entity_type,
    entity_id: e.entity_id,
    event_type: e.event_type,
    field: e.field ?? null,
    old_value: e.old_value === undefined ? null : e.old_value,
    new_value: e.new_value === undefined ? null : e.new_value,
    applied: e.applied ?? true,
    actor: e.actor ?? null,
    details: e.details ?? null,
  }));
  await q.query(
    `insert into event_log (source, entity_type, entity_id, event_type, field, old_value, new_value, applied, actor, correlation_id, details)
     select x.source, x.entity_type, x.entity_id, x.event_type, x.field, x.old_value, x.new_value, x.applied, x.actor, $2::uuid, x.details
       from jsonb_to_recordset($1::jsonb) as x(source text, entity_type text, entity_id text, event_type text, field text,
                                               old_value jsonb, new_value jsonb, applied boolean, actor text, details jsonb)`,
    [JSON.stringify(payload), correlationId],
  );
}

// ── task (spec §6.1 open / reopen / close semantics) ────────────────────────
export type TaskOutcome = 'opened' | 'reopened' | 'unchanged' | 'closed';

type OpenIntent = Extract<TaskIntent, { op: 'open' }>;

/**
 * Create the task, or reopen the SAME row if it was closed (reopen_count + 1,
 * open_since = now). An already-open task only has its text refreshed.
 */
export async function openTask(q: Queryable, t: OpenIntent, correlationId: string | null, dueAt: string | null = null): Promise<TaskOutcome> {
  const { rows } = await q.query<{ id: string; status: string; title: string; details: string }>(
    'select id, status, title, details from task where dedupe_key = $1 for update', [t.dedupeKey]);
  const existing = rows[0];

  if (!existing) {
    const ins = await q.query<{ id: string }>(
      `insert into task (task_type, dedupe_key, title, details, source_ref, status, synced_status, due_at, open_since, monday_dirty)
       values ($1, $2, $3, $4, $5::jsonb, 'not_started', 'not_started', $6::timestamptz, now(), true)
       returning id`,
      [t.taskType, t.dedupeKey, t.title, t.details, JSON.stringify(t.sourceRef), dueAt]);
    await appendEvents(q, [taskEvent(ins.rows[0].id, 'task_opened', t.dedupeKey, { task_type: t.taskType })], correlationId);
    return 'opened';
  }

  if (existing.status === 'done') {
    await q.query(
      `update task
          set status = 'not_started', synced_status = 'not_started', reopen_count = reopen_count + 1,
              open_since = now(), closed_at = null, close_mode = null,
              title = $2, details = $3, source_ref = $4::jsonb, monday_dirty = true
        where id = $1`,
      [existing.id, t.title, t.details, JSON.stringify(t.sourceRef)]);
    await appendEvents(q, [taskEvent(existing.id, 'task_reopened', t.dedupeKey, { task_type: t.taskType })], correlationId);
    return 'reopened';
  }

  if (existing.title !== t.title || existing.details !== t.details) {
    await q.query('update task set title = $2, details = $3, monday_dirty = true where id = $1', [existing.id, t.title, t.details]);
  }
  return 'unchanged';
}

/** Close if open; accumulate open time. No-op for a missing or already-closed task. */
export async function closeTask(q: Queryable, dedupeKey: string, mode: 'auto' | 'manual', correlationId: string | null): Promise<TaskOutcome> {
  const { rows } = await q.query<{ id: string }>(
    `update task
        set status = 'done', synced_status = 'done', close_mode = $2, closed_at = now(),
            total_open_seconds = total_open_seconds + greatest(0, extract(epoch from now() - coalesce(open_since, now())))::bigint,
            open_since = null, monday_dirty = true
      where dedupe_key = $1 and status <> 'done'
      returning id`,
    [dedupeKey, mode]);
  if (rows.length === 0) return 'unchanged';
  await appendEvents(q, [taskEvent(rows[0].id, 'task_closed', dedupeKey, { close_mode: mode })], correlationId);
  return 'closed';
}

function taskEvent(taskId: string, eventType: string, dedupeKey: string, details: Record<string, unknown>): EventRow {
  return { source: 'engine', entity_type: 'task', entity_id: taskId, event_type: eventType, actor: 'engine', details: { dedupe_key: dedupeKey, ...details } };
}

// ── watermark + engine_status ───────────────────────────────────────────────
export async function getWatermark(q: Queryable, name: string): Promise<Date | null> {
  const { rows } = await q.query<{ value: string }>('select value from watermark where name = $1', [name]);
  return rows[0] ? new Date(rows[0].value) : null;
}

export async function setWatermark(q: Queryable, name: string, value: Date): Promise<void> {
  await q.query(
    `insert into watermark (name, value, updated_at) values ($1, $2, now())
     on conflict (name) do update set value = excluded.value, updated_at = now()`,
    [name, value.toISOString()]);
}

export async function setEngineStatus(q: Queryable, name: string, value: Record<string, unknown>): Promise<void> {
  await q.query(
    `insert into engine_status (name, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (name) do update set value = excluded.value, updated_at = now()`,
    [name, JSON.stringify(value)]);
}
