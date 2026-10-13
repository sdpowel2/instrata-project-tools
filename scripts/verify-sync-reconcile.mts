// Regression check for the Salesforce → monday reconcile PLANNER (spec §4).
// Pure: no Salesforce, no monday, no database. Each case builds an opportunity +
// link/item state, plans, and asserts the decision. Most cases also apply the plan
// to the simulated state and plan again, asserting zero effects (idempotency).
//
//   node --experimental-strip-types scripts/verify-sync-reconcile.mts
import { planReconcile, planHasEffects } from '../sync-engine/src/reconcile/plan.ts';
import { CREATED_ITEM } from '../sync-engine/src/reconcile/types.ts';
import type {
  ColumnWrite, LinkRow, MondayItemSnapshot, PlannerConfig, PlannerMaps, ReconcilePlan, SfOpportunity, TaskIntent,
} from '../sync-engine/src/reconcile/types.ts';

// ── Config + maps mirroring the add_sync_and_queue.sql seeds ─────────────────
const G = { new_requests: 'new_group12986', follow_up: 'new_group66048', won: 'new_group52602', lost: 'new_group64129', declined: 'new_group', pre_eng: 'grp_preeng' };
const S = { in_progress: 0, won: 1, lost: 2, not_started: 5, follow_up: 6, declined_to_bid: 7, rebid: 8, on_hold: 9 };

function makeConfig(over: Partial<PlannerConfig> = {}): PlannerConfig {
  const col = (columnId: string | null, type: any, owner: any) => ({ columnId, type, owner });
  return {
    columns: {
      'presales.due_date': col('date7', 'datetime', 'salesforce'),
      'presales.quote_number': col('text8', 'text', 'salesforce'),
      'presales.win_pct': col('dropdown__1', 'dropdown', 'salesforce'),
      'presales.business_unit': col('dropdown2', 'dropdown', 'salesforce'),
      'presales.sales_person': col('dropdown3', 'dropdown', 'salesforce'),
      'presales.sf_id': col('text_mkv2656m', 'text', 'salesforce'),
      'presales.status': col('status9', 'status', 'shared'),
      'presales.win_loss_notes': col('long_text_notes', 'long_text', 'salesforce'),
    },
    groups: {
      'presales.new_requests': G.new_requests, 'presales.follow_up': G.follow_up, 'presales.won': G.won,
      'presales.lost': G.lost, 'presales.declined_to_bid': G.declined, 'presales.pre_engineering': G.pre_eng,
    },
    labels: Object.fromEntries(Object.entries(S).map(([k, v]) => [`presales.status.${k}`, v])),
    creationStages: ['Engineering', 'Budget', 'Rebid', 'Delivered to Customer', 'Contract In House'],
    confirmedWinPcts: ['100%'],
    blockedColumns: [],
    ...over,
  };
}

