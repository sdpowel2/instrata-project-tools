/**
 * Stage 'notify' + Win % without Confirmed to Win (Seth 2026-10-28), end to end
 * below the network: real migrations (incl. sync_stage_notify.sql, run twice),
 * real config loader, planner, executor and writeGate; fake monday / Salesforce.
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

const MIGRATION = fileURLToPath(new URL('../../supabase/migrations/sync_stage_notify.sql', import.meta.url));
const OPP = '006AAA000000001';
const LINE = '00kAAA000000001';

function opp(over: Partial<SfOpportunity> = {}): SfOpportunity {
  return {
    Id: OPP, Name: 'Acme HQ – Boardroom', StageName: 'Delivered to Customer',
    Estimate_Due_Date_Time__c: null, Estimate_Number__c: 'Q-1001',
    Win_Likelihood__c: '50%', Business_Unit__c: null, Sales_Rep__c: '005REP', Sales_Rep__r: { Name: 'Luke Wood' },
    Lost_Reason__c: null, Other_lost_reason__c: null, Lost_To__c: null,
    SystemModstamp: '2026-10-10T12:00:00.000+0000', LastModifiedById: '005USER', LastModifiedBy: { Name: 'Max Jaeger' },
    lineItems: [{ Id: LINE, isAVProduct__c: true, Technology__c: 'AV', UnitPrice: 0, Quantity: 1, Sold_in_Margin__c: null, CreatedDate: 'c' }],
    ...over,
  };
}

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
  const sql = readFileSync(MIGRATION, 'utf8');
  await db.pg.exec(`reset role; ${sql} ${sql} set role sync_engine;`); // re-runnable
});
afterEach(async () => { await db.close(); });

function harness(o: SfOpportunity) {
  const monday = fakeMonday();
  const sf = fakeSalesforce({ opps: [o] });
  const gate = createWriteGate('live', monday.client, sf.client);
  const deps = { db, gate, monday: monday.client, salesforce: sf.client, getConfig: () => loadRuntimeConfig(db), salesforceLoginUrl: 'https://acme.my.salesforce.com' };
  return { monday, sf, run: () => reconcileOpportunities(deps, [OPP]), setOpp: (x: SfOpportunity) => sf.opps.set(x.Id, x) };
}
const statusCol = async () => (await loadRuntimeConfig(db)).planner.columns['presales.status'].columnId!;
const winCol = async () => (await loadRuntimeConfig(db)).planner.columns['presales.win_pct'].columnId!;

test('migration: notify stages, recipients, no Confirmed to Win, 99/100% → 75%', async () => {
  const cfg = await loadRuntimeConfig(db);
  for (const s of ['Rebid', 'On Hold', 'Closed Won', 'Closed Lost', 'Declined to Bid', 'Canceled']) {
    assert.equal(cfg.maps.stageAction[s].action, 'notify', s);
  }
  assert.equal(cfg.maps.stageAction['Contract In House'].action, 'stage_check_contract', 'stage checks untouched');
  assert.deepEqual(cfg.planner.confirmedWinPcts, [], 'an empty list stays empty');
  assert.equal(cfg.maps.winPct['99%'], 3);
  assert.equal(cfg.maps.winPct['100%'], 3);
  assert.equal((cfg.settings.stage_change_recipients as string[]).length, 3);
});

test('Closed Won: nothing written to monday, one email to the recipients, logged', async () => {
  const h = harness(opp());
  const s1 = await h.run();
  assert.equal(s1.failed.length, 0, JSON.stringify(s1.failed));
  assert.equal(h.sf.emails.length, 0, 'creating the item is not a stage change');
  const itemId = s1.results[0].result.createdItemId!;

  h.setOpp(opp({ StageName: 'Closed Won' }));
  h.monday.writes.length = 0;
  const s2 = await h.run();
  assert.equal(s2.failed.length, 0, JSON.stringify(s2.failed));
  const col = await statusCol();
  assert.ok(!h.monday.writes.some((w) => w.op === 'change' && col in (w.args[2] as object)), 'no status write');
  assert.ok(!h.monday.writes.some((w) => w.op.startsWith('move') || w.op === 'archive'), 'no move / archive');

  assert.equal(h.sf.emails.length, 1);
  const m = h.sf.emails[0];
  assert.equal(m.to, 'lee.thompson@instrata.com,isaac.garner@instrata.com,kelina.bauman@instrata.com');
  assert.equal(m.subject, 'Salesforce: Acme HQ – Boardroom is now Closed Won');
  assert.match(m.body, /moved from Delivered to Customer to Closed Won in Salesforce \(changed by Max Jaeger\)/);
  assert.match(m.body, /Sales Rep: Luke Wood/);
  assert.match(m.body, /https:\/\/acme\.lightning\.force\.com\/lightning\/r\/Opportunity\/006AAA000000001\/view/);
  assert.match(m.body, /monday: Pre-Sales Summary \/ New Requests/);
  assert.equal(m.relatedRecordId, OPP);

  const ev = (await db.query<any>(`select entity_id, applied, details from event_log where event_type = 'notified'`)).rows;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.to_stage, 'Closed Won');
  const won = (await db.query<any>(`select 1 from task where dedupe_key like 'won_%' and source_ref->>'monday_item_id' = $1`, [itemId])).rows;
  assert.equal(won.length, 0, 'no Won tasks: nobody set Won yet');

  // Same stage again → no second email.
  await h.run();
  assert.equal(h.sf.emails.length, 1);
});

test('a failed email is logged and does not hold back the field sync', async () => {
  const h = harness(opp());
  await h.run();
  h.sf.client.sendEmail = async () => { throw new Error('SINGLE_EMAIL_LIMIT_EXCEEDED'); };
  h.setOpp(opp({ StageName: 'Closed Lost', Estimate_Number__c: 'Q-2002' }));
  const s = await h.run();
  assert.equal(s.failed.length, 0, JSON.stringify(s.failed));
  const ev = (await db.query<any>(`select applied, details from event_log where event_type = 'notified'`)).rows;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].applied, false);
  assert.match(ev[0].details.error, /SINGLE_EMAIL_LIMIT_EXCEEDED/);
  const link = (await db.query<any>(`select last_synced_values from sf_link`)).rows[0];
  assert.equal(link.last_synced_values['sf.stage'], 'Closed Lost', 'baseline advanced; no retry storm');
});

test('Win % 99% writes the 75% label and never sets Won', async () => {
  const h = harness(opp());
  await h.run();
  h.setOpp(opp({ Win_Likelihood__c: '99%' }));
  h.monday.writes.length = 0;
  const s = await h.run();
  assert.equal(s.failed.length, 0, JSON.stringify(s.failed));
  const [wc, sc] = [await winCol(), await statusCol()];
  const change = h.monday.writes.find((w) => w.op === 'change')!;
  const values = change.args[2] as Record<string, any>;
  assert.deepEqual(values[wc], { ids: [3] }, '75% label');
  assert.ok(!(sc in values), 'no status write');
  assert.equal(h.sf.emails.length, 0);
});
