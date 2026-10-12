/**
 * Registers the engine's monday webhooks through the API (Build Guide §3: nothing
 * to click). Idempotent: monday's Webhook type doesn't expose the target URL, so
 * the ids we created (and a hash of the URL they point at) are remembered in engine_status;
 * anything missing is (re)created.
 *
 * Infrastructure, not a sync write — runs in dry run too (dry run needs events).
 */
import type { Db } from '../db/pool.ts';
import { setEngineStatus } from '../db/store.ts';
import { sha256 } from '../ingress/parse.ts';
import type { MondayClient } from './client.ts';

export const PRESALES_EVENTS = ['change_column_value', 'item_archived', 'item_deleted'] as const;

interface Registered {
  /** sha256 of the delivery URL — the URL itself carries the path secret and engine_status is readable in the app. */
  urlHash: string;
  ids: Record<string, string>; // event → webhook id
}

export async function ensurePresalesWebhooks(
  db: Db,
  monday: MondayClient,
  boardId: string,
  url: string,
): Promise<{ created: string[]; kept: string[] }> {
  const statusKey = `monday_webhooks:${boardId}`;
  const { rows } = await db.query<{ value: Registered }>('select value from engine_status where name = $1', [statusKey]);
  const prior: Registered | null = rows[0]?.value ?? null;
  const live = new Set((await monday.listWebhooks(boardId)).map((w) => String(w.id)));

  const urlHash = sha256('webhook-url', url);
  const ids: Record<string, string> = {};
  const created: string[] = [];
  const kept: string[] = [];
  for (const event of PRESALES_EVENTS) {
    const priorId = prior?.urlHash === urlHash ? prior.ids[event] : undefined;
    if (priorId && live.has(priorId)) {
      ids[event] = priorId;
      kept.push(event);
    } else {
      ids[event] = await monday.createWebhook(boardId, url, event);
      created.push(event);
    }
  }
  await setEngineStatus(db, statusKey, { urlHash, ids } satisfies Registered);
  return { created, kept };
}
