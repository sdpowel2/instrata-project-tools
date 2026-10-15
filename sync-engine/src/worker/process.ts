/**
 * Drains the inbox. Salesforce events (webhooks and sweep entries alike) are
 * batched into one reconcile per distinct opportunity; monday events are routed
 * one by one.
 */
import { errMessage, log } from '../log.ts';
import { reconcileOpportunities, type ReconcileDeps } from '../reconcile/service.ts';
import { claimBatch, defer, markDone, markFailed, type InboxRow } from './inbox.ts';
import { handleMondayEvent } from './mondayEvents.ts';

export interface WorkerDeps extends ReconcileDeps {
  integrationUserId: string;
  salesforceLoginUrl?: string;
  now?: () => Date;
}

export async function processRows(deps: WorkerDeps, rows: InboxRow[]): Promise<{ done: number; failed: number; deferred: number }> {
  const stats = { done: 0, failed: 0, deferred: 0 };

  const sfRows = rows.filter((r) => r.source === 'salesforce');
  if (sfRows.length > 0) {
    const oppOf = (r: InboxRow) => String(r.payload?.opportunity_id ?? '');
    try {
      const summary = await reconcileOpportunities(deps, sfRows.map(oppOf).filter(Boolean));
      const failed = new Map(summary.failed.map((f) => [f.opportunityId, f.error]));
      const ok = sfRows.filter((r) => oppOf(r) && !failed.has(oppOf(r)));
      await markDone(deps.db, ok.map((r) => r.id));
      stats.done += ok.length;
      for (const r of sfRows.filter((r) => !ok.includes(r))) {
        await markFailed(deps.db, r, failed.get(oppOf(r)) ?? 'missing opportunity_id');
        stats.failed++;
      }
    } catch (e) {
      // Whole-batch failure (Salesforce down, auth broken): every row retries.
      for (const r of sfRows) await markFailed(deps.db, r, errMessage(e));
      stats.failed += sfRows.length;
    }
  }

  const mondayRows = rows.filter((r) => r.source === 'monday');
  if (mondayRows.length > 0) {
    const cfg = await deps.getConfig();
    for (const r of mondayRows) {
      try {
        const out = await handleMondayEvent({ ...deps, cfg }, r);
        if (out.kind === 'defer') {
          await defer(deps.db, r.id, out.until);
          stats.deferred++;
        } else {
          await markDone(deps.db, [r.id]);
          stats.done++;
        }
      } catch (e) {
        await markFailed(deps.db, r, errMessage(e));
        stats.failed++;
      }
    }
  }
  return stats;
}

/** Claim-and-process until the queue has nothing due. Returns rows handled. */
export async function drainInbox(deps: WorkerDeps): Promise<number> {
  let handled = 0;
  for (;;) {
    const rows = await claimBatch(deps.db);
    if (rows.length === 0) return handled;
    const s = await processRows(deps, rows);
    handled += rows.length;
    if (s.failed > 0) log.warn('inbox batch had failures', s);
    if (rows.length < 20) return handled;
  }
}
