/**
 * Routing for monday webhook events: the three pre-sales boards, and Hope's Queue
 * (her status edits; src/queue).
 *
 *   - Echoes of the engine's own writes (integration user) → ignored (spec §4.7).
 *   - Quoted Price / GM % changed by a person → writeback, debounced (spec §5).
 *   - Salesforce-owned field or status changed by a person → logged for rework
 *     analysis (spec §4.5, §8). The sync does not fight hand edits.
 *   - Item archived / deleted → its link is archived.
 *   - Pre-Sales Engineer, or (Triage) Bid Decision / engineer pick changed → Triage moves R5 / R7
 *     and the Estimator writeback, debounced (src/assign; Seth 2026-10-15).
 */
import type { Db } from '../db/pool.ts';
import { appendEvents } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import { isMondayRemoval, parseMondayEvent, type MondayEvent } from '../ingress/parse.ts';
import type { MondayClient } from '../monday/client.ts';
import type { SalesforceClient } from '../salesforce/client.ts';
import type { WriteGate } from '../writeGate.ts';
import { runWriteback } from '../writeback/run.ts';
import { assignColumnIds, runAssignment, type AssignTrigger } from '../assign/run.ts';
import { log } from '../log.ts';
import { handleQueueEvent } from '../queue/run.ts';
import { openWonTasksForItem } from '../queue/jobs.ts';
import type { InboxRow } from './inbox.ts';

export interface MondayEventDeps {
  db: Db;
  gate: WriteGate;
  monday: MondayClient;
  salesforce: SalesforceClient;
  cfg: RuntimeConfig;
  integrationUserId: string;
  /** Salesforce login URL, for links in the Estimator rep email. */
  salesforceLoginUrl?: string;
  now?: () => Date;
}

export type MondayOutcome = { kind: 'done'; note: string } | { kind: 'defer'; until: Date };

const WRITEBACK_KEYS = ['presales.quoted_price', 'presales.gm_pct'];

/** config_boards keys whose items mirror Salesforce opportunities. */
export const PRESALES_BOARD_KEYS = ['presales', 'prequal', 'triage'] as const;

/** column id on the pre-sales board → semantic key */
function semanticKeyFor(cfg: RuntimeConfig, columnId: string): string | null {
  for (const [key, col] of Object.entries(cfg.planner.columns)) {
    if (col.boardKey === 'presales' && col.columnId === columnId) return key;
  }
  return null;
}

export async function handleMondayEvent(deps: MondayEventDeps, row: InboxRow): Promise<MondayOutcome> {
  const ev = parseMondayEvent(row.payload);
  if (!ev) return { kind: 'done', note: 'unparseable' };
  // Hope's Queue board: her status edits (and archives) flow back into the task table.
  const queueBoard = deps.cfg.boards.queue;
  if (queueBoard && String(ev.boardId) === String(queueBoard)) {
    if (ev.userId === deps.integrationUserId) return { kind: 'done', note: 'own echo' };
    const note = await handleQueueEvent({ ...deps, salesforceLoginUrl: deps.salesforceLoginUrl ?? '' }, ev);
    return { kind: 'done', note: `queue: ${note}` };
  }
  // The Pre-Sales Summary plus the intake boards (same column ids on all three).
  const salesBoards = PRESALES_BOARD_KEYS.map((k) => deps.cfg.boards[k]).filter((id): id is string => !!id).map(String);
  if (!ev.boardId || !salesBoards.includes(String(ev.boardId))) return { kind: 'done', note: 'not a pre-sales board' };
  if (ev.userId === deps.integrationUserId) return { kind: 'done', note: 'own echo' };
  if (!ev.itemId) return { kind: 'done', note: 'no item' };

  if (isMondayRemoval(ev)) {
    const { rows } = await deps.db.query<{ n: number }>('select count(*)::int as n from sf_link where monday_item_id = $1::bigint', [ev.itemId]);
    if (rows[0].n > 0) {
      await deps.db.tx(async (q) => {
        await q.query(`update sf_link set link_state = 'archived' where monday_item_id = $1::bigint`, [ev.itemId]);
        await appendEvents(q, [{ source: 'monday', entity_type: 'monday_item', entity_id: ev.itemId!, event_type: 'archived', actor: ev.userId, details: { type: ev.type } }], null);
      });
    }
    return { kind: 'done', note: 'removal' };
  }

  if (!ev.columnId) return { kind: 'done', note: 'no column' };

  // Pre-Sales Engineer (any of the three boards) or Bid Decision (Triage) → Triage
  // moves + Estimator writeback, debounced like the price writeback.
  const assign = assignColumnIds(deps.cfg);
  const onTriage = deps.cfg.boards.triage !== null && String(deps.cfg.boards.triage) === String(ev.boardId);
  const isBid = assign.bid !== null && ev.columnId === assign.bid && onTriage;
  const isPick = assign.pick !== null && ev.columnId === assign.pick && onTriage;
  if (ev.columnId === assign.engineer || isBid || isPick) return assignment(deps, row, ev, isBid ? 'bid' : isPick ? 'pick' : 'engineer');

  const key = semanticKeyFor(deps.cfg, ev.columnId);
  if (!key) return { kind: 'done', note: 'untracked column' };

  if (WRITEBACK_KEYS.includes(key)) return writeback(deps, row, ev);

  const col = deps.cfg.planner.columns[key];
  if (col.owner === 'salesforce' || key === 'presales.status') {
    await appendEvents(deps.db, [{
      source: 'monday', entity_type: 'monday_item', entity_id: ev.itemId,
      event_type: key === 'presales.status' ? 'status_changed' : 'field_changed',
      field: key, old_value: ev.previousValue, new_value: ev.value, actor: ev.userId,
      details: { column_id: ev.columnId },
    }], null);
    // A person set a Pre-Sales item to Won → the Won tasks (the engine's own Won
    // opens them in the planner). Opened once, so re-setting Won never reopens them.
    const onPresales = deps.cfg.boards.presales !== null && String(deps.cfg.boards.presales) === String(ev.boardId);
    const wonId = deps.cfg.planner.labels['presales.status.won'];
    const labelOf = (v: unknown) => (v as { label?: { index?: number } } | null)?.label?.index ?? null;
    if (key === 'presales.status' && onPresales && wonId !== undefined && wonId !== null
        && labelOf(ev.value) === wonId && labelOf(ev.previousValue) !== wonId) {
      const opened = await openWonTasksForItem(deps, ev.itemId, deps.now?.() ?? new Date());
      return { kind: 'done', note: `logged; won tasks opened: ${opened}` };
    }
    return { kind: 'done', note: 'logged' };
  }
  return { kind: 'done', note: 'monday-owned column' };
}

