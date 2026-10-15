/**
 * Triage moves (R5 / R7) + Estimator writeback (Seth 2026-10-15): the pure rules,
 * then end to end below the network against the real migrations (intake +
 * sync_triage_and_estimator.sql, each run twice), real config loader, writeGate,
 * and the monday-event routing.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from './helpers/pglite.mts';
import { fakeMonday, fakeSalesforce } from './helpers/fakes.mts';
import { loadRuntimeConfig, type RuntimeConfig } from '../src/config/load.ts';
import { createWriteGate } from '../src/writeGate.ts';
import { insertLink } from '../src/db/store.ts';
import { pickEstimator, planEstimator, planTriage, unmappedEngineerKey, type AssignItem, type EstimatorInput } from '../src/assign/plan.ts';
import { retryUnmappedEngineers, runAssignment, runEstimatorFirstPass } from '../src/assign/run.ts';
import { drainInbox, type WorkerDeps } from '../src/worker/process.ts';
import type { SfEstimatorContext, SfUser } from '../src/salesforce/client.ts';

const migration = (f: string) => readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${f}`, import.meta.url)), 'utf8');
const PRESALES = '3477536693';
const TRIAGE = '18435527543';
const ITEM = '13300000001';
const OPP = '006AAA000000001';
const LINE = '00kAAA000000001';
const LEE = { Id: '005LEE000000001', Name: 'Lee Thompson', Email: 'lee@example.com' };
const SHAUN = { Id: '005SHA000000001', Name: 'Shaun Lee', Email: 'shaun@example.com' };
const REP = { id: '005REP000000001', name: 'Luke Wood', email: 'luke@example.com' };
const U = { lee: '33940238', shaun: '36489661', mitch: '36489667', stranger: '99999999' };

let db: TestDb;
let cfg: RuntimeConfig;
beforeEach(async () => {
  db = await createTestDb();
  const intake = migration('sync_intake_boards.sql');
  const mine = migration('sync_triage_and_estimator.sql');
  await db.pg.exec(`reset role; ${intake} ${mine} ${intake} ${mine}
    update config_field_registry set monday_column_id = 'bid_decision' where semantic_key = 'triage.bid_decision';
    update config_settings set value = 'true'::jsonb where key = 'estimator_writeback';
    set role sync_engine;`);
  cfg = await loadRuntimeConfig(db);
});
afterEach(async () => { await db.close(); });
const rows = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows;

function ctx(over: Partial<SfEstimatorContext> = {}): SfEstimatorContext {
  return { lineItemId: LINE, opportunityId: OPP, opportunityName: 'Acme HQ', opportunityClosed: false, estimatorId: null, estimatorName: null, rep: REP, ...over };
}
function item(over: Partial<AssignItem> = {}): AssignItem {
  return { id: ITEM, name: 'Acme HQ', boardKey: 'presales', groupId: 'new_group12986', statusLabelId: 0, engineerUserIds: [U.lee], bidLabelId: null, ...over };
}
const users = (...us: SfUser[]) => new Map(us.map((u) => [u.Name, [u]]));

// ── Pure rules ──────────────────────────────────────────────────────────────
test('migration: engineer map (4 ignored), Bid Decision labels, settings; re-runnable', async () => {
  assert.equal(Object.keys(cfg.estimators).length, 20);
  assert.equal(Object.values(cfg.estimators).filter((r) => r.ignore).length, 4);
  assert.equal(cfg.estimators[U.mitch].ignore, true);
  assert.equal(cfg.estimators['52972596'].sfUserName, 'Jerry Bates');
  assert.equal(cfg.planner.labels['triage.bid_decision.bid'], 1);
  assert.equal(cfg.planner.labels['triage.bid_decision.no_bid'], 2);
  assert.equal(cfg.settings.estimator_rep_email, true);
  const fresh = await loadRuntimeConfig(db);
  assert.equal(fresh.planner.columns['triage.bid_decision'].boardKey, 'triage');
});

test('pickEstimator: first mappable person; ignored skipped; unknown or unmatched blocks; empty clears', () => {
  const m = cfg.estimators;
  assert.deepEqual(pickEstimator([U.lee, U.shaun], m, users(LEE, SHAUN)), { kind: 'user', user: LEE, mondayUserId: U.lee });
  assert.equal((pickEstimator([U.mitch, U.shaun], m, users(SHAUN)) as any).user.Id, SHAUN.Id, 'Mitch is ignored → next person');
  assert.deepEqual(pickEstimator([U.mitch], m, users()), { kind: 'none' });
  assert.deepEqual(pickEstimator([], m, users()), { kind: 'clear' });
  assert.equal((pickEstimator([U.stranger, U.lee], m, users(LEE)) as any).why, 'no_mapping', 'unknown first person blocks (may be the lead)');
  assert.equal((pickEstimator([U.lee], m, users()) as any).why, 'no_sf_user');
  assert.equal((pickEstimator([U.lee], m, new Map([['Lee Thompson', [LEE, { ...LEE, Id: '005DUP' }]]])) as any).why, 'no_sf_user', 'two users by that name');
});

test('planTriage: No-Bid → R5 (status + Declined to Bid); Bid + engineer → R7; otherwise nothing', () => {
  const p = cfg.planner;
  const r5 = planTriage(p, item({ boardKey: 'triage', bidLabelId: 2 }));
  assert.equal(r5?.rule, 'R5');
  assert.deepEqual(r5?.moveTo, { boardKey: 'presales', groupKey: 'declined_to_bid' });
  assert.deepEqual(r5?.columnWrites, [{ semanticKey: 'presales.status', value: { type: 'status', labelId: 7 } }]);
  assert.deepEqual(planTriage(p, item({ boardKey: 'triage', bidLabelId: 2, statusLabelId: 7 }))?.columnWrites, [], 'status already Declined');
  assert.equal(planTriage(p, item({ boardKey: 'triage', bidLabelId: 1 }))?.rule, 'R7');
  assert.equal(planTriage(p, item({ boardKey: 'triage', bidLabelId: 1, engineerUserIds: [] })), null, 'Bid, no engineer yet');
  assert.equal(planTriage(p, item({ boardKey: 'triage', bidLabelId: null })), null, 'engineer, no decision yet');
  assert.equal(planTriage(p, item({ boardKey: 'presales', bidLabelId: 2 })), null, 'only on Triage');
});

test('planEstimator: patch + rep email; the cases that leave Salesforce alone', () => {
  const base: EstimatorInput = {
    item: item(), closedGroup: false, noBid: false, link: { sfLineItemId: LINE, sfOpportunityId: OPP, linkState: 'active' },
    ctx: ctx(), pick: { kind: 'user', user: LEE, mondayUserId: U.lee }, firstPass: false, repEmail: true,
    itemLabel: 'Acme HQ (monday item 1)', sfBaseUrl: 'https://instrata.lightning.force.com',
  };
  const d = planEstimator(base);
  assert.equal(d.kind, 'patch');
  if (d.kind !== 'patch') return;
  assert.equal(d.estimatorId, LEE.Id);
  assert.equal(d.repEmail?.to, REP.email);
  assert.match(d.repEmail!.body, /Lee Thompson is estimating Acme HQ/);
  assert.match(d.repEmail!.body, /lightning\/r\/Opportunity\/006AAA000000001\/view/);

  assert.equal((planEstimator({ ...base, firstPass: true }) as any).repEmail, null, 'first pass: no rep email');
  assert.equal((planEstimator({ ...base, repEmail: false }) as any).repEmail, null, 'setting off');
  assert.equal((planEstimator({ ...base, ctx: ctx({ rep: { ...REP, id: LEE.Id } }) }) as any).repEmail, null, 'rep is the estimator');
  assert.equal((planEstimator({ ...base, ctx: ctx({ rep: null }) }) as any).repEmail, null, 'no rep');
  assert.equal(planEstimator({ ...base, ctx: ctx({ estimatorId: LEE.Id }) }).kind, 'none', 'already matches');
  assert.equal(planEstimator({ ...base, closedGroup: true }).kind, 'none');
  assert.equal(planEstimator({ ...base, noBid: true }).kind, 'none');
  assert.equal(planEstimator({ ...base, ctx: ctx({ opportunityClosed: true }) }).kind, 'none');
  assert.equal(planEstimator({ ...base, link: null }).kind, 'none');
  assert.equal(planEstimator({ ...base, ctx: null }).kind, 'none');

  const cleared = planEstimator({ ...base, pick: { kind: 'clear' }, ctx: ctx({ estimatorId: SHAUN.Id, estimatorName: SHAUN.Name }) });
  assert.equal(cleared.kind, 'patch');
  assert.equal((cleared as any).estimatorId, null);
  assert.equal((cleared as any).repEmail, null, 'clearing emails nobody');

  const task = planEstimator({ ...base, pick: { kind: 'blocked', mondayUserId: U.stranger, mondayName: 'New Person', why: 'no_mapping' } });
  assert.equal(task.kind, 'task');
  assert.equal((task as any).task.dedupeKey, unmappedEngineerKey(U.stranger));
  assert.equal((task as any).task.member.id, ITEM);
});

// ── End to end ──────────────────────────────────────────────────────────────
function harness(opts: { mode?: 'live' | 'dry_run'; estimator?: Partial<SfEstimatorContext>; users?: SfUser[] } = {}) {
  const monday = fakeMonday();
  const sf = fakeSalesforce({ estimatorContexts: [ctx(opts.estimator)], users: opts.users ?? [LEE, SHAUN] });
  const gate = createWriteGate(opts.mode ?? 'live', monday.client, sf.client);
  const deps = () => ({ db, gate, monday: monday.client, salesforce: sf.client, cfg, salesforceLoginUrl: 'https://instrata.my.salesforce.com' });
  const put = (board: string, group: string, cols: { engineers?: string[]; bid?: number | null; status?: number }) => {
    monday.addItem(ITEM, {
      person: JSON.stringify({ personsAndTeams: (cols.engineers ?? []).map((id) => ({ id: Number(id), kind: 'person' })) }),
      status9: JSON.stringify({ index: cols.status ?? 0 }),
      ...(cols.bid ? { bid_decision: JSON.stringify({ index: cols.bid }) } : {}),
    }, group);
    monday.items.get(ITEM)!.board = { id: board };
  };
  return { monday, sf, deps, put };
}
const link = () => insertLink(db, { mondayItemId: ITEM, sfOpportunityId: OPP, sfLineItemId: LINE, baseline: {} }, 'live');

test('R5: No-Bid on Triage → status Declined to Bid, moved to Pre-Sales / Declined to Bid, Salesforce untouched', async () => {
  const h = harness();
  await link();
  h.put(TRIAGE, 'new_group66048', { engineers: [U.lee], bid: 2 });
  const r = await runAssignment(h.deps(), ITEM, '33940282');
  assert.equal(r.triage, 'R5');
  assert.deepEqual(h.monday.writes.map((w) => w.op), ['change', 'move_board']);
  assert.deepEqual(h.monday.writes[0].args[2], { status9: { index: 7 } });
  assert.deepEqual(h.monday.writes[1].args, [ITEM, TRIAGE, PRESALES, 'new_group']);
  assert.equal(h.sf.patches.length, 0, 'No-Bid never writes Salesforce');
  assert.equal((await rows(`select count(*)::int n from event_log where event_type = 'group_moved' and details->>'rule' = 'R5'`))[0].n, 1);
});

test('R7 + Estimator: Bid + engineer → New Requests; Estimator written; rep emailed', async () => {
  const h = harness();
  await link();
  h.put(TRIAGE, 'group_mm84ys96', { engineers: [U.lee, U.shaun], bid: 1 });
  const r = await runAssignment(h.deps(), ITEM, '33940282');
  assert.equal(r.triage, 'R7');
  assert.deepEqual(h.monday.writes.map((w) => w.op), ['move_board']);
  assert.deepEqual(h.monday.writes[0].args, [ITEM, TRIAGE, PRESALES, 'new_group12986']);
  assert.deepEqual(h.sf.patches, [{ id: LINE, values: { Estimator__c: LEE.Id } }], 'first person in the column');
  assert.equal(h.sf.emails.length, 1);
  assert.equal(h.sf.emails[0].to, REP.email);
  const ev = (await rows(`select old_value, new_value from event_log where event_type = 'writeback' and field = 'Estimator__c'`))[0];
  assert.deepEqual(ev.new_value, { id: LEE.Id, name: LEE.Name });

  // Re-running changes nothing (Salesforce now matches; the item is on Pre-Sales).
  h.monday.items.get(ITEM)!.board = { id: PRESALES };
  const again = await runAssignment(h.deps(), ITEM, null);
  assert.equal(again.estimator, 'none');
  assert.equal(h.sf.patches.length, 1);
  assert.equal(h.sf.emails.length, 1);
});

test('engineer changed → overwrite + email; column emptied → cleared, no email; closed group → untouched', async () => {
  const h = harness({ estimator: { estimatorId: LEE.Id, estimatorName: LEE.Name } });
  await link();
  h.put(PRESALES, 'new_group12986', { engineers: [U.shaun] });
  await runAssignment(h.deps(), ITEM, null);
  assert.deepEqual(h.sf.patches.at(-1), { id: LINE, values: { Estimator__c: SHAUN.Id } });
  assert.equal(h.sf.emails.length, 1);

  h.put(PRESALES, 'new_group12986', { engineers: [] });
  await runAssignment(h.deps(), ITEM, null);
  assert.deepEqual(h.sf.patches.at(-1), { id: LINE, values: { Estimator__c: null } });
  assert.equal(h.sf.emails.length, 1, 'clearing sends no email');

  h.put(PRESALES, 'new_group52602', { engineers: [U.lee] }); // Won
  await runAssignment(h.deps(), ITEM, null);
  assert.equal(h.sf.patches.length, 2, 'Won group: monday edits no longer touch Salesforce');
});

test('a failed rep email keeps the Estimator write and logs notify_failed', async () => {
  const h = harness();
  await link();
  h.sf.failEmail(new Error('NO_MASS_MAIL_PERMISSION'));
  h.put(PRESALES, 'new_group12986', { engineers: [U.lee] });
  await runAssignment(h.deps(), ITEM, null);
  assert.equal(h.sf.patches.length, 1);
  assert.equal((await rows(`select count(*)::int n from event_log where event_type = 'notified' and not applied`))[0].n, 1);
});

test('unknown engineer → grouped task for Hope; mapping them + the hourly retry writes it and closes the task', async () => {
  const h = harness({ users: [LEE, SHAUN, { Id: '005NEW000000001', Name: 'New Person', Email: null }] });
  await link();
  h.put(PRESALES, 'new_group12986', { engineers: [U.stranger, U.lee] });
  await runAssignment(h.deps(), ITEM, null);
  assert.equal(h.sf.patches.length, 0, 'blocked: the unknown person may be the lead');
  const t = (await rows(`select status, source_ref from task where dedupe_key = $1`, [unmappedEngineerKey(U.stranger)]))[0];
  assert.equal(t.status, 'not_started');
  assert.deepEqual(t.source_ref.members.map((m: any) => m.id), [ITEM]);

  await db.pg.exec(`reset role; insert into map_estimator (monday_user_id, monday_name, sf_user_name) values (${U.stranger}, 'New Person', 'New Person'); set role sync_engine;`);
  cfg = await loadRuntimeConfig(db);
  assert.equal(await retryUnmappedEngineers(h.deps()), 1);
  assert.deepEqual(h.sf.patches, [{ id: LINE, values: { Estimator__c: '005NEW000000001' } }]);
  assert.equal((await rows(`select status from task where dedupe_key = $1`, [unmappedEngineerKey(U.stranger)]))[0].status, 'done');
});

test('dry run: nothing written, dry_run_write events instead', async () => {
  const h = harness({ mode: 'dry_run' });
  await link();
  h.put(TRIAGE, 'group_mm84ys96', { engineers: [U.lee], bid: 1 });
  await runAssignment(h.deps(), ITEM, null);
  assert.equal(h.monday.writes.length, 0);
  assert.equal(h.sf.patches.length, 0);
  assert.equal(h.sf.emails.length, 0);
  const ops = (await rows(`select details->>'op' op from event_log where event_type = 'dry_run_write' order by id`)).map((r) => r.op);
  assert.deepEqual(ops, ['move_item_to_board', 'patch_line_item', 'send_email']);
});

test('estimator_writeback off → Triage moves still run, Salesforce untouched', async () => {
  await db.pg.exec(`reset role; update config_settings set value = 'false'::jsonb where key = 'estimator_writeback'; set role sync_engine;`);
  cfg = await loadRuntimeConfig(db);
  const h = harness();
  await link();
  h.put(TRIAGE, 'group_mm84ys96', { engineers: [U.lee], bid: 1 });
  const r = await runAssignment(h.deps(), ITEM, null);
  assert.equal(r.triage, 'R7');
  assert.equal(h.sf.patches.length, 0);
});

test('first pass: preview writes nothing; apply overwrites, emails no rep, skips closed deals', async () => {
  const h = harness({ estimator: { estimatorId: SHAUN.Id, estimatorName: SHAUN.Name } });
  await link();
  h.put(PRESALES, 'new_group12986', { engineers: [U.lee] });
  const preview = await runEstimatorFirstPass(h.deps(), { apply: false });
  assert.deepEqual(preview.counts, { replace: 1 });
  assert.equal(preview.rows[0].salesforceNow, 'Shaun Lee');
  assert.equal(preview.rows[0].willBe, 'Lee Thompson');
  assert.equal(h.sf.patches.length, 0);

  const applied = await runEstimatorFirstPass(h.deps(), { apply: true });
  assert.deepEqual(applied.counts, { replace: 1 });
  assert.deepEqual(h.sf.patches, [{ id: LINE, values: { Estimator__c: LEE.Id } }]);
  assert.equal(h.sf.emails.length, 0, 'no rep emails on the first pass');

  h.sf.estimatorContexts.get(LINE)!.opportunityClosed = true;
  const closed = await runEstimatorFirstPass(h.deps(), { apply: false });
  assert.deepEqual(closed.counts, { 'skipped (closed / not found)': 1 });
});

test('routing: an engineer change waits out the debounce, then writes; a Bid Decision change is logged', async () => {
  const h = harness();
  await link();
  h.put(TRIAGE, 'group_mm84ys96', { engineers: [U.lee], bid: 1 });
  const d: WorkerDeps = { db, gate: createWriteGate('live', h.monday.client, h.sf.client), monday: h.monday.client, salesforce: h.sf.client, getConfig: () => loadRuntimeConfig(db), integrationUserId: '119228546', salesforceLoginUrl: 'https://instrata.my.salesforce.com' };
  const enqueue = (columnId: string, agoSec: number) => db.query(
    `insert into webhook_inbox (source, payload, dedupe_hash, received_at) values ('monday', $1::jsonb, $2, now() - make_interval(secs => $3))`,
    [JSON.stringify({ event: { type: 'update_column_value', boardId: Number(TRIAGE), pulseId: Number(ITEM), columnId, userId: 33940282, value: { label: { index: 1, text: 'Bid' } }, previousValue: null, triggerUuid: `t-${columnId}-${agoSec}` } }), `h-${columnId}-${agoSec}`, agoSec]);

  await enqueue('person', 0);
  await drainInbox(d);
  assert.equal(h.sf.patches.length, 0, 'deferred');
  assert.equal((await rows(`select status from webhook_inbox`))[0].status, 'pending');

  await db.query(`update webhook_inbox set received_at = now() - interval '2 minutes', next_attempt_at = now()`);
  await enqueue('bid_decision', 120);
  await drainInbox(d);
  assert.equal(h.sf.patches.length, 1, 'the older person event is superseded by the newer bid event; one write');
  assert.equal(h.monday.writes.filter((w) => w.op === 'move_board').length, 1);
  const bid = (await rows(`select actor, new_value from event_log where event_type = 'field_changed' and field = 'triage.bid_decision'`))[0];
  assert.equal(bid.actor, '33940282');
  assert.equal(bid.new_value.label.text, 'Bid');
});
