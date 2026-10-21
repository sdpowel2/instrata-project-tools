/**
 * Keeps the Hope's Queue monday board in step with the task table (spec §6,
 * plan B2), and applies Hope's status edits made on the board.
 *
 *   - Every minute: create items for open tasks that have none, push tasks marked
 *     monday_dirty, and move items whose group changed (due dates roll into
 *     Today / Overdue as time passes). Closed tasks that never had an item get none.
 *   - Hope's Status edit → task.status (Done = manual close; leaving Done = manual
 *     reopen). Archiving / deleting an open item counts as Hope closing it.
 * Items Hope adds by hand have no task and are only logged.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.ts';
import { appendEvents, closeTask } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import type { MondayClient } from '../monday/client.ts';
import { encodeColumnValues, readStatusLabelId } from '../monday/encode.ts';
import type { MondayEvent } from '../ingress/parse.ts';
import { isMondayRemoval } from '../ingress/parse.ts';
import { lightningBase } from '../report/run.ts';
import type { WriteGate } from '../writeGate.ts';
import { errMessage, log } from '../log.ts';
import { groupFor, queueItemValues, statusFromLabel, type QueueGroup, type QueueTask, type TaskStatus } from './plan.ts';

export interface QueueDeps {
  db: Db;
  gate: WriteGate;
  monday: MondayClient;
  cfg: RuntimeConfig;
  salesforceLoginUrl: string;
  now?: () => Date;
}

const GROUPS: QueueGroup[] = ['today_overdue', 'this_week', 'as_needed', 'job_opening', 'background', 'done'];

function labelsFor(cfg: RuntimeConfig, semanticKey: string): Record<string, number | null> {
  const prefix = `${semanticKey}.`;
  return Object.fromEntries(Object.entries(cfg.planner.labels).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
}

let slugCache: string | null = null;
async function accountSlug(monday: MondayClient): Promise<string | null> {
  if (slugCache) return slugCache;
  const r = await monday.query<{ account: { slug: string } | null }>('query { account { slug } }').catch(() => null);
  slugCache = r?.account?.slug ?? null;
  return slugCache;
}

interface TaskRow {
  id: string;
  task_type: string;
  dedupe_key: string;
  title: string;
  details: string;
  source_ref: QueueTask['sourceRef'];
  status: TaskStatus;
  synced_status: TaskStatus | null;
  due_at: Date | null;
  count_value: string | null;
  reopen_count: number;
  open_since: Date | null;
  queue_item_id: string | null;
  group_key: string | null;
  monday_dirty: boolean;
  /** Text, not a Date: a Date drops Postgres's microseconds and the settle check never matches. */
  updated_at: string;
}

const toQueueTask = (r: TaskRow): QueueTask => ({
  id: r.id, taskType: r.task_type, dedupeKey: r.dedupe_key, title: r.title, details: r.details, sourceRef: r.source_ref ?? {},
  status: r.status, dueAt: r.due_at ? r.due_at.toISOString() : null, countValue: r.count_value === null ? null : Number(r.count_value),
  reopenCount: r.reopen_count, openSince: r.open_since ? r.open_since.toISOString() : null,
});

export interface QueueSyncResult {
  skipped?: string;
  created: number;
  archived: number;
  updated: number;
  moved: number;
  failed: number;
}

export async function syncQueueBoard(deps: QueueDeps): Promise<QueueSyncResult> {
  const { cfg } = deps;
  const out: QueueSyncResult = { created: 0, archived: 0, updated: 0, moved: 0, failed: 0 };
  if (cfg.settings.queue_push !== true) return { ...out, skipped: 'queue_push is off' };
  const boardId = cfg.boards.queue;
  if (!boardId) return { ...out, skipped: 'no queue board configured' };
  const groupIds = Object.fromEntries(GROUPS.map((g) => [g, cfg.planner.groups[`queue.${g}`] ?? null])) as Record<QueueGroup, string | null>;
  const statusLabels = labelsFor(cfg, 'queue.status');
  const typeLabels = labelsFor(cfg, 'queue.task_type');
  const columnId = (k: string) => cfg.planner.columns[k]?.columnId;
  const slug = await accountSlug(deps.monday);
  const links = {
    mondayItemUrl: (boardKey: string, itemId: string) => {
      const b = cfg.boards[boardKey];
      return slug && b ? `https://${slug}.monday.com/boards/${b}/pulses/${itemId}` : null;
    },
    opportunityUrl: (id: string) => `${lightningBase(deps.salesforceLoginUrl).replace(/\/$/, '')}/lightning/r/Opportunity/${id}/view`,
  };
  const now = deps.now?.() ?? new Date();
  const live = deps.gate.mode === 'live';

  const { rows } = await deps.db.query<TaskRow>(
    `select id, task_type, dedupe_key, title, details, source_ref, status, synced_status, due_at, count_value, reopen_count, open_since,
            queue_item_id::text, group_key, monday_dirty, updated_at::text as updated_at
       from task
      where monday_dirty or status <> 'done' or (queue_item_id is not null and group_key is distinct from 'done')
      order by created_at`);

  for (const r of rows) {
    // A status set in Project Tools (the app may only change status): same meaning
    // as Hope's edit on monday — Done is a manual close, leaving Done a reopen.
    if (live && r.synced_status !== null && r.status !== r.synced_status) await applyAppStatus(deps.db, r);
    const t = toQueueTask(r);
    const want = groupFor(t, now);
    const gid = groupIds[want];
    if (!gid) continue; // group not configured
    try {
      const gate = deps.gate.fork();
      // Leave the row dirty if it changed while we were pushing (compare updated_at).
      const settle = (itemId: string | null) => deps.db.query(
        `update task set queue_item_id = $2::bigint, group_key = $3, synced_status = status,
                monday_dirty = case when updated_at = $4::timestamptz then false else true end
          where id = $1`, [r.id, itemId, want, r.updated_at]);

      if (!r.queue_item_id) {
        if (t.status === 'done') {
          if (live) await settle(null); // closed before it ever reached the board: no item
          continue;
        }
        const v = queueItemValues(t, statusLabels, typeLabels, links);
        const id = await gate.monday.createItem(boardId, gid, v.name, encodeColumnValues(v.writes, columnId));
        if (live && id) await settle(id);
        out.created++;
        continue;
      }

      // Withdrawn (its reason went away, e.g. a deal un-won): off the board, not into Done.
      if (t.status === 'done' && t.sourceRef.withdrawn) {
        await gate.monday.archiveItem(r.queue_item_id);
        if (live) await settle(null);
        out.archived++;
        continue;
      }

      let touched = false;
      if (r.monday_dirty) {
        const v = queueItemValues(t, statusLabels, typeLabels, links);
        await gate.monday.changeColumnValues(boardId, r.queue_item_id, { name: v.name, ...encodeColumnValues(v.writes, columnId) });
        out.updated++;
        touched = true;
      }
      if (r.group_key !== want) {
        await gate.monday.moveItemToGroup(r.queue_item_id, gid);
        out.moved++;
        touched = true;
      }
      if (live && touched) await settle(r.queue_item_id);
    } catch (e) {
      out.failed++;
      log.warn('queue push failed', { taskId: r.id, dedupeKey: r.dedupe_key, error: errMessage(e) });
    }
  }
  return out;
}

