import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './helpers/pglite.mts';
import { fakeSalesforce } from './helpers/fakes.mts';
import { runSweep, SWEEP_WATERMARK } from '../src/schedule/sweep.ts';
import { getWatermark, insertLink, openTask, setWatermark } from '../src/db/store.ts';
import { requeueLinked } from '../src/schedule/requeue.ts';

let db: TestDb;
beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await db.close(); });

test('sweep: unions changed opps, changed lines and deleted lines; enqueues one row each; advances the watermark', async () => {
  const sf = fakeSalesforce();
  sf.setQueryResults({
    'FROM Opportunity WHERE SystemModstamp': [{ Id: '006A' }, { Id: '006B' }],
    'FROM OpportunityLineItem WHERE SystemModstamp': [{ OpportunityId: '006B' }, { OpportunityId: '006C' }],
    'IsDeleted = true': [{ OpportunityId: '006D' }],
  });
  await setWatermark(db, SWEEP_WATERMARK, new Date('2026-10-11T10:00:00Z'));
  const now = new Date('2026-10-11T11:00:00Z');

  const r = await runSweep({ db, salesforce: sf.client }, now);
  assert.equal(r.since, '2026-10-11T09:50:00.000Z', 'watermark − 10 min overlap');
  assert.equal(r.changed, 4);
  assert.equal(r.enqueued, 4);
  assert.ok(sf.queries.some((q) => q.startsWith('ALL:') && q.includes('IsDeleted = true')), 'deletes read via queryAll');
  const opps = (await db.query<any>(`select payload->>'opportunity_id' as id from webhook_inbox order by 1`)).rows.map((x) => x.id);
  assert.deepEqual(opps, ['006A', '006B', '006C', '006D']);
  assert.equal((await getWatermark(db, SWEEP_WATERMARK))?.toISOString(), now.toISOString());
});

test('sweep: re-queues opportunities behind open unmapped-value tasks (mapping fixes get picked up)', async () => {
  const sf = fakeSalesforce();
  const open = (id: string) => openTask(db, { op: 'open', taskType: 'sync_failure', dedupeKey: 'sync_failure:unmapped_value:presales.business_unit:Louisiana', title: 't', details: 'd', sourceRef: {}, member: { id, label: id } }, null);
  await open('006Y');
  await open('006Z');
  const r = await runSweep({ db, salesforce: sf.client }, new Date());
  assert.equal(r.mappingRetries, 2, 'every member of the grouped task');
  const ids = (await db.query<any>(`select payload->>'opportunity_id' as id from webhook_inbox order by 1`)).rows.map((x) => x.id);
  assert.deepEqual(ids, ['006Y', '006Z']);
});

test('requeue-linked: one row per linked opportunity; dry-run reset touches only the dry baseline', async () => {
  await insertLink(db, { mondayItemId: '1', sfOpportunityId: '006A', sfLineItemId: '00kA', baseline: { 'sf.stage': 'Engineering' } }, 'live');
  await insertLink(db, { mondayItemId: '2', sfOpportunityId: '006B', sfLineItemId: '00kB', baseline: { 'sf.stage': 'Rebid' } }, 'live');
  await db.query(`update sf_link set dry_run_synced_values = '{"sf.stage":"Engineering","presales.quote_number":"Q-1"}', last_synced_values = last_synced_values || '{"presales.quote_number":"LIVE"}'`);
  await db.query(`update sf_link set link_state = 'archived' where monday_item_id = 2`);

  const r = await requeueLinked(db, { resetDryRunBaseline: true });
  assert.equal(r.queued, 1, 'archived links are skipped');
  assert.equal(r.reset, 1);
  const link = (await db.query<any>('select last_synced_values l, dry_run_synced_values d from sf_link where monday_item_id = 1')).rows[0];
  assert.deepEqual(link.d, { 'sf.stage': 'Engineering' }, 'dry baseline back to stage-only');
  assert.equal(link.l['presales.quote_number'], 'LIVE', 'live baseline untouched');
});

test('sweep: a Salesforce failure leaves the watermark where it was', async () => {
  const sf = fakeSalesforce();
  sf.client.query = async () => { throw new Error('Salesforce 503'); };
  const before = new Date('2026-10-11T10:00:00Z');
  await setWatermark(db, SWEEP_WATERMARK, before);
  await assert.rejects(runSweep({ db, salesforce: sf.client }, new Date()));
  assert.equal((await getWatermark(db, SWEEP_WATERMARK))?.toISOString(), before.toISOString());
});
