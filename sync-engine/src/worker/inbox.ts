/**
 * webhook_inbox queue operations (spec §3.4).
 *
 * Claiming is a lease: the claim bumps `attempts` and pushes `next_attempt_at`
 * out by LEASE_SECONDS. If the process dies mid-row, the row simply becomes
 * claimable again when the lease expires — nothing is lost. SKIP LOCKED keeps
 * two workers (shouldn't happen, but) from taking the same row.
 */
import type { Queryable } from '../db/pool.ts';
import { openTask } from '../db/store.ts';

export const LEASE_SECONDS = 300;
export const MAX_ATTEMPTS = 5;

export interface InboxRow {
  id: string;
  source: 'salesforce' | 'monday';
  payload: any;
  attempts: number;
  received_at: string;
}

export async function claimBatch(q: Queryable, limit = 20): Promise<InboxRow[]> {
  const { rows } = await q.query<InboxRow>(
    `update webhook_inbox w
        set attempts = w.attempts + 1, next_attempt_at = now() + make_interval(secs => $2)
      where w.id in (select id from webhook_inbox
                      where status = 'pending' and next_attempt_at <= now()
                      order by id limit $1 for update skip locked)
      returning w.id::text, w.source, w.payload, w.attempts, w.received_at`,
    [limit, LEASE_SECONDS]);
  return rows.sort((a, b) => Number(a.id) - Number(b.id));
}

export async function markDone(q: Queryable, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await q.query(
    `update webhook_inbox set status = 'done', processed_at = now(), error_text = null where id = any($1::bigint[])`, [ids]);
}

/** Not a failure: come back at `until` without spending an attempt (writeback debounce). */
export async function defer(q: Queryable, id: string, until: Date): Promise<void> {
  await q.query(
    `update webhook_inbox set next_attempt_at = $2, attempts = greatest(0, attempts - 1) where id = $1::bigint`,
    [id, until.toISOString()]);
}

/**
 * Retry with exponential backoff (1, 2, 4, 8 min); after MAX_ATTEMPTS the row is
 * parked as `error` and surfaces as a failure task on Hope's queue (spec §6.3).
 */
export async function markFailed(q: Queryable, row: InboxRow, error: string): Promise<'retry' | 'error'> {
  if (row.attempts < MAX_ATTEMPTS) {
    await q.query(
      `update webhook_inbox set status = 'pending', error_text = $2,
              next_attempt_at = now() + make_interval(mins => $3) where id = $1::bigint`,
      [row.id, error.slice(0, 2000), 2 ** (row.attempts - 1)]);
    return 'retry';
  }
  await q.query(
    `update webhook_inbox set status = 'error', processed_at = now(), error_text = $2 where id = $1::bigint`,
    [row.id, error.slice(0, 2000)]);
  const what = row.source === 'salesforce'
    ? `opportunity ${row.payload?.opportunity_id ?? '?'}`
    : `monday item ${row.payload?.event?.pulseId ?? '?'}`;
  await openTask(q, {
    op: 'open', taskType: 'sync_failure', dedupeKey: `sync_failure:webhook_error:inbox:${row.id}`,
    title: `Sync event failed ${MAX_ATTEMPTS}× (${row.source}): ${what}`,
    details: `Inbox row ${row.id} gave up after ${MAX_ATTEMPTS} attempts. Last error: ${error.slice(0, 500)}`,
    sourceRef: row.source === 'salesforce' && row.payload?.opportunity_id ? { sf_opportunity_id: String(row.payload.opportunity_id) } : {},
  }, null);
  return 'error';
}

export async function inboxStats(q: Queryable): Promise<Record<string, number>> {
  const { rows } = await q.query<{ status: string; n: number }>(
    `select status, count(*)::int as n from webhook_inbox where status <> 'done' or processed_at > now() - interval '1 day' group by status`);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
