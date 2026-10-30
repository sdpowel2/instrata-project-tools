/**
 * Duplicate check before create + link on a pasted Salesforce ID (Seth 2026-10-30).
 * Matcher cases are the real Triage duplicates of Oct 28–30; the rest runs end to
 * end below the network (real migration, config loader, planner, executor, worker).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './helpers/pglite.mts';
import { loadRuntimeConfig } from '../src/config/load.ts';
import { fakeMonday, fakeSalesforce } from './helpers/fakes.mts';
import { createWriteGate } from '../src/writeGate.ts';
import { reconcileOpportunities } from '../src/reconcile/service.ts';
import { handleMondayEvent } from '../src/worker/mondayEvents.ts';
import { findDuplicates, possibleDuplicateKey, type PoolItem } from '../src/reconcile/duplicates.ts';
import { insertLink } from '../src/db/store.ts';
import { runBackfill } from '../src/backfill/run.ts';
import type { SfOpportunity } from '../src/reconcile/types.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INTAKE = fileURLToPath(new URL('../../supabase/migrations/sync_intake_boards.sql', import.meta.url));

// ── Matcher ──
const p = (id: string, name: string, quote: string | null = null, sfId: string | null = null): PoolItem => ({ id, name, boardKey: 'presales', groupId: 'g', quote, sfId });
const POOL = [
  p('12792560071', 'Cardinal Infrastructure Group Cabling & AV (Acorn) - Base Bid', '26-SE-1052'),
  p('9452683588', 'Cardinal Maintenance Shop', '25-1072'),
  p('18190742111', 'Roseshire - Display Adds', '25-INSTR-MA-0009'),
  p('12407847957', 'Episcopal Church of the Redeemer - Nave & Parish', '26- / 25-427'),
  p('13129855049', 'Fayetteville Woodpeckers service audit & system reprogramming', '26-se-1278'),
  p('12576053941', 'Fayetteville Woodpeckers Stadium Upgrades', '26-SE-0909'),
  p('11', 'Charleston Place Third Floor Large Conference Room'),
  p('12', 'Monarch HQ', null, '00kQO000016ID30YAG'),
];
const match = (name: string, quote: string | null, line = '00kNEW000000001') =>
  findDuplicates({ opportunityId: '006NEW000000001', lineItemId: line, name, quote }, POOL).map((m) => `${m.item.id}:${m.why}`);

test('matcher: the real Triage duplicates are caught, generic names are not', () => {
  assert.deepEqual(match('Cardinal Infrastructure AV', '26-SE-1298'), ['12792560071:name'], 'every word of the short name; Maintenance Shop shares one word only');
  assert.deepEqual(match('Roseshire Display Adds', '26-MA-0398'), ['18190742111:name']);
  assert.deepEqual(match('Episcopal Church of the redeemer Nave & Parish', '26-MA-0517'), ['12407847957:name']);
  assert.deepEqual(match('Fayetteville Woodpeckers Stadium Service', '26-SE-1278'), ['13129855049:quote_number'], 'quote, case ignored');
  assert.deepEqual(match('Charleston Place', '26-SE-0187'), ['11:name']);
  assert.deepEqual(match('Conference Room', 'Q-12345'), [], 'only generic words shared');
  assert.deepEqual(match('Large Conference Room Refresh', null), []);
  assert.deepEqual(match('Something else', null, '00kQO000016ID30YAGX'.slice(0, 18)), ['12:salesforce_id'], 'ID already pasted');
});

// ── End to end ──
const OPP = '006AAA000000001';
const LINE = '00kAAA000000001';
function opp(over: Partial<SfOpportunity> = {}): SfOpportunity {
  return {
    Id: OPP, Name: 'Roseshire Display Adds', StageName: 'Engineering',
    Estimate_Due_Date_Time__c: null, Estimate_Number__c: '26-MA-0398',
    Win_Likelihood__c: '50%', Business_Unit__c: null, Sales_Rep__c: '005REP', Sales_Rep__r: { Name: 'Luke Wood' },
    Lost_Reason__c: null, Other_lost_reason__c: null, Lost_To__c: null,
    SystemModstamp: '2026-10-10T12:00:00.000+0000', LastModifiedById: '005USER',
    lineItems: [{ Id: LINE, isAVProduct__c: true, Technology__c: 'AV', UnitPrice: 0, Quantity: 1, Sold_in_Margin__c: null, CreatedDate: 'c' }],
    ...over,
  };
}

let db: TestDb;
beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await db.close(); });

const rows = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows;

async function harness() {
  const cfg = await loadRuntimeConfig(db);
  const presales = String(cfg.boards.presales);
  const sfCol = cfg.planner.columns['presales.sf_id'].columnId!;
  const monday = fakeMonday();
  monday.client.pageBoardItems = async (boardId, _cols, onPage) => {
    await onPage([...monday.items.values()].filter((i) => (i.board?.id ?? presales) === String(boardId) && i.state === 'active'));
  };
  const sf = fakeSalesforce({ opps: [opp()] });
  sf.setQueryResults({ 'FROM OpportunityLineItem WHERE Id IN': [{ Id: LINE, OpportunityId: OPP, Opportunity: { StageName: 'Engineering' } }] });
  const gate = createWriteGate('live', monday.client, sf.client);
  const deps = { db, gate, monday: monday.client, salesforce: sf.client, getConfig: () => loadRuntimeConfig(db) };
  const existing = (id: string, name: string, sfId: string | null = null) => {
    monday.addItem(id, sfId ? { [sfCol]: JSON.stringify(sfId) } : {}, 'new_group66048');
    monday.items.get(id)!.name = name;
  };
  const paste = (itemId: string, sfId: string) => {
    monday.setCol(monday.items.get(itemId)!, sfCol, JSON.stringify(sfId));
    return handleMondayEvent({ db, gate, monday: monday.client, salesforce: sf.client, cfg, integrationUserId: '119228546' }, {
      id: '1', source: 'monday', received_at: new Date().toISOString(), attempts: 1,
      payload: { event: { type: 'update_column_value', boardId: Number(presales), pulseId: Number(itemId), columnId: sfCol, userId: 33940282, value: { value: sfId }, previousValue: null, triggerUuid: 't' } },
    } as any);
  };
  return { cfg, monday, sf, existing, paste, run: () => reconcileOpportunities(deps, [OPP]) };
}

test('a likely duplicate holds the create and opens Possible duplicate for Hope', async () => {
  const h = await harness();
  h.existing('18190742111', 'Roseshire - Display Adds');
  const s = await h.run();
  assert.equal(s.failed.length, 0, JSON.stringify(s.failed));
  assert.ok(!h.monday.writes.some((w) => w.op === 'create'), 'nothing created');
  const t = await rows('select title, details, status, source_ref from task where dedupe_key = $1', [possibleDuplicateKey(OPP)]);
  assert.equal(t.length, 1);
  assert.equal(t[0].title, 'Possible duplicate: Roseshire Display Adds');
  assert.match(t[0].details, /Roseshire - Display Adds — Pre-Sales Summary \/ Follow Up \(similar name\)/);
  assert.match(t[0].details, /paste the Salesforce ID 00kAAA000000001/);
  assert.equal(t[0].source_ref.monday_item_id, '18190742111');
  assert.equal((await rows('select count(*)::int as n from sf_link'))[0].n, 0);

  await h.run();
  assert.ok(!h.monday.writes.some((w) => w.op === 'create'), 'still held on the next change');
});

test('pasting the ID links the item, closes the task and queues its reconcile', async () => {
  const h = await harness();
  h.existing('18190742111', 'Roseshire - Display Adds');
  await h.run();
  const r = await h.paste('18190742111', LINE);
  assert.equal(r.kind === 'done' && r.note, `linked to ${LINE}`);
  const link = await rows('select monday_item_id::text as item, sf_opportunity_id, link_state, last_synced_values from sf_link');
  assert.deepEqual(link.map((l) => [l.item, l.sf_opportunity_id, l.link_state]), [['18190742111', OPP, 'active']]);
  assert.deepEqual(link[0].last_synced_values, { 'sf.stage': 'Engineering' }, 'first-link baseline, like the backfill');
  assert.equal((await rows('select status from task where dedupe_key = $1', [possibleDuplicateKey(OPP)]))[0].status, 'done');
  assert.equal((await rows(`select count(*)::int as n from webhook_inbox where payload->>'opportunity_id' = $1`, [OPP]))[0].n, 1);

  h.monday.writes.length = 0;
  await h.run();
  assert.ok(!h.monday.writes.some((w) => w.op === 'create'), 'linked now: never created');
});

test('Hope marks the task Done → the engine creates the item', async () => {
  const h = await harness();
  h.existing('18190742111', 'Roseshire - Display Adds');
  await h.run();
  await db.query(`update task set status = 'done', close_mode = 'manual', closed_at = now() where dedupe_key = $1`, [possibleDuplicateKey(OPP)]);
  const s = await h.run();
  assert.equal(s.failed.length, 0, JSON.stringify(s.failed));
  assert.equal(h.monday.writes.filter((w) => w.op === 'create').length, 1);
  assert.equal((await rows('select status from task where dedupe_key = $1', [possibleDuplicateKey(OPP)]))[0].status, 'done', 'not reopened');
});

test('an unlinked item already holding the ID is linked instead of creating', async () => {
  const h = await harness();
  h.existing('12792560071', 'Cardinal Infrastructure Group Cabling & AV (Acorn) - Base Bid', LINE);
  const s = await h.run();
  assert.equal(s.failed.length, 0, JSON.stringify(s.failed));
  assert.ok(!h.monday.writes.some((w) => w.op === 'create'));
  assert.deepEqual((await rows('select monday_item_id::text as item from sf_link')).map((l) => l.item), ['12792560071']);
  assert.equal((await rows('select count(*)::int as n from task where dedupe_key = $1', [possibleDuplicateKey(OPP)]))[0].n, 0, 'no task needed');
});

test('a line held by an archived link (deleted Triage item) moves to the pasted item', async () => {
  const h = await harness();
  await insertLink(db, { mondayItemId: '13421241584', sfOpportunityId: OPP, sfLineItemId: LINE, baseline: { 'sf.stage': 'Engineering' } }, 'live');
  await db.query(`update sf_link set link_state = 'archived'`);
  h.existing('12792560071', 'Cardinal Infrastructure Group Cabling & AV (Acorn) - Base Bid');
  const r = await h.paste('12792560071', LINE);
  assert.equal(r.kind === 'done' && r.note, `linked to ${LINE}`);
  assert.deepEqual((await rows('select monday_item_id::text as item, link_state from sf_link')).map((l) => [l.item, l.link_state]), [['12792560071', 'active']]);
});

test('backfill reads Pre-Qualification and Triage too, and takes lines from archived links', async () => {
  await db.pg.exec(`reset role; ${readFileSync(INTAKE, 'utf8')} set role sync_engine;`);
  const h = await harness();
  const prequal = String(h.cfg.boards.prequal);
  const LINE2 = '00kAAA000000002';
  h.existing('12016646886', 'Project Baccara / Project Eagle - Monterra', LINE);
  h.monday.items.get('12016646886')!.board = { id: prequal };
  h.existing('12792560071', 'Cardinal Infrastructure Group Cabling & AV (Acorn) - Base Bid', LINE2);
  await insertLink(db, { mondayItemId: '13421241584', sfOpportunityId: '006AAA000000002', sfLineItemId: LINE2, baseline: {} }, 'live');
  await db.query(`update sf_link set link_state = 'archived'`);
  h.sf.setQueryResults({ 'FROM OpportunityLineItem WHERE Id IN': [
    { Id: LINE, OpportunityId: OPP, Opportunity: { StageName: 'Lead' } },
    { Id: LINE2, OpportunityId: '006AAA000000002', Opportunity: { StageName: 'Contract In House' } },
  ] });
  const r = await runBackfill({ db, monday: h.monday.client, salesforce: h.sf.client, cfg: await loadRuntimeConfig(db) }, { preview: false, reconcile: false });
  assert.equal(r.linked, 2);
  assert.equal(r.handedOver, 1, 'the deleted Triage item\'s link');
  assert.equal(r.problems.duplicate.count, 0);
  assert.deepEqual((await rows('select monday_item_id::text as item, link_state from sf_link order by 1')).map((l) => [l.item, l.link_state]),
    [['12016646886', 'active'], ['12792560071', 'active']]);
});

test('a line held by a LIVE item is not stolen: duplicate problem for Hope', async () => {
  const h = await harness();
  await insertLink(db, { mondayItemId: '500', sfOpportunityId: OPP, sfLineItemId: LINE, baseline: {} }, 'live');
  h.existing('12792560071', 'Cardinal Infrastructure Group Cabling & AV (Acorn) - Base Bid');
  const r = await h.paste('12792560071', LINE);
  assert.equal(r.kind === 'done' && r.note, 'not linked: duplicate');
  assert.deepEqual((await rows('select monday_item_id::text as item from sf_link')).map((l) => l.item), ['500']);
  assert.equal((await rows(`select count(*)::int as n from task where dedupe_key = 'sync_failure:backfill:duplicate' and status <> 'done'`))[0].n, 1);
});
