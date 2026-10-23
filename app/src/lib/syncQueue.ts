// Coordinator page (sync task queue + mappings) — client data layer for the Salesforce ↔ monday sync
// engine's tables (supabase/migrations/add_sync_and_queue.sql and the sync_*.sql
// migrations). Readable by admins and ops coordinators only (RLS: is_sync_viewer()).
// The app may change a task's STATUS (column grant) and edit the map_* tables;
// everything else is engine-owned. The engine pushes changes to the Hope's Queue
// monday board within a minute.
//
// Schema: production data lives in `public`; the staging engine writes `sync_sandbox`
// (admin-only "Sandbox data" switch — the schema must be in Supabase's exposed schemas).
// Kept out of the Zustand store on purpose (fetched on demand, like projectWiki.ts).
import { supabase, isSupabaseConfigured } from './supabase';

export type SyncSchema = 'public' | 'sync_sandbox';
export type TaskStatus = 'not_started' | 'in_progress' | 'waiting' | 'done';
export type QueueGroup = 'today_overdue' | 'this_week' | 'as_needed' | 'job_opening' | 'background' | 'done';

export const TASK_STATUSES: { key: TaskStatus; label: string }[] = [
  { key: 'not_started', label: 'Not Started' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'waiting', label: 'Waiting on Someone' },
  { key: 'done', label: 'Done' },
];

export const QUEUE_GROUPS: { key: QueueGroup; label: string }[] = [
  { key: 'today_overdue', label: 'Today / Overdue' },
  { key: 'this_week', label: 'This Week' },
  { key: 'as_needed', label: 'As Needed' },
  { key: 'job_opening', label: 'Job Opening' },
  { key: 'background', label: 'Background' },
  { key: 'done', label: 'Done (last 7 days)' },
];

export interface QueueTask {
  id: string;
  taskType: string;
  dedupeKey: string;
  title: string;
  details: string;
  sourceRef: { board_key?: string; monday_item_id?: string; sf_opportunity_id?: string; mapping_table?: string; withdrawn?: boolean; [k: string]: unknown };
  status: TaskStatus;
  dueAt: string | null;
  countValue: number | null;
  reopenCount: number;
  openSince: string | null;
  closedAt: string | null;
  closeMode: 'auto' | 'manual' | null;
}

// ── Task Type labels (twin of sync-engine/src/queue/plan.ts — keep in sync) ──
const FIX_MAPPING = new Set(['unmapped_value', 'unmapped_stage', 'unmapped_engineer', 'config_missing', 'config_drift']);
const REVIEW = new Set(['due_date_differs', 'confirmed_win_review', 'won_on_intake', 'prequal_estimate_due', 'archived_reactivated']);

export function taskTypeLabel(t: Pick<QueueTask, 'taskType' | 'dedupeKey'>): string {
  switch (t.taskType) {
    case 'sync_failure': {
      const kind = t.dedupeKey.split(':')[1] ?? '';
      if (FIX_MAPPING.has(kind)) return 'Fix Mapping';
      if (REVIEW.has(kind)) return 'Review';
      return 'Sync Problem';
    }
    case 'writeback_no_link':
    case 'writeback_quantity': return 'Sync Problem';
    case 'stage_check_delivered':
    case 'stage_check_contract': return 'Stage Check';
    case 'won_handoff': return 'Won – Handoff';
    case 'open_job': return 'Won – Open Job';
    case 'report_presales_weekly':
    case 'report_pm_weekly':
    case 'report_avss_monthly': return 'Report';
    case 'triage': return 'Triage';
    case 'data_cleanliness': return 'Data Cleanliness';
    default: return 'Sync Problem';
  }
}

/** Same placement rule as the engine (Eastern time). */
export function groupFor(t: Pick<QueueTask, 'status' | 'taskType' | 'dueAt'>, now = new Date()): QueueGroup {
  if (t.status === 'done') return 'done';
  if (t.taskType === 'data_cleanliness') return 'background';
  if (t.taskType === 'open_job') return 'job_opening';
  if (!t.dueAt) return 'as_needed';
  const et = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const due = et(new Date(t.dueAt));
  if (due <= et(now)) return 'today_overdue';
  if (due <= et(new Date(now.getTime() + 7 * 86_400_000))) return 'this_week';
  return 'as_needed';
}

