/**
 * reconcileOpportunities(ids): fetch → plan → execute, per opportunity.
 * Triggered by the Salesforce webhook, the hourly sweep, and the manual
 * admin endpoint / MCP tool (spec §4.1). One opportunity failing never blocks the rest.
 */
import type { Db } from '../db/pool.ts';
import { loadLinksForOpportunities } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import type { MondayClient } from '../monday/client.ts';
import type { SalesforceClient } from '../salesforce/client.ts';
import type { WriteGate } from '../writeGate.ts';
import { errMessage, log } from '../log.ts';
import { executePlan, type ExecuteResult } from './execute.ts';
import { planReconcile } from './plan.ts';
import { snapshotColumnIds, toSnapshot } from './snapshot.ts';
import type { MondayItemSnapshot } from './types.ts';

export interface ReconcileDeps {
  db: Db;
  gate: WriteGate;
  monday: MondayClient;
  salesforce: SalesforceClient;
  getConfig: () => Promise<RuntimeConfig>;
}

export interface ReconcileSummary {
  results: { opportunityId: string; result: ExecuteResult }[];
  failed: { opportunityId: string; error: string }[];
}

export async function reconcileOpportunities(deps: ReconcileDeps, ids: string[]): Promise<ReconcileSummary> {
  const unique = [...new Set(ids)];
  const summary: ReconcileSummary = { results: [], failed: [] };
  if (unique.length === 0) return summary;

  const cfg = await deps.getConfig();
  const [opps, links] = await Promise.all([
    deps.salesforce.getOpportunities(unique),
    loadLinksForOpportunities(deps.db, unique, deps.gate.mode),
  ]);

  const itemIds = [...new Set(links.map((l) => l.mondayItemId))];
  const items: Record<string, MondayItemSnapshot> = {};
  if (itemIds.length > 0) {
    for (const raw of await deps.monday.getItems(itemIds, snapshotColumnIds(cfg.planner))) {
      items[String(raw.id)] = toSnapshot(raw, cfg.planner, cfg.boards);
    }
  }

  for (const opportunityId of unique) {
    try {
      const plan = planReconcile({
        opportunity: opps.get(opportunityId) ?? null,
        opportunityId,
        links: links.filter((l) => l.sfOpportunityId === opportunityId),
        items,
        config: cfg.planner,
        maps: cfg.maps,
      });
      const result = await executePlan({ db: deps.db, gate: deps.gate, cfg }, plan);
      summary.results.push({ opportunityId, result });
      if (result.externalWrites > 0 || plan.create) {
        log.info('reconciled', { opportunityId, mode: deps.gate.mode, writes: result.externalWrites, created: result.createdItemId, correlationId: result.correlationId });
      }
    } catch (e) {
      summary.failed.push({ opportunityId, error: errMessage(e) });
      log.error('reconcile failed', { opportunityId, error: errMessage(e) });
    }
  }
  return summary;
}
