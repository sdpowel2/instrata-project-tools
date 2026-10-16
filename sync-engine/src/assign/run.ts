/**
 * Carries out the monday-side rules for one item (Triage moves R5 / R7 and the
 * Estimator writeback), the Estimator first pass, and the hourly retry of items
 * waiting on an engineer mapping. Decisions live in plan.ts.
 */
import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/pool.ts';
import { appendEvents, closeTask, openTask, type EventRow } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import type { MondayClient, MondayItemRaw } from '../monday/client.ts';
import { encodeColumnValues, readPersonIds, readStatusLabelId } from '../monday/encode.ts';
import type { SalesforceClient, SfEstimatorContext, SfUser } from '../salesforce/client.ts';
import type { WriteGate } from '../writeGate.ts';
import { isClosedGroup } from '../reconcile/plan.ts';
import { lightningBase } from '../report/run.ts';
import { toCsv } from '../report/fieldDiff.ts';
import { errMessage, log } from '../log.ts';
import {
  UNMAPPED_ENGINEER_PREFIX, assignedSfIds, bidDecisionOf, namesToResolve, pickEstimator, planEstimator, planTriage,
  type AssignItem, type EstimatorDecision, type TriageMove,
} from './plan.ts';

export interface AssignDeps {
  db: Db;
  gate: WriteGate;
  monday: MondayClient;
  salesforce: SalesforceClient;
  cfg: RuntimeConfig;
  salesforceLoginUrl: string;
}

const ASSIGN_KEYS = ['presales.presales_engineer', 'presales.status', 'triage.bid_decision'] as const;

/** Column ids whose change triggers this module (engineer anywhere, Bid Decision on Triage). */
export function assignColumnIds(cfg: RuntimeConfig): { engineer: string | null; bid: string | null } {
  return {
    engineer: cfg.planner.columns['presales.presales_engineer']?.columnId ?? null,
    bid: cfg.planner.columns['triage.bid_decision']?.columnId ?? null,
  };
}

function toAssignItem(raw: MondayItemRaw, cfg: RuntimeConfig): AssignItem {
  const value = (key: string) => {
    const id = cfg.planner.columns[key]?.columnId;
    return id ? raw.column_values.find((c) => c.id === id)?.value ?? null : null;
  };
  const boardId = raw.board?.id ? String(raw.board.id) : null;
  const boardKey = boardId ? Object.entries(cfg.boards).find(([, id]) => id !== null && String(id) === boardId)?.[0] ?? null : null;
  return {
    id: String(raw.id),
    name: raw.name,
    boardKey,
    groupId: raw.group?.id ?? null,
    statusLabelId: readStatusLabelId(value('presales.status')),
    engineerUserIds: readPersonIds(value('presales.presales_engineer')),
    bidLabelId: boardKey === 'triage' ? readStatusLabelId(value('triage.bid_decision')) : null,
  };
}

function columnIds(cfg: RuntimeConfig): string[] {
  return ASSIGN_KEYS.map((k) => cfg.planner.columns[k]?.columnId).filter((x): x is string => !!x);
}

interface LinkRow { sfLineItemId: string; sfOpportunityId: string; linkState: 'active' | 'archived' | 'conflict' }

async function loadLinks(q: Queryable, itemIds: string[]): Promise<Map<string, LinkRow>> {
  const { rows } = await q.query<{ item: string; line: string; opp: string; state: LinkRow['linkState'] }>(
    `select monday_item_id::text as item, sf_line_item_id as line, sf_opportunity_id as opp, link_state as state
       from sf_link where monday_item_id = any($1::bigint[])`, [itemIds]);
  return new Map(rows.map((r) => [r.item, { sfLineItemId: r.line, sfOpportunityId: r.opp, linkState: r.state }]));
}

async function usersByName(sf: SalesforceClient, names: string[]): Promise<Map<string, SfUser[]>> {
  const out = new Map<string, SfUser[]>();
  if (names.length === 0) return out;
  for (const u of await sf.findActiveUsersByName(names)) out.set(u.Name, [...(out.get(u.Name) ?? []), u]);
  return out;
}

const itemLabel = (item: AssignItem) => `${item.name} (monday item ${item.id})`;

