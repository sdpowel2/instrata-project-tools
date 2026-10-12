/**
 * Routing for monday webhook events (pre-sales board; Hope's Queue board events
 * arrive with the queue engine in Phase 1B).
 *
 *   - Echoes of the engine's own writes (integration user) → ignored (spec §4.7).
 *   - Quoted Price / GM % changed by a person → writeback, debounced (spec §5).
 *   - Salesforce-owned field or status changed by a person → logged for rework
 *     analysis (spec §4.5, §8). The sync does not fight hand edits.
 *   - Item archived / deleted → its link is archived.
 */
import type { Db } from '../db/pool.ts';
import { appendEvents } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import { isMondayRemoval, parseMondayEvent, type MondayEvent } from '../ingress/parse.ts';
import type { MondayClient } from '../monday/client.ts';
import type { SalesforceClient } from '../salesforce/client.ts';
import type { WriteGate } from '../writeGate.ts';
import { runWriteback } from '../writeback/run.ts';
import type { InboxRow } from './inbox.ts';

export interface MondayEventDeps {
  db: Db;
  gate: WriteGate;
  monday: MondayClient;
  salesforce: SalesforceClient;
  cfg: RuntimeConfig;
  integrationUserId: string;
  now?: () => Date;
}

export type MondayOutcome = { kind: 'done'; note: string } | { kind: 'defer'; until: Date };

const WRITEBACK_KEYS = ['presales.quoted_price', 'presales.gm_pct'];

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
  if (ev.boardId !== deps.cfg.boards.presales) return { kind: 'done', note: 'not the pre-sales board' };
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
    return { kind: 'done', note: 'logged' };
  }
  return { kind: 'done', note: 'monday-owned column' };
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