// Row shapes as PostgREST returns them.
interface TaskRow {
  id: string; task_type: string; dedupe_key: string; title: string; details: string | null; source_ref: QueueTask['sourceRef'] | null;
  status: TaskStatus; due_at: string | null; count_value: string | number | null; reopen_count: number | null;
  open_since: string | null; closed_at: string | null; close_mode: 'auto' | 'manual' | null;
}
interface StatusRow { name: string; value: Record<string, unknown> & { mode?: string; at?: string; slug?: string; labels?: EngineInfo['labels'] } }
interface BoardRow { board_key: string; monday_board_id: string | number | null }
interface SnapshotRow { snapshot_date: string; exception_count: number }
interface LabelMapDbRow { id: string; sf_value: string; monday_label_id: number | null; active: boolean; notes: string | null }
interface EstimatorDbRow {
  id: string; monday_user_id: string | number; monday_name: string | null; sf_user_name: string | null;
  triage_label_id: number | null; ignore: boolean; active: boolean; notes: string | null;
}

function db(schema: SyncSchema) {
  return schema === 'public' ? supabase : supabase.schema(schema);
}

function must<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

// ── Reads ────────────────────────────────────────────────────────────────────
export async function listTasks(schema: SyncSchema): Promise<QueueTask[]> {
  if (!isSupabaseConfigured()) return [];
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = must(await db(schema).from('task')
    .select('id, task_type, dedupe_key, title, details, source_ref, status, due_at, count_value, reopen_count, open_since, closed_at, close_mode')
    .or(`status.neq.done,closed_at.gte.${since}`)
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })) as TaskRow[];
  return rows
    .filter((r) => !(r.status === 'done' && r.source_ref?.withdrawn)) // withdrawn = off the queue, not "done"
    .map((r) => ({
      id: r.id, taskType: r.task_type, dedupeKey: r.dedupe_key, title: r.title, details: r.details ?? '',
      sourceRef: r.source_ref ?? {}, status: r.status, dueAt: r.due_at, countValue: r.count_value === null ? null : Number(r.count_value),
      reopenCount: r.reopen_count ?? 0, openSince: r.open_since, closedAt: r.closed_at, closeMode: r.close_mode,
    }));
}

export interface EngineInfo {
  mode: string | null;
  lastSweepAt: string | null;
  boards: Record<string, string | null>;
  slug: string;
  cleanliness: CleanlinessItems | null;
  labels: Record<string, { id: number; label: string }[]>;
  labelsAt: string | null;
}

export interface CleanlinessItems {
  at: string;
  fields: Record<string, { title: string; board: string; count: number; items: { id: string; name: string }[] }>;
  /** board → in-scope items left out of the count because they were set aside */
  setAside?: Record<string, number>;
}

export async function engineInfo(schema: SyncSchema): Promise<EngineInfo> {
  const empty: EngineInfo = { mode: null, lastSweepAt: null, boards: {}, slug: 'premiere5', cleanliness: null, labels: {}, labelsAt: null };
  if (!isSupabaseConfigured()) return empty;
  const [status, boards] = await Promise.all([
    db(schema).from('engine_status').select('name, value').in('name', ['boot', 'last_sweep', 'cleanliness_items', 'monday_labels']),
    db(schema).from('config_boards').select('board_key, monday_board_id'),
  ]);
  const byName: Record<string, StatusRow['value'] | undefined> = Object.fromEntries((must(status) as StatusRow[]).map((r) => [r.name, r.value]));
  const clean = (byName.cleanliness_items ?? null) as (CleanlinessItems & { slug?: string }) | null;
  return {
    mode: byName.boot?.mode ?? null,
    lastSweepAt: byName.last_sweep?.at ?? null,
    boards: Object.fromEntries((must(boards) as BoardRow[]).map((b) => [b.board_key, b.monday_board_id ? String(b.monday_board_id) : null])),
    slug: clean?.slug ?? 'premiere5',
    cleanliness: clean,
    labels: byName.monday_labels?.labels ?? {},
    labelsAt: byName.monday_labels?.at ?? null,
  };
}

