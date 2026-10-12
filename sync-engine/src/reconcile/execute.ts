/**
 * Executes a ReconcilePlan: outbound writes through the writeGate, then one
 * transaction for baselines, events and tasks.
 *
 * Failure model: external writes happen first. If one throws, nothing else is
 * persisted, the baseline doesn't advance, and the next reconcile re-plans the
 * same writes (monday writes are idempotent; status writes are skipped when the
 * item already has the target status).
 *
 * The one non-idempotent write is create_item. As soon as it returns, the link
 * is saved — WITHOUT 'sf.stage' — so a crash before the stage write can't make a
 * duplicate item on retry; the retry finds the link, sees no synced stage, and
 * re-applies the stage action.
 *
 * Dry run: no link is created, baselines go to dry_run_synced_values, link_state
 * never changes, and only failure tasks are persisted. Everything that would
 * have been written is logged as `dry_run_write` events (the dry-run report's
 * input). Semantic events (field_changed, status_changed…) are logged only when
 * live, so rework metrics never count changes that didn't happen.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.ts';
import { appendEvents, closeTask, eventRowFromIntent, insertLink, openTask, updateLink, type EventRow } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import { encodeColumnValues } from '../monday/encode.ts';
import type { WriteGate } from '../writeGate.ts';
import { CREATED_ITEM, type ReconcilePlan, type TaskIntent } from './types.ts';
import { STAGE_KEY } from './normalize.ts';

export interface ExecuteDeps {
  db: Db;
  gate: WriteGate;
  cfg: RuntimeConfig;
}

export interface ExecuteResult {
  correlationId: string;
  createdItemId: string | null;
  externalWrites: number;
}

export async function executePlan(deps: ExecuteDeps, plan: ReconcilePlan): Promise<ExecuteResult> {
  const { db, gate, cfg } = deps;
  const live = gate.mode === 'live';
  const correlationId = randomUUID();
  const boardId = cfg.boards.presales;
  if (!boardId) throw new Error('config_boards.presales has no monday board id');
  const columnIdFor = (k: string) => cfg.planner.columns[k]?.columnId;
  gate.drain();

  // ── Outbound writes ──
  let createdId: string | null = null;
  if (plan.create) {
    const c = plan.create;
    createdId = await gate.monday.createItem(
      boardId, cfg.planner.groups['presales.new_requests'] ?? null, c.itemName, encodeColumnValues(c.columnWrites, columnIdFor));
    if (createdId) {
      const { [STAGE_KEY]: _stage, ...preStage } = c.baseline;
      await insertLink(db, { mondayItemId: createdId, sfOpportunityId: plan.opportunityId, sfLineItemId: c.sfLineItemId, baseline: preStage }, gate.mode);
    }
    if (c.stageWrites.length > 0) {
      await gate.monday.changeColumnValues(boardId, createdId ?? CREATED_ITEM, encodeColumnValues(c.stageWrites, columnIdFor));
    }
  }

  for (const ip of plan.items) {
    if (ip.columnWrites.length > 0) {
      await gate.monday.changeColumnValues(boardId, ip.mondayItemId, encodeColumnValues(ip.columnWrites, columnIdFor));
    }
    if (ip.moveToGroupKey) {
      const groupId = cfg.planner.groups[`presales.${ip.moveToGroupKey}`];
      if (!groupId) throw new Error(`No monday group configured for presales.${ip.moveToGroupKey}`);
      await gate.monday.moveItemToGroup(ip.mondayItemId, groupId);
    }
    if (ip.postUpdate) await gate.monday.createUpdate(ip.mondayItemId, ip.postUpdate.body, ip.postUpdate.mentionUserIds);
    if (ip.archive) await gate.monday.archiveItem(ip.mondayItemId);
  }

  const journal = gate.drain();

  // ── Persist ──
  const itemRef = createdId ?? `pending:${plan.opportunityId}`;
  const resolve = (s: string) => s.split(CREATED_ITEM).join(itemRef);

  const events: EventRow[] = plan.events
    .filter((e) => live || e.eventType === 'sync_failure')
    .map((e) => ({ ...eventRowFromIntent(e), entity_id: resolve(e.entityId) }));

  if (!live) {
    for (const j of journal) {
      events.push({
        source: 'engine', entity_type: j.system === 'monday' ? 'monday_item' : 'line_item', entity_id: resolve(j.target),
        event_type: 'dry_run_write', actor: 'engine',
        details: { op: j.op, payload: j.payload, sf_opportunity_id: plan.opportunityId },
      });
    }
  }

  // Dry run keeps only failure tasks (Hope can start clearing unmapped values);
  // stage-check / won tasks describe writes that didn't happen.
  const keepTask = (t: TaskIntent) => live || t.dedupeKey.startsWith('sync_failure:');
  for (const t of plan.tasks) {
    if (!keepTask(t) && t.op === 'open') {
      events.push({
        source: 'engine', entity_type: 'task', entity_id: resolve(t.dedupeKey), event_type: 'dry_run_write', actor: 'engine',
        details: { op: 'open_task', task_type: t.taskType, title: t.title, sf_opportunity_id: plan.opportunityId },
      });
    }
  }

  await db.tx(async (q) => {
    if (plan.create && createdId) await updateLink(q, createdId, plan.create.baseline, gate.mode);
    for (const ip of plan.items) {
      await updateLink(q, ip.mondayItemId, ip.baseline, gate.mode, live && ip.newLinkState ? { linkState: ip.newLinkState } : {});
    }
    await appendEvents(q, events, correlationId);
    for (const t of plan.tasks.filter(keepTask)) {
      if (t.op === 'open') {
        const ref = { ...t.sourceRef, ...(t.sourceRef.monday_item_id ? { monday_item_id: resolve(t.sourceRef.monday_item_id) } : {}) };
        await openTask(q, { ...t, dedupeKey: resolve(t.dedupeKey), sourceRef: ref }, correlationId);
      } else {
        await closeTask(q, resolve(t.dedupeKey), 'auto', correlationId);
      }
    }
  });

  return { correlationId, createdItemId: createdId, externalWrites: journal.length };
}
