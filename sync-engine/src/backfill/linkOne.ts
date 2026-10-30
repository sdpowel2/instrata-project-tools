/**
 * Link one item from the ID typed into its Salesforce ID column (Seth 2026-10-30).
 * Runs when a person pastes an ID on any of the three pre-sales boards, and when
 * the duplicate check finds an unlinked item that already holds the new deal's ID.
 * Before this only the backfill linked, so a pasted ID did nothing (Cardinal, Oct 30).
 *
 * Same rules as the backfill (planBackfill), plus: a line still held by an
 * ARCHIVED link (its item was deleted or archived) moves to this item.
 */
import type { Db } from '../db/pool.ts';
import { closeTask, openTask, setAsideItemIds } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import type { MondayClient } from '../monday/client.ts';
import { readText } from '../monday/encode.ts';
import type { SalesforceClient } from '../salesforce/client.ts';
import { sha256 } from '../ingress/parse.ts';
import { possibleDuplicateKey } from '../reconcile/duplicates.ts';
import { PROBLEM_TEXT, backfillTaskKey, planBackfill, type BackfillProblemKind } from './plan.ts';
import { lookupSfIds } from './run.ts';

export interface LinkOneDeps {
  db: Db;
  monday: MondayClient;
  salesforce: SalesforceClient;
  cfg: RuntimeConfig;
}

export type LinkOneResult =
  | { kind: 'linked'; sfOpportunityId: string; sfLineItemId: string; movedFromArchived: boolean }
  | { kind: 'skipped'; note: string }
  | { kind: 'problem'; problem: BackfillProblemKind };

export async function linkPastedId(deps: LinkOneDeps, itemId: string): Promise<LinkOneResult> {
  const sfCol = deps.cfg.planner.columns['presales.sf_id']?.columnId;
  if (!sfCol) return { kind: 'skipped', note: 'presales.sf_id column not configured' };
  if ((await setAsideItemIds(deps.db)).has(itemId)) return { kind: 'skipped', note: 'set aside' };

  const [raw] = await deps.monday.getItems([itemId], [sfCol]);
  if (!raw || raw.state !== 'active') return { kind: 'skipped', note: 'item not active' };
  const c = raw.column_values.find((x) => x.id === sfCol);
  const sfId = (c?.text ?? readText(c?.value ?? null) ?? '').trim();
  if (sfId === '') return { kind: 'skipped', note: 'no Salesforce ID' };

  const { rows: links } = await deps.db.query<{ item: string; line: string; state: string }>(
    'select monday_item_id::text as item, sf_line_item_id as line, link_state as state from sf_link');
  const own = links.find((l) => l.item === itemId);
  if (own && own.state !== 'archived') return { kind: 'skipped', note: 'already linked' };
  const held = links.filter((l) => l.state !== 'archived');

  const item = { id: itemId, name: raw.name, sfId };
  const { lineItems, avLinesByOpp } = await lookupSfIds(deps.salesforce, [item]);
  const plan = planBackfill({ items: [item], lineItems, avLinesByOpp, alreadyLinkedItems: new Set(), alreadyLinkedLines: new Set(held.map((l) => l.line)) });

  const kinds = Object.keys(plan.problems) as BackfillProblemKind[];
  const link = plan.links[0];
  if (!link) {
    const kind = kinds.find((k) => plan.problems[k].length > 0)!;
    await openTask(deps.db, { op: 'open', taskType: 'sync_failure', dedupeKey: backfillTaskKey(kind), ...PROBLEM_TEXT[kind], sourceRef: { board_key: 'presales' }, member: plan.problems[kind][0] }, null);
    return { kind: 'problem', problem: kind };
  }

  const key15 = (id: string) => id.slice(0, 15);
  const moved = links.some((l) => l.state === 'archived' && key15(l.line) === key15(link.sfLineItemId) && l.item !== itemId);
  await deps.db.tx(async (q) => {
    await q.query(
      `delete from sf_link where monday_item_id = $1::bigint or (link_state = 'archived' and left(sf_line_item_id, 15) = left($2, 15))`,
      [itemId, link.sfLineItemId]);
    // Stage-only baseline, like the backfill: the first reconcile treats it as a first link.
    await q.query(
      `insert into sf_link (monday_item_id, sf_opportunity_id, sf_line_item_id, last_synced_values, dry_run_synced_values)
       values ($1::bigint, $2, $3, jsonb_build_object('sf.stage', $4::text), jsonb_build_object('sf.stage', $4::text))`,
      [itemId, link.sfOpportunityId, link.sfLineItemId, link.stage]);
    await closeTask(q, `writeback_no_link:${itemId}`, 'auto', null);
    await closeTask(q, possibleDuplicateKey(link.sfOpportunityId), 'auto', null);
    for (const k of kinds) await closeTask(q, backfillTaskKey(k), 'auto', null, itemId);
    await q.query(
      `insert into webhook_inbox (source, payload, dedupe_hash) values ('salesforce', $1::jsonb, $2) on conflict (dedupe_hash) do nothing`,
      [JSON.stringify({ object: 'Linked', opportunity_id: link.sfOpportunityId, monday_item_id: itemId }), sha256('linked', itemId, new Date().toISOString())]);
  });
  return { kind: 'linked', sfOpportunityId: link.sfOpportunityId, sfLineItemId: link.sfLineItemId, movedFromArchived: moved };
}
