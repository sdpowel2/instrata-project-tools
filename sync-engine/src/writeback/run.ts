/** Carries out a writeback for one monday item: fat fetch both sides, decide, write, log. */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.ts';
import { appendEvents, closeTask, openTask, setAsideItemIds, type EventRow } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import type { MondayClient } from '../monday/client.ts';
import { readNumber } from '../monday/encode.ts';
import type { SalesforceClient } from '../salesforce/client.ts';
import type { WriteGate } from '../writeGate.ts';
import { planWriteback, writebackTaskKeys, type WritebackDecision } from './plan.ts';

export interface WritebackDeps {
  db: Db;
  gate: WriteGate;
  monday: MondayClient;
  salesforce: SalesforceClient;
  cfg: RuntimeConfig;
}

export async function runWriteback(deps: WritebackDeps, mondayItemId: string, actor: string | null): Promise<WritebackDecision> {
  const gate = deps.gate.fork();
  const live = gate.mode === 'live';
  const priceCol = deps.cfg.planner.columns['presales.quoted_price']?.columnId;
  const gmCol = deps.cfg.planner.columns['presales.gm_pct']?.columnId;
  if (!priceCol || !gmCol) throw new Error('presales.quoted_price / presales.gm_pct columns are not configured');

  // Set aside (a change order, say): nothing to send, and no "isn't linked" task.
  if ((await setAsideItemIds(deps.db)).has(mondayItemId)) {
    await deps.db.tx(async (q) => { for (const key of writebackTaskKeys(mondayItemId)) await closeTask(q, key, 'auto', null); });
    return { kind: 'none', reason: 'item set aside' };
  }

  const { rows } = await deps.db.query<{ sf_line_item_id: string; sf_opportunity_id: string; link_state: 'active' | 'archived' | 'conflict' }>(
    'select sf_line_item_id, sf_opportunity_id, link_state from sf_link where monday_item_id = $1::bigint', [mondayItemId]);
  const link = rows[0] ? { sfLineItemId: rows[0].sf_line_item_id, sfOpportunityId: rows[0].sf_opportunity_id, linkState: rows[0].link_state } : null;

  const [item] = await deps.monday.getItems([mondayItemId], [priceCol, gmCol]);
  const val = (col: string) => readNumber(item?.column_values.find((c) => c.id === col)?.value ?? null);
  const lineItem = link ? await deps.salesforce.getLineItem(link.sfLineItemId) : null;

  const decision = planWriteback({ mondayItemId, link, lineItem, quotedPrice: val(priceCol), gmPct: val(gmCol) });
  if (decision.kind === 'patch') await gate.salesforce.patchLineItem(decision.lineItemId, decision.values);

  const correlationId = randomUUID();
  const journal = gate.drain();
  const events: EventRow[] = [];
  if (decision.kind === 'patch') {
    events.push(live
      ? { source: 'engine', entity_type: 'line_item', entity_id: decision.lineItemId, event_type: 'writeback', old_value: decision.old, new_value: decision.values, actor: actor ?? 'engine', details: { monday_item_id: mondayItemId, sf_opportunity_id: link?.sfOpportunityId } }
      : { source: 'engine', entity_type: 'line_item', entity_id: decision.lineItemId, event_type: 'dry_run_write', actor: 'engine', details: { op: journal[0]?.op, payload: journal[0]?.payload, monday_item_id: mondayItemId } });
  }

  await deps.db.tx(async (q) => {
    await appendEvents(q, events, correlationId);
    if (decision.kind === 'task') {
      await openTask(q, { op: 'open', taskType: decision.taskType, dedupeKey: decision.dedupeKey, title: decision.title, details: decision.details,
        sourceRef: { board_key: 'presales', monday_item_id: mondayItemId, ...(link ? { sf_opportunity_id: link.sfOpportunityId } : {}) } }, correlationId);
    } else if (live || decision.kind === 'none') {
      // Success (or nothing to do because Salesforce already matches) closes earlier writeback tasks.
      for (const key of writebackTaskKeys(mondayItemId)) await closeTask(q, key, 'auto', correlationId);
    }
  });
  return decision;
}
