/**
 * End to end below the network: real migration + seeds (PGlite), real config
 * loader, real planner, real executor, real writeGate — fake monday and
 * Salesforce clients that record every call.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './helpers/pglite.mts';
import { loadRuntimeConfig } from '../src/config/load.ts';
import { insertLink } from '../src/db/store.ts';
import type { MondayClient, MondayItemRaw } from '../src/monday/client.ts';
import type { SalesforceClient } from '../src/salesforce/client.ts';
import { createWriteGate } from '../src/writeGate.ts';
import { reconcileOpportunities } from '../src/reconcile/service.ts';
import type { SfOpportunity } from '../src/reconcile/types.ts';

const OPP = '006AAA000000001';
const LINE = '00kAAA000000001';
const NOTES_COL = 'long_text_notes';

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

/** In-memory monday: items + a log of write calls. */
function fakeMonday() {
  const items = new Map<string, MondayItemRaw>();
  const writes: { op: string; args: unknown[] }[] = [];
  let nextId = 5000;
  let failNextChange = false;
  const client: MondayClient = {
    query: async () => { throw new Error('not used'); },
    getItems: async (ids) => ids.map((id) => items.get(id)).filter((x): x is MondayItemRaw => !!x),
    pageBoardItems: async () => {},
    getColumnLabels: async () => [],
    listWebhooks: async () => [],
    async changeColumnValues(boardId, itemId, values) {
      if (failNextChange) { failNextChange = false; throw new Error('monday 500'); }
      writes.push({ op: 'change', args: [boardId, itemId, values] });
      const it = items.get(itemId);
      const v = values as Record<string, any>;
      if (it && v.status9) setCol(it, 'status9', JSON.stringify(v.status9));
    },
    async createItem(boardId, groupId, name, values) {
      const id = String(nextId++);
      writes.push({ op: 'create', args: [boardId, groupId, name, values] });
      items.set(id, { id, name, state: 'active', group: { id: groupId ?? '' }, column_values: [] });
      return id;
    },
    async moveItemToGroup(itemId, groupId) { writes.push({ op: 'move', args: [itemId, groupId] }); },
    async archiveItem(itemId) { writes.push({ op: 'archive', args: [itemId] }); const it = items.get(itemId); if (it) it.state = 'archived'; },
    async createUpdate(itemId, body, mentions) { writes.push({ op: 'update', args: [itemId, body, mentions] }); },
    async createNotification(userId, itemId, text) { writes.push({ op: 'notify', args: [userId, itemId, text] }); },
    async createWebhook() { return 'wh'; },
  };
  function setCol(it: MondayItemRaw, id: string, value: string) {
    const c = it.column_values.find((x) => x.id === id);
    if (c) c.value = value; else it.column_values.push({ id, value, text: null });
  }
  return { client, items, writes, failOnce: () => { failNextChange = true; }, setCol };
}

function fakeSalesforce(state: { opps: Map<string, SfOpportunity> }): SalesforceClient {
  return {
    query: async () => [], queryAll: async () => [],
    getOpportunities: async (ids) => new Map(ids.filter((id) => state.opps.has(id)).map((id) => [id, state.opps.get(id)!])),
    getLineItem: async () => null,
    picklistValues: async () => [],
    patchLineItem: async () => { throw new Error('writeback not under test'); },
  };
}

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb();
  await db.query(`update config_field_registry set monday_column_id = $1 where semantic_key = 'presales.win_loss_notes'`, [NOTES_COL]);
});
afterEach(async () => { await db.close(); });

function harness(mode: 'dry_run' | 'live', o: SfOpportunity = opp()) {
  const monday = fakeMonday();
  const sfState = { opps: new Map([[o.Id, o]]) };
  const salesforce = fakeSalesforce(sfState);
  const gate = createWriteGate(mode, monday.client, salesforce);
  const deps = { db, gate, monday: monday.client, salesforce, getConfig: () => loadRuntimeConfig(db) };
  const run = () => reconcileOpportunities(deps, [OPP]);
  return { monday, sfState, run, setOpp: (x: SfOpportunity) => sfState.opps.set(x.Id, x) };
}

const rows = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows;

