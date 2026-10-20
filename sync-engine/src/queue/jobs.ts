/**
 * Won tasks outside the reconcile planner (Seth 2026-10-20):
 *   - openWonTasksForItem: a PERSON set a Pre-Sales item to Won in monday (the
 *     engine's own Won goes through the planner). Same two tasks, opened once.
 *   - closeOpenedJobs (hourly): an open_job task closes once the deal's Post-Sales
 *     copy has a Project Number. The copy is found through the Project ID text
 *     column, which monday's Won → Post-Sales duplication carries over.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.ts';
import { closeTask, openTask } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import type { MondayClient } from '../monday/client.ts';
import { readText } from '../monday/encode.ts';
import { businessDaysAfter } from './time.ts';
import { handoffSlaDays, wonTaskIntents } from './won.ts';

export async function openWonTasksForItem(
  deps: { db: Db; monday: MondayClient; cfg: RuntimeConfig },
  itemId: string,
  now: Date = new Date(),
): Promise<number> {
  const { rows } = await deps.db.query<{ opp: string }>(
    'select sf_opportunity_id as opp from sf_link where monday_item_id = $1::bigint', [itemId]);
  const [item] = await deps.monday.getItems([itemId], []);
  const name = item?.name ?? `monday item ${itemId}`;
  const ref = { board_key: 'presales', monday_item_id: itemId, ...(rows[0] ? { sf_opportunity_id: rows[0].opp } : {}) };
  const sla = handoffSlaDays(deps.cfg.settings);
  let opened = 0;
  await deps.db.tx(async (q) => {
    const correlationId = randomUUID();
    for (const t of wonTaskIntents(itemId, name, ref)) {
      const dueAt = t.taskType === 'won_handoff' && sla ? businessDaysAfter(now, sla).toISOString() : null;
      if (await openTask(q, t, correlationId, dueAt) === 'opened') opened++;
    }
  });
  return opened;
}

export interface JobCheck { checked: number; closed: number; skipped?: string }

export async function closeOpenedJobs(deps: { db: Db; monday: MondayClient; cfg: RuntimeConfig }): Promise<JobCheck> {
  const { cfg } = deps;
  const postBoard = cfg.boards.postsales;
  const preProject = cfg.planner.columns['presales.project_id']?.columnId;
  const postProject = cfg.planner.columns['postsales.project_id']?.columnId;
  const postNumber = cfg.planner.columns['postsales.project_number']?.columnId;
  if (!postBoard || !preProject || !postProject || !postNumber) return { checked: 0, closed: 0, skipped: 'Post-Sales board or Project ID / Project Number columns not configured' };

  const { rows: tasks } = await deps.db.query<{ dedupe_key: string; item: string | null }>(
    `select dedupe_key, source_ref->>'monday_item_id' as item from task where task_type = 'open_job' and status <> 'done'`);
  const withItem = tasks.filter((t): t is { dedupe_key: string; item: string } => !!t.item);
  if (withItem.length === 0) return { checked: 0, closed: 0 };

  // Pre-Sales item → its Project ID.
  const raws = await deps.monday.getItems(withItem.map((t) => t.item), [preProject]);
  const projectOf = new Map(raws.map((r) => [String(r.id), readText(r.column_values.find((c) => c.id === preProject)?.value ?? null)]));
  const projectIds = [...new Set([...projectOf.values()].filter((p): p is string => !!p))];

  // Post-Sales items carrying those Project IDs → Project Number.
  const numberOf = new Map<string, string>();
  for (let i = 0; i < projectIds.length; i += 50) {
    const data = await deps.monday.query<{ items_page_by_column_values: { items: { column_values: { id: string; text: string | null }[] }[] } }>(
      `query ($b: ID!, $c: String!, $v: [String]!, $cols: [String!]) {
         items_page_by_column_values(board_id: $b, limit: 500, columns: [{ column_id: $c, column_values: $v }]) {
           items { column_values(ids: $cols) { id text } } } }`,
      { b: postBoard, c: postProject, v: projectIds.slice(i, i + 50), cols: [postProject, postNumber] });
    for (const it of data.items_page_by_column_values?.items ?? []) {
      const pid = it.column_values.find((c) => c.id === postProject)?.text?.trim();
      const num = it.column_values.find((c) => c.id === postNumber)?.text?.trim();
      if (pid && num) numberOf.set(pid, num);
    }
  }

  let closed = 0;
  for (const t of withItem) {
    const pid = projectOf.get(t.item);
    if (!pid || !numberOf.get(pid)) continue;
    if (await closeTask(deps.db, t.dedupe_key, 'auto', null) === 'closed') closed++;
  }
  return { checked: withItem.length, closed };
}