/** Remove the item from every open "map this engineer" task it's waiting in. */
async function leaveUnmappedTasks(q: Queryable, itemId: string, correlationId: string): Promise<void> {
  const { rows } = await q.query<{ dedupe_key: string }>(
    `select dedupe_key from task
      where dedupe_key like $1 and status <> 'done'
        and exists (select 1 from jsonb_array_elements(coalesce(source_ref->'members', '[]'::jsonb)) m where m->>'id' = $2)`,
    [`${UNMAPPED_ENGINEER_PREFIX}%`, itemId]);
  for (const r of rows) await closeTask(q, r.dedupe_key, 'auto', correlationId, itemId);
}

export interface AssignResult {
  triage: TriageMove['rule'] | null;
  estimator: EstimatorDecision['kind'] | 'off';
  note: string;
}

/**
 * What made this run happen. Only 'engineer' (someone changed the Pre-Sales
 * Engineer column) may clear Salesforce's Estimator.
 */
export type AssignTrigger = 'engineer' | 'bid' | 'retry';

/** One item, after a Pre-Sales Engineer or Bid Decision change (debounced by the caller). */
export async function runAssignment(deps: AssignDeps, itemId: string, actor: string | null, trigger: AssignTrigger): Promise<AssignResult> {
  const { cfg } = deps;
  const gate = deps.gate.fork();
  const live = gate.mode === 'live';
  const [raw] = await deps.monday.getItems([itemId], columnIds(cfg));
  if (!raw || raw.state !== 'active') return { triage: null, estimator: 'off', note: 'item missing or archived' };
  const item = toAssignItem(raw, cfg);
  if (!item.boardKey) return { triage: null, estimator: 'off', note: 'not on a pre-sales board' };

  const events: EventRow[] = [];
  const boardId = (key: string) => {
    const id = cfg.boards[key];
    if (!id) throw new Error(`config_boards.${key} has no monday board id`);
    return id;
  };

  // ── Triage moves ──
  const move = planTriage(cfg.planner, item);
  if (move) {
    const groupId = cfg.planner.groups[`${move.moveTo.boardKey}.${move.moveTo.groupKey}`];
    if (!groupId) throw new Error(`No monday group configured for ${move.moveTo.boardKey}.${move.moveTo.groupKey}`);
    if (move.columnWrites.length > 0) {
      await gate.monday.changeColumnValues(boardId('triage'), item.id, encodeColumnValues(move.columnWrites, (k) => cfg.planner.columns[k]?.columnId));
    }
    await gate.monday.moveItemToBoard(item.id, boardId('triage'), boardId(move.moveTo.boardKey), groupId);
    if (live) {
      events.push({
        source: 'engine', entity_type: 'monday_item', entity_id: item.id, event_type: 'group_moved',
        old_value: 'triage', new_value: `${move.moveTo.boardKey}.${move.moveTo.groupKey}`,
        actor: actor ?? 'engine', details: { rule: move.rule, engineer_user_ids: item.engineerUserIds },
      });
    }
  }

  // ── Estimator writeback ──
  let decision: EstimatorDecision | null = null;
  if (cfg.settings.estimator_writeback === true) {
    const link = (await loadLinks(deps.db, [item.id])).get(item.id) ?? null;
    const ctx: SfEstimatorContext | null = link
      ? (await deps.salesforce.getEstimatorContexts([link.sfLineItemId])).get(link.sfLineItemId) ?? null
      : null;
    const users = await usersByName(deps.salesforce, namesToResolve(item.engineerUserIds, cfg.estimators));
    decision = planEstimator({
      item,
      closedGroup: isClosedGroup(cfg.planner, item.boardKey, item.groupId),
      noBid: item.boardKey === 'triage' && bidDecisionOf(cfg.planner, item.bidLabelId) === 'no_bid',
      link, ctx,
      pick: pickEstimator(item.engineerUserIds, cfg.estimators, users),
      assignedSfIds: assignedSfIds(item.engineerUserIds, cfg.estimators, users),
      allowClear: trigger === 'engineer',
      firstPass: false,
      repEmail: cfg.settings.estimator_rep_email !== false,
      itemLabel: itemLabel(item),
      sfBaseUrl: lightningBase(deps.salesforceLoginUrl),
    });

    if (decision.kind === 'patch') {
      await gate.salesforce.patchLineItem(decision.lineItemId, { Estimator__c: decision.estimatorId });
      if (live) {
        events.push({
          source: 'engine', entity_type: 'line_item', entity_id: decision.lineItemId, event_type: 'writeback',
          field: 'Estimator__c', old_value: decision.old, new_value: { id: decision.estimatorId, name: decision.estimatorName },
          actor: actor ?? 'engine', details: { monday_item_id: item.id, sf_opportunity_id: link?.sfOpportunityId },
        });
      }
      if (decision.repEmail) {
        try {
          await gate.salesforce.sendEmail(decision.repEmail);
          if (live) events.push({ source: 'engine', entity_type: 'opportunity', entity_id: decision.repEmail.relatedRecordId, event_type: 'notified', actor: 'engine', details: { email_to: decision.repEmail.to, subject: decision.repEmail.subject } });
        } catch (e) {
          // The Estimator is written; a failed courtesy email must not undo or retry that.
          log.warn('rep email failed', { itemId: item.id, error: errMessage(e) });
          events.push({ source: 'engine', entity_type: 'opportunity', entity_id: decision.repEmail.relatedRecordId, event_type: 'notified', applied: false, actor: 'engine', details: { email_to: decision.repEmail.to, error: errMessage(e) } });
        }
      }
    }
  }

  const journal = gate.drain();
  if (!live) {
    for (const j of journal) {
      events.push({ source: 'engine', entity_type: j.system === 'monday' ? 'monday_item' : 'line_item', entity_id: j.target, event_type: 'dry_run_write', actor: 'engine', details: { op: j.op, payload: j.payload, monday_item_id: item.id } });
    }
  }

  const correlationId = randomUUID();
  await deps.db.tx(async (q) => {
    await appendEvents(q, events, correlationId);
    if (decision?.kind === 'task') await openTask(q, decision.task, correlationId);
    else if (decision) await leaveUnmappedTasks(q, item.id, correlationId);
  });

  const note = [move ? move.rule : null, decision ? `estimator: ${decision.kind === 'none' ? decision.reason : decision.kind}` : 'estimator: off'].filter(Boolean).join('; ');
  return { triage: move?.rule ?? null, estimator: decision?.kind ?? 'off', note };
}