test('dry run create: nothing written, no link, intended writes logged', async () => {
  const h = harness('dry_run');
  const s = await h.run();
  assert.equal(s.failed.length, 0, JSON.stringify(s.failed));
  assert.equal(h.monday.writes.length, 0, 'no monday calls in dry run');
  assert.equal((await rows('select count(*)::int n from sf_link'))[0].n, 0);
  const dry = await rows(`select details from event_log where event_type = 'dry_run_write'`);
  assert.equal(dry.length, 1);
  assert.equal(dry[0].details.op, 'create_item');
  assert.equal(dry[0].details.payload.groupId, 'new_group12986');
  assert.deepEqual(dry[0].details.payload.values.date7, { date: '2026-10-15', time: '18:00:00' });
  assert.deepEqual(dry[0].details.payload.values.dropdown2, { ids: [4] }, 'Northeast → Instrata NE by label id');
  assert.equal(dry[0].details.payload.values.text_mkv2656m, LINE);
  assert.equal((await rows(`select count(*)::int n from event_log where event_type = 'created'`))[0].n, 0, 'semantic events only when live');
});

test('dry run on a backfilled link: logs the update, advances only the dry-run baseline, idempotent', async () => {
  await insertLink(db, { mondayItemId: '777', sfOpportunityId: OPP, sfLineItemId: LINE, baseline: { 'sf.stage': 'Engineering' } }, 'live');
  await db.query(`update sf_link set dry_run_synced_values = last_synced_values`);
  const h = harness('dry_run');
  h.monday.items.set('777', { id: '777', name: 'x', state: 'active', group: { id: 'new_group12986' }, column_values: [] });

  await h.run();
  const first = await rows(`select details from event_log where event_type = 'dry_run_write'`);
  assert.equal(first.length, 1);
  assert.equal(first[0].details.op, 'change_multiple_column_values');
  assert.deepEqual(Object.keys(first[0].details.payload.values).sort(), ['date7', 'dropdown2', 'dropdown3', 'dropdown__1', 'text8']);
  const link = (await rows('select last_synced_values, dry_run_synced_values from sf_link'))[0];
  assert.deepEqual(link.last_synced_values, { 'sf.stage': 'Engineering' }, 'live baseline untouched');
  assert.equal(link.dry_run_synced_values['presales.quote_number'], 'Q-1001');

  await h.run();
  assert.equal((await rows(`select count(*)::int n from event_log where event_type = 'dry_run_write'`))[0].n, 1, 'second dry run logs nothing new');
  assert.equal(h.monday.writes.length, 0);
});

test('live create: item created with encoded values, link saved with real id, re-run is a no-op', async () => {
  const h = harness('live');
  await h.run();
  assert.equal(h.monday.writes.length, 1);
  const [boardId, groupId, name, values] = h.monday.writes[0].args as [string, string, string, Record<string, unknown>];
  assert.equal(boardId, '3477536693');
  assert.equal(groupId, 'new_group12986');
  assert.equal(name, 'Acme HQ – Boardroom');
  assert.deepEqual(values.dropdown3, { ids: [1] }, 'Luke Wood');
  assert.equal(values.text8, 'Q-1001');

  const link = (await rows('select monday_item_id::text id, last_synced_values b, dry_run_synced_values d from sf_link'))[0];
  assert.equal(link.id, '5000');
  assert.equal(link.b['sf.stage'], 'Engineering');
  assert.deepEqual(link.d, {}, 'live never writes the dry-run baseline');
  assert.equal((await rows(`select entity_id from event_log where event_type = 'created'`))[0].entity_id, '5000', 'CREATED_ITEM resolved');

  await h.run();
  assert.equal(h.monday.writes.length, 1, 'second reconcile: zero writes');
});

test('live create survives a crash between create_item and the stage write — no duplicate item', async () => {
  const h = harness('live', opp({ StageName: 'Rebid' }));
  h.monday.failOnce();
  const s1 = await h.run();
  assert.equal(s1.failed.length, 1, 'stage write failed');
  const link = (await rows('select last_synced_values b from sf_link'))[0];
  assert.ok(link, 'link saved right after create');
  assert.equal(link.b['sf.stage'], undefined, 'stage not marked synced');

  const s2 = await h.run();
  assert.equal(s2.failed.length, 0, JSON.stringify(s2.failed));
  assert.equal(h.monday.writes.filter((w) => w.op === 'create').length, 1, 'no duplicate create');
  const change = h.monday.writes.find((w) => w.op === 'change')!;
  assert.deepEqual((change.args[2] as any).status9, { index: 8 }, 'Rebid status re-applied');
  assert.equal((await rows('select last_synced_values b from sf_link'))[0].b['sf.stage'], 'Rebid');
});

