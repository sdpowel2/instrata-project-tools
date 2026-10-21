/** Inbox queue semantics + event routing, against the real migration. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './helpers/pglite.mts';
import { fakeMonday, fakeSalesforce } from './helpers/fakes.mts';
import { INTEGRATION_USER, LINE, OPP, mondayColumnEvent, opp } from './helpers/fixtures.mts';
import { claimBatch, markFailed, MAX_ATTEMPTS } from '../src/worker/inbox.ts';
import { processRows, drainInbox, type WorkerDeps } from '../src/worker/process.ts';
import { loadRuntimeConfig } from '../src/config/load.ts';
import { insertLink } from '../src/db/store.ts';
import { createWriteGate } from '../src/writeGate.ts';

let db: TestDb;
beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await db.close(); });

const rows = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
async function enqueue(source: 'salesforce' | 'monday', payload: unknown, hash = `h-${Math.random()}`, receivedAgoSec = 0) {
  await db.query(
    `insert into webhook_inbox (source, payload, dedupe_hash, received_at) values ($1, $2::jsonb, $3, now() - make_interval(secs => $4))`,
    [source, JSON.stringify(payload), hash, receivedAgoSec]);
}

function deps(mode: 'dry_run' | 'live' = 'live', o = opp()) {
  const monday = fakeMonday();
  const sf = fakeSalesforce({ opps: [o], lineItems: [{ Id: LINE, OpportunityId: OPP, UnitPrice: 0, Quantity: 1, Sold_in_Margin__c: null }] });
  const d: WorkerDeps = { db, gate: createWriteGate(mode, monday.client, sf.client), monday: monday.client, salesforce: sf.client, getConfig: () => loadRuntimeConfig(db), integrationUserId: INTEGRATION_USER };
  return { d, monday, sf };
}

test('claim is a lease: claimed rows are invisible until processed or the lease expires', async () => {
  await enqueue('salesforce', { opportunity_id: OPP });
  const first = await claimBatch(db);
  assert.equal(first.length, 1);
  assert.equal(first[0].attempts, 1);
  assert.equal((await claimBatch(db)).length, 0, 'leased');
  await db.query(`update webhook_inbox set next_attempt_at = now() - interval '1 second'`);
  assert.equal((await claimBatch(db))[0].attempts, 2, 'lease expired → claimable again (crash recovery)');
});

test(`failures back off, then park as error with a failure task after ${MAX_ATTEMPTS} attempts`, async () => {
  await enqueue('salesforce', { opportunity_id: OPP });
  let row = (await claimBatch(db))[0];
  assert.equal(await markFailed(db, row, 'boom'), 'retry');
  assert.equal((await rows('select status from webhook_inbox'))[0].status, 'pending');
  await db.query(`update webhook_inbox set attempts = ${MAX_ATTEMPTS - 1}, next_attempt_at = now()`);
  row = (await claimBatch(db))[0];
  assert.equal(await markFailed(db, row, 'still boom'), 'error');
  const inbox = (await rows('select status, error_text from webhook_inbox'))[0];
  assert.deepEqual(inbox, { status: 'error', error_text: 'still boom' });
  const task = (await rows('select task_type, source_ref from task'))[0];
  assert.equal(task.task_type, 'sync_failure');
  assert.equal(task.source_ref.sf_opportunity_id, OPP);
});

test('salesforce rows: one reconcile per opportunity, rows marked done', async () => {
  const { d, monday } = deps('live');
  await enqueue('salesforce', { object: 'Opportunity', opportunity_id: OPP });
  await enqueue('salesforce', { object: 'Sweep', opportunity_id: OPP });
  assert.equal(await drainInbox(d), 2);
  assert.equal(monday.writes.filter((w) => w.op === 'create').length, 1, 'two events, one item');
  assert.deepEqual((await rows('select distinct status from webhook_inbox')).map((r) => r.status), ['done']);
});

test('salesforce outage: every row in the batch retries', async () => {
  const { d, sf } = deps('live');
  sf.failOpportunities(new Error('Salesforce 503'));
  await enqueue('salesforce', { opportunity_id: OPP });
  await processRows(d, await claimBatch(db));
  assert.deepEqual((await rows('select status, error_text from webhook_inbox'))[0], { status: 'pending', error_text: 'Salesforce 503' });
});

test('monday: the engine ignores its own echoes', async () => {
  const { d, sf } = deps('live');
  await insertLink(db, { mondayItemId: '13092716583', sfOpportunityId: OPP, sfLineItemId: LINE, baseline: {} }, 'live');
  await enqueue('monday', mondayColumnEvent({ userId: Number(INTEGRATION_USER) }), 'h', 120);
  await drainInbox(d);
  assert.equal(sf.patches.length, 0);
  assert.equal((await rows(`select count(*)::int n from event_log where source = 'monday'`))[0].n, 0);
});

test('monday price edit: waits out the debounce, then writes back once', async () => {
  const { d, monday, sf } = deps('live');
  monday.addItem('13092716583', { numbers9: '"98000"', numbers__1: '"32"' });
  await insertLink(db, { mondayItemId: '13092716583', sfOpportunityId: OPP, sfLineItemId: LINE, baseline: {} }, 'live');

  await enqueue('monday', mondayColumnEvent(), 'fresh', 0);
  await drainInbox(d);
  assert.equal(sf.patches.length, 0, 'inside the 30 s window: deferred');
  const r = (await rows('select status, attempts, next_attempt_at > now() as later from webhook_inbox'))[0];
  assert.deepEqual(r, { status: 'pending', attempts: 0, later: true }, 'deferral spends no attempt');

  await db.query(`update webhook_inbox set received_at = now() - interval '31 seconds', next_attempt_at = now()`);
  await drainInbox(d);
  assert.deepEqual(sf.patches, [{ id: LINE, values: { UnitPrice: 98000, Sold_in_Margin__c: 32 } }]);
});

test('monday: typing in a number field → earlier events superseded, a single PATCH', async () => {
  const { d, monday, sf } = deps('live');
  monday.addItem('13092716583', { numbers9: '"125000"', numbers__1: '"35"' });
  await insertLink(db, { mondayItemId: '13092716583', sfOpportunityId: OPP, sfLineItemId: LINE, baseline: {} }, 'live');
  await enqueue('monday', mondayColumnEvent({ value: { value: 12 } }), 'k1', 40);
  await enqueue('monday', mondayColumnEvent({ value: { value: 1250 } }), 'k2', 35);
  await enqueue('monday', mondayColumnEvent({ value: { value: 125000 } }), 'k3', 31);
  await drainInbox(d);
  assert.equal(sf.patches.length, 1, 'only the last edit writes');
  assert.equal(sf.patches[0].values.UnitPrice, 125000, 'and it uses the current monday value');
});

test('monday: a person editing a Salesforce-owned field or the status is logged, not fought', async () => {
  const { d } = deps('live');
  await enqueue('monday', mondayColumnEvent({ columnId: 'text8', value: { value: 'Q-HAND' } }));
  await enqueue('monday', mondayColumnEvent({ columnId: 'status9', value: { label: { index: 6 } } }));
  await enqueue('monday', mondayColumnEvent({ columnId: 'person' }));
  await drainInbox(d);
  const ev = await rows(`select event_type, field, actor from event_log where source = 'monday' order by id`);
  assert.deepEqual(ev, [
    { event_type: 'field_changed', field: 'presales.quote_number', actor: '33940282' },
    { event_type: 'status_changed', field: 'presales.status', actor: '33940282' },
  ], 'monday-owned columns (engineer) are not logged');
});

test('monday: archiving a linked item archives its link', async () => {
  const { d } = deps('live');
  await insertLink(db, { mondayItemId: '13092716583', sfOpportunityId: OPP, sfLineItemId: LINE, baseline: {} }, 'live');
  await enqueue('monday', mondayColumnEvent({ type: 'archive_pulse', columnId: null }));
  await drainInbox(d);
  assert.equal((await rows('select link_state from sf_link'))[0].link_state, 'archived');
});

test('monday: events from other boards are ignored', async () => {
  const { d, sf } = deps('live');
  await enqueue('monday', mondayColumnEvent({ boardId: 999 }), 'other', 120);
  await drainInbox(d);
  assert.equal(sf.patches.length, 0);
  assert.equal((await rows('select status from webhook_inbox'))[0].status, 'done');
});