async function assignment(deps: MondayEventDeps, row: InboxRow, ev: MondayEvent, trigger: AssignTrigger): Promise<MondayOutcome> {
  const isBid = trigger === 'bid';
  const debounceSec = Number(deps.cfg.settings.writeback_debounce_seconds ?? 30) || 30;
  const due = new Date(new Date(row.received_at).getTime() + debounceSec * 1000);
  const now = deps.now?.() ?? new Date();
  if (due > now) return { kind: 'defer', until: due };

  // The decision itself is kept even though the column drops off at the move (Seth 2026-10-15).
  if (isBid) {
    await appendEvents(deps.db, [{
      source: 'monday', entity_type: 'monday_item', entity_id: ev.itemId!, event_type: 'field_changed',
      field: 'triage.bid_decision', old_value: ev.previousValue, new_value: ev.value, actor: ev.userId,
      details: { column_id: ev.columnId },
    }], null);
  }

  // Superseded only by a newer edit of the SAME column, so an engineer removal
  // still runs (and may clear) even when a Bid Decision change follows it.
  const { rows } = await deps.db.query<{ n: number }>(
    `select count(*)::int as n from webhook_inbox
      where source = 'monday' and status = 'pending' and id > $1::bigint
        and payload->'event'->>'pulseId' = $2 and payload->'event'->>'columnId' = any($3::text[])`,
    [row.id, ev.itemId, [ev.columnId]]);
  if (rows[0].n > 0) return { kind: 'done', note: 'superseded by a newer edit' };

  const r = await runAssignment({ ...deps, salesforceLoginUrl: deps.salesforceLoginUrl ?? '' }, ev.itemId!, ev.userId, trigger);
  if (r.triage || r.estimator === 'patch' || r.estimator === 'task') {
    log.info('assignment', { itemId: ev.itemId, mode: deps.gate.mode, triage: r.triage, estimator: r.estimator, note: r.note });
  }
  return { kind: 'done', note: r.note };
}

/**
 * Debounce in the database, not in memory, so a restart can't lose a writeback:
 * the event waits until received_at + debounce; if a newer price/GM event for the
 * same item is already queued by then, this one is superseded.
 */
async function writeback(deps: MondayEventDeps, row: InboxRow, ev: MondayEvent): Promise<MondayOutcome> {
  const debounceSec = Number(deps.cfg.settings.writeback_debounce_seconds ?? 30) || 30;
  const due = new Date(new Date(row.received_at).getTime() + debounceSec * 1000);
  const now = deps.now?.() ?? new Date();
  if (due > now) return { kind: 'defer', until: due };

  const cols = WRITEBACK_KEYS.map((k) => deps.cfg.planner.columns[k]?.columnId).filter(Boolean);
  const { rows } = await deps.db.query<{ n: number }>(
    `select count(*)::int as n from webhook_inbox
      where source = 'monday' and status = 'pending' and id > $1::bigint
        and payload->'event'->>'pulseId' = $2 and payload->'event'->>'columnId' = any($3::text[])`,
    [row.id, ev.itemId, cols]);
  if (rows[0].n > 0) return { kind: 'done', note: 'superseded by a newer edit' };

  const decision = await runWriteback(deps, ev.itemId!, ev.userId);
  return { kind: 'done', note: `writeback: ${decision.kind}` };
}