async function applyAppStatus(db: Db, r: TaskRow): Promise<void> {
  if (r.status === 'done') {
    await db.query(
      `update task set close_mode = 'manual', closed_at = now(), open_since = null,
              total_open_seconds = total_open_seconds + greatest(0, extract(epoch from now() - coalesce(open_since, now())))::bigint
        where id = $1`, [r.id]);
  } else if (r.synced_status === 'done') {
    await db.query(`update task set close_mode = null, closed_at = null, open_since = now(), reopen_count = reopen_count + 1 where id = $1`, [r.id]);
    r.reopen_count += 1;
    r.open_since = new Date();
  }
  await appendEvents(db, [{
    source: 'hope', entity_type: 'task', entity_id: r.id, event_type: r.status === 'done' ? 'task_closed' : r.synced_status === 'done' ? 'task_reopened' : 'status_changed',
    old_value: r.synced_status, new_value: r.status, details: { dedupe_key: r.dedupe_key, via: 'project_tools' },
  }], null);
}

/** A monday event on the Hope's Queue board (not the engine's own echo). */
export async function handleQueueEvent(deps: QueueDeps, ev: MondayEvent): Promise<string> {
  if (!ev.itemId) return 'no item';
  const { rows } = await deps.db.query<{ id: string; dedupe_key: string; status: TaskStatus }>(
    'select id, dedupe_key, status from task where queue_item_id = $1::bigint', [ev.itemId]);
  const task = rows[0];
  const correlationId = randomUUID();

  if (isMondayRemoval(ev)) {
    if (!task) return 'removal of an untracked item';
    await deps.db.tx(async (q) => {
      // Hope archived it: an open task counts as closed by her; either way don't recreate it.
      if (task.status !== 'done') await closeTask(q, task.dedupe_key, 'manual', correlationId);
      await q.query('update task set queue_item_id = null, group_key = $2, monday_dirty = false where id = $1', [task.id, 'done']);
    });
    return task.status === 'done' ? 'done item archived' : 'closed by archive';
  }

  const statusCol = deps.cfg.planner.columns['queue.status']?.columnId;
  if (!ev.columnId || ev.columnId !== statusCol) return 'not the status column';
  const raw = ev.value as { label?: { index?: number } } | null;
  const labelId = typeof raw?.label?.index === 'number' ? raw.label.index : readStatusLabelId(JSON.stringify(raw ?? null));
  const status = statusFromLabel(Object.fromEntries(Object.entries(deps.cfg.planner.labels)
    .filter(([k]) => k.startsWith('queue.status.')).map(([k, v]) => [k.slice('queue.status.'.length), v])), labelId);

  if (!task) {
    // One of Hope's own items: logged for the record, nothing else.
    await appendEvents(deps.db, [{ source: 'hope', entity_type: 'monday_item', entity_id: ev.itemId, event_type: 'status_changed', field: 'queue.status', old_value: ev.previousValue, new_value: ev.value, actor: ev.userId }], correlationId);
    return 'untracked item: logged';
  }
  if (!status || status === task.status) return 'no change';

  await deps.db.tx(async (q) => {
    if (status === 'done') {
      await closeTask(q, task.dedupe_key, 'manual', correlationId);
    } else if (task.status === 'done') {
      await q.query(
        `update task set status = $2, synced_status = $2, close_mode = null, closed_at = null, open_since = now(),
                reopen_count = reopen_count + 1, monday_dirty = true
          where id = $1`, [task.id, status]);
      await appendEvents(q, [{ source: 'hope', entity_type: 'task', entity_id: task.id, event_type: 'task_reopened', actor: ev.userId, details: { dedupe_key: task.dedupe_key, status, via: 'monday' } }], correlationId);
    } else {
      await q.query('update task set status = $2, synced_status = $2 where id = $1', [task.id, status]);
      await appendEvents(q, [{ source: 'hope', entity_type: 'task', entity_id: task.id, event_type: 'status_changed', old_value: task.status, new_value: status, actor: ev.userId, details: { dedupe_key: task.dedupe_key, via: 'monday' } }], correlationId);
    }
  });
  return `status → ${status}`;
}
