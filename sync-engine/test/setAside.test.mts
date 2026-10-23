/**
 * Set-aside items (sync_set_aside.sql, Seth 2026-10-23): change orders and other items
 * that can never agree with Salesforce. Real migrations (PGlite), real backfill,
 * reconcile, writeback, cleanliness and prune; fake monday / Salesforce.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from './helpers/pglite.mts';
import { fakeMonday, fakeSalesforce } from './helpers/fakes.mts';
import { loadRuntimeConfig } from '../src/config/load.ts';
import { insertLink, openTask, setAsideItemIds } from '../src/db/store.ts';
import { createWriteGate } from '../src/writeGate.ts';
import { runBackfill } from '../src/backfill/run.ts';
import { reconcileOpportunities } from '../src/reconcile/service.ts';
import { runWriteback } from '../src/writeback/run.ts';
import { countExceptions } from '../src/queue/cleanliness.ts';
import { pruneSetAside } from '../src/queue/setAside.ts';
import type { SfOpportunity } from '../src/reconcile/types.ts';

const MIGRATION = fileURLToPath(new URL('../../supabase/migrations/sync_set_aside.sql', import.meta.url));
const OPP = '006AAA000000001AAA';
const LINE = '00kAAA000000001AAA';

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
  const sql = readFileSync(MIGRATION, 'utf8');
  await db.pg.exec(`reset role; ${sql} ${sql} set role sync_engine;`); // re-runnable
});
afterEach(async () => { await db.close(); });
const rows = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;
const setAside = (id: string, reason = 'change_order') => db.query('insert into item_set_aside (monday_item_id, reason, item_name) values ($1::bigint, $2, $3)', [id, reason, `Item ${id}`]);

function opp(over: Partial<SfOpportunity> = {}): SfOpportunity {
  return {
    Id: OPP, Name: 'Acme HQ – Boardroom', StageName: 'Engineering',
    Estimate_Due_Date_Time__c: '2026-10-15T18:00:00.000+0000', Estimate_Number__c: 'Q-1001',
    Win_Likelihood__c: '50%', Business_Unit__c: 'Northeast', Sales_Rep__c: '005REP', Sales_Rep__r: { Name: 'Luke Wood' },
    Lost_Reason__c: null, Other_lost_reason__c: null, Lost_To__c: null,
    SystemModstamp: '2026-10-10T12:00:00.000+0000', LastModifiedById: '005USER',
    lineItems: [{ Id: LINE, isAVProduct__c: true, Technology__c: 'AV', UnitPrice: 0, Quantity: 1, Sold_in_Margin__c: null, CreatedDate: 'c' }],
    ...over,
  };
}

test('migration: table + audit; empty set until something is set aside', async () => {
  assert.equal((await setAsideItemIds(db)).size, 0);
  await setAside('42');
  assert.deepEqual([...(await setAsideItemIds(db))], ['42']);
  const audit = await rows(`select entity_type, field from event_log where entity_id like 'item_set_aside:%'`);
  assert.deepEqual(audit, [{ entity_type: 'mapping', field: 'INSERT' }], 'every set-aside is audited');
});

test('backfill: a set-aside change order that holds the line hands it to the real deal; no duplicate left', async () => {
  const monday = fakeMonday();
  monday.addItem('1001', { text_mkv2656m: JSON.stringify(LINE) });   // the change order, linked first
  monday.addItem('1002', { text_mkv2656m: JSON.stringify(LINE) });   // the real deal, same Salesforce ID
  monday.client.pageBoardItems = async (_b, _c, onPage) => { await onPage([...monday.items.values()].map((i) => ({ ...i, column_values: i.column_values.map((c) => ({ ...c, text: c.value ? JSON.parse(c.value) : null })) }))); };
  const sf = fakeSalesforce();
  sf.setQueryResults({ 'FROM OpportunityLineItem WHERE Id IN': [{ Id: LINE, OpportunityId: OPP, Opportunity: { StageName: 'Closed Won' } }] });
  const deps = { db, monday: monday.client, salesforce: sf.client, cfg: await loadRuntimeConfig(db) };
  await insertLink(db, { mondayItemId: '1001', sfOpportunityId: OPP, sfLineItemId: LINE, baseline: { 'sf.stage': 'Closed Won' } }, 'live');

  const before = await runBackfill(deps, { preview: false, reconcile: false });
  assert.equal(before.problems.duplicate.count, 1, 'the real deal is stuck as a duplicate');

  await setAside('1001');
  const preview = await runBackfill(deps, { preview: true, reconcile: false });
  assert.deepEqual([preview.setAside, preview.handedOver], [1, 1]);
  assert.equal((await rows('select monday_item_id::text id from sf_link'))[0].id, '1001', 'preview changes nothing');

  const r = await runBackfill(deps, { preview: false, reconcile: false });
  assert.deepEqual([r.linked, r.handedOver, r.problems.duplicate.count], [1, 1, 0]);
  assert.deepEqual((await rows('select monday_item_id::text id from sf_link')).map((x) => x.id), ['1002']);
  assert.equal((await rows(`select status from task where dedupe_key = 'sync_failure:backfill:duplicate'`))[0].status, 'done');
});

test('backfill: a set-aside item with a bad id is never a problem', async () => {
  const monday = fakeMonday();
  monday.addItem('2001', { text_mkv2656m: JSON.stringify('CO #3 for Q-1001') });
  monday.client.pageBoardItems = async (_b, _c, onPage) => { await onPage([...monday.items.values()].map((i) => ({ ...i, column_values: i.column_values.map((c) => ({ ...c, text: c.value ? JSON.parse(c.value) : null })) }))); };
  const deps = { db, monday: monday.client, salesforce: fakeSalesforce().client, cfg: await loadRuntimeConfig(db) };
  await setAside('2001');
  const r = await runBackfill(deps, { preview: false, reconcile: false });
  assert.deepEqual([r.setAside, r.counts.problems, (await rows('select count(*)::int n from task'))[0].n], [1, 0, 0]);
});

test('reconcile: a linked item that is set aside gets no writes', async () => {
  await insertLink(db, { mondayItemId: '778', sfOpportunityId: OPP, sfLineItemId: LINE, baseline: { 'sf.stage': 'Engineering' } }, 'live');
  await setAside('778');
  const monday = fakeMonday();
  monday.items.set('778', { id: '778', name: 'CO', state: 'active', group: { id: 'new_group12986' }, column_values: [] });
  const sf = fakeSalesforce({ opps: [opp()] });
  const deps = { db, gate: createWriteGate('live', monday.client, sf.client), monday: monday.client, salesforce: sf.client, getConfig: () => loadRuntimeConfig(db) };
  const s = await reconcileOpportunities(deps, [OPP]);
  assert.equal(s.failed.length, 0, JSON.stringify(s.failed));
  assert.equal(monday.writes.length, 0, 'quote number, due date … would otherwise be written');
});

test('writeback: no "isn\'t linked" task for a set-aside item, and an open one closes', async () => {
  await openTask(db, { op: 'open', taskType: 'writeback_no_link', dedupeKey: 'writeback_no_link:3001', title: 'Price/GM% not sent', details: '', sourceRef: {} }, null);
  await setAside('3001');
  const monday = fakeMonday();
  monday.addItem('3001', { numbers9: JSON.stringify('1200') });
  const sf = fakeSalesforce();
  const deps = { db, gate: createWriteGate('live', monday.client, sf.client), monday: monday.client, salesforce: sf.client, cfg: await loadRuntimeConfig(db) };
  assert.deepEqual(await runWriteback(deps, '3001', null), { kind: 'none', reason: 'item set aside' });
  assert.equal((await rows(`select status from task where dedupe_key = 'writeback_no_link:3001'`))[0].status, 'done');
});

test('prune: set-aside items leave grouped backfill tasks and close "isn\'t linked" tasks', async () => {
  const key = 'sync_failure:backfill:not_found';
  for (const id of ['11', '12']) {
    await openTask(db, { op: 'open', taskType: 'sync_failure', dedupeKey: key, title: 'Backfill: not found', details: 'Fix it.', sourceRef: { board_key: 'presales' }, member: { id, label: `Item ${id}` } }, null);
  }
  await openTask(db, { op: 'open', taskType: 'writeback_no_link', dedupeKey: 'writeback_no_link:12', title: 'Price/GM% not sent', details: '', sourceRef: {} }, null);
  await setAside('12');
  assert.equal(await pruneSetAside(db), 2);
  const t = (await rows(`select status, source_ref from task where dedupe_key = $1`, [key]))[0];
  assert.deepEqual([t.status, t.source_ref.members.map((m: any) => m.id)], ['not_started', ['11']]);
  assert.equal((await rows(`select status from task where dedupe_key = 'writeback_no_link:12'`))[0].status, 'done');
  assert.equal(await pruneSetAside(db), 0, 'idempotent');
});

test('cleanliness: set-aside items are not counted, but reported', () => {
  const blank = (id: string) => ({ id, name: `Item ${id}`, state: 'active', group: { id: 'g_follow' }, column_values: [{ id: 'numbers9', value: null, text: null }] });
  const r = countExceptions({
    items: { presales: [blank('1'), blank('2'), blank('3')] as any },
    rules: [{ boardKey: 'presales', semanticKey: 'presales.quoted_price', exemptWhen: {} }],
    columns: { 'presales.quoted_price': { columnId: 'numbers9', type: 'numbers' } } as any,
    groups: { 'presales.follow_up': 'g_follow' },
    scope: { presales: { groups: ['follow_up'] } },
    programmingNumbers: new Set(), year: 2026, setAside: new Set(['2']),
  });
  assert.deepEqual([r.total, r.inScope.presales, r.setAside.presales], [2, 2, 1]);
  assert.deepEqual(r.itemsByField['presales.quoted_price'].map((i) => i.id), ['1', '3']);
});
