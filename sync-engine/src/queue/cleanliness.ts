/**
 * Data-cleanliness counts (spec §7, plan B4; scope + exemptions Seth 2026-10-20).
 *
 * Counts blank required fields on ACTIVE work only (config_settings.cleanliness_scope):
 *   Pre-Sales    Follow Up + Won items whose Contract Date is in the current year
 *   Post-Sales   In Progress, Install, Close Out
 *   Programming  On Radar, Active, Close Out
 * Rules live in config_cleanliness_rule (one row per required field) so exemptions
 * change without a deploy. exempt_when flags understood here:
 *   not_on_programming_board  Post-Sales Programmer: only required when the job's
 *                             Project Number appears on the Programming board.
 * A number of 0 counts as filled (e.g. Premiere Protect $ 0 = no Protect).
 *
 * Output: the one "Data Cleanliness" task (Background group) — Count = total, details
 * broken down per board and field — plus a daily cleanliness_snapshot row per field.
 * countExceptions is pure (test/queue.test.mts); runCleanliness does the I/O, hourly.
 */
import type { Db } from '../db/pool.ts';
import { openTask, setAsideItemIds, setEngineStatus } from '../db/store.ts';
import type { RuntimeConfig } from '../config/load.ts';
import type { MondayClient, MondayItemRaw } from '../monday/client.ts';
import { etDate } from '../monday/encode.ts';
import type { ColumnDef } from '../reconcile/types.ts';

export const CLEANLINESS_KEY = 'data_cleanliness:singleton';
const BOARDS = ['presales', 'postsales', 'programming'] as const;
type BoardKey = (typeof BOARDS)[number];
const BOARD_TITLE: Record<BoardKey, string> = { presales: 'Pre-Sales', postsales: 'Post-Sales', programming: 'Programming' };

export interface CleanRule { boardKey: string; semanticKey: string; exemptWhen: Record<string, unknown> }
export type CleanScope = Partial<Record<BoardKey, { groups?: string[]; won_current_year?: boolean }>>;

/** Is a monday column value blank for its column type? */
export function isBlank(type: ColumnDef['type'], raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined || raw === '' || raw === 'null') return true;
  let j: any;
  try { j = JSON.parse(raw); } catch { return raw.trim() === ''; }
  switch (type) {
    case 'numbers': return j === null || String(j).trim() === '';
    case 'text': return typeof j !== 'string' || j.trim() === '';
    case 'long_text': return !j?.text || String(j.text).trim() === '';
    case 'dropdown': return !Array.isArray(j?.ids) || j.ids.length === 0;
    case 'people': return !Array.isArray(j?.personsAndTeams) || j.personsAndTeams.length === 0;
    case 'status': return j?.index === undefined || j?.index === null;
    case 'date':
    case 'datetime': return !j?.date;
    default: return false;
  }
}

const valueOf = (item: MondayItemRaw, columnId: string | null | undefined) =>
  columnId ? item.column_values.find((c) => c.id === columnId)?.value ?? null : null;

export interface CleanResult {
  total: number;
  /** semantic key → blank count */
  byField: Record<string, number>;
  /** semantic key → the items behind the count (for Hope's Dashboard). */
  itemsByField: Record<string, { id: string; name: string }[]>;
  /** board → items in scope */
  inScope: Record<string, number>;
  /** board → in-scope items left out because the coordinator set them aside */
  setAside: Record<string, number>;
}

export function countExceptions(input: {
  items: Partial<Record<BoardKey, MondayItemRaw[]>>;
  rules: CleanRule[];
  columns: Record<string, ColumnDef & { boardKey?: string }>;
  groups: Record<string, string | null>;
  scope: CleanScope;
  /** Project Numbers on the Programming board. */
  programmingNumbers: Set<string>;
  /** Current year (ET). */
  year: number;
  /** monday item ids set aside (sync_set_aside.sql): not counted. */
  setAside?: Set<string>;
}): CleanResult {
  const out: CleanResult = { total: 0, byField: {}, itemsByField: {}, inScope: {}, setAside: {} };
  for (const board of BOARDS) {
    const sc = input.scope[board];
    if (!sc) continue;
    const groupIds = new Set((sc.groups ?? []).map((g) => input.groups[`${board}.${g}`]).filter((x): x is string => !!x));
    const wonId = input.groups[`${board}.won`];
    const contractCol = input.columns['presales.contract_date']?.columnId;
    const rules = input.rules.filter((r) => r.boardKey === board);
    const inScope = (it: MondayItemRaw) => {
      const g = it.group?.id ?? '';
      if (groupIds.has(g)) return true;
      if (board === 'presales' && sc.won_current_year && wonId && g === wonId) {
        const raw = valueOf(it, contractCol);
        if (isBlank('date', raw)) return false;
        return String(JSON.parse(raw!).date).startsWith(String(input.year));
      }
      return false;
    };
    const active = (input.items[board] ?? []).filter((it) => it.state === 'active' && inScope(it));
    const items = active.filter((it) => !input.setAside?.has(String(it.id)));
    out.inScope[board] = items.length;
    out.setAside[board] = active.length - items.length;
    for (const r of rules) {
      const col = input.columns[r.semanticKey];
      if (!col?.columnId) continue;
      let n = 0;
      const hits: { id: string; name: string }[] = [];
      for (const it of items) {
        if (!isBlank(col.type, valueOf(it, col.columnId))) continue;
        if (r.exemptWhen.not_on_programming_board) {
          const num = valueOf(it, input.columns['postsales.project_number']?.columnId);
          const pn = isBlank('text', num) ? '' : String(JSON.parse(num!)).trim();
          if (!pn || !input.programmingNumbers.has(pn)) continue;
        }
        n++;
        hits.push({ id: String(it.id), name: it.name });
      }
      out.byField[r.semanticKey] = n;
      out.itemsByField[r.semanticKey] = hits;
      out.total += n;
    }
  }
  return out;
}

