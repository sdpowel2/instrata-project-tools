/**
 * Set-aside items (sync_set_aside.sql, Seth 2026-10-23): monday items that can never
 * agree with a Salesforce record — mostly change orders — set aside by the coordinator
 * on the Coordinator page. Backfill, reconcile, writeback and the cleanliness count
 * skip them at the source; this takes them off the tasks already open, every minute
 * with the queue push, so Hope's queue shrinks right after she sets one aside:
 *   - a member of a grouped backfill task leaves it (the task closes with its last one)
 *   - a "Price/GM% not sent: item isn't linked" task closes
 */
import type { Db } from '../db/pool.ts';
import { closeTask, setAsideItemIds } from '../db/store.ts';

const WRITEBACK_NO_LINK = 'writeback_no_link:';

export async function pruneSetAside(db: Db): Promise<number> {
  const aside = await setAsideItemIds(db);
  if (aside.size === 0) return 0;
  let removed = 0;
  await db.tx(async (q) => {
    const { rows } = await q.query<{ dedupe_key: string; source_ref: { members?: { id: string }[] } | null }>(
      `select dedupe_key, source_ref from task
        where status <> 'done' and (dedupe_key like 'sync_failure:backfill:%' or dedupe_key like '${WRITEBACK_NO_LINK}%')`);
    for (const r of rows) {
      if (r.dedupe_key.startsWith(WRITEBACK_NO_LINK)) {
        if (aside.has(r.dedupe_key.slice(WRITEBACK_NO_LINK.length)) && (await closeTask(q, r.dedupe_key, 'auto', null)) !== 'unchanged') removed++;
        continue;
      }
      for (const m of r.source_ref?.members ?? []) {
        if (aside.has(String(m.id)) && (await closeTask(q, r.dedupe_key, 'auto', null, String(m.id))) !== 'unchanged') removed++;
      }
    }
  });
  return removed;
}
