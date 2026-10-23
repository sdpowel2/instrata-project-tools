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
import { appendEvents, closeTask, eventRowFromIntent, insertLink, openTask, setAsideItemIds, updateLink, type EventRow } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import { encodeColumnValues } from '../monday/encode.ts';
import type { WriteGate } from '../writeGate.ts';
import { CREATED_ITEM, type ReconcilePlan, type TaskIntent } from './types.ts';
import { STAGE_KEY } from './normalize.ts';
import { handoffSlaDays } from '../queue/won.ts';
import { businessDaysAfter } from '../queue/time.ts';

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
  const { db, cfg } = deps;
  const gate = deps.gate.fork();
  const live = gate.mode === 'live';
  const correlationId = randomUUID();
  // The three pre-sales boards share column ids, so column config is board-agnostic;
  // only the board (and group) differ.
  const boardIdOf = (key: string | undefined) => {
    const id = cfg.boards[key ?? 'presales'];
    if (!id) throw new Error(`config_boards.${key ?? 'presales'} has no monday board id`);
    return id;
  };
  const groupIdOf = (boardKey: string, groupKey: string) => {
    const id = cfg.planner.groups[`${boardKey}.${groupKey}`];
    if (!id) throw new Error(`No monday group configured for ${boardKey}.${groupKey}`);
    return id;
  };
  const columnIdFor = (k: string) => cfg.planner.columns[k]?.columnId;
  // A set-aside item (a change order, say) still holds its link but is never written
  // to and raises no tasks; the next backfill may hand the link to the real deal.
  const aside = await setAsideItemIds(db);
  const items = plan.items.filter((ip) => !aside.has(ip.mondayItemId));
  const tasks = plan.tasks.filter((t) => !(t.op === 'open' && t.sourceRef.monday_item_id && aside.has(String(t.sourceRef.monday_item_id))));
  // ── Outbound writes ──
  let createdId: string | null = null;
  if (plan.create) {
    const c = plan.create;
    const boardId = boardIdOf(c.boardKey);
    createdId = await gate.monday.createItem(
      boardId, groupIdOf(c.boardKey, c.groupKey), c.itemName, encodeColumnValues(c.columnWrites, columnIdFor));
    if (createdId) {
      const { [STAGE_KEY]: _stage, ...preStage } = c.baseline;
      await insertLink(db, { mondayItemId: createdId, sfOpportunityId: plan.opportunityId, sfLineItemId: c.sfLineItemId, baseline: preStage }, gate.mode);
    }
    if (c.stageWrites.length > 0) {
      await gate.monday.changeColumnValues(boardId, createdId ?? CREATED_ITEM, encodeColumnValues(c.stageWrites, columnIdFor));
    }
  }

  for (const ip of items) {
    const boardKey = ip.boardKey ?? 'presales';
    // Column writes land on the board the item is on now, before any move.
    if (ip.columnWrites.length > 0) {
      await gate.monday.changeColumnValues(boardIdOf(boardKey), ip.mondayItemId, encodeColumnValues(ip.columnWrites, columnIdFor));
    }
    if (ip.moveTo) {
      const groupId = groupIdOf(ip.moveTo.boardKey, ip.moveTo.groupKey);
      if (ip.moveTo.boardKey === boardKey) await gate.monday.moveItemToGroup(ip.mondayItemId, groupId);
      else await gate.monday.moveItemToBoard(ip.mondayItemId, boardIdOf(boardKey), boardIdOf(ip.moveTo.boardKey), groupId);
    }
    if (ip.postUpdate) await gate.monday.createUpdate(ip.mondayItemId, ip.postUpdate.body, ip.postUpdate.mentionUserIds);
    if (ip.archive) await gate.monday.archiveItem(ip.mondayItemId);
  }

  const journal = gate.drain();

  // ── Persist ──
  const itemRef = createdId ?? `pending:${plan.opportunityId}`;
  const resolve = (s: string) => s.split(CREATED_ITEM).join(itemRef);
  // Task-member labels read 'monday item <id>'; for a not-yet-created item say so in words.
  const resolveItemLabel = (s: string) => s.split(`monday item ${CREATED_ITEM}`).join(createdId ? `monday item ${createdId}` : 'not on the board yet');

  const events: EventRow[] = plan.events
    .filter((e) => (live || e.eventType === 'sync_failure') && !aside.has(e.entityId))
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
  // stage-check / won tasks describe writes that didn't happen, and so does any task
  // keyed to an item dry run only pretended to create (no such item on any board).
  const keepTask = (t: TaskIntent) => live || (t.dedupeKey.startsWith('sync_failure:') && !t.dedupeKey.includes(CREATED_ITEM));
  for (const t of tasks) {
    if (!keepTask(t) && t.op === 'open') {
      events.push({
        source: 'engine', entity_type: 'task', entity_id: resolve(t.dedupeKey), event_type: 'dry_run_write', actor: 'engine',
        details: { op: 'open_task', task_type: t.taskType, title: t.title, sf_opportunity_id: plan.opportunityId },
      });
    }
  }

  await db.tx(async (q) => {
    if (plan.create && createdId) await updateLink(q, createdId, plan.create.baseline, gate.mode);
    for (const ip of items) {
      await updateLink(q, ip.mondayItemId, ip.baseline, gate.mode, live && ip.newLinkState ? { linkState: ip.newLinkState } : {});
    }
    await appendEvents(q, events, correlationId);
    for (const t of tasks.filter(keepTask)) {
      if (t.op === 'open') {
        const ref = { ...t.sourceRef, ...(t.sourceRef.monday_item_id ? { monday_item_id: resolve(t.sourceRef.monday_item_id) } : {}) };
        const member = t.member ? { ...t.member, label: resolveItemLabel(t.member.label) } : undefined;
        // Won – handoff is due N business days after Won (Seth 2026-10-20).
        const sla = t.taskType === 'won_handoff' ? handoffSlaDays(cfg.settings) : null;
        const dueAt = sla ? businessDaysAfter(new Date(), sla).toISOString() : null;
        await openTask(q, { ...t, dedupeKey: resolve(t.dedupeKey), sourceRef: ref, ...(member ? { member } : {}) }, correlationId, dueAt);
      } else {
        await closeTask(q, resolve(t.dedupeKey), 'auto', correlationId, t.memberId, { withdraw: t.withdraw });
      }
    }
  });

  return { correlationId, createdItemId: createdId, externalWrites: journal.length };
}