test('live unmapped value: failure task with mapping table, retried until Hope maps it, then auto-closed', async () => {
  const h = harness('live', opp({ Business_Unit__c: 'Louisiana' }));
  await h.run();
  const create = h.monday.writes[0].args[3] as Record<string, unknown>;
  assert.equal(create.dropdown2, undefined, 'unmapped BU not written');
  const key = `sync_failure:unmapped_value:${OPP}:presales.business_unit`;
  const task = (await rows('select status, source_ref from task where dedupe_key = $1', [key]))[0];
  assert.equal(task.status, 'not_started');
  assert.equal(task.source_ref.mapping_table, 'map_business_unit');

  await h.run();
  assert.equal((await rows(`select count(*)::int n from event_log where event_type = 'sync_failure'`))[0].n, 1, 'reported once');

  await db.query(`update map_business_unit set monday_label_id = 9 where sf_value = 'Louisiana'`);
  await h.run();
  const change = h.monday.writes.find((w) => w.op === 'change')!;
  assert.deepEqual((change.args[2] as any).dropdown2, { ids: [9] });
  const closed = (await rows('select status, close_mode from task where dedupe_key = $1', [key]))[0];
  assert.deepEqual(closed, { status: 'done', close_mode: 'auto' });
});

test('live Closed Lost: notes + status in ONE mutation', async () => {
  const h = harness('live');
  await h.run();
  h.setOpp(opp({ StageName: 'Closed Lost', Lost_Reason__c: 'Cost', Other_lost_reason__c: 'client went with incumbent', Lost_To__c: 'Acme AV' }));
  await h.run();
  const changes = h.monday.writes.filter((w) => w.op === 'change');
  assert.equal(changes.length, 1);
  const values = changes[0].args[2] as Record<string, any>;
  assert.deepEqual(values.status9, { index: 2 });
  assert.deepEqual(values[NOTES_COL], { text: 'Lost/Canceled Reason: Cost · Detail: client went with incumbent · Lost to: Acme AV' });
});

test('live Canceled with no price: @mention update, then archive, link archived', async () => {
  const h = harness('live');
  await h.run();
  h.monday.setCol(h.monday.items.get('5000')!, 'person', '{"personsAndTeams":[{"id":555,"kind":"person"}]}');
  h.setOpp(opp({ StageName: 'Canceled', Lost_Reason__c: 'Project Cancelled' }));
  await h.run();
  const ops = h.monday.writes.map((w) => w.op);
  assert.deepEqual(ops.slice(1), ['update', 'archive'], 'update posted before archiving');
  assert.deepEqual(h.monday.writes[1].args[2], ['555']);
  assert.equal((await rows('select link_state from sf_link'))[0].link_state, 'archived');
});

test('dry run keeps failure tasks but not won / stage-check tasks', async () => {
  await insertLink(db, { mondayItemId: '778', sfOpportunityId: OPP, sfLineItemId: LINE, baseline: { 'sf.stage': 'Engineering' } }, 'live');
  await db.query(`update sf_link set dry_run_synced_values = last_synced_values`);
  const h = harness('dry_run', opp({ StageName: 'Closed Won', Sales_Rep__r: { Name: 'Johnny Price' } }));
  h.monday.items.set('778', { id: '778', name: 'x', state: 'active', group: { id: 'new_group12986' }, column_values: [] });
  await h.run();
  const types = (await rows('select task_type from task order by task_type')).map((r) => r.task_type);
  assert.deepEqual(types, ['sync_failure'], 'unmapped rep persisted; won_handoff/open_job not');
  const dryTasks = await rows(`select details from event_log where event_type = 'dry_run_write' and entity_type = 'task'`);
  assert.deepEqual(dryTasks.map((r) => r.details.task_type).sort(), ['open_job', 'won_handoff'], 'but logged as intended');
});
