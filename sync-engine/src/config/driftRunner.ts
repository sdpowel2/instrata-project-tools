/** Runs the drift check against live monday labels and keeps the config_drift tasks in step. */
import type { Db } from '../db/pool.ts';
import { closeTask, openTask } from '../db/store.ts';
import type { MondayClient } from '../monday/client.ts';
import type { LiveLabel } from '../monday/encode.ts';
import { driftTaskKey, driftTaskText, findDrift, type DriftResult } from './drift.ts';
import type { RuntimeConfig } from './load.ts';

export async function runDriftCheck(db: Db, monday: MondayClient, cfg: RuntimeConfig): Promise<DriftResult> {
  const live: Record<string, LiveLabel[]> = {};
  for (const key of new Set(cfg.labelRefs.map((r) => r.semanticKey))) {
    const col = cfg.planner.columns[key];
    const boardId = col?.boardKey ? cfg.boards[col.boardKey] : null;
    if (!col?.columnId || !boardId) continue;
    live[key] = await monday.getColumnLabels(boardId, col.columnId);
  }

  const result = findDrift(cfg.labelRefs, live);
  const current = new Set(result.findings.map(driftTaskKey));

  await db.tx(async (q) => {
    for (const f of result.findings) {
      await openTask(q, { op: 'open', taskType: 'sync_failure', dedupeKey: driftTaskKey(f), ...driftTaskText(f), sourceRef: { mapping_table: f.ref.source } }, null);
    }
    const { rows } = await q.query<{ dedupe_key: string }>(
      `select dedupe_key from task where dedupe_key like 'sync_failure:config_drift:%' and status <> 'done'`);
    for (const r of rows) if (!current.has(r.dedupe_key)) await closeTask(q, r.dedupe_key, 'auto', null);
  });

  return result;
}
