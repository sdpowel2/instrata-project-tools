/**
 * Field-by-field review of what the sync would change on a linked item:
 * "monday now" vs "Salesforce says". Pure — tested by test/report.test.mts.
 *
 * Compares LIVE values (not the sync baseline), so it answers "what is out of
 * date right now" and can run any time, in dry run or live.
 */
import { extractSfFields, SF_FIELD_KEYS, type SfFieldKey } from '../reconcile/normalize.ts';
import { fieldLabel, isClosedGroup, mapSfValue } from '../reconcile/plan.ts';
import { etDate, mondayValueMatches, readDropdownIds, readText } from '../monday/encode.ts';
import type { MondayItemSnapshot, PlannerConfig, PlannerMaps, SfOpportunity } from '../reconcile/types.ts';

export interface DiffRow {
  field: string;
  mondayNow: string;
  salesforce: string;
  note: string;
}

/** semanticKey → label id → label text, read live from monday. */
export type LabelText = (semanticKey: string, id: number) => string;

const TZ = 'America/New_York';

/** '2026-10-15T18:00:00Z' → 'Oct 15, 2026 2:00 PM ET' (what an ET viewer sees in monday). */
export function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`;
}

function readableMonday(key: SfFieldKey, raw: string | null | undefined, labelText: LabelText): string {
  if (raw === null || raw === undefined || raw === '') return '(blank)';
  if (key === 'presales.due_date') {
    try {
      const j = JSON.parse(raw);
      if (!j?.date) return '(blank)';
      return j.time ? formatInstant(`${j.date}T${j.time}Z`) : `${j.date} (no time)`;
    } catch {
      return raw;
    }
  }
  if (key === 'presales.quote_number') return readText(raw) ?? '(blank)';
  const ids = readDropdownIds(raw);
  return ids.length === 0 ? '(blank)' : ids.map((id) => labelText(key, id)).join(', ');
}

export { etDate };

/**
 * monday holds dates only today; Salesforce holds date + time. Say whether the
 * sync merely adds the time, or the DATE itself is different (comparing in ET,
 * the date most viewers see).
 */
function dueDateNote(raw: string | null | undefined, sfIso: string): string {
  if (!raw) return 'monday blank — fills it in';
  try {
    const j = JSON.parse(raw);
    if (!j?.date) return 'monday blank — fills it in';
    if (j.date === etDate(sfIso)) return j.time ? 'Time differs' : 'Same date — adds the time of day';
    return "Date differs: first pass keeps monday's date and lists it for Hope";
  } catch {
    return '';
  }
}

function readableSalesforce(key: SfFieldKey, value: string): string {
  return key === 'presales.due_date' ? formatInstant(value) : value;
}

export function diffItem(
  opp: SfOpportunity,
  item: MondayItemSnapshot,
  cfg: PlannerConfig,
  maps: PlannerMaps,
  labelText: LabelText,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const sf = extractSfFields(opp);
  const current = item.fieldValues ?? {};
  const terminal = ['lost', 'declined', 'canceled'].includes(maps.stageAction[opp.StageName]?.action ?? '');
  // A first pass over an item in Won / Lost / Declined to Bid writes nothing (Seth 2026-10-13).
  const closed = isClosedGroup(cfg, item.boardKey ?? 'presales', item.groupId);
  const CLOSED_NOTE = 'Closed group: first pass leaves it';

  for (const key of SF_FIELD_KEYS) {
    const value = sf[key];
    if (value === null) continue; // a blank in Salesforce never clears monday
    const now = readableMonday(key, current[key], labelText);

    if (key === 'presales.win_pct' && cfg.confirmedWinPcts.includes(value)) {
      const wonId = cfg.labels['presales.status.won'];
      const statusId = item.statusLabelId;
      if (!terminal && statusId !== wonId) {
        rows.push({
          field: 'Status (Confirmed to Win)',
          mondayNow: statusId === null ? '(blank)' : labelText('presales.status', statusId),
          salesforce: `Won — Win % is ${value}`,
          note: 'Needs review: on a just-linked item the sync will NOT set Won; Hope decides',
        });
      }
      continue;
    }

    const mv = mapSfValue(maps, key, value);
    if (!mv) {
      rows.push({ field: fieldLabel(key), mondayNow: now, salesforce: readableSalesforce(key, value), note: closed ? CLOSED_NOTE : `Unmapped — "${value}" has no monday label; field left unchanged` });
      continue;
    }
    if (mondayValueMatches(mv, current[key])) continue;
    rows.push({ field: fieldLabel(key), mondayNow: now, salesforce: readableSalesforce(key, value), note: closed ? CLOSED_NOTE : key === 'presales.due_date' ? dueDateNote(current[key], value) : '' });
  }
  return rows;
}

// ── CSV ──
const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.map((v) => cell(v ?? '')).join(',')).join('\r\n') + '\r\n';
}
