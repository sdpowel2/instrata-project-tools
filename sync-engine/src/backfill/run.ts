/**
 * Runs the backfill: read every pre-sales item, look its Salesforce ID up,
 * save links + grouped problem tasks. Database-only — never writes to monday or
 * Salesforce, so it's safe in dry run. Re-runnable: existing links are kept, and
 * each problem task's member list is replaced with the current set.
 */
import type { Db } from '../db/pool.ts';
import { closeTask, openTask, setAsideItemIds } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import type { MondayClient } from '../monday/client.ts';
import { readText } from '../monday/encode.ts';
import type { SalesforceClient } from '../salesforce/client.ts';
import { assertSfId } from '../salesforce/soql.ts';
import { sha256 } from '../ingress/parse.ts';
import type { TaskMember } from '../reconcile/types.ts';
import {
  PROBLEM_TEXT, backfillTaskKey, idsToFetch, planBackfill,
  type BackfillItem, type BackfillPlan, type BackfillProblemKind, type SfLineRef,
} from './plan.ts';

export interface BackfillDeps {
  db: Db;
  monday: MondayClient;
  salesforce: SalesforceClient;
  cfg: RuntimeConfig;
}

export interface BackfillReport {
  preview: boolean;
  counts: BackfillPlan['counts'];
  problems: Record<BackfillProblemKind, { count: number; examples: string[] }>;
  linked: number;
  reconcilesQueued: number;
  /** Items the coordinator set aside: skipped entirely. */
  setAside: number;
  /** Links a set-aside item (or a deleted / archived item) held that go to the other item with the same Salesforce ID. */
  handedOver: number;
  /** "isn't linked" writeback tasks closed because their item now has a link. */
  unlinkedTasksClosed: number;
}

const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const inList = (ids: string[]) => ids.map((id) => `'${assertSfId(id)}'`).join(', ');
const key15 = (id: string) => id.slice(0, 15);
const BACKFILL_BOARDS = ['presales', 'prequal', 'triage'] as const;

/** The Salesforce side of planBackfill: line items by id, AV lines per opportunity id. */
export async function lookupSfIds(salesforce: SalesforceClient, items: BackfillItem[]): Promise<{ lineItems: Map<string, SfLineRef>; avLinesByOpp: Map<string, SfLineRef[]> }> {
  const { lineIds, oppIds } = idsToFetch(items);
  const lineItems = new Map<string, SfLineRef>();
  for (const ids of chunk(lineIds, 150)) {
    const rows = await salesforce.query<any>(
      `SELECT Id, OpportunityId, Opportunity.StageName FROM OpportunityLineItem WHERE Id IN (${inList(ids)})`);
    for (const r of rows) lineItems.set(r.Id, { id: r.Id, opportunityId: r.OpportunityId, stage: r.Opportunity?.StageName ?? '' });
  }
  const avLinesByOpp = new Map<string, SfLineRef[]>();
  for (const ids of chunk(oppIds, 100)) {
    const rows = await salesforce.query<any>(
      `SELECT Id, StageName, (SELECT Id FROM OpportunityLineItems WHERE isAVProduct__c = true OR Technology__c = 'AV') FROM Opportunity WHERE Id IN (${inList(ids)})`);
    for (const r of rows) {
      avLinesByOpp.set(key15(r.Id), (r.OpportunityLineItems?.records ?? []).map((l: any) => ({ id: l.Id, opportunityId: r.Id, stage: r.StageName })));
    }
  }
  return { lineItems, avLinesByOpp };
}

