/**
 * Snapshot of the monday labels Hope maps Salesforce values to (Sales Person,
 * Business Unit, Win %) and the Triage engineer dropdown, so the Mappings screen
 * in Project Tools can show label names (map rows store label ids). Written to
 * engine_status 'monday_labels' with the hourly drift check.
 */
import type { Db } from '../db/pool.ts';
import { setEngineStatus } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import type { MondayClient } from '../monday/client.ts';

const KEYS = ['presales.sales_person', 'presales.business_unit', 'presales.win_pct', 'triage.engineer_pick'];

export async function snapshotMondayLabels(db: Db, monday: MondayClient, cfg: RuntimeConfig): Promise<void> {
  const out: Record<string, { id: number; label: string }[]> = {};
  for (const key of KEYS) {
    const col = cfg.planner.columns[key];
    const boardId = col ? cfg.boards[col.boardKey ?? 'presales'] : null;
    if (!col?.columnId || !boardId) continue;
    const labels = await monday.getColumnLabels(String(boardId), col.columnId);
    out[key] = labels.filter((l) => !l.deactivated).map((l) => ({ id: l.id, label: l.label }));
  }
  await setEngineStatus(db, 'monday_labels', { at: new Date().toISOString(), labels: out });
}