/** Daily totals for the last 30 days (sum over fields). */
export async function cleanlinessTrend(schema: SyncSchema): Promise<{ date: string; total: number }[]> {
  if (!isSupabaseConfigured()) return [];
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const rows = must(await db(schema).from('cleanliness_snapshot').select('snapshot_date, exception_count').gte('snapshot_date', since)) as SnapshotRow[];
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.snapshot_date, (byDate.get(r.snapshot_date) ?? 0) + r.exception_count);
  return [...byDate.entries()].sort().map(([date, total]) => ({ date, total }));
}

// ── Writes ───────────────────────────────────────────────────────────────────
export async function setTaskStatus(schema: SyncSchema, taskId: string, status: TaskStatus): Promise<void> {
  must(await db(schema).from('task').update({ status }).eq('id', taskId).select('id'));
}

// ── Mappings ─────────────────────────────────────────────────────────────────
export type LabelMapTable = 'map_sales_rep' | 'map_business_unit' | 'map_win_pct';

export const LABEL_MAPS: { table: LabelMapTable; title: string; labelsKey: string; sfField: string }[] = [
  { table: 'map_sales_rep', title: 'Sales Rep', labelsKey: 'presales.sales_person', sfField: 'presales.sales_person' },
  { table: 'map_business_unit', title: 'Business Unit', labelsKey: 'presales.business_unit', sfField: 'presales.business_unit' },
  { table: 'map_win_pct', title: 'Win %', labelsKey: 'presales.win_pct', sfField: 'presales.win_pct' },
];

export interface LabelMapRow { id: string; sfValue: string; mondayLabelId: number | null; active: boolean; notes: string }

export async function listLabelMap(schema: SyncSchema, table: LabelMapTable): Promise<LabelMapRow[]> {
  const rows = must(await db(schema).from(table).select('id, sf_value, monday_label_id, active, notes').order('sf_value')) as LabelMapDbRow[];
  return rows.map((r) => ({ id: r.id, sfValue: r.sf_value, mondayLabelId: r.monday_label_id, active: r.active, notes: r.notes ?? '' }));
}

export async function saveLabelMap(schema: SyncSchema, table: LabelMapTable, row: { id?: string; sfValue: string; mondayLabelId: number | null; active: boolean }): Promise<void> {
  const values = { sf_value: row.sfValue.trim(), monday_label_id: row.mondayLabelId, active: row.active };
  if (row.id) must(await db(schema).from(table).update(values).eq('id', row.id).select('id'));
  else must(await db(schema).from(table).insert(values).select('id'));
}

export interface EstimatorRow {
  id: string;
  mondayUserId: string;
  mondayName: string;
  sfUserName: string | null;
  triageLabelId: number | null;
  ignore: boolean;
  active: boolean;
  notes: string;
}

export async function listEstimators(schema: SyncSchema): Promise<EstimatorRow[]> {
  const rows = must(await db(schema).from('map_estimator').select('*').order('monday_name')) as EstimatorDbRow[];
  return rows.map((r) => ({
    id: r.id, mondayUserId: String(r.monday_user_id), mondayName: r.monday_name ?? '', sfUserName: r.sf_user_name,
    triageLabelId: r.triage_label_id ?? null, ignore: r.ignore, active: r.active, notes: r.notes ?? '',
  }));
}

export async function saveEstimator(schema: SyncSchema, row: Omit<EstimatorRow, 'id' | 'notes'> & { id?: string }): Promise<void> {
  const values = {
    monday_user_id: Number(row.mondayUserId), monday_name: row.mondayName.trim(), sf_user_name: row.sfUserName?.trim() || null,
    triage_label_id: row.triageLabelId, ignore: row.ignore, active: row.active,
  };
  if (row.id) must(await db(schema).from('map_estimator').update(values).eq('id', row.id).select('id'));
  else must(await db(schema).from('map_estimator').insert(values).select('id'));
}

/** Open "Unmapped <field>: <value>" tasks → what to add. Key: sync_failure:unmapped_value:<field>:<value>. */
export function unmappedValues(tasks: QueueTask[]): { field: string; value: string; taskId: string; members: number }[] {
  const prefix = 'sync_failure:unmapped_value:';
  return tasks.filter((t) => t.status !== 'done' && t.dedupeKey.startsWith(prefix)).map((t) => {
    const rest = t.dedupeKey.slice(prefix.length);
    const at = rest.indexOf(':');
    return { field: rest.slice(0, at), value: rest.slice(at + 1), taskId: t.id, members: Array.isArray(t.sourceRef.members) ? (t.sourceRef.members as unknown[]).length : 0 };
  });
}

