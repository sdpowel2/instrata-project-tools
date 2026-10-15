/**
 * Intake boards (Pre-Qualification + Triage), end to end below the network:
 * real migrations (incl. sync_intake_boards.sql, run twice), real config loader,
 * planner, executor and writeGate; fake monday / Salesforce that record calls.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from './helpers/pglite.mts';
import { loadRuntimeConfig } from '../src/config/load.ts';
import { fakeMonday, fakeSalesforce } from './helpers/fakes.mts';
import { createWriteGate } from '../src/writeGate.ts';
import { reconcileOpportunities } from '../src/reconcile/service.ts';
import type { SfOpportunity } from '../src/reconcile/types.ts';

const MIGRATION = fileURLToPath(new URL('../../supabase/migrations/sync_intake_boards.sql', import.meta.url));
const PRESALES = '3477536693';
const PREQUAL = '18435527184';
const TRIAGE = '18435527543';
const OPP = '006AAA000000001';
const LINE = '00kAAA000000001';

function opp(over: Partial<SfOpportunity> = {}): SfOpportunity {
  return {
    Id: OPP, Name: 'Acme HQ – Boardroom', StageName: 'Lead',
    Estimate_Due_Date_Time__c: '2026-10-15T18:00:00.000+0000', Estimate_Number__c: 'Q-1001',
    Win_Likelihood__c: '50%', Business_Unit__c: 'Northeast', Sales_Rep__c: '005REP', Sales_Rep__r: { Name: 'Luke Wood' },
    Lost_Reason__c: null, Other_lost_reason__c: null, Lost_To__c: null,
    SystemModstamp: '2026-10-10T12:00:00.000+0000', LastModifiedById: '005USER',
    lineItems: [{ Id: LINE, isAVProduct__c: true, Technology__c: 'AV', UnitPrice: 0, Quantity: 1, Sold_in_Margin__c: null, CreatedDate: 'c' }],
    ...over,
  };
}

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
  const sql = readFileSync(MIGRATION, 'utf8');
  await db.pg.exec(`reset role; ${sql} ${sql} set role sync_engine;`); // re-runnable
  await db.query(`update config_field_registry set monday_column_id = 'long_text_notes' where semantic_key = 'presales.win_loss_notes'`);
});
afterEach(async () => { await db.close(); });

function harness(o: SfOpportunity) {
  const monday = fakeMonday();
  const sf = fakeSalesforce({ opps: [o] });
  const gate = createWriteGate('live', monday.client, sf.client);
  const deps = { db, gate, monday: monday.client, salesforce: sf.client, getConfig: () => loadRuntimeConfig(db) };
  return { monday, run: () => reconcileOpportunities(deps, [OPP]), setOpp: (x: SfOpportunity) => sf.opps.set(x.Id, x) };
}
const rows = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows;

test('migration: both intake boards, per-board groups, settings; intake mode on', async () => {
  const cfg = await loadRuntimeConfig(db);
  assert.equal(cfg.boards.prequal, PREQUAL);
  assert.equal(cfg.boards.triage, TRIAGE);
  assert.equal(cfg.planner.intake, true);
  assert.deepEqual(cfg.planner.prequalStages, ['Lead', 'Qualified Opportunity']);
  assert.equal(cfg.planner.createItems, true, 'production (public) creates');
  assert.equal(cfg.planner.groups['triage.bid_no_bid'], 'new_group66048');
  assert.equal(cfg.planner.groups['presales.follow_up'], 'new_group66048', 'same id, different board');
});

test('Lead → created on Pre-Qualification with the EC2 task; Engineering → moved to Triage, task closed', async () => {
  const h = harness(opp());
  const s1 = await h.run();
  assert.equal(s1.failed.length, 0, JSON.stringify(s1.failed));
  const create = h.monday.writes.find((w) => w.op === 'create')!;
  assert.deepEqual(create.args.slice(0, 2), [PREQUAL, 'new_group12986'], 'Pre-Qualification / Lead');
  const itemId = s1.results[0].result.createdItemId!;
  const ec2 = await rows(`select status, source_ref from task where dedupe_key = $1`, [`sync_failure:prequal_estimate_due:${itemId}:due_date`]);
  assert.equal(ec2.length, 1, 'EC2 task keyed by the real item id');
  assert.equal(ec2[0].status, 'not_started');

  h.setOpp(opp({ StageName: 'Engineering' }));
  h.monday.writes.length = 0;
  const s2 = await h.run();
  assert.equal(s2.failed.length, 0, JSON.stringify(s2.failed));
  const move = h.monday.writes.find((w) => w.op === 'move_board');
  assert.deepEqual(move?.args, [itemId, PREQUAL, TRIAGE, 'new_group12986'], 'R3: to Triage / Triage');
  assert.equal((await rows(`select status from task where dedupe_key = $1`, [`sync_failure:prequal_estimate_due:${itemId}:due_date`]))[0].status, 'done');
});

test('Closed Lost while on Triage → status + notes on Triage, then moved to Pre-Sales Lost', async () => {
  const h = harness(opp({ StageName: 'Engineering' }));
  const s1 = await h.run();
  const itemId = s1.results[0].result.createdItemId!;
  assert.equal(h.monday.writes.find((w) => w.op === 'create')!.args[0], TRIAGE);

  h.setOpp(opp({ StageName: 'Closed Lost', Lost_Reason__c: 'Price' }));
  h.monday.writes.length = 0;
  const s2 = await h.run();
  assert.equal(s2.failed.length, 0, JSON.stringify(s2.failed));
  const [change, move] = h.monday.writes;
  assert.equal(change.op, 'change');
  assert.equal(change.args[0], TRIAGE, 'writes go to the board the item is on');
  assert.deepEqual((change.args[2] as any).status9, { index: 2 }, 'Lost');
  assert.ok((change.args[2] as any).long_text_notes, 'Win/Loss notes');
  assert.deepEqual(move.args, [itemId, TRIAGE, PRESALES, 'new_group64129'], 'then to Pre-Sales / Lost');

  // Steady afterwards: nothing more to do.
  h.monday.writes.length = 0;
  await h.run();
  assert.equal(h.monday.writes.length, 0);
});

test('create_items = false → nothing created, nothing fails', async () => {
  await db.query(`update config_settings set value = 'false'::jsonb where key = 'create_items'`);
  const h = harness(opp());
  const s = await h.run();
  assert.equal(s.failed.length, 0);
  assert.equal(h.monday.writes.length, 0);
});
