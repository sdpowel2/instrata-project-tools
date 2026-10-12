/** monday item (raw GraphQL) → the snapshot the planner reasons about. Pure. */
import type { MondayItemRaw } from '../monday/client.ts';
import { readNumber, readPersonIds, readStatusLabelId } from '../monday/encode.ts';
import type { MondayItemSnapshot, PlannerConfig } from './types.ts';
import { SF_FIELD_KEYS } from './normalize.ts';

export const SNAPSHOT_KEYS = ['presales.status', 'presales.quoted_price', 'presales.presales_engineer'] as const;
/** Salesforce-owned columns read so unchanged values aren't re-written. */
export const FIELD_VALUE_KEYS = SF_FIELD_KEYS;

/** Column ids to request for snapshots (unconfigured ones are skipped). */
export function snapshotColumnIds(cfg: PlannerConfig): string[] {
  return [...SNAPSHOT_KEYS, ...FIELD_VALUE_KEYS].map((k) => cfg.columns[k]?.columnId).filter((x): x is string => !!x);
}

export function toSnapshot(raw: MondayItemRaw, cfg: PlannerConfig): MondayItemSnapshot {
  const value = (key: string) => {
    const id = cfg.columns[key]?.columnId;
    return id ? raw.column_values.find((c) => c.id === id)?.value ?? null : null;
  };
  return {
    id: String(raw.id),
    state: raw.state,
    groupId: raw.group?.id ?? null,
    statusLabelId: readStatusLabelId(value('presales.status')),
    quotedPrice: readNumber(value('presales.quoted_price')),
    engineerUserIds: readPersonIds(value('presales.presales_engineer')),
    fieldValues: Object.fromEntries(
      FIELD_VALUE_KEYS.filter((k) => cfg.columns[k]?.columnId).map((k) => [k, value(k)]),
    ),
  };
}