function makeMaps(): PlannerMaps {
  return {
    businessUnit: { Northeast: 4, 'Mid-Atlantic': 3, Southeast: 2, Southwest: 1, Louisiana: null },
    winPct: { '0%': 4, '25%': 1, '50%': 2, '75%': 3, '99%': null },
    salesRep: { '(blank)': 4, 'Michelle Bravo': 25, 'Luke Wood': 1, 'Johnny Price': null },
    stageAction: {
      Lead: { action: 'none', params: {} },
      'Qualified Opportunity': { action: 'none', params: {} },
      Engineering: { action: 'none', params: {} },
      Budget: { action: 'none', params: {} },
      Rebid: { action: 'set_status', params: { label_key: 'rebid' } },
      'On Hold': { action: 'set_status', params: { label_key: 'on_hold' } },
      'Delivered to Customer': { action: 'stage_check_delivered', params: {} },
      'Contract In House': { action: 'stage_check_contract', params: {} },
      'Closed Won': { action: 'won', params: {} },
      'Closed Lost': { action: 'lost', params: {} },
      'Declined to Bid': { action: 'declined', params: {} },
      Canceled: { action: 'canceled', params: {} },
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const OPP = '006AAA000000001';
const LINE = '00kAAA000000001';
const ITEM = '13092716583';

function opp(over: Partial<SfOpportunity> = {}): SfOpportunity {
  return {
    Id: OPP, Name: 'Acme HQ – Boardroom', StageName: 'Engineering',
    Estimate_Due_Date_Time__c: '2026-10-15T18:00:00.000+0000', Estimate_Number__c: 'Q-1001',
    Win_Likelihood__c: '50%', Business_Unit__c: 'Northeast', Sales_Rep__c: '005REP', Sales_Rep__r: { Name: 'Luke Wood' },
    Lost_Reason__c: null, Other_lost_reason__c: null, Lost_To__c: null,
    SystemModstamp: '2026-10-10T12:00:00.000+0000', LastModifiedById: '005USER',
    lineItems: [{ Id: LINE, isAVProduct__c: true, Technology__c: 'AV', UnitPrice: 0, Quantity: 1, Sold_in_Margin__c: null, CreatedDate: '2026-10-01T00:00:00.000+0000' }],
    ...over,
  };
}

interface State { links: LinkRow[]; items: Record<string, MondayItemSnapshot>; }
const empty = (): State => ({ links: [], items: {} });

function item(over: Partial<MondayItemSnapshot> = {}): MondayItemSnapshot {
  return { id: ITEM, state: 'active', groupId: G.new_requests, statusLabelId: S.in_progress, quotedPrice: null, engineerUserIds: [], ...over };
}

/**
 * A linked item whose baseline already matches `o` — a steady state. Built the way
 * the backfill seeds links: field baseline from an eligible-stage create, and
 * 'sf.stage' = the opportunity's current stage (so historical stage actions never replay).
 */
function linked(o: SfOpportunity, itemOver: Partial<MondayItemSnapshot> = {}, cfg = makeConfig(), maps = makeMaps()): State {
  const created = planReconcile({ opportunity: { ...o, StageName: 'Engineering' }, opportunityId: o.Id, links: [], items: {}, config: cfg, maps });
  if (!created.create) throw new Error('fixture: expected a create');
  const baseline = { ...created.create.baseline, 'sf.stage': o.StageName };
  return {
    links: [{ mondayItemId: ITEM, sfOpportunityId: o.Id, sfLineItemId: created.create.sfLineItemId, linkState: 'active', baseline }],
    items: { [ITEM]: item(itemOver) },
  };
}

const run = (o: SfOpportunity | null, st: State, cfg = makeConfig(), maps = makeMaps()): ReconcilePlan =>
  planReconcile({ opportunity: o, opportunityId: o?.Id ?? OPP, links: st.links, items: st.items, config: cfg, maps });

/** Simulates the executor: persist baselines, reflect writes in the snapshots. */
function apply(plan: ReconcilePlan, st: State): State {
  const next: State = { links: st.links.map((l) => ({ ...l })), items: { ...st.items } };
  const status = (ws: ColumnWrite[]) => ws.find((w) => w.semanticKey === 'presales.status');
  if (plan.create) {
    const s = status(plan.create.stageWrites);
    next.items[ITEM] = item({ statusLabelId: s && s.value.type === 'status' ? s.value.labelId : null });
    next.links.push({ mondayItemId: ITEM, sfOpportunityId: plan.opportunityId, sfLineItemId: plan.create.sfLineItemId, linkState: 'active', baseline: plan.create.baseline });
  }
  for (const ip of plan.items) {
    const link = next.links.find((l) => l.mondayItemId === ip.mondayItemId)!;
    link.baseline = ip.baseline;
    if (ip.newLinkState) link.linkState = ip.newLinkState;
    const snap = { ...next.items[ip.mondayItemId] };
    const s = status(ip.columnWrites);
    if (s && s.value.type === 'status') snap.statusLabelId = s.value.labelId;
    if (ip.moveToGroupKey) snap.groupId = (G as any)[ip.moveToGroupKey];
    if (ip.archive) snap.state = 'archived';
    next.items[ip.mondayItemId] = snap;
  }
  return next;
}

// ── Assertions ────────────────────────────────────────────────────────────────
let failures = 0;
let cases = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? ` — ${detail}` : ''}`);
}
function section(name: string) { cases++; console.log(`\n${name}`); }

const opens = (p: ReconcilePlan) => p.tasks.filter((t): t is Extract<TaskIntent, { op: 'open' }> => t.op === 'open');
const writesOf = (p: ReconcilePlan, id = ITEM) => p.items.find((i) => i.mondayItemId === id)?.columnWrites ?? [];
const writeKeys = (ws: ColumnWrite[]) => ws.map((w) => w.semanticKey).sort().join(',');
const statusWrite = (ws: ColumnWrite[]) => {
  const w = ws.find((x) => x.semanticKey === 'presales.status');
  return w && w.value.type === 'status' ? w.value.labelId : undefined;
};
function idempotent(plan: ReconcilePlan, st: State, o: SfOpportunity, cfg = makeConfig(), maps = makeMaps()) {
  const again = run(o, apply(plan, st), cfg, maps);
  check('re-running produces zero effects', !planHasEffects(again), JSON.stringify(again, null, 1).slice(0, 600));
}

// ── Cases ─────────────────────────────────────────────────────────────────────
section('1. Create: eligible AV opportunity at Engineering');
{
  const o = opp();
  const p = run(o, empty());
  check('create planned', !!p.create);
  check('item name = Opportunity.Name', p.create?.itemName === o.Name);
  check('group = New Requests', p.create?.groupKey === 'new_requests');
  check('writes every SF-owned field + sf_id',
    writeKeys(p.create?.columnWrites ?? []) === 'presales.business_unit,presales.due_date,presales.quote_number,presales.sales_person,presales.sf_id,presales.win_pct',
    writeKeys(p.create?.columnWrites ?? []));
  const due = p.create?.columnWrites.find((w) => w.semanticKey === 'presales.due_date');
  check('due date passed through as UTC instant', due?.value.type === 'datetime' && due.value.iso === '2026-10-15T18:00:00Z', JSON.stringify(due));
  const sfid = p.create?.columnWrites.find((w) => w.semanticKey === 'presales.sf_id');
  check('sf_id = line item id', sfid?.value.type === 'text' && sfid.value.text === LINE);
  check('no stage writes at Engineering', (p.create?.stageWrites.length ?? -1) === 0);
  check('no failure tasks', opens(p).length === 0);
  check('created event logged', p.events.some((e) => e.eventType === 'created' && e.entityId === CREATED_ITEM));
  idempotent(p, empty(), o);
}

section('2. No create: Lead / Qualified Opportunity / Closed Won / no AV product');
for (const stage of ['Lead', 'Qualified Opportunity', 'Closed Won', 'Closed Lost']) {
  const p = run(opp({ StageName: stage }), empty());
  check(`${stage}: nothing created, no tasks`, !p.create && opens(p).length === 0);
}
{
  const p = run(opp({ lineItems: [{ ...opp().lineItems[0], isAVProduct__c: false, Technology__c: 'Security' }] }), empty());
  check('no AV line item: nothing created', !p.create && opens(p).length === 0);
}

section('3. AV detection falls back to Technology__c = AV');
{
  const p = run(opp({ lineItems: [{ ...opp().lineItems[0], isAVProduct__c: null, Technology__c: 'AV' }] }), empty());
  check('create planned', !!p.create);
}

section('4. Two AV line items → multi_av_product failure, no create');
{
  const li = opp().lineItems[0];
  const p = run(opp({ lineItems: [li, { ...li, Id: '00kAAA000000002' }] }), empty());
  check('no create', !p.create);
  check('one multi_av_product failure task', opens(p).length === 1 && opens(p)[0].dedupeKey === `sync_failure:multi_av_product:${OPP}:line_items`);
}

section('5. Steady state: hand edit in monday is not fought');
{
  const o = opp();
  const st = linked(o);
  const p = run(o, st);
  check('zero effects (monday values are never the baseline)', !planHasEffects(p));
}

section('6. Salesforce change → write + event');
{
  const st = linked(opp());
  const o = opp({ Estimate_Due_Date_Time__c: '2026-10-20T14:30:00.000+0000', Estimate_Number__c: 'Q-1002' });
  const p = run(o, st);
  check('writes due date + quote number only', writeKeys(writesOf(p)) === 'presales.due_date,presales.quote_number', writeKeys(writesOf(p)));
  const ev = p.events.find((e) => e.field === 'presales.due_date');
  check('field_changed event carries old → new', ev?.oldValue === '2026-10-15T18:00:00Z' && ev?.newValue === '2026-10-20T14:30:00Z');
  check('event actor = Salesforce user', ev?.actor === '005USER');
  idempotent(p, st, o);
}

section('7. Blank Salesforce value never clears monday');
{
  const st = linked(opp());
  const o = opp({ Estimate_Number__c: '  ', Estimate_Due_Date_Time__c: null });
  const p = run(o, st);
  check('no writes', writesOf(p).length === 0);
  check('field_changed logged with applied=false (x2)', p.events.filter((e) => e.eventType === 'field_changed' && e.applied === false).length === 2);
  idempotent(p, st, o);
}

section('8. Mapping miss: one field fails, the rest still write, retried until mapped');
{
  const st = linked(opp());
  const o = opp({ Business_Unit__c: 'Louisiana', Estimate_Number__c: 'Q-2000' });
  const p = run(o, st);
  check('quote number still written', writeKeys(writesOf(p)) === 'presales.quote_number', writeKeys(writesOf(p)));
  const t = opens(p);
  check('one unmapped_value task naming the mapping table',
    t.length === 1 && t[0].dedupeKey === 'sync_failure:unmapped_value:presales.business_unit:Louisiana' && t[0].sourceRef.mapping_table === 'map_business_unit');
  check('task carries this opportunity as a member', t[0]?.member?.id === OPP && /Acme HQ/.test(t[0]?.member?.label ?? ''), JSON.stringify(t[0]?.member));
  check('sync_failure event logged', p.events.some((e) => e.eventType === 'sync_failure'));
  const st2 = apply(p, st);
  check('BU baseline left unchanged (so it is retried)', st2.links[0].baseline['presales.business_unit'] === 'Northeast');
  const p2 = run(o, st2);
  check('second pass: no repeat task / event / write', !planHasEffects(p2), JSON.stringify(opens(p2)));
  const fixed = makeMaps(); fixed.businessUnit.Louisiana = 7;
  const p3 = run(o, st2, makeConfig(), fixed);
  check('after Hope maps it: BU written', writeKeys(writesOf(p3)) === 'presales.business_unit');
  check('after Hope maps it: this opportunity leaves the task', p3.tasks.some((x) => x.op === 'close' && x.dedupeKey === 'sync_failure:unmapped_value:presales.business_unit:Louisiana' && x.memberId === OPP));
  idempotent(p3, st2, o, makeConfig(), fixed);
}

section('9. Unmapped value on create: item still created without that field');
{
  const o = opp({ Sales_Rep__r: { Name: 'Johnny Price' } });
  const p = run(o, empty());
  check('create planned', !!p.create);
  check('sales person not written', !p.create?.columnWrites.some((w) => w.semanticKey === 'presales.sales_person'));
  check('unmapped_value task opened, keyed by the missing value', opens(p).some((t) => t.dedupeKey === 'sync_failure:unmapped_value:presales.sales_person:Johnny Price'));
  check('member label points at the not-yet-created item (executor rewrites it)', opens(p).some((t) => t.op === 'open' && !!t.member?.label.includes('monday item ' + CREATED_ITEM)));
}

section('10. Sales rep: blank → House, Salesforce spelling translated');
{
  const p = run(opp({ Sales_Rep__c: null, Sales_Rep__r: null }), empty());
  const w = p.create?.columnWrites.find((x) => x.semanticKey === 'presales.sales_person');
  check('blank rep → House (4)', w?.value.type === 'dropdown' && w.value.labelIds[0] === 4);
  const p2 = run(opp({ Sales_Rep__r: { Name: 'Michelle Bravo' } }), empty());
  const w2 = p2.create?.columnWrites.find((x) => x.semanticKey === 'presales.sales_person');
  check('"Michelle Bravo" → Michelle Scheller-Bravo (25)', w2?.value.type === 'dropdown' && w2.value.labelIds[0] === 25);
}

section('11. Win % normalization: numeric 75 → "75%" label');
{
  const p = run(opp({ Win_Likelihood__c: 75 }), empty());
  const w = p.create?.columnWrites.find((x) => x.semanticKey === 'presales.win_pct');
  check('75 → label 3', w?.value.type === 'dropdown' && w.value.labelIds[0] === 3);
}

section('12. Win % = 100% → status Won (not a label) + won tasks');
{
  const st = linked(opp());
  const o = opp({ Win_Likelihood__c: '100%' });
  const p = run(o, st);
  check('win_pct dropdown NOT written', !writesOf(p).some((w) => w.semanticKey === 'presales.win_pct'));
  check('status → Won', statusWrite(writesOf(p)) === S.won);
  check('won_handoff + open_job opened', opens(p).map((t) => t.taskType).sort().join(',') === 'open_job,won_handoff');
  idempotent(p, st, o);
}

section('13. Stage → Rebid / On Hold set status; re-run is a no-op');
for (const [stage, label] of [['Rebid', S.rebid], ['On Hold', S.on_hold]] as const) {
  const st = linked(opp());
  const o = opp({ StageName: stage });
  const p = run(o, st);
  check(`${stage}: status → ${label}`, statusWrite(writesOf(p)) === label);
  check(`${stage}: stage_changed logged`, p.events.some((e) => e.eventType === 'stage_changed' && e.newValue === stage));
  check(`${stage}: no group move`, !p.items[0].moveToGroupKey);
  idempotent(p, st, o);
}

section('14. Delivered to Customer: task only if not in Follow Up; never writes');
{
  const o = opp({ StageName: 'Delivered to Customer' });
  const st = linked(opp());
  const p = run(o, st);
  check('no writes', writesOf(p).length === 0);
  check('stage_check_delivered task', opens(p).some((t) => t.dedupeKey === `stage_check_delivered:${ITEM}`));
  const p2 = run(o, linked(opp(), { groupId: G.follow_up }));
  check('in Follow Up → no task', opens(p2).length === 0);
}

section('15. Contract In House: task if status is not Won');
{
  const o = opp({ StageName: 'Contract In House' });
  const p = run(o, linked(opp()));
  check('no writes', writesOf(p).length === 0);
  check('stage_check_contract task', opens(p).some((t) => t.dedupeKey === `stage_check_contract:${ITEM}`));
  const p2 = run(o, linked(opp(), { statusLabelId: S.won }));
  check('already Won → no task', opens(p2).length === 0);
}

section('16. Closed Won: status Won + tasks; already Won → nothing');
{
  const o = opp({ StageName: 'Closed Won' });
  const st = linked(opp());
  const p = run(o, st);
  check('status → Won', statusWrite(writesOf(p)) === S.won);
  check('won tasks opened', opens(p).length === 2);
  check('Contract Date never written', !writesOf(p).some((w) => w.semanticKey === 'presales.contract_date'));
  idempotent(p, st, o);
  const p2 = run(o, linked(opp(), { statusLabelId: S.won }));
  check('human already set Won → no write, no tasks', writesOf(p2).length === 0 && opens(p2).length === 0);
}

section('17. Closed Lost: notes + status in ONE mutation, exact notes format');
{
  const o = opp({ StageName: 'Closed Lost', Lost_Reason__c: 'Price', Other_lost_reason__c: 'client went with incumbent', Lost_To__c: 'Acme AV' });
  const st = linked(opp());
  const p = run(o, st);
  const ws = writesOf(p);
  check('one item plan carries both columns', p.items.length === 1 && writeKeys(ws) === 'presales.status,presales.win_loss_notes', writeKeys(ws));
  const n = ws.find((w) => w.semanticKey === 'presales.win_loss_notes');
  check('notes format', n?.value.type === 'long_text' && n.value.text === 'Lost/Canceled Reason: Price · Detail: client went with incumbent · Lost to: Acme AV',
    JSON.stringify(n));
  check('status → Lost', statusWrite(ws) === S.lost);
  idempotent(p, st, o);
}

section('18. Declined to Bid: status, notes only when a reason exists');
{
  const p = run(opp({ StageName: 'Declined to Bid' }), linked(opp()));
  check('no reason → status only', writeKeys(writesOf(p)) === 'presales.status' && statusWrite(writesOf(p)) === S.declined_to_bid);
  const p2 = run(opp({ StageName: 'Declined to Bid', Lost_Reason__c: 'Capacity' }), linked(opp()));
  check('reason → notes + status', writeKeys(writesOf(p2)) === 'presales.status,presales.win_loss_notes');
}

section('19. Canceled with a quoted price → CANCELED notes + Lost');
{
  const o = opp({ StageName: 'Canceled', Lost_Reason__c: 'Project Canceled' });
  const p = run(o, linked(opp(), { quotedPrice: 125000 }));
  const n = writesOf(p).find((w) => w.semanticKey === 'presales.win_loss_notes');
  check('notes prefixed "CANCELED — "', n?.value.type === 'long_text' && n.value.text === 'CANCELED — Lost/Canceled Reason: Project Canceled', JSON.stringify(n));
  check('status → Lost', statusWrite(writesOf(p)) === S.lost);
  check('not archived', !p.items[0].archive);
}

section('20. Canceled, no quoted price → @mention engineer, archive, link archived');
{
  const o = opp({ StageName: 'Canceled', Lost_Reason__c: 'Project Canceled' });
  const st = linked(opp(), { engineerUserIds: ['555'] });
  const p = run(o, st);
  const ip = p.items[0];
  check('no column writes', ip.columnWrites.length === 0);
  check('update mentions the engineer', ip.postUpdate?.mentionUserIds.join() === '555' && /canceled in Salesforce/.test(ip.postUpdate.body));
  check('item archived + link archived', ip.archive === true && ip.newLinkState === 'archived');
  idempotent(p, st, o);
  const p2 = run(o, linked(opp()));
  check('no engineer → archive without an update', p2.items[0].archive === true && !p2.items[0].postUpdate);
}

section('21. Archived link brought back to life → restore task, once');
{
  const st = linked(opp());
  st.links[0].linkState = 'archived';
  st.links[0].baseline['sf.stage'] = 'Canceled';
  const o = opp({ StageName: 'Engineering', Estimate_Number__c: 'Q-9999' });
  const p = run(o, st);
  check('no writes to an archived item', writesOf(p).length === 0);
  check('archived_reactivated task', opens(p).some((t) => t.dedupeKey === `sync_failure:archived_reactivated:${OPP}:StageName`));
  idempotent(p, st, o);
}

section('22. Pre-Engineering item reaching Engineering → moved to New Requests');
{
  const st = linked(opp({ StageName: 'Qualified Opportunity' }), { groupId: G.pre_eng });
  const o = opp({ StageName: 'Engineering' });
  const p = run(o, st);
  check('move to new_requests', p.items[0].moveToGroupKey === 'new_requests');
  check('group_moved event', p.events.some((e) => e.eventType === 'group_moved'));
  idempotent(p, st, o);
  const p2 = run(opp({ StageName: 'Qualified Opportunity', Estimate_Number__c: 'Q-1' }), linked(opp({ StageName: 'Qualified Opportunity' }), { groupId: G.pre_eng }));
  check('still Qualified → stays put (fields still sync)', !p2.items[0].moveToGroupKey && writeKeys(writesOf(p2)) === 'presales.quote_number');
}

section('23. Unmapped stage → failure task, nothing written');
{
  const p = run(opp({ StageName: 'Negotiation' }), linked(opp()));
  check('unmapped_stage task', opens(p).some((t) => t.dedupeKey === `sync_failure:unmapped_stage:${OPP}:StageName`));
  check('no writes', writesOf(p).length === 0);
}

section('24. Win/Loss Notes column not configured yet → status still written, config task');
{
  const cfg = makeConfig();
  cfg.columns['presales.win_loss_notes'] = { columnId: null, type: 'long_text', owner: 'salesforce' };
  const p = run(opp({ StageName: 'Closed Lost', Lost_Reason__c: 'Price' }), linked(opp(), {}, cfg), cfg);
  check('status → Lost written', statusWrite(writesOf(p)) === S.lost && writeKeys(writesOf(p)) === 'presales.status');
  check('config_missing task', opens(p).some((t) => t.dedupeKey === 'sync_failure:config_missing:presales:presales.win_loss_notes'));
}

section('25. Config drift: blocked column is skipped and retried later');
{
  const st = linked(opp());
  const o = opp({ Estimate_Number__c: 'Q-3000' });
  const cfg = makeConfig({ blockedColumns: ['presales.quote_number'] });
  const p = run(o, st, cfg);
  check('no write while blocked', writesOf(p).length === 0);
  const st2 = apply(p, st);
  check('baseline unchanged while blocked', st2.links[0].baseline['presales.quote_number'] === 'Q-1001');
  const p2 = run(o, st2);
  check('unblocked → written', writeKeys(writesOf(p2)) === 'presales.quote_number');
}

section('26. Create at Rebid → status write goes in the second (stage) mutation');
{
  const o = opp({ StageName: 'Rebid' });
  const p = run(o, empty());
  check('stageWrites = status Rebid', statusWrite(p.create?.stageWrites ?? []) === S.rebid);
  check('status not in the create_item column values', !p.create?.columnWrites.some((w) => w.semanticKey === 'presales.status'));
  idempotent(p, empty(), o);
}

section('27. Linked AV product removed → failure task, opportunity fields keep syncing');
{
  const st = linked(opp());
  const o = opp({ lineItems: [], Estimate_Number__c: 'Q-4000' });
  const p = run(o, st);
  check('av_line_missing task', opens(p).some((t) => t.dedupeKey === `sync_failure:av_line_missing:${OPP}:${LINE}`));
  check('quote number still written', writeKeys(writesOf(p)) === 'presales.quote_number');
}

section('28. Second AV product added to a linked opportunity → multi_av failure, no new item');
{
  const li = opp().lineItems[0];
  const p = run(opp({ lineItems: [li, { ...li, Id: '00kAAA000000009' }] }), linked(opp()));
  check('no create', !p.create);
  check('multi_av_product task', opens(p).some((t) => t.dedupeKey === `sync_failure:multi_av_product:${OPP}:line_items`));
}

section('29. Opportunity not found → failure task, monday untouched');
{
  const p = run(null, linked(opp()));
  check('opportunity_missing task', opens(p).some((t) => t.dedupeKey === `sync_failure:opportunity_missing:${OPP}:opportunity`));
  check('no item plans', p.items.length === 0 && !p.create);
}

section('30. Item archived by hand in monday → link archived, no writes');
{
  const st = linked(opp(), { state: 'archived' });
  const p = run(opp({ Estimate_Number__c: 'Q-5' }), st);
  check('link archived, nothing written', p.items[0].newLinkState === 'archived' && writesOf(p).length === 0);
}

section('31. Win 100% while Closed Lost → Lost wins, no Won');
{
  const p = run(opp({ StageName: 'Closed Lost', Win_Likelihood__c: '100%' }), linked(opp()));
  check('status → Lost, not Won', statusWrite(writesOf(p)) === S.lost);
  check('no won tasks', !opens(p).some((t) => t.taskType === 'won_handoff'));
}

section('32. Instrata setting: 99% AND 100% are Confirmed to Win → status Won, no label, no re-trigger between them');
{
  const cfg = makeConfig({ confirmedWinPcts: ['99%', '100%'] });
  const st = linked(opp(), {}, cfg);
  const p = run(opp({ Win_Likelihood__c: '99%' }), st, cfg);
  check('99% → status Won', statusWrite(writesOf(p)) === S.won);
  check('win_pct dropdown not written', !writesOf(p).some((w) => w.semanticKey === 'presales.win_pct'));
  check('no unmapped-99% task', !opens(p).some((t) => t.dedupeKey.includes('99%')));
  const st2 = apply(p, st);
  const p2 = run(opp({ Win_Likelihood__c: '100%' }), st2, cfg);
  check('99% → 100% does not re-trigger Won', statusWrite(writesOf(p2)) === undefined && !opens(p2).some((t) => t.taskType === 'won_handoff'));
  const p3 = run(opp({ Win_Likelihood__c: '99%' }), linked(opp()));
  check('with the default setting (100% only), 99% is just an unmapped label', opens(p3).some((t) => t.dedupeKey === 'sync_failure:unmapped_value:presales.win_pct:99%'));
}

section("33. Missing value changes (A → B): joins B's task, leaves A's");
{
  const st = linked(opp());
  const p1 = run(opp({ Business_Unit__c: 'Louisiana' }), st);
  const st2 = apply(p1, st);
  const p2 = run(opp({ Business_Unit__c: 'Texas' }), st2);
  check('joins Texas', opens(p2).some((t) => t.dedupeKey === 'sync_failure:unmapped_value:presales.business_unit:Texas' && t.member?.id === OPP));
  check('leaves Louisiana', p2.tasks.some((t) => t.op === 'close' && t.dedupeKey === 'sync_failure:unmapped_value:presales.business_unit:Louisiana' && t.memberId === OPP));
  idempotent(p2, st2, opp({ Business_Unit__c: 'Texas' }));
}

section('34. Two opportunities missing the same value share ONE task');
{
  const a = run(opp({ Sales_Rep__r: { Name: 'Johnny Price' } }), empty());
  const b = run(opp({ Id: '006BBB000000002', Name: 'Other Job', Sales_Rep__r: { Name: 'Johnny Price' } }), empty());
  const ka = opens(a).find((t) => t.dedupeKey.includes('Johnny Price'));
  const kb = opens(b).find((t) => t.dedupeKey.includes('Johnny Price'));
  check('same dedupe key', !!ka && ka.dedupeKey === kb?.dedupeKey);
  check('different members', ka?.member?.id === OPP && kb?.member?.id === '006BBB000000002');
}

section('35. Backfilled item whose monday values already match Salesforce: no writes, baseline catches up');
{
  // Stage-only baseline, like the backfill seeds.
  const st: State = {
    links: [{ mondayItemId: ITEM, sfOpportunityId: OPP, sfLineItemId: LINE, linkState: 'active', baseline: { 'sf.stage': 'Engineering' } }],
    items: { [ITEM]: item({ fieldValues: {
      'presales.due_date': '{"date":"2026-10-15","time":"18:00:00","changed_at":"2026-10-01T00:00:00Z"}',
      'presales.quote_number': '"Q-1001"',
      'presales.win_pct': '{"ids":[2]}',
      'presales.business_unit': '{"ids":[4]}',
      'presales.sales_person': '{"ids":[1]}',
    } }) },
  };
  const o = opp();
  const p = run(o, st);
  check('nothing written — monday already has every value', writesOf(p).length === 0, writeKeys(writesOf(p)));
  check('no field_changed events (nothing changed)', !p.events.some((e) => e.eventType === 'field_changed'));
  check('baseline now holds all five fields', ['presales.due_date', 'presales.quote_number', 'presales.win_pct', 'presales.business_unit', 'presales.sales_person'].every((k) => k in p.items[0].baseline));
  idempotent(p, st, o);

  const stale: State = { ...st, items: { [ITEM]: item({ fieldValues: { ...st.items[ITEM].fieldValues!, 'presales.quote_number': '"Q-OLD"', 'presales.due_date': null } }) } };
  const p2 = run(o, stale);
  check('only the stale fields are written (quote number, empty due date)', writeKeys(writesOf(p2)) === 'presales.due_date,presales.quote_number', writeKeys(writesOf(p2)));
}

section('36. First look at a backfilled item at 99%/100%: review task for Hope, NO automatic Won');
{
  const cfg = makeConfig({ confirmedWinPcts: ['99%', '100%'] });
  const backfilled = (status = S.follow_up): State => ({
    links: [{ mondayItemId: ITEM, sfOpportunityId: OPP, sfLineItemId: LINE, linkState: 'active', baseline: { 'sf.stage': 'Engineering' } }],
    items: { [ITEM]: item({ statusLabelId: status }) },
  });
  const o = opp({ Win_Likelihood__c: '99%' });
  const reviewKey = `sync_failure:confirmed_win_review:${ITEM}:status`;

  const p = run(o, backfilled(), cfg);
  check('status NOT written', statusWrite(writesOf(p)) === undefined);
  check('no won_handoff / open_job', !opens(p).some((t) => t.taskType === 'won_handoff' || t.taskType === 'open_job'));
  const review = opens(p).find((t) => t.dedupeKey === reviewKey);
  check('review task opened', !!review);
  check('details name the current monday status', /status is Follow Up/.test(review?.details ?? ''), review?.details);
  check('Win % recorded in the baseline', p.items[0].baseline['presales.win_pct'] === '99%');
  idempotent(p, backfilled(), o, cfg);

  // Hope sets Won in monday → next reconcile closes the task.
  const st2 = apply(p, backfilled());
  st2.items[ITEM] = { ...st2.items[ITEM], statusLabelId: S.won };
  const p2 = run(o, st2, cfg);
  check('closes once monday is Won', p2.tasks.some((t) => t.op === 'close' && t.dedupeKey === reviewKey));
  check('…without writing anything', writesOf(p2).length === 0);

  // Or Salesforce drops back below confirmed → closes too.
  const p3 = run(opp({ Win_Likelihood__c: '75%' }), apply(p, backfilled()), cfg);
  check('closes when Salesforce drops to 75%', p3.tasks.some((t) => t.op === 'close' && t.dedupeKey === reviewKey));

  // Already Won in monday → nothing to review.
  const p4 = run(o, backfilled(S.won), cfg);
  check('already Won → no task', !opens(p4).some((t) => t.dedupeKey === reviewKey));

  // After the first look, a NEW move to confirmed does fire Won as designed.
  const st5 = apply(run(opp({ Win_Likelihood__c: '75%' }), backfilled(), cfg), backfilled());
  const p5 = run(o, st5, cfg);
  check('later 75% → 99% sets Won automatically', statusWrite(writesOf(p5)) === S.won);
}

// Backfilled link: stage-only baseline, monday values as given.
const backfilledWith = (fieldValues: Record<string, string | null>, itemOver: Partial<MondayItemSnapshot> = {}): State => ({
  links: [{ mondayItemId: ITEM, sfOpportunityId: OPP, sfLineItemId: LINE, linkState: 'active', baseline: { 'sf.stage': 'Engineering' } }],
  items: { [ITEM]: item({ fieldValues, ...itemOver }) },
});
const STALE = {
  'presales.due_date': '{"date":"2026-10-22"}', // Salesforce: Oct 15
  'presales.quote_number': '"Q-OLD"',
  'presales.win_pct': '{"ids":[1]}',
  'presales.business_unit': '{"ids":[2]}',
  'presales.sales_person': '{"ids":[25]}',
};

section('37. First look at an item in Won / Lost / Declined: nothing written, later changes sync');
for (const [name, groupId] of [['Won', G.won], ['Lost', G.lost], ['Declined to Bid', G.declined]] as const) {
  const st = backfilledWith(STALE, { groupId });
  const o = opp();
  const p = run(o, st);
  check(`${name}: no writes`, writesOf(p).length === 0, writeKeys(writesOf(p)));
  check(`${name}: no tasks`, opens(p).length === 0, JSON.stringify(opens(p)));
  check(`${name}: baseline records all five Salesforce values`, ['presales.due_date', 'presales.quote_number', 'presales.win_pct', 'presales.business_unit', 'presales.sales_person'].every((k) => k in p.items[0].baseline));
  idempotent(p, st, o);
  const p2 = run(opp({ Estimate_Number__c: 'Q-NEW' }), apply(p, st));
  check(`${name}: a later Salesforce edit is written`, writeKeys(writesOf(p2)) === 'presales.quote_number', writeKeys(writesOf(p2)));
}
{
  const p = run(opp({ Business_Unit__c: 'Louisiana' }), backfilledWith(STALE, { groupId: G.lost }));
  check('closed item with an unmapped value: no failure task on the first look', opens(p).length === 0);
}

section("38. First look, Due Date on a different day: keep monday's, one grouped review task");
{
  const st = backfilledWith(STALE, { groupId: G.follow_up });
  const o = opp();
  const p = run(o, st);
  check('other stale fields still written', writeKeys(writesOf(p)) === 'presales.business_unit,presales.quote_number,presales.sales_person,presales.win_pct', writeKeys(writesOf(p)));
  const t = opens(p).find((x) => x.dedupeKey === 'sync_failure:due_date_differs:presales:presales.due_date');
  check('review task opened with this opportunity as a member', t?.member?.id === OPP, JSON.stringify(opens(p)));
  check('member label shows both dates', /monday 2026-10-22, Salesforce 2026-10-15/.test(t?.member?.label ?? ''), t?.member?.label);
  check('baseline records Salesforce date', p.items[0].baseline['presales.due_date'] === '2026-10-15T18:00:00Z');
  idempotent(p, st, o);

  // Hope fixes monday → member leaves the task, nothing written.
  const st2 = apply(p, st);
  st2.items[ITEM] = { ...st2.items[ITEM], fieldValues: { ...STALE, 'presales.due_date': '{"date":"2026-10-15","time":"18:00:00"}' } };
  const p2 = run(o, st2);
  check('monday made to match → leaves the review', p2.tasks.some((x) => x.op === 'close' && x.dedupeKey === t?.dedupeKey && x.memberId === OPP));
  check('…without writing the due date', !writesOf(p2).some((w) => w.semanticKey === 'presales.due_date'));
  idempotent(p2, st2, o);

  // Or Salesforce moves the date → written, and leaves the review.
  const o3 = opp({ Estimate_Due_Date_Time__c: '2026-10-29T16:00:00.000+0000' });
  const p3 = run(o3, apply(p, st));
  check('Salesforce changes the date → written', writesOf(p3).some((w) => w.semanticKey === 'presales.due_date'));
  check('…and leaves the review', p3.tasks.some((x) => x.op === 'close' && x.dedupeKey === t?.dedupeKey && x.memberId === OPP));
}
{
  const p = run(opp(), backfilledWith({ ...STALE, 'presales.due_date': '{"date":"2026-10-15"}' }, { groupId: G.follow_up }));
  check('same day, no time → time added (written), no review', writesOf(p).some((w) => w.semanticKey === 'presales.due_date') && !opens(p).some((x) => x.dedupeKey.includes('due_date_differs')));
  const p2 = run(opp(), backfilledWith({ ...STALE, 'presales.due_date': null }, { groupId: G.follow_up }));
  check('monday blank → filled in, no review', writesOf(p2).some((w) => w.semanticKey === 'presales.due_date') && !opens(p2).some((x) => x.dedupeKey.includes('due_date_differs')));
  const p3 = run(opp({ Estimate_Due_Date_Time__c: '2026-10-16T01:30:00.000+0000' }), backfilledWith({ ...STALE, 'presales.due_date': '{"date":"2026-10-15"}' }, { groupId: G.follow_up }));
  check('9:30 PM ET on the 15th counts as the same day (ET, not UTC)', !opens(p3).some((x) => x.dedupeKey.includes('due_date_differs')));
  const st4 = linked(opp());
  st4.items[ITEM] = { ...st4.items[ITEM], fieldValues: { 'presales.due_date': '{"date":"2026-11-30"}' } };
  const p4 = run(opp({ Estimate_Due_Date_Time__c: '2026-10-20T14:30:00.000+0000' }), st4);
  check('after the first look, a Salesforce date change overwrites monday as before', writesOf(p4).some((w) => w.semanticKey === 'presales.due_date') && !opens(p4).some((x) => x.dedupeKey.includes('due_date_differs')));
}

console.log(`\n${cases} cases, ${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
