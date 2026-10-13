/**
 * Pure monday value encoding / decoding. No I/O — tested by test/monday.test.mts.
 */
import type { MondayValue } from '../reconcile/types.ts';

/**
 * Planner value → the per-column JSON `change_multiple_column_values` /
 * `create_item` accept. Labels are always by ID (spec §2.2), and the caller
 * always sends create_labels_if_missing: false (spec §1).
 */
export function encodeColumnValue(v: MondayValue): unknown {
  switch (v.type) {
    case 'status':
      return { index: v.labelId };
    case 'dropdown':
      return { ids: v.labelIds };
    case 'datetime': {
      // UTC instant passed straight through — monday stores UTC and renders in
      // each viewer's timezone (spec §12). No conversion.
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})Z$/.exec(v.iso);
      if (!m) throw new Error(`datetime must be second-precision UTC ISO, got "${v.iso}"`);
      return { date: m[1], time: m[2] };
    }
    case 'text':
      return v.text;
    case 'long_text':
      return { text: v.text };
  }
}

/** { semanticKey: value } → { columnId: encoded } for one mutation. */
export function encodeColumnValues(
  writes: { semanticKey: string; value: MondayValue }[],
  columnIdFor: (semanticKey: string) => string | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const w of writes) {
    const id = columnIdFor(w.semanticKey);
    if (!id) throw new Error(`No monday column configured for ${w.semanticKey}`);
    out[id] = encodeColumnValue(w.value);
  }
  return out;
}

// ── Reading column values back ───────────────────────────────────────────────
function parseJson(raw: string | null | undefined): any {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Status column `value` is {"index": <label id>, …}. */
export function readStatusLabelId(raw: string | null | undefined): number | null {
  const j = parseJson(raw);
  return j && Number.isInteger(j.index) ? j.index : null;
}

/** Numbers column `value` is a JSON string ("125000") or null. */
export function readNumber(raw: string | null | undefined): number | null {
  const j = parseJson(raw);
  if (j === null || j === '') return null;
  const n = Number(j);
  return Number.isFinite(n) ? n : null;
}

/** People column `value` is {"personsAndTeams": [{"id": 123, "kind": "person"}, …]}. */
export function readPersonIds(raw: string | null | undefined): string[] {
  const j = parseJson(raw);
  const list = Array.isArray(j?.personsAndTeams) ? j.personsAndTeams : [];
  return list.filter((p: any) => p?.kind === 'person' && p.id !== undefined).map((p: any) => String(p.id));
}

/** Dropdown column `value` is {"ids": [1, 2]}. */
export function readDropdownIds(raw: string | null | undefined): number[] {
  const j = parseJson(raw);
  return Array.isArray(j?.ids) ? j.ids.map(Number).filter(Number.isInteger) : [];
}

export function readText(raw: string | null | undefined): string | null {
  const j = parseJson(raw);
  if (typeof j === 'string') return j.trim() === '' ? null : j;
  if (j && typeof j.text === 'string') return j.text.trim() === '' ? null : j.text;
  return null;
}

/** The calendar date an Eastern-time viewer sees for a UTC instant, as YYYY-MM-DD. */
export function etDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * The calendar date a date column shows an ET viewer, as YYYY-MM-DD. A date
 * with a time is a UTC instant; a date without one is already a calendar date.
 * Blank or unparseable → null.
 */
export function readEtDate(raw: string | null | undefined): string | null {
  const j = parseJson(raw);
  if (!j || typeof j.date !== 'string' || j.date === '') return null;
  return typeof j.time === 'string' && j.time !== '' ? etDate(`${j.date}T${j.time}Z`) : j.date;
}

/**
 * Does monday already hold this value? Compares the intended write with the
 * column's current raw value. Unknown or unparseable → false (write it).
 */
export function mondayValueMatches(v: MondayValue, raw: string | null | undefined): boolean {
  if (raw === undefined) return false;
  switch (v.type) {
    case 'status':
      return readStatusLabelId(raw) === v.labelId;
    case 'dropdown': {
      const cur = readDropdownIds(raw).slice().sort((a, b) => a - b);
      const want = v.labelIds.slice().sort((a, b) => a - b);
      return cur.length === want.length && cur.every((x, i) => x === want[i]);
    }
    case 'datetime': {
      const j = parseJson(raw);
      if (!j || typeof j.date !== 'string') return false;
      const time = typeof j.time === 'string' && j.time !== '' ? j.time : null;
      return time !== null && `${j.date}T${time}Z` === v.iso;
    }
    case 'text':
    case 'long_text':
      return readText(raw) === v.text;
  }
}

// ── Column label settings (config-drift check + mapping UI) ──────────────────
export interface LiveLabel {
  id: number;
  label: string;
  deactivated: boolean;
}

/**
 * Status and dropdown settings come in a few shapes across API versions:
 *   status:   {"labels": {"0": "In Progress", "1": "Won"}, …}
 *             or {"labels": [{"id": 0, "label": "In Progress", "is_deactivated": false}]}
 *   dropdown: {"labels": [{"id": 1, "name": "Yes"}], "deactivated_labels": [5]}
 *             or {"labels": [{"id": 1, "label": "Yes", "is_deactivated": false}]}
 * Normalize them all to LiveLabel[].
 */
export function parseColumnLabels(settings: unknown): LiveLabel[] {
  const s: any = typeof settings === 'string' ? parseJson(settings) : settings;
  if (!s || s.labels === undefined || s.labels === null) return [];
  const deactivatedIds = new Set<number>((Array.isArray(s.deactivated_labels) ? s.deactivated_labels : []).map(Number));

  if (Array.isArray(s.labels)) {
    return s.labels
      .filter((l: any) => l && l.id !== undefined)
      .map((l: any) => ({
        id: Number(l.id),
        label: String(l.label ?? l.name ?? ''),
        deactivated: Boolean(l.is_deactivated) || deactivatedIds.has(Number(l.id)),
      }));
  }
  return Object.entries(s.labels as Record<string, unknown>).map(([id, label]) => ({
    id: Number(id),
    label: String(label ?? ''),
    deactivated: deactivatedIds.has(Number(id)),
  }));
}
