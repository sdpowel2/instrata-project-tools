/**
 * Engine persistence: sf_link, event_log, task, watermark. Every function takes
 * a Queryable so callers choose the transaction. SQL is exercised against the
 * real migration in test/store.test.mts.
 */
import type { Queryable } from './pool.ts';
import type { SyncMode } from '../env.ts';
import type { Baseline, EventIntent, LinkRow, TaskIntent, TaskMember } from '../reconcile/types.ts';

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
export type TaskOutcome = 'opened' | 'reopened' | 'unchanged' | 'closed' | 'shrunk';

type OpenIntent = Extract<TaskIntent, { op: 'open' }>;

/**
 * Create the task, or reopen the SAME row if it was closed (reopen_count + 1,
 * open_since = now). An already-open task only has its text refreshed.
 */
/**
 * Grouped tasks (one per missing mapping value) keep their member opportunities
 * in source_ref.members and their base text in source_ref.title_base /
 * details_base; the visible title and details are rendered from those.
 */
export function renderGrouped(base: { title: string; details: string }, members: TaskMember[]): { title: string; details: string } {
  const n = members.length;
  return {
    title: n > 1 ? `${base.title} (${n} opportunities)` : base.title,
    details: n > 0 ? `${base.details}\n\nOpportunities to check:\n${members.map((m) => `• ${m.label}`).join('\n')}` : base.details,
  };
}

interface TaskRow {
  id: string;
  status: string;
  title: string;
  details: string;
  source_ref: Record<string, any>;
}

export async function openTask(q: Queryable, t: OpenIntent, correlationId: string | null, dueAt: string | null = null): Promise<TaskOutcome> {
  const { rows } = await q.query<TaskRow>(
    'select id, status, title, details, source_ref from task where dedupe_key = $1 for update', [t.dedupeKey]);
  const existing = rows[0];
  // "once": never reopen or refresh, except a task withdrawn because its reason went away.
  if (t.once && existing && !(existing.status === 'done' && existing.source_ref?.withdrawn)) return 'unchanged';

  let title = t.title;
  let details = t.details;
  let sourceRef: Record<string, unknown> = t.sourceRef;
  if (t.member) {
    // A reopened task starts a fresh member list; an open one gains this member.
    const members: TaskMember[] = existing && existing.status !== 'done' ? [...(existing.source_ref?.members ?? [])] : [];
    const at = members.findIndex((m) => m.id === t.member!.id);
    if (at >= 0) members[at] = t.member;
    else members.push(t.member);
    sourceRef = { ...t.sourceRef, title_base: t.title, details_base: t.details, members };
    ({ title, details } = renderGrouped(t, members));
  }

  if (!existing) {
    const ins = await q.query<{ id: string }>(
      `insert into task (task_type, dedupe_key, title, details, source_ref, status, synced_status, due_at, open_since, monday_dirty)
       values ($1, $2, $3, $4, $5::jsonb, 'not_started', 'not_started', $6::timestamptz, now(), true)
       returning id`,
      [t.taskType, t.dedupeKey, title, details, JSON.stringify(sourceRef), dueAt]);
    await appendEvents(q, [taskEvent(ins.rows[0].id, 'task_opened', t.dedupeKey, { task_type: t.taskType, ...(t.member ? { member: t.member.id } : {}) })], correlationId);
    return 'opened';
  }

  if (existing.status === 'done') {
    await q.query(
      `update task
          set status = 'not_started', synced_status = 'not_started', reopen_count = reopen_count + 1,
              open_since = now(), closed_at = null, close_mode = null,
              title = $2, details = $3, source_ref = $4::jsonb, monday_dirty = true,
              due_at = coalesce($5::timestamptz, due_at)
        where id = $1`,
      [existing.id, title, details, JSON.stringify(sourceRef), dueAt]);
    await appendEvents(q, [taskEvent(existing.id, 'task_reopened', t.dedupeKey, { task_type: t.taskType, ...(t.member ? { member: t.member.id } : {}) })], correlationId);
    return 'reopened';
  }

  if (existing.title !== title || existing.details !== details) {
    await q.query('update task set title = $2, details = $3, source_ref = $4::jsonb, monday_dirty = true where id = $1',
      [existing.id, title, details, JSON.stringify(sourceRef)]);
  }
  return 'unchanged';
}

/**
 * Close if open; accumulate open time. No-op for a missing or already-closed task.
 * With `memberId`, only that member leaves a grouped task; the task closes when
 * the last one does ('shrunk' = members remain).
 */
export async function closeTask(
  q: Queryable, dedupeKey: string, mode: 'auto' | 'manual', correlationId: string | null, memberId?: string,
  opts: { withdraw?: boolean } = {},
): Promise<TaskOutcome> {
  if (memberId !== undefined) {
    const { rows } = await q.query<TaskRow>(
      'select id, status, title, details, source_ref from task where dedupe_key = $1 for update', [dedupeKey]);
    const row = rows[0];
    if (!row || row.status === 'done') return 'unchanged';
    const before: TaskMember[] = row.source_ref?.members ?? [];
    const members = before.filter((m) => m.id !== memberId);
    if (members.length === before.length) return 'unchanged';
    if (members.length > 0) {
      const base = { title: String(row.source_ref.title_base ?? row.title), details: String(row.source_ref.details_base ?? row.details) };
      const r = renderGrouped(base, members);
      await q.query('update task set title = $2, details = $3, source_ref = $4::jsonb, monday_dirty = true where id = $1',
        [row.id, r.title, r.details, JSON.stringify({ ...row.source_ref, members })]);
      return 'shrunk';
    }
    await q.query('update task set source_ref = $2::jsonb where id = $1', [row.id, JSON.stringify({ ...row.source_ref, members })]);
  }

  const { rows } = await q.query<{ id: string }>(
    `update task
        set status = 'done', synced_status = 'done', close_mode = $2, closed_at = now(),
            total_open_seconds = total_open_seconds + greatest(0, extract(epoch from now() - coalesce(open_since, now())))::bigint,
            open_since = null, monday_dirty = true,
            source_ref = case when $3 then source_ref || '{"withdrawn": true}'::jsonb else source_ref end
      where dedupe_key = $1 and status <> 'done'
      returning id`,
    [dedupeKey, mode, opts.withdraw === true]);
  if (rows.length === 0) return 'unchanged';
  await appendEvents(q, [taskEvent(rows[0].id, 'task_closed', dedupeKey, { close_mode: mode, ...(opts.withdraw ? { withdrawn: true } : {}) })], correlationId);
  return 'closed';
}

function taskEvent(taskId: string, eventType: string, dedupeKey: string, details: Record<string, unknown>): EventRow {
  return { source: 'engine', entity_type: 'task', entity_id: taskId, event_type: eventType, actor: 'engine', details: { dedupe_key: dedupeKey, ...details } };
}

// ── set-aside items (sync_set_aside.sql, Seth 2026-10-23) ──────────────────
/**
 * monday item ids the coordinator set aside (change orders etc.): never linked,
 * written to, counted or flagged. Empty until the migration has run.
 */
export async function setAsideItemIds(q: Queryable): Promise<Set<string>> {
  const { rows: t } = await q.query<{ ok: boolean }>(`select to_regclass('item_set_aside') is not null as ok`);
  if (!t[0]?.ok) return new Set();
  const { rows } = await q.query<{ id: string }>('select monday_item_id::text as id from item_set_aside');
  return new Set(rows.map((r) => r.id));
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