/** Open "Map Pre-Sales Engineer" tasks. Key: sync_failure:unmapped_engineer:<monday user id | triage-label:N>:estimator. */
export function unmappedEngineers(tasks: QueueTask[]): { mondayUserId: string | null; triageLabelId: number | null; title: string; taskId: string }[] {
  const prefix = 'sync_failure:unmapped_engineer:';
  return tasks.filter((t) => t.status !== 'done' && t.dedupeKey.startsWith(prefix)).map((t) => {
    const who = t.dedupeKey.slice(prefix.length, t.dedupeKey.lastIndexOf(':'));
    const label = who.startsWith('triage-label:') ? Number(who.slice('triage-label:'.length)) : null;
    return { mondayUserId: label === null ? who : null, triageLabelId: label, title: t.title, taskId: t.id };
  });
}

// ── Set aside (sync_set_aside.sql, Seth 2026-10-23) ──────────────────────────
// Items that can never agree with Salesforce (mostly change orders). The engine skips
// them: no blank-field count, no backfill problem, no "isn't linked" task. Restore = delete.
export type SetAsideReason = 'change_order' | 'other';
export const SET_ASIDE_REASONS: { key: SetAsideReason; label: string }[] = [
  { key: 'change_order', label: 'Change order' },
  { key: 'other', label: 'Other' },
];

export interface SetAsideItem {
  id: string;
  mondayItemId: string;
  boardKey: string;
  itemName: string;
  reason: SetAsideReason;
  note: string;
  setByName: string;
  setAt: string;
}

interface SetAsideDbRow {
  id: string; monday_item_id: string | number; board_key: string; item_name: string; reason: SetAsideReason;
  note: string; set_by_name: string; set_at: string;
}

export async function listSetAside(schema: SyncSchema): Promise<SetAsideItem[]> {
  if (!isSupabaseConfigured()) return [];
  const r = await db(schema).from('item_set_aside').select('*').order('set_at', { ascending: false });
  // Before sync_set_aside.sql has run the table doesn't exist: the page works without it.
  if (r.error && /item_set_aside|does not exist|schema cache/i.test(r.error.message)) return [];
  return (must(r) as SetAsideDbRow[]).map((x) => ({
    id: x.id, mondayItemId: String(x.monday_item_id), boardKey: x.board_key, itemName: x.item_name,
    reason: x.reason, note: x.note, setByName: x.set_by_name, setAt: x.set_at,
  }));
}

export async function setItemAside(schema: SyncSchema, item: { mondayItemId: string; boardKey: string; itemName: string; reason: SetAsideReason; note: string; setByName: string }): Promise<void> {
  must(await db(schema).from('item_set_aside').insert({
    monday_item_id: Number(item.mondayItemId), board_key: item.boardKey, item_name: item.itemName,
    reason: item.reason, note: item.note.trim(), set_by_name: item.setByName,
  }).select('id'));
}

export async function restoreSetAside(schema: SyncSchema, id: string): Promise<void> {
  must(await db(schema).from('item_set_aside').delete().eq('id', id).select('id'));
}

/** The items a grouped backfill task lists (source_ref.members), with the deal name split off the label. */
export function backfillMembers(t: QueueTask): { id: string; name: string }[] {
  if (!t.dedupeKey.startsWith('sync_failure:backfill:') || !Array.isArray(t.sourceRef.members)) return [];
  return (t.sourceRef.members as { id: string; label?: string }[]).map((m) => {
    const label = m.label ?? '';
    const at = label.lastIndexOf(' (monday item ');
    return { id: String(m.id), name: at > 0 ? label.slice(0, at) : label || `Item ${m.id}` };
  });
}

// ── Links ────────────────────────────────────────────────────────────────────
export function mondayItemUrl(info: EngineInfo, boardKey: string | undefined, itemId: string): string | null {
  const board = info.boards[boardKey ?? 'presales'];
  return board ? `https://${info.slug}.monday.com/boards/${board}/pulses/${itemId}` : null;
}

export function salesforceUrl(schema: SyncSchema, opportunityId: string): string {
  const base = schema === 'public' ? 'https://instrata.lightning.force.com' : 'https://instrata--partial.sandbox.lightning.force.com';
  return `${base}/lightning/r/Opportunity/${opportunityId}/view`;
}
