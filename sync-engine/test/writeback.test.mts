import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { planWriteback } from '../src/writeback/plan.ts';
import { runWriteback } from '../src/writeback/run.ts';
import { loadRuntimeConfig } from '../src/config/load.ts';
import { insertLink, openTask } from '../src/db/store.ts';
import { createWriteGate } from '../src/writeGate.ts';
import { createTestDb, type TestDb } from './helpers/pglite.mts';
import { fakeMonday, fakeSalesforce } from './helpers/fakes.mts';
import { LINE, OPP } from './helpers/fixtures.mts';

const ITEM = '13092716583';
const link = { sfLineItemId: LINE, sfOpportunityId: OPP, linkState: 'active' as const };
const li = (over = {}) => ({ Id: LINE, OpportunityId: OPP, UnitPrice: 0, Quantity: 1, Sold_in_Margin__c: null, ...over });

test('plan: patches only what differs, only the two line-item fields', () => {
  const d = planWriteback({ mondayItemId: ITEM, link, lineItem: li(), quotedPrice: 125000, gmPct: 35 });
  assert.equal(d.kind, 'patch');
  if (d.kind === 'patch') {
    assert.deepEqual(d.values, { UnitPrice: 125000, Sold_in_Margin__c: 35 });
    assert.deepEqual(Object.keys(d.values).sort(), ['Sold_in_Margin__c', 'UnitPrice'], 'never Opportunity header fields');
  }
  const d2 = planWriteback({ mondayItemId: ITEM, link, lineItem: li({ UnitPrice: 125000 }), quotedPrice: 125000, gmPct: 35 });
  assert.deepEqual(d2.kind === 'patch' && d2.values, { Sold_in_Margin__c: 35 });
});

test('plan: no link / multi-quantity / missing line → tasks; matching / archived → nothing', () => {
  assert.equal(planWriteback({ mondayItemId: ITEM, link: null, lineItem: null, quotedPrice: 1, gmPct: null }).kind, 'task');
  const q = planWriteback({ mondayItemId: ITEM, link, lineItem: li({ Quantity: 3 }), quotedPrice: 1, gmPct: null });
  assert.equal(q.kind === 'task' && q.dedupeKey, `writeback_quantity:${ITEM}`);
  const m = planWriteback({ mondayItemId: ITEM, link, lineItem: null, quotedPrice: 1, gmPct: null });
  assert.equal(m.kind === 'task' && m.taskType, 'sync_failure');
  assert.equal(planWriteback({ mondayItemId: ITEM, link, lineItem: li({ UnitPrice: 5, Sold_in_Margin__c: 30 }), quotedPrice: 5, gmPct: 30 }).kind, 'none');
  assert.equal(planWriteback({ mondayItemId: ITEM, link: { ...link, linkState: 'archived' }, lineItem: li(), quotedPrice: 5, gmPct: 30 }).kind, 'none');
  assert.equal(planWriteback({ mondayItemId: ITEM, link, lineItem: li(), quotedPrice: null, gmPct: null }).kind, 'none', 'blank monday never clears Salesforce');
});

let db: TestDb;
beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await db.close(); });

async function setup(mode: 'dry_run' | 'live', opts: { linked?: boolean; quantity?: number } = {}) {
  const monday = fakeMonday();
  monday.addItem(ITEM, { numbers9: '"125000"', numbers__1: '"35"' });
  const sf = fakeSalesforce({ lineItems: [li({ Quantity: opts.quantity ?? 1 })] });
  if (opts.linked !== false) await insertLink(db, { mondayItemId: ITEM, sfOpportunityId: OPP, sfLineItemId: LINE, baseline: {} }, 'live');
  const deps = { db, gate: createWriteGate(mode, monday.client, sf.client), monday: monday.client, salesforce: sf.client, cfg: await loadRuntimeConfig(db) };
  return { sf, run: () => runWriteback(deps, ITEM, '33940282') };
}
const rows = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;

test('live: re-reads monday, patches Salesforce, logs a writeback event, closes old writeback tasks', async () => {
  const { sf, run } = await setup('live');
  await openTask(db, { op: 'open', taskType: 'writeback_quantity', dedupeKey: `writeback_quantity:${ITEM}`, title: 't', details: 'd', sourceRef: {} }, null);
  const d = await run();
  assert.equal(d.kind, 'patch');
  assert.deepEqual(sf.patches, [{ id: LINE, values: { UnitPrice: 125000, Sold_in_Margin__c: 35 } }]);
  const ev = (await rows(`select actor, old_value, new_value from event_log where event_type = 'writeback'`))[0];
  assert.equal(ev.actor, '33940282', 'the monday user who changed the price');
  assert.deepEqual(ev.new_value, { UnitPrice: 125000, Sold_in_Margin__c: 35 });
  assert.equal((await rows('select status from task where dedupe_key = $1', [`writeback_quantity:${ITEM}`]))[0].status, 'done');

  assert.equal((await run()).kind, 'none', 'second run: Salesforce already matches');
  assert.equal(sf.patches.length, 1);
});

test('dry run: nothing sent, intended PATCH logged', async () => {
  const { sf, run } = await setup('dry_run');
  await run();
  assert.equal(sf.patches.length, 0);
  const dry = (await rows(`select details from event_log where event_type = 'dry_run_write'`))[0];
  assert.equal(dry.details.op, 'patch_line_item');
  assert.deepEqual(dry.details.payload.values, { UnitPrice: 125000, Sold_in_Margin__c: 35 });
});

test('quantity ≠ 1 and unlinked items raise their tasks and write nothing', async () => {
  const a = await setup('live', { quantity: 2 });
  await a.run();
  assert.equal(a.sf.patches.length, 0);
  assert.equal((await rows('select task_type from task'))[0].task_type, 'writeback_quantity');

  await db.close();
  db = await createTestDb();
  const b = await setup('live', { linked: false });
  await b.run();
  assert.equal((await rows('select task_type from task'))[0].task_type, 'writeback_no_link');
});
