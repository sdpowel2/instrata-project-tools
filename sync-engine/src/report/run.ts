/**
 * Builds the field-diff review over every active linked item, from LIVE data.
 * Read-only on both systems. GET /admin/diff-report (?format=csv).
 */
import type { Db } from '../db/pool.ts';
import type { RuntimeConfig } from '../config/load.ts';
import type { MondayClient } from '../monday/client.ts';
import type { SalesforceClient } from '../salesforce/client.ts';
import { snapshotColumnIds, toSnapshot } from '../reconcile/snapshot.ts';
import { diffItem, toCsv } from './fieldDiff.ts';

export interface ReportRow {
  group: string;
  item: string;
  mondayItemId: string;
  opportunity: string;
  stage: string;
  field: string;
  mondayNow: string;
  salesforce: string;
  note: string;
  mondayUrl: string;
  salesforceUrl: string;
}

export interface DiffReport {
  generatedAt: string;
  linkedItems: number;
  itemsWithChanges: number;
  byField: Record<string, number>;
  rows: ReportRow[];
}

const LABEL_KEYS = ['presales.win_pct', 'presales.business_unit', 'presales.sales_person', 'presales.status'];

/** https://x.my.salesforce.com → https://x.lightning.force.com (also for sandbox domains). */
export function lightningBase(loginUrl: string): string {
  return loginUrl.replace(/\.my\.salesforce\.com\/?$/, '.lightning.force.com');
}

export async function buildDiffReport(deps: {
  db: Db;
  monday: MondayClient;
  salesforce: SalesforceClient;
  cfg: RuntimeConfig;
  salesforceLoginUrl: string;
}): Promise<DiffReport> {
  const { cfg } = deps;
  const boardId = cfg.boards.presales;
  if (!boardId) throw new Error('presales board not configured');

  const { rows: links } = await deps.db.query<{ item: string; opp: string }>(
    `select monday_item_id::text as item, sf_opportunity_id as opp from sf_link where link_state = 'active'`);
  const opps = await deps.salesforce.getOpportunities(links.map((l) => l.opp));
  const raw = await deps.monday.getItems(links.map((l) => l.item), snapshotColumnIds(cfg.planner));
  const items = new Map(raw.map((r) => [String(r.id), r]));

  // Readable names: groups, dropdown/status labels, account slug for links.
  const meta = await deps.monday.query<{ boards: { groups: { id: string; title: string }[] }[]; account: { slug: string } }>(
    `query ($b: [ID!]) { boards(ids: $b) { groups { id title } } account { slug } }`, { b: [boardId] });
  const groups = new Map((meta.boards?.[0]?.groups ?? []).map((g) => [g.id, g.title]));
  const labels = new Map<string, Map<number, string>>();
  for (const key of LABEL_KEYS) {
    const col = cfg.planner.columns[key]?.columnId;
    if (!col) continue;
    labels.set(key, new Map((await deps.monday.getColumnLabels(boardId, col)).map((l) => [l.id, l.label])));
  }
  const labelText = (key: string, id: number) => labels.get(key)?.get(id) ?? `label ${id}`;
  const mondayBase = `https://${meta.account?.slug ?? 'monday'}.monday.com/boards/${boardId}/pulses/`;
  const sfBase = `${lightningBase(deps.salesforceLoginUrl)}/lightning/r/Opportunity/`;

  const out: ReportRow[] = [];
  for (const link of links) {
    const opp = opps.get(link.opp);
    const r = items.get(link.item);
    if (!opp || !r || r.state !== 'active') continue;
    const snap = toSnapshot(r, cfg.planner);
    for (const d of diffItem(opp, snap, cfg.planner, cfg.maps, labelText)) {
      out.push({
        group: groups.get(r.group?.id ?? '') ?? r.group?.id ?? '',
        item: r.name,
        mondayItemId: link.item,
        opportunity: opp.Name,
        stage: opp.StageName,
        ...d,
        mondayUrl: mondayBase + link.item,
        salesforceUrl: `${sfBase}${opp.Id}/view`,
      });
    }
  }
  out.sort((a, b) => a.group.localeCompare(b.group) || a.item.localeCompare(b.item) || a.field.localeCompare(b.field));

  const byField: Record<string, number> = {};
  for (const r of out) byField[r.field] = (byField[r.field] ?? 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    linkedItems: links.length,
    itemsWithChanges: new Set(out.map((r) => r.mondayItemId)).size,
    byField,
    rows: out,
  };
}

export function reportCsv(r: DiffReport): string {
  return toCsv(
    ['Group', 'monday item', 'Opportunity', 'Stage', 'Field', 'monday now', 'Salesforce says', 'Note', 'monday link', 'Salesforce link'],
    r.rows.map((x) => [x.group, x.item, x.opportunity, x.stage, x.field, x.mondayNow, x.salesforce, x.note, x.mondayUrl, x.salesforceUrl]),
  );
}