/** Hourly: re-run items waiting on a "map this engineer" task (a mapping fix touches no item). */
export async function retryUnmappedEngineers(deps: AssignDeps): Promise<number> {
  const { rows } = await deps.db.query<{ item: string }>(
    `select distinct m->>'id' as item
       from task, jsonb_array_elements(coalesce(source_ref->'members', '[]'::jsonb)) as m
      where dedupe_key like $1 and status <> 'done'`, [`${UNMAPPED_ENGINEER_PREFIX}%`]);
  for (const r of rows) {
    try {
      await runAssignment(deps, r.item, 'engine', 'retry');
    } catch (e) {
      log.error('estimator retry failed', { itemId: r.item, error: errMessage(e) });
    }
  }
  return rows.length;
}

// ── First pass (existing Estimator values; Seth 2026-10-15) ───────────────────
export interface FirstPassRow {
  opportunity: string;
  opportunityId: string;
  mondayItem: string;
  board: string;
  engineers: string;
  salesforceNow: string;
  willBe: string;
  action: string;
}

export interface FirstPassReport {
  mode: 'preview' | 'apply';
  linked: number;
  counts: Record<string, number>;
  failed: { mondayItem: string; error: string }[];
  rows: FirstPassRow[];
}

/**
 * Every active link on an open deal: monday's first mappable engineer → the AV
 * line's Estimator, overwriting whatever is there. No rep emails (the org's flow
 * still emails each engineer). `apply: false` writes nothing.
 */
