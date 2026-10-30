/**
 * The duplicate check around a planned create (Seth 2026-10-30; matching rules in
 * duplicates.ts):
 *   - Hope already said "different project" (marked the Possible duplicate task
 *     Done by hand) → create.
 *   - One unlinked item already holds this deal's Salesforce ID → link it instead.
 *   - Any other match → hold: no item, a Possible duplicate task for Hope listing
 *     the matches. She pastes the ID into the right item (linkOne links it and
 *     closes the task) or marks the task Done (the engine then creates).
 */
import type { Db } from '../db/pool.ts';
import { setAsideItemIds } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import type { MondayClient } from '../monday/client.ts';
import { readText } from '../monday/encode.ts';
import type { SalesforceClient } from '../salesforce/client.ts';
import { linkPastedId } from '../backfill/linkOne.ts';
import { findDuplicates, possibleDuplicateKey, type DuplicateMatch, type PoolItem } from './duplicates.ts';
import { BOARD_TITLE, groupTitle } from './notify.ts';
import { CREATED_ITEM, type ReconcilePlan, type SfOpportunity } from './types.ts';

export interface HoldDeps {
  db: Db;
  monday: MondayClient;
  salesforce: SalesforceClient;
}

export type CreateCheck = { kind: 'create' } | { kind: 'linked'; itemId: string } | { kind: 'hold'; matches: DuplicateMatch[] };

const POOL_TTL_MS = 10 * 60 * 1000;
const poolCache = new WeakMap<MondayClient, { at: number; items: PoolItem[] }>();

const BOARDS = ['presales', 'prequal', 'triage'] as const;

/** Every item on the three boards (name, quote, Salesforce ID), cached for 10 minutes. */
async function boardItems(monday: MondayClient, cfg: RuntimeConfig, now: number): Promise<PoolItem[]> {
  const hit = poolCache.get(monday);
  if (hit && now - hit.at < POOL_TTL_MS) return hit.items;
  const quoteCol = cfg.planner.columns['presales.quote_number']?.columnId ?? undefined;
  const sfCol = cfg.planner.columns['presales.sf_id']?.columnId ?? undefined;
  const cols = [quoteCol, sfCol].filter((x): x is string => !!x);
  const items: PoolItem[] = [];
  for (const boardKey of BOARDS) {
    const boardId = cfg.boards[boardKey];
    if (!boardId) continue;
    await monday.pageBoardItems(boardId, cols, (page) => {
      for (const it of page) {
        const val = (id: string | undefined) => {
          const c = it.column_values.find((x) => x.id === id);
          return c ? (c.text ?? readText(c.value)) : null;
        };
        items.push({ id: String(it.id), name: it.name, boardKey, groupId: it.group?.id ?? null, quote: val(quoteCol), sfId: val(sfCol) });
      }
    });
  }
  poolCache.set(monday, { at: now, items });
  return items;
}

export async function checkBeforeCreate(deps: HoldDeps, cfg: RuntimeConfig, opp: SfOpportunity, lineItemId: string, now = Date.now()): Promise<CreateCheck> {
  const { rows: task } = await deps.db.query<{ status: string; close_mode: string | null }>(
    'select status, close_mode from task where dedupe_key = $1', [possibleDuplicateKey(opp.Id)]);
  if (task[0]?.status === 'done' && task[0].close_mode === 'manual') return { kind: 'create' };

  const [all, aside, linked] = await Promise.all([
    boardItems(deps.monday, cfg, now),
    setAsideItemIds(deps.db),
    deps.db.query<{ item: string }>(`select monday_item_id::text as item from sf_link where link_state <> 'archived'`),
  ]);
  const taken = new Set(linked.rows.map((r) => r.item));
  const pool = all.filter((i) => !aside.has(i.id) && !taken.has(i.id));
  const matches = findDuplicates({ opportunityId: opp.Id, lineItemId, name: opp.Name, quote: opp.Estimate_Number__c }, pool);
  if (matches.length === 0) return { kind: 'create' };

  const byId = matches.filter((m) => m.why === 'salesforce_id');
  if (byId.length === 1) {
    const r = await linkPastedId({ ...deps, cfg }, byId[0].item.id);
    if (r.kind === 'linked') {
      poolCache.delete(deps.monday);
      return { kind: 'linked', itemId: byId[0].item.id };
    }
  }
  return { kind: 'hold', matches };
}

const WHY: Record<DuplicateMatch['why'], string> = {
  salesforce_id: 'already has this Salesforce ID',
  quote_number: 'same quote number',
  name: 'similar name',
};
const SHOWN = 3;

/** Replace the plan's create with Hope's Possible duplicate task. */
export function holdCreate(plan: ReconcilePlan, opp: SfOpportunity, matches: DuplicateMatch[], cfg: RuntimeConfig, mondaySlug: string | null): void {
  const create = plan.create!;
  const where = BOARD_TITLE[create.boardKey] ?? create.boardKey;
  plan.create = null;
  plan.events = plan.events.filter((e) => e.entityId !== CREATED_ITEM);
  plan.tasks = plan.tasks.filter((t) => !t.dedupeKey.includes(CREATED_ITEM) && !(t.op === 'open' && t.sourceRef.monday_item_id === CREATED_ITEM));

  const lines = matches.slice(0, SHOWN).map((m) => {
    const board = cfg.boards[m.item.boardKey];
    const url = mondaySlug && board ? `\n  https://${mondaySlug}.monday.com/boards/${board}/pulses/${m.item.id}` : '';
    const quote = m.item.quote ? `, quote ${m.item.quote}` : '';
    return `• ${m.item.name} — ${BOARD_TITLE[m.item.boardKey] ?? m.item.boardKey} / ${groupTitle(cfg.planner, m.item.boardKey, m.item.groupId)}${quote} (${WHY[m.why]})${url}`;
  });
  if (matches.length > SHOWN) lines.push(`• …and ${matches.length - SHOWN} more with a similar name`);

  const quote = opp.Estimate_Number__c ? `, quote ${opp.Estimate_Number__c}` : '';
  plan.tasks.push({
    op: 'open',
    taskType: 'sync_failure',
    dedupeKey: possibleDuplicateKey(opp.Id),
    title: `Possible duplicate: ${opp.Name}`,
    details:
      `"${opp.Name}" (${opp.StageName}${quote}) is not on the boards yet, but it looks like an item that already is, so the sync did not create it.\n\n` +
      `• Same project: paste the Salesforce ID ${create.sfLineItemId} into that item's Salesforce ID column. The sync links it within a minute and this task closes.\n` +
      `• Different project: mark this task Done. The sync creates the item on ${where} within a minute.\n\n` +
      `Possible matches:\n${lines.join('\n')}`,
    sourceRef: { board_key: matches[0].item.boardKey, monday_item_id: matches[0].item.id, sf_opportunity_id: opp.Id },
  });
}
