/**
 * Config-drift check (spec §2.2): every configured label id must still exist,
 * active, on its monday column. Run at startup and every sweep.
 *
 *   - A config_labels id that vanished → block writes to that whole column and
 *     raise a config_drift failure task (the engine can't reason about status
 *     without its labels).
 *   - A map_* row whose label vanished → just that row is treated as unmapped,
 *     so the normal unmapped-value failure fires instead of writing a dead id.
 */
import type { LabelRef } from './load.ts';
import type { LiveLabel } from '../monday/encode.ts';

export interface DriftFinding {
  ref: LabelRef;
  problem: 'missing' | 'deactivated';
}

export interface DriftResult {
  findings: DriftFinding[];
  blockedColumns: string[];
  deadMapRows: { table: string; sfValue: string }[];
}

/** Pure. `live` holds the current labels per semantic key; keys absent from it weren't checked. */
export function findDrift(refs: LabelRef[], live: Record<string, LiveLabel[]>): DriftResult {
  const findings: DriftFinding[] = [];
  for (const ref of refs) {
    const labels = live[ref.semanticKey];
    if (!labels) continue;
    const hit = labels.find((l) => l.id === ref.labelId);
    if (!hit) findings.push({ ref, problem: 'missing' });
    else if (hit.deactivated) findings.push({ ref, problem: 'deactivated' });
  }
  return {
    findings,
    blockedColumns: [...new Set(findings.filter((f) => f.ref.source === 'config_labels').map((f) => f.ref.semanticKey))],
    deadMapRows: findings.filter((f) => f.ref.source !== 'config_labels').map((f) => ({ table: f.ref.source, sfValue: f.ref.key })),
  };
}

export function driftTaskKey(f: DriftFinding): string {
  return `sync_failure:config_drift:${f.ref.source}:${f.ref.semanticKey}.${f.ref.key}`;
}

export function driftTaskText(f: DriftFinding): { title: string; details: string } {
  const what = f.ref.source === 'config_labels' ? `label "${f.ref.key}"` : `the label mapped from "${f.ref.key}"`;
  return {
    title: `Config drift: ${f.ref.semanticKey} ${what} is ${f.problem}`,
    details:
      `monday label id ${f.ref.labelId} on ${f.ref.semanticKey} is ${f.problem}. ` +
      (f.ref.source === 'config_labels'
        ? 'Writes to this column are paused until it is fixed in Sync Admin → Labels.'
        : `That value is treated as unmapped until ${f.ref.source} is fixed in Sync Admin → Mappings.`),
  };
}
