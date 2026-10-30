/**
 * Hourly safety sweep (spec §4.1). Salesforce doesn't retry failed Flow
 * callouts and monday webhooks can drop, so this makes missed events self-heal.
 *
 * It doesn't reconcile directly: it ENQUEUES one inbox row per opportunity, so
 * sweep work gets the same retries, backoff and failure tasks as webhook work.
 * The watermark advances only after everything is enqueued.
 *
 * Also re-enqueues opportunities behind open unmapped-value failure tasks — a
 * mapping fix doesn't touch the opportunity, so nothing else would revisit it.
 */
import type { Db } from '../db/pool.ts';
import { getWatermark, setWatermark } from '../db/store.ts';
import { sha256 } from '../ingress/parse.ts';
import type { SalesforceClient } from '../salesforce/client.ts';
import { sweepQueries } from '../salesforce/soql.ts';

export const SWEEP_WATERMARK = 'sf_sweep';
const OVERLAP_MS = 10 * 60 * 1000; // watermark − 10 min (spec §4.1)

export interface SweepResult {
  since: string;
  changed: number;
  mappingRetries: number;
  enqueued: number;
}

export async function runSweep(deps: { db: Db; salesforce: SalesforceClient }, now: Date = new Date()): Promise<SweepResult> {
  const wm = (await getWatermark(deps.db, SWEEP_WATERMARK)) ?? new Date(now.getTime() - 24 * 3600 * 1000);
  const since = new Date(wm.getTime() - OVERLAP_MS);
  const q = sweepQueries(since);

  const [opps, lines, deleted] = await Promise.all([
    deps.salesforce.query<{ Id: string }>(q.opportunities),
    deps.salesforce.query<{ OpportunityId: string }>(q.lineItems),
    deps.salesforce.queryAll<{ OpportunityId: string }>(q.deletedLineItems),
  ]);
  const changed = new Set<string>([...opps.map((o) => o.Id), ...lines.map((l) => l.OpportunityId), ...deleted.map((d) => d.OpportunityId)]);

  const { rows: retry } = await deps.db.query<{ opp: string }>(
    `select distinct m->>'id' as opp
       from task, jsonb_array_elements(coalesce(source_ref->'members', '[]'::jsonb)) as m
      where dedupe_key like 'sync_failure:unmapped_value:%' and status <> 'done'`);
  // "Different project" set on a held create from Project Tools (no monday webhook):
  // still unlinked → reconcile, and the engine creates the item (Seth 2026-10-30).
  const { rows: dismissed } = await deps.db.query<{ opp: string }>(
    `select split_part(t.dedupe_key, ':', 3) as opp from task t
      where t.dedupe_key like 'sync_failure:possible_duplicate:%' and t.status = 'done' and t.close_mode = 'manual'
        and t.closed_at > now() - interval '7 days'
        and not exists (select 1 from sf_link l where l.sf_opportunity_id = split_part(t.dedupe_key, ':', 3))`);
  retry.push(...dismissed);
  const all = new Set([...changed, ...retry.map((r) => r.opp).filter(Boolean)]);

  let enqueued = 0;
  if (all.size > 0) {
    const stamp = now.toISOString();
    const payload = [...all].map((id) => ({
      payload: { object: 'Sweep', opportunity_id: id, swept_at: stamp },
      dedupe_hash: sha256('sweep', id, stamp),
    }));
    const { rows } = await deps.db.query<{ id: string }>(
      `insert into webhook_inbox (source, payload, dedupe_hash)
       select 'salesforce', x.payload, x.dedupe_hash from jsonb_to_recordset($1::jsonb) as x(payload jsonb, dedupe_hash text)
       on conflict (dedupe_hash) do nothing returning id`,
      [JSON.stringify(payload)]);
    enqueued = rows.length;
  }

  await setWatermark(deps.db, SWEEP_WATERMARK, now);
  return { since: since.toISOString(), changed: changed.size, mappingRetries: retry.length, enqueued };
}
