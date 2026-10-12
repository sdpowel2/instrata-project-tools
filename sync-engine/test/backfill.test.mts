import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { planBackfill, idsToFetch, type BackfillItem, type SfLineRef } from '../src/backfill/plan.ts';
import { runBackfill } from '../src/backfill/run.ts';
import { loadRuntimeConfig } from '../src/config/load.ts';
import { createTestDb, type TestDb } from './helpers/pglite.mts';
import { fakeMonday, fakeSalesforce } from './helpers/fakes.mts';

const L1 = '00kAAA000000001AAA';
const L2 = '00kAAA000000002AAA';
const O1 = '006AAA000000001AAA';
const O2 = '006AAA000000002AAA';
const O3 = '006AAA000000003AAA';
const line = (id: string, opp: string, stage = 'Engineering'): SfLineRef => ({ id, opportunityId: opp, stage });
const item = (id: string, sfId: string | null, name = `Item ${id}`): BackfillItem => ({ id, name, sfId });

function input(items: BackfillItem[], extra: Partial<Parameters<typeof planBackfill>[0]> = {}) {
  return {
    items,
    lineItems: new Map([[L1, line(L1, O1, 'Closed Won')], [L2, line(L2, O2)]]),
    avLinesByOpp: new Map<string, SfLineRef[]>([
      [O1.slice(0, 15), [line(L1, O1, 'Closed Won')]],
      [O3.slice(0, 15), [line('00kAAA000000003AAA', O3), line('00kAAA000000004AAA', O3)]],
    ]),
    alreadyLinkedItems: new Set<string>(),
    alreadyLinkedLines: new Set<string>(),
    ...extra,
  };
}

test('plan: links line ids (15 or 18 chars), resolves single-AV opportunity ids, leaves blanks alone', () => {
  const p = planBackfill(input([item('1', L1), item('2', L2.slice(0, 15)), item('3', null), item('4', '  ')]));
  assert.deepEqual(p.links.map((l) => [l.mondayItemId, l.sfLineItemId, l.via, l.stage]), [
    ['1', L1, 'line_id', 'Closed Won'],
    ['2', L2, 'line_id', 'Engineering'],
  ]);
  assert.equal(p.counts.blank, 2);
  assert.equal(p.counts.problems, 0);

  const viaOpp = planBackfill(input([item('5', O1)]));
  assert.deepEqual(viaOpp.links.map((l) => [l.sfLineItemId, l.via]), [[L1, 'opportunity_id']], 'the "UC Water – Soundmasking" case');
});

test('plan: every problem kind becomes a grouped-task member with what to check', () => {
  const p = planBackfill(input([
    item('10', '00kZZZ000000009AAA', 'Gone Job'),   // not in Salesforce
    item('11', 'see Q-1001', 'Typo Job'),           // not an id
    item('12', O3, 'Two AV Job'),                    // opp with two AV lines
    item('13', O2, 'No AV Opp'),                     // opp exists? not in map → not_found
    item('20', L1, 'First'),
    item('21', L1, 'Second'),                        // duplicate
  ]));
  assert.deepEqual(p.problems.not_found.map((m) => m.id).sort(), ['10', '13']);
  assert.deepEqual(p.problems.bad_id.map((m) => m.id), ['11']);
  assert.deepEqual(p.problems.opp_unresolved.map((m) => m.id), ['12']);
  assert.deepEqual(p.problems.duplicate.map((m) => m.id), ['21'], 'lowest item id wins the line');
  assert.equal(p.links.length, 1);
  assert.match(p.problems.bad_id[0].label, /Typo Job \(monday item 11; Salesforce ID "see Q-1001"\)/);
});

test('plan: re-run skips linked items and never double-claims a linked line', () => {
  const p = planBackfill(input([item('1', L1), item('2', L1)], { alreadyLinkedItems: new Set(['1']), alreadyLinkedLines: new Set([L1]) }));
  assert.equal(p.counts.alreadyLinked, 1);
  assert.deepEqual(p.problems.duplicate.map((m) => m.id), ['2']);
  assert.equal(p.links.length, 0);
});

test('idsToFetch splits line and opportunity ids, ignoring junk', () => {
  assert.deepEqual(idsToFetch([item('1', L1), item('2', O1), item('3', 'x'), item('4', null)]), { lineIds: [L1], oppIds: [O1] });
});

// ── Against the real migration ──
let db: TestDb;
beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await db.close(); });

async function setup() {
  const monday = fakeMonday();
  monday.addItem('1001', { text_mkv2656m: JSON.stringify(L1) });
  monday.addItem('1002', { text_mkv2656m: JSON.stringify('junk') });
  monday.addItem('1003', { text_mkv2656m: null });
  const sf = fakeSalesforce();
  sf.setQueryResults({
    'FROM OpportunityLineItem WHERE Id IN': [{ Id: L1, OpportunityId: O1, Opportunity: { StageName: 'Canceled' } }],
  });
  // fake pageBoardItems: hand over the fake items
  monday.client.pageBoardItems = async (_b, _c, onPage) => { await onPage([...monday.items.values()].map((i) => ({ ...i, column_values: i.column_values.map((c) => ({ ...c, text: c.value ? JSON.parse(c.value) : null })) }))); };
  const deps = { db, monday: monday.client, salesforce: sf.client, cfg: await loadRuntimeConfig(db) };
  return { monday, sf, deps };
}
const rows = async (sql: string) => (await db.query<any>(sql)).rows;

test('preview saves nothing', async () => {
  const { deps } = await setup();
  const r = await runBackfill(deps, { preview: true, reconcile: true });
  assert.equal(r.counts.linkByLineId, 1);
  assert.equal(r.problems.bad_id.count, 1);
  assert.equal((await rows('select count(*)::int n from sf_link'))[0].n, 0);
  assert.equal((await rows('select count(*)::int n from task'))[0].n, 0);
});

test('run: links with a stage-only baseline in both columns, opens grouped problem task, queues a reconcile; re-run is a no-op', async () => {
  const { deps, monday } = await setup();
  const r = await runBackfill(deps, { preview: false, reconcile: true });
  assert.equal(r.linked, 1);
  assert.equal(r.reconcilesQueued, 1);
  const link = (await rows('select monday_item_id::text id, last_synced_values l, dry_run_synced_values d from sf_link'))[0];
  assert.deepEqual([link.id, link.l, link.d], ['1001', { 'sf.stage': 'Canceled' }, { 'sf.stage': 'Canceled' }],
    'seeded stage: a long-canceled item will NOT be archived / @mention its engineer on first reconcile');
  const task = (await rows(`select title, source_ref from task where dedupe_key = 'sync_failure:backfill:bad_id'`))[0];
  assert.match(task.title, /isn't a Salesforce ID/);
  assert.deepEqual(task.source_ref.members.map((m: any) => m.id), ['1002']);
  assert.equal(monday.writes.length, 0, 'never writes to monday');

  const again = await runBackfill(deps, { preview: false, reconcile: true });
  assert.equal(again.linked, 0);
  assert.equal(again.counts.alreadyLinked, 1);
  assert.equal((await rows('select count(*)::int n from task'))[0].n, 1);

  // Someone fixes the junk id → next run drops it from the task, which closes.
  monday.setCol(monday.items.get('1002')!, 'text_mkv2656m', JSON.stringify(''));
  await runBackfill(deps, { preview: false, reconcile: false });
  assert.equal((await rows(`select status from task where dedupe_key = 'sync_failure:backfill:bad_id'`))[0].status, 'done');
});
