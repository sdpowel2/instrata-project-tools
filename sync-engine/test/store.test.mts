import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './helpers/pglite.mts';
import {
  appendEvents, closeTask, getWatermark, insertLink, loadLinksForOpportunities, openTask, setWatermark, updateLink,
} from '../src/db/store.ts';

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db.close(); });

const intent = (key: string) => ({
  op: 'open' as const, taskType: 'sync_failure' as const, dedupeKey: key, title: 'Unmapped Business Unit: Louisiana',
  details: 'Add it to map_business_unit', sourceRef: { sf_opportunity_id: '006A', mapping_table: 'map_business_unit' },
});

test('task lifecycle: open → unchanged → auto-close → reopen SAME row → close', async () => {
  const key = 'sync_failure:unmapped_value:006A:presales.business_unit';
  assert.equal(await openTask(db, intent(key), null), 'opened');
  assert.equal(await openTask(db, intent(key), null), 'unchanged');

  const [first] = (await db.query<any>('select id, status, synced_status, monday_dirty from task where dedupe_key = $1', [key])).rows;
  assert.equal(first.status, 'not_started');
  assert.equal(first.synced_status, 'not_started', 'engine-set status is already "processed"');
  assert.equal(first.monday_dirty, true, 'new task needs pushing to the board');

  assert.equal(await closeTask(db, key, 'auto', null), 'closed');
  assert.equal(await closeTask(db, key, 'auto', null), 'unchanged', 'closing twice is a no-op');
  const closed = (await db.query<any>('select status, close_mode, closed_at, open_since, total_open_seconds from task where dedupe_key = $1', [key])).rows[0];
  assert.equal(closed.status, 'done');
  assert.equal(closed.close_mode, 'auto');
  assert.ok(closed.closed_at);
  assert.equal(closed.open_since, null);
  assert.ok(Number(closed.total_open_seconds) >= 0);

  assert.equal(await openTask(db, intent(key), null), 'reopened');
  const reopened = (await db.query<any>('select id, status, reopen_count, close_mode, closed_at, open_since from task where dedupe_key = $1', [key])).rows[0];
  assert.equal(reopened.id, first.id, 'reopen reuses the row — no duplicate');
  assert.equal(reopened.reopen_count, 1);
  assert.equal(reopened.status, 'not_started');
  assert.equal(reopened.close_mode, null);
  assert.equal(reopened.closed_at, null);
  assert.ok(reopened.open_since);

  const events = (await db.query<any>(`select event_type from event_log where entity_type = 'task' and entity_id = $1 order by id`, [first.id])).rows.map((r) => r.event_type);
  assert.deepEqual(events, ['task_opened', 'task_closed', 'task_reopened']);

  assert.equal(await closeTask(db, 'sync_failure:nope', 'auto', null), 'unchanged');
});

test('an open task gets its text refreshed, not duplicated', async () => {
  const key = 'sync_failure:unmapped_value:006B:presales.sales_person';
  await openTask(db, intent(key), null);
  await openTask(db, { ...intent(key), title: 'Unmapped Sales Rep: Johnny Price' }, null);
  const rows = (await db.query<any>('select title from task where dedupe_key = $1', [key])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Unmapped Sales Rep: Johnny Price');
});

test('events: batch insert keeps value types; event_log is append-only for the engine', async () => {
  await appendEvents(db, [
    { source: 'salesforce', entity_type: 'opportunity', entity_id: '006E', event_type: 'field_changed', field: 'presales.quote_number', old_value: null, new_value: 'Q-1', actor: '005U' },
    { source: 'engine', entity_type: 'monday_item', entity_id: '123', event_type: 'status_changed', old_value: 0, new_value: 1, applied: true, details: { label_key: 'won' } },
  ], '11111111-1111-1111-1111-111111111111');
  const rows = (await db.query<any>(`select entity_id, old_value, new_value, correlation_id, details from event_log where entity_id in ('006E','123') order by id`)).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].old_value, null);
  assert.equal(rows[0].new_value, 'Q-1');
  assert.equal(rows[1].new_value, 1);
  assert.deepEqual(rows[1].details, { label_key: 'won' });
  assert.equal(rows[1].correlation_id, '11111111-1111-1111-1111-111111111111');
  await assert.rejects(db.query(`update event_log set actor = 'x' where entity_id = '006E'`));
  await assert.rejects(db.query(`delete from event_log where entity_id = '006E'`));
});

test('links: dry run and live keep separate baselines', async () => {
  await insertLink(db, { mondayItemId: '9001', sfOpportunityId: '006L', sfLineItemId: '00kL', baseline: { 'sf.stage': 'Engineering' } }, 'live');
  await updateLink(db, '9001', { 'sf.stage': 'Engineering', 'presales.quote_number': 'Q-DRY' }, 'dry_run');

  const [liveView] = await loadLinksForOpportunities(db, ['006L'], 'live');
  const [dryView] = await loadLinksForOpportunities(db, ['006L'], 'dry_run');
  assert.deepEqual(liveView.baseline, { 'sf.stage': 'Engineering' }, 'dry run never advanced the live baseline');
  assert.deepEqual(dryView.baseline, { 'sf.stage': 'Engineering', 'presales.quote_number': 'Q-DRY' });
  assert.equal(liveView.mondayItemId, '9001');

  await updateLink(db, '9001', { 'sf.stage': 'Canceled' }, 'live', { linkState: 'archived' });
  assert.equal((await loadLinksForOpportunities(db, ['006L'], 'live'))[0].linkState, 'archived');
  assert.deepEqual(await loadLinksForOpportunities(db, [], 'live'), []);
});

test('watermarks round-trip', async () => {
  const t = new Date('2026-10-11T08:00:00.000Z');
  await setWatermark(db, 'sf_sweep', t);
  assert.equal((await getWatermark(db, 'sf_sweep'))?.toISOString(), t.toISOString());
  assert.equal(await getWatermark(db, 'missing'), null);
});
