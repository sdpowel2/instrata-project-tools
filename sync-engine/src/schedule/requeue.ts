/**
 * Queue a reconcile for every active linked opportunity — e.g. after a mapping
 * overhaul, or to measure the real dry-run diff.
 *
 * resetDryRunBaseline (dry run only): put dry_run_synced_values back to the
 * stage-only seed first, so the next pass re-plans every field from scratch.
 * The live baseline is never touched.
 */
import type { Db } from '../db/pool.ts';
import { sha256 } from '../ingress/parse.ts';

export async function requeueLinked(db: Db, opts: { resetDryRunBaseline: boolean }): Promise<{ queued: number; reset: number; queuedAt: string }> {
  const queuedAt = new Date().toISOString();
  return db.tx(async (q) => {
    let reset = 0;
    if (opts.resetDryRunBaseline) {
      const { rows } = await q.query<{ id: string }>(
        `update sf_link
            set dry_run_synced_values = jsonb_build_object('sf.stage', coalesce(last_synced_values->>'sf.stage', dry_run_synced_values->>'sf.stage'))
          where link_state = 'active' returning id`);
      reset = rows.length;
    }
    const { rows: opps } = await q.query<{ opp: string }>(
      `select distinct sf_opportunity_id as opp from sf_link where link_state = 'active'`);
    const { rows } = await q.query<{ id: string }>(
      `insert into webhook_inbox (source, payload, dedupe_hash)
       select 'salesforce', x.payload, x.dedupe_hash from jsonb_to_recordset($1::jsonb) as x(payload jsonb, dedupe_hash text)
       on conflict (dedupe_hash) do nothing returning id`,
      [JSON.stringify(opps.map((o) => ({ payload: { object: 'Requeue', opportunity_id: o.opp }, dedupe_hash: sha256('requeue', o.opp, queuedAt) })))]);
    return { queued: rows.length, reset, queuedAt };
  });
}