export async function runBackfill(deps: BackfillDeps, opts: { preview: boolean; reconcile: boolean }): Promise<BackfillReport> {
  const sfCol = deps.cfg.planner.columns['presales.sf_id']?.columnId;
  if (!deps.cfg.boards.presales || !sfCol) throw new Error('presales board / presales.sf_id column not configured');

  // 1. Every item on the three pre-sales boards (same column ids), with its Salesforce
  // ID text. Pre-Qualification and Triage since Oct 30: Hope moves old Lead /
  // Qualified items there and types their IDs in.
  const items: BackfillItem[] = [];
  const seen = new Set<string>();
  for (const key of BACKFILL_BOARDS) {
    const boardId = deps.cfg.boards[key];
    if (!boardId) continue;
    await deps.monday.pageBoardItems(boardId, [sfCol], (page) => {
      for (const it of page) {
        if (seen.has(String(it.id))) continue; // moved between boards mid-read
        seen.add(String(it.id));
        const c = it.column_values.find((x) => x.id === sfCol);
        items.push({ id: String(it.id), name: it.name, sfId: c?.text ?? readText(c?.value ?? null) });
      }
    });
  }

  // Set-aside items (change orders etc.) are left out: never linked, never a problem.
  const aside = await setAsideItemIds(deps.db);
  const planItems = items.filter((i) => !aside.has(i.id));

  // 2. Look the ids up in Salesforce.
  const { lineItems, avLinesByOpp } = await lookupSfIds(deps.salesforce, planItems);

  // 3. Plan against what's already linked.
  // A link held by a set-aside item doesn't claim its line, so the other item with
  // the same Salesforce ID (usually the real deal behind a change order) can take it.
  // Neither does an archived link (its item was deleted or archived; Oct 30, as linkOne).
  const { rows: allLinks } = await deps.db.query<{ item: string; line: string; state: string }>(
    'select monday_item_id::text as item, sf_line_item_id as line, link_state as state from sf_link');
  const released = (e: { item: string; state: string }) => aside.has(e.item) || e.state === 'archived';
  const existing = allLinks.filter((e) => !released(e));
  const plan = planBackfill({
    items: planItems, lineItems, avLinesByOpp,
    alreadyLinkedItems: new Set(existing.map((e) => e.item)),
    alreadyLinkedLines: new Set(existing.map((e) => e.line)),
  });
  const handed = allLinks.filter((e) => released(e)
    && plan.links.some((l) => key15(l.sfLineItemId) === key15(e.line) || l.mondayItemId === e.item));

  const report: BackfillReport = {
    preview: opts.preview,
    counts: plan.counts,
    problems: Object.fromEntries(Object.entries(plan.problems).map(([k, ms]) => [k, { count: ms.length, examples: ms.slice(0, 5).map((m) => m.label) }])) as BackfillReport['problems'],
    linked: 0,
    reconcilesQueued: 0,
    setAside: items.length - planItems.length,
    handedOver: handed.length,
    unlinkedTasksClosed: 0,
  };
  if (opts.preview) return report;

  // 4. Persist: links (stage-only baseline in BOTH columns), problem tasks, reconciles.
  await deps.db.tx(async (q) => {
    if (handed.length > 0) {
      await q.query('delete from sf_link where monday_item_id = any($1::bigint[])', [handed.map((h) => h.item)]);
    }
    if (plan.links.length > 0) {
      const { rows } = await q.query<{ id: string }>(
        `insert into sf_link (monday_item_id, sf_opportunity_id, sf_line_item_id, last_synced_values, dry_run_synced_values)
         select x.item::bigint, x.opp, x.line, jsonb_build_object('sf.stage', x.stage), jsonb_build_object('sf.stage', x.stage)
           from jsonb_to_recordset($1::jsonb) as x(item text, opp text, line text, stage text)
         on conflict do nothing returning id`,
        [JSON.stringify(plan.links.map((l) => ({ item: l.mondayItemId, opp: l.sfOpportunityId, line: l.sfLineItemId, stage: l.stage })))]);
      report.linked = rows.length;
    }

    // "Price/GM% not sent: item isn't linked" closes once the item has a link. A live
    // writeback closes it too, but dry run never writes, so the backfill does it (Oct 27).
    const { rows: noLink } = await q.query<{ dedupe_key: string }>(
      `select t.dedupe_key from task t
         join sf_link l on t.dedupe_key = 'writeback_no_link:' || l.monday_item_id::text
        where t.status <> 'done'`);
    for (const t of noLink) await closeTask(q, t.dedupe_key, 'auto', null);
    report.unlinkedTasksClosed = noLink.length;

    for (const kind of Object.keys(plan.problems) as BackfillProblemKind[]) {
      const key = backfillTaskKey(kind);
      const current = plan.problems[kind];
      const { rows } = await q.query<{ source_ref: { members?: TaskMember[] } }>(
        `select source_ref from task where dedupe_key = $1 and status <> 'done'`, [key]);
      const stale = (rows[0]?.source_ref?.members ?? []).filter((m) => !current.some((c) => c.id === m.id));
      for (const m of stale) await closeTask(q, key, 'auto', null, m.id);
      for (const m of current) {
        await openTask(q, { op: 'open', taskType: 'sync_failure', dedupeKey: key, ...PROBLEM_TEXT[kind], sourceRef: { board_key: 'presales' }, member: m }, null);
      }
    }

    if (opts.reconcile && plan.links.length > 0) {
      const stamp = new Date().toISOString();
      const opps = [...new Set(plan.links.map((l) => l.sfOpportunityId))];
      const { rows } = await q.query<{ id: string }>(
        `insert into webhook_inbox (source, payload, dedupe_hash)
         select 'salesforce', x.payload, x.dedupe_hash from jsonb_to_recordset($1::jsonb) as x(payload jsonb, dedupe_hash text)
         on conflict (dedupe_hash) do nothing returning id`,
        [JSON.stringify(opps.map((id) => ({ payload: { object: 'Backfill', opportunity_id: id }, dedupe_hash: sha256('backfill', id, stamp) })))]);
      report.reconcilesQueued = rows.length;
    }
  });
  return report;
}