export async function runEstimatorFirstPass(deps: AssignDeps, opts: { apply: boolean }): Promise<FirstPassReport> {
  const { cfg } = deps;
  const { rows: linkRows } = await deps.db.query<{ item: string }>(`select monday_item_id::text as item from sf_link where link_state = 'active'`);
  const links = await loadLinks(deps.db, linkRows.map((r) => r.item));
  const raws = await deps.monday.getItems([...links.keys()], columnIds(cfg));
  const items = raws.filter((r) => r.state === 'active').map((r) => toAssignItem(r, cfg)).filter((i) => i.boardKey);

  const ctxs = await deps.salesforce.getEstimatorContexts(items.map((i) => links.get(i.id)!.sfLineItemId));
  const users = await usersByName(deps.salesforce, [...new Set(items.flatMap((i) => namesToResolve(i.engineerUserIds, cfg.estimators)))]);
  const who = (ids: string[]) => ids.map((id) => cfg.estimators[id]?.mondayName || `monday user ${id}`).join(', ');

  const report: FirstPassReport = { mode: opts.apply ? 'apply' : 'preview', linked: links.size, counts: {}, failed: [], rows: [] };
  const count = (k: string) => { report.counts[k] = (report.counts[k] ?? 0) + 1; };

  for (const item of items) {
    const link = links.get(item.id)!;
    const ctx = ctxs.get(link.sfLineItemId) ?? null;
    const decision = planEstimator({
      item,
      closedGroup: isClosedGroup(cfg.planner, item.boardKey!, item.groupId),
      noBid: item.boardKey === 'triage' && bidDecisionOf(cfg.planner, item.bidLabelId) === 'no_bid',
      link, ctx,
      pick: pickEstimator(item.engineerUserIds, cfg.estimators, users),
      assignedSfIds: assignedSfIds(item.engineerUserIds, cfg.estimators, users),
      allowClear: false,
      firstPass: true, repEmail: false, itemLabel: itemLabel(item), sfBaseUrl: lightningBase(deps.salesforceLoginUrl),
    });
    // Closed deals and unlinked lines aren't part of the cleanup; leave them out of the list.
    if (decision.kind === 'none' && !LISTED_NONE.has(decision.reason)) {
      count('skipped (closed / not found)');
      continue;
    }
    const action = decision.kind === 'patch' ? (decision.estimatorId ? (decision.old.id ? 'replace' : 'fill blank') : 'clear')
      : decision.kind === 'task' ? 'needs mapping' : LISTED_NONE.get(decision.reason)!;
    count(action);
    report.rows.push({
      opportunity: ctx?.opportunityName ?? '', opportunityId: link.sfOpportunityId, mondayItem: item.id, board: item.boardKey!,
      engineers: who(item.engineerUserIds), salesforceNow: ctx?.estimatorName ?? '',
      willBe: decision.kind === 'patch' ? decision.estimatorName ?? '(blank)' : decision.kind === 'task' ? '(unchanged until the engineer is mapped)' : ctx?.estimatorName ?? '',
      action,
    });
    if (!opts.apply || decision.kind === 'none') continue;

    try {
      const gate = deps.gate.fork();
      if (decision.kind === 'patch') await gate.salesforce.patchLineItem(decision.lineItemId, { Estimator__c: decision.estimatorId });
      const journal = gate.drain();
      const correlationId = randomUUID();
      await deps.db.tx(async (q) => {
        const events: EventRow[] = decision.kind !== 'patch' ? []
          : gate.mode === 'live'
            ? [{ source: 'engine', entity_type: 'line_item', entity_id: decision.lineItemId, event_type: 'writeback', field: 'Estimator__c', old_value: decision.old, new_value: { id: decision.estimatorId, name: decision.estimatorName }, actor: 'engine', details: { monday_item_id: item.id, first_pass: true } }]
            : journal.map((j) => ({ source: 'engine' as const, entity_type: 'line_item' as const, entity_id: j.target, event_type: 'dry_run_write', actor: 'engine', details: { op: j.op, payload: j.payload, monday_item_id: item.id, first_pass: true } }));
        await appendEvents(q, events, correlationId);
        if (decision.kind === 'task') await openTask(q, decision.task, correlationId);
      });
    } catch (e) {
      report.failed.push({ mondayItem: item.id, error: errMessage(e) });
    }
  }
  report.rows.sort((a, b) => a.action.localeCompare(b.action) || a.opportunity.localeCompare(b.opportunity));
  return report;
}

/** "Nothing to write" outcomes the first-pass list still shows, with their Action label. */
const LISTED_NONE = new Map([
  ['Salesforce already matches', 'already right'],
  ['Salesforce already has an engineer on the item', 'already right'],
  ['only ignored people assigned', 'leave (only ignored people)'],
  ['no engineer in monday', 'leave (no engineer in monday)'],
]);

export function firstPassCsv(r: FirstPassReport): string {
  return toCsv(
    ['Action', 'Opportunity', 'Opportunity id', 'monday item', 'Board', 'Pre-Sales Engineer(s) in monday', 'Salesforce Estimator now', 'Estimator after'],
    r.rows.map((x) => [x.action, x.opportunity, x.opportunityId, x.mondayItem, x.board, x.engineers, x.salesforceNow, x.willBe]),
  );
}