export function cleanlinessText(r: CleanResult, columns: Record<string, { title?: string } & ColumnDef>, titles: Record<string, string>): { title: string; details: string } {
  const lines: string[] = [];
  for (const board of BOARDS) {
    if (r.inScope[board] === undefined) continue;
    const fields = Object.entries(r.byField).filter(([k, n]) => k.startsWith(`${board}.`) && n > 0)
      .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${titles[k] ?? k} ${n}`);
    const sum = Object.entries(r.byField).filter(([k]) => k.startsWith(`${board}.`)).reduce((a, [, n]) => a + n, 0);
    const aside = r.setAside?.[board] ? `, ${r.setAside[board]} set aside` : '';
    lines.push(`${BOARD_TITLE[board]} (${r.inScope[board]} active items${aside}): ${sum} blank${fields.length ? ` — ${fields.join(', ')}` : ''}`);
  }
  return {
    title: `Data cleanliness: ${r.total} blank required field${r.total === 1 ? '' : 's'}`,
    details: `${lines.join('\n')}\n\nCounts active work only (Pre-Sales: Follow Up + this year's Won; Post-Sales: In Progress, Install, Close Out; Programming: On Radar, Active, Close Out). Refreshed hourly. The items behind each count are on the Coordinator page in Project Tools, where an item that can never match Salesforce (a change order, say) can be set aside.`,
  };
}

export async function runCleanliness(deps: { db: Db; monday: MondayClient; cfg: RuntimeConfig }, now: Date = new Date()): Promise<CleanResult | null> {
  const { cfg } = deps;
  if (cfg.settings.queue_push !== true) return null;
  const scope = (cfg.settings.cleanliness_scope ?? null) as CleanScope | null;
  if (!scope) return null;
  const { rows } = await deps.db.query<{ board_key: string; semantic_key: string; exempt_when: Record<string, unknown> }>(
    'select board_key, semantic_key, exempt_when from config_cleanliness_rule where active');
  const rules: CleanRule[] = rows.map((r) => ({ boardKey: r.board_key, semanticKey: r.semantic_key, exemptWhen: r.exempt_when ?? {} }));
  const { rows: titleRows } = await deps.db.query<{ semantic_key: string; title: string }>('select semantic_key, title from config_field_registry');
  const titles = Object.fromEntries(titleRows.map((t) => [t.semantic_key, t.title]));

  const items: Partial<Record<BoardKey, MondayItemRaw[]>> = {};
  for (const board of BOARDS) {
    const boardId = cfg.boards[board];
    if (!boardId || !scope[board]) continue;
    const cols = new Set<string>();
    for (const r of rules.filter((x) => x.boardKey === board)) {
      const id = cfg.planner.columns[r.semanticKey]?.columnId;
      if (id) cols.add(id);
    }
    if (board === 'presales') { const c = cfg.planner.columns['presales.contract_date']?.columnId; if (c) cols.add(c); }
    if (board === 'postsales') { const c = cfg.planner.columns['postsales.project_number']?.columnId; if (c) cols.add(c); }
    if (board === 'programming') { const c = cfg.planner.columns['programming.project_number']?.columnId; if (c) cols.add(c); }
    const list: MondayItemRaw[] = [];
    await deps.monday.pageBoardItems(String(boardId), [...cols], (page) => { list.push(...page); });
    items[board] = list;
  }

  const progCol = cfg.planner.columns['programming.project_number']?.columnId;
  const programmingNumbers = new Set((items.programming ?? []).map((it) => {
    const raw = valueOf(it, progCol);
    return isBlank('text', raw) ? '' : String(JSON.parse(raw!)).trim();
  }).filter(Boolean));

  const year = Number(etDate(now.toISOString()).slice(0, 4));
  const setAside = await setAsideItemIds(deps.db);
  const result = countExceptions({ items, rules, columns: cfg.planner.columns, groups: cfg.planner.groups, scope, programmingNumbers, year, setAside });
  const text = cleanlinessText(result, cfg.planner.columns, titles);

  await deps.db.tx(async (q) => {
    await openTask(q, { op: 'open', taskType: 'data_cleanliness', dedupeKey: CLEANLINESS_KEY, title: text.title, details: text.details, sourceRef: {} }, null);
    await q.query(`update task set count_value = $2, monday_dirty = true where dedupe_key = $1 and count_value is distinct from $2`, [CLEANLINESS_KEY, result.total]);
    // The lists behind the counts, for Hope's Dashboard (engine_status is readable by sync viewers).
    const slug = await deps.monday.query<{ account: { slug: string } | null }>('query { account { slug } }').then((x) => x.account?.slug ?? null).catch(() => null);
    await setEngineStatus(q, 'cleanliness_items', {
      at: now.toISOString(), slug,
      boards: Object.fromEntries(BOARDS.map((b) => [b, cfg.boards[b] ?? null])),
      setAside: result.setAside,
      fields: Object.fromEntries(Object.entries(result.itemsByField).map(([k, list]) => [k, {
        title: titles[k] ?? k, board: k.split('.')[0], count: result.byField[k], items: list.slice(0, 300),
      }])),
    });
    const today = etDate(now.toISOString());
    for (const r of rules) {
      if (result.byField[r.semanticKey] === undefined) continue;
      await q.query(
        `insert into cleanliness_snapshot (snapshot_date, board_key, semantic_key, exception_count) values ($1, $2, $3, $4)
         on conflict (snapshot_date, board_key, semantic_key) do update set exception_count = excluded.exception_count`,
        [today, r.boardKey, r.semanticKey, result.byField[r.semanticKey]]);
    }
  });
  return result;
}
