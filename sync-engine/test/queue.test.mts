/**
 * Hope's Queue board: the pure rules, then push / placement / Hope's edits against
 * the real migrations (sync_hopes_queue.sql run twice), real config loader and
 * writeGate, with a fake monday.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from './helpers/pglite.mts';
import { fakeMonday, fakeSalesforce } from './helpers/fakes.mts';
import { loadRuntimeConfig, type RuntimeConfig } from '../src/config/load.ts';
import { createWriteGate } from '../src/writeGate.ts';
import { closeTask, openTask } from '../src/db/store.ts';
import { groupFor, projectFrom, queueItemValues, statusFromLabel, taskTypeLabelKey, type QueueTask } from '../src/queue/plan.ts';
import { handleQueueEvent, syncQueueBoard } from '../src/queue/run.ts';
import type { MondayEvent } from '../src/ingress/parse.ts';

const migration = (f: string) => readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${f}`, import.meta.url)), 'utf8');
const QUEUE = '18436259969';
const G = { today: 'group_mm8a4edz', week: 'group_mm8av6n3', asNeeded: 'group_mm8akjek', background: 'group_mm8aa9q0', done: 'group_mm8a4bf9' };

let db: TestDb;
let cfg: RuntimeConfig;
beforeEach(async () => {
  db = await createTestDb();
  const q = migration('sync_hopes_queue.sql');
  await db.pg.exec(`reset role; ${q} ${q} update config_settings set value = 'true'::jsonb where key = 'queue_push'; set role sync_engine;`);
  cfg = await loadRuntimeConfig(db);
});
afterEach(async () => { await db.close(); });
const rows = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;

// ── Pure ────────────────────────────────────────────────────────────────────
test('Task Type: engine task kinds grouped by what Hope does', () => {
  assert.equal(taskTypeLabelKey('sync_failure', 'sync_failure:unmapped_value:x:presales.sales_person'), 'fix_mapping');
  assert.equal(taskTypeLabelKey('sync_failure', 'sync_failure:unmapped_engineer:123:estimator'), 'fix_mapping');
  assert.equal(taskTypeLabelKey('sync_failure', 'sync_failure:due_date_differs:x:y'), 'review');
  assert.equal(taskTypeLabelKey('sync_failure', 'sync_failure:won_on_intake:1:status'), 'review');
  assert.equal(taskTypeLabelKey('sync_failure', 'sync_failure:assign_failed:1:engineer'), 'sync_problem');
  assert.equal(taskTypeLabelKey('writeback_quantity', 'writeback_quantity:1'), 'sync_problem');
  assert.equal(taskTypeLabelKey('stage_check_contract', 'stage_check_contract:1'), 'stage_check');
  assert.equal(taskTypeLabelKey('open_job', 'open_job:1'), 'won_open_job');
  assert.equal(taskTypeLabelKey('report_pm_weekly', 'report_pm_weekly:2026-W43'), 'report');
});

test('group placement in Eastern time', () => {
  const now = new Date('2026-10-20T15:00:00Z'); // 11:00 ET Tue
  const g = (dueAt: string | null, over: Partial<QueueTask> = {}) => groupFor({ status: 'not_started', taskType: 'sync_failure', dueAt, ...over }, now);
  assert.equal(g(null), 'as_needed');
  assert.equal(g('2026-10-19T12:00:00Z'), 'today_overdue', 'overdue');
  assert.equal(g('2026-10-21T03:30:00Z'), 'today_overdue', '23:30 ET today is still today');
  assert.equal(g('2026-10-21T05:00:00Z'), 'this_week', 'tomorrow 01:00 ET');
  assert.equal(g('2026-10-27T20:00:00Z'), 'this_week', '7 days out');
  assert.equal(g('2026-10-29T15:00:00Z'), 'as_needed');
  assert.equal(g(null, { status: 'done' }), 'done');
  assert.equal(g(null, { taskType: 'data_cleanliness' }), 'background');
});

test('Project only for tasks about one deal; status labels map both ways', () => {
  assert.equal(projectFrom({ title: 'Assign Erik on the Pre-Sales Summary: AVSS Test Opp 5', sourceRef: { monday_item_id: '1' } }), 'AVSS Test Opp 5');
  assert.equal(projectFrom({ title: 'Map Pre-Sales Engineer: Erik', sourceRef: { mapping_table: 'map_estimator' } }), '');
  const labels = { not_started: 5, in_progress: 0, waiting: 3, done: 1 };
  assert.equal(statusFromLabel(labels, 3), 'waiting');
  assert.equal(statusFromLabel(labels, 0), 'in_progress', 'label id 0 is a real label');
  assert.equal(statusFromLabel(labels, 7), null);
  const v = queueItemValues({
    id: 't', taskType: 'sync_failure', dedupeKey: 'sync_failure:won_on_intake:1:status', title: 'Won in Salesforce, still on Triage: Acme',
    details: 'x'.repeat(2500), sourceRef: { board_key: 'triage', monday_item_id: '1', sf_opportunity_id: '006A' },
    status: 'not_started', dueAt: null, countValue: null, reopenCount: 2, openSince: '2026-10-20T15:00:00Z',
  }, labels, { review: 2 }, { mondayItemUrl: (b, i) => `m/${b}/${i}`, opportunityUrl: (id) => `sf/${id}` });
  const w = Object.fromEntries(v.writes.map((x) => [x.semanticKey, x.value]));
  assert.deepEqual(w['queue.task_type'], { type: 'dropdown', labelIds: [2] });
  assert.equal((w['queue.details'] as any).text.length, 2000);
  assert.deepEqual(w['queue.monday_link'], { type: 'link', url: 'm/triage/1', text: 'Open in monday' });
  assert.deepEqual(w['queue.opened'], { type: 'date', date: '2026-10-20' });
  assert.equal((w['queue.project'] as any).text, 'Acme');
});

// ── End to end ──────────────────────────────────────────────────────────────
function harness(mode: 'live' | 'dry_run' = 'live', now = new Date('2026-10-20T15:00:00Z')) {
  const monday = fakeMonday();
  const gate = createWriteGate(mode, monday.client, fakeSalesforce().client);
  const deps = () => ({ db, gate, monday: monday.client, cfg, salesforceLoginUrl: 'https://instrata.my.salesforce.com', now: () => now });
  return { monday, deps };
}
const open = (key: string, extra: Record<string, unknown> = {}) => openTask(db, {
  op: 'open', taskType: 'sync_failure', dedupeKey: key, title: `Problem: ${key}`, details: 'Fix it.',
  sourceRef: { board_key: 'presales', monday_item_id: '777', sf_opportunity_id: '006AAA000000001', ...extra },
}, null);
const ev = (over: Partial<MondayEvent>): MondayEvent => ({
  type: 'update_column_value', boardId: QUEUE, itemId: null, columnId: 'queue_status', userId: '116687250', groupId: null, triggerUuid: 't', value: null, previousValue: null, ...over,
});

test('push: open tasks become items in their group; clean rows are left alone; closing moves to Done', async () => {
  const h = harness();
  await open('sync_failure:unmapped_value:Johnny:presales.sales_person');
  await open('sync_failure:due_date_differs:x:presales.due_date');
  await db.query(`update task set due_at = '2026-10-20T20:00:00Z' where dedupe_key like '%due_date_differs%'`);

  const r = await syncQueueBoard(h.deps());
  assert.deepEqual({ created: r.created, failed: r.failed }, { created: 2, failed: 0 });
  const creates = h.monday.writes.filter((w) => w.op === 'create');
  assert.deepEqual(creates.map((c) => c.args[1]).sort(), [G.asNeeded, G.today].sort());
  const t = (await rows(`select queue_item_id, group_key, monday_dirty from task order by created_at`));
  assert.ok(t.every((x) => x.queue_item_id && !x.monday_dirty));

  h.monday.writes.length = 0;
  assert.deepEqual(await syncQueueBoard(h.deps()), { created: 0, updated: 0, moved: 0, failed: 0 }, 'nothing to do');

  await closeTask(db, 'sync_failure:unmapped_value:Johnny:presales.sales_person', 'auto', null);
  const r2 = await syncQueueBoard(h.deps());
  assert.deepEqual({ updated: r2.updated, moved: r2.moved }, { updated: 1, moved: 1 });
  assert.equal(h.monday.writes.find((w) => w.op === 'move')!.args[1], G.done);
  const change = h.monday.writes.find((w) => w.op === 'change')!.args[2] as Record<string, any>;
  assert.deepEqual(change.queue_status, { index: 1 }, 'Done label');
  assert.ok(change.name.startsWith('Problem:'));
});

test('a task closed before it ever reached the board gets no item; due dates roll into Today', async () => {
  const h = harness();
  await open('sync_failure:av_line_missing:006:00k');
  await closeTask(db, 'sync_failure:av_line_missing:006:00k', 'auto', null);
  await open('sync_failure:prequal_estimate_due:9:due_date');
  await db.query(`update task set due_at = '2026-10-23T20:00:00Z' where dedupe_key like '%prequal%'`);
  await syncQueueBoard(h.deps());
  assert.equal(h.monday.writes.filter((w) => w.op === 'create').length, 1);
  assert.equal(h.monday.writes[0].args[1], G.week);

  // Three days later the same task is due today.
  const later = harness('live', new Date('2026-10-23T13:00:00Z'));
  const r = await syncQueueBoard(later.deps());
  assert.equal(r.moved, 1);
  assert.deepEqual(later.monday.writes.map((w) => [w.op, w.args[1]]), [['move', G.today]]);
});

test("Hope's status edits: In Progress, Done (manual close), back to In Progress (reopen); archive closes", async () => {
  const h = harness();
  await open('sync_failure:won_on_intake:5:status');
  await syncQueueBoard(h.deps());
  const item = (await rows(`select queue_item_id from task`))[0].queue_item_id;

  assert.equal(await handleQueueEvent(h.deps(), ev({ itemId: item, value: { label: { index: 0, text: 'In Progress' } } })), 'status → in_progress');
  assert.equal((await rows(`select status from task`))[0].status, 'in_progress');

  await handleQueueEvent(h.deps(), ev({ itemId: item, value: { label: { index: 1, text: 'Done' } } }));
  let t = (await rows(`select status, close_mode, monday_dirty from task`))[0];
  assert.deepEqual([t.status, t.close_mode, t.monday_dirty], ['done', 'manual', true], 'dirty so the push moves it to Done');

  await handleQueueEvent(h.deps(), ev({ itemId: item, value: { label: { index: 0, text: 'In Progress' } } }));
  t = (await rows(`select status, reopen_count, close_mode from task`))[0];
  assert.deepEqual([t.status, t.reopen_count, t.close_mode], ['in_progress', 1, null]);

  assert.equal(await handleQueueEvent(h.deps(), ev({ itemId: item, type: 'delete_pulse', columnId: null })), 'closed by archive');
  t = (await rows(`select status, close_mode, queue_item_id, monday_dirty from task`))[0];
  assert.deepEqual([t.status, t.close_mode, t.queue_item_id, t.monday_dirty], ['done', 'manual', null, false]);
  h.monday.writes.length = 0;
  await syncQueueBoard(h.deps());
  assert.equal(h.monday.writes.length, 0, 'not recreated');
});

test("Hope's own items are only logged; queue_push off touches nothing; dry run writes nothing", async () => {
  const h = harness();
  assert.equal(await handleQueueEvent(h.deps(), ev({ itemId: '999', value: { label: { index: 1 } } })), 'untracked item: logged');
  assert.equal((await rows(`select count(*)::int n from event_log where source = 'hope'`))[0].n, 1);

  await open('sync_failure:unmapped_stage:006:StageName');
  const dry = harness('dry_run');
  await syncQueueBoard(dry.deps());
  assert.equal(dry.monday.writes.length, 0);
  assert.equal((await rows(`select queue_item_id from task`))[0].queue_item_id, null);

  await db.pg.exec(`reset role; update config_settings set value = 'false'::jsonb where key = 'queue_push'; set role sync_engine;`);
  cfg = await loadRuntimeConfig(db);
  assert.equal((await syncQueueBoard(h.deps())).skipped, 'queue_push is off');
});
