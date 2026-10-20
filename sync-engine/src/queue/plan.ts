/**
 * Hope's Queue board: what each task looks like on monday (spec §6, Build Guide §4).
 * Pure — tested by test/queue.test.mts.
 *
 *   - Task Type labels group the engine's task kinds by what Hope does
 *     (Seth 2026-10-19): Fix Mapping / Review / Sync Problem / Stage Check /
 *     Won – Handoff / Won – Open Job / Report / Triage / Data Cleanliness.
 *   - Group placement (Eastern time): Done if done; Background for the data
 *     cleanliness row; Today / Overdue when due today or earlier; This Week when
 *     due within 7 days; otherwise As Needed.
 */
import { etDate } from '../monday/encode.ts';
import type { ColumnWrite } from '../reconcile/types.ts';

export type TaskStatus = 'not_started' | 'in_progress' | 'waiting' | 'done';
export type QueueGroup = 'today_overdue' | 'this_week' | 'as_needed' | 'background' | 'done';

/** The task row fields the board needs. */
export interface QueueTask {
  id: string;
  taskType: string;
  dedupeKey: string;
  title: string;
  details: string;
  sourceRef: { board_key?: string; monday_item_id?: string; sf_opportunity_id?: string; [k: string]: unknown };
  status: TaskStatus;
  dueAt: string | null; // ISO
  countValue: number | null;
  reopenCount: number;
  openSince: string | null; // ISO
}

const FIX_MAPPING = new Set(['unmapped_value', 'unmapped_stage', 'unmapped_engineer', 'config_missing', 'config_drift']);
const REVIEW = new Set(['due_date_differs', 'confirmed_win_review', 'won_on_intake', 'prequal_estimate_due', 'archived_reactivated']);

/** config_labels key under queue.task_type. */
export function taskTypeLabelKey(taskType: string, dedupeKey: string): string {
  switch (taskType) {
    case 'sync_failure': {
      const kind = dedupeKey.split(':')[1] ?? '';
      if (FIX_MAPPING.has(kind)) return 'fix_mapping';
      if (REVIEW.has(kind)) return 'review';
      return 'sync_problem';
    }
    case 'writeback_no_link':
    case 'writeback_quantity':
      return 'sync_problem';
    case 'stage_check_delivered':
    case 'stage_check_contract':
      return 'stage_check';
    case 'won_handoff':
      return 'won_handoff';
    case 'open_job':
      return 'won_open_job';
    case 'report_presales_weekly':
    case 'report_pm_weekly':
    case 'report_avss_monthly':
      return 'report';
    case 'triage':
      return 'triage';
    case 'data_cleanliness':
      return 'data_cleanliness';
    default:
      return 'sync_problem';
  }
}

export function groupFor(t: Pick<QueueTask, 'status' | 'taskType' | 'dueAt'>, now: Date): QueueGroup {
  if (t.status === 'done') return 'done';
  if (t.taskType === 'data_cleanliness') return 'background';
  if (!t.dueAt) return 'as_needed';
  const due = etDate(t.dueAt);
  if (due <= etDate(now.toISOString())) return 'today_overdue';
  if (due <= etDate(new Date(now.getTime() + 7 * 86_400_000).toISOString())) return 'this_week';
  return 'as_needed';
}

/** Task kinds whose title doesn't end in a deal name ("…: item 123 isn't linked", "Config missing: presales.x"). */
const NO_PROJECT_KINDS = new Set(['config_missing', 'config_drift', 'webhook_error', 'backfill', 'unmapped_value', 'unmapped_stage', 'unmapped_engineer', 'due_date_differs']);

/** "Assign Erik on the Pre-Sales Summary: AVSS Test Opp 5" → "AVSS Test Opp 5" (only for tasks about one deal). */
export function projectFrom(t: Pick<QueueTask, 'title' | 'sourceRef'> & Partial<Pick<QueueTask, 'taskType' | 'dedupeKey'>>): string {
  if (!t.sourceRef.monday_item_id && !t.sourceRef.sf_opportunity_id) return '';
  if (t.taskType === 'writeback_no_link') return '';
  if (t.taskType === 'sync_failure' && NO_PROJECT_KINDS.has(t.dedupeKey?.split(':')[1] ?? '')) return '';
  const at = t.title.indexOf(': ');
  return at >= 0 ? t.title.slice(at + 2) : '';
}

export interface LinkContext {
  /** monday item URL for a board key + item id, or null when unknown. */
  mondayItemUrl: (boardKey: string, itemId: string) => string | null;
  /** Salesforce opportunity URL. */
  opportunityUrl: (opportunityId: string) => string;
}

const MAX_NAME = 255;
const MAX_DETAILS = 2000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Item name + every engine-owned column, for create and for each push. */
export function queueItemValues(t: QueueTask, statusLabels: Record<string, number | null>, typeLabels: Record<string, number | null>, links: LinkContext): {
  name: string;
  writes: ColumnWrite[];
} {
  const writes: ColumnWrite[] = [];
  const status = statusLabels[t.status];
  if (status !== undefined && status !== null) writes.push({ semanticKey: 'queue.status', value: { type: 'status', labelId: status } });
  const type = typeLabels[taskTypeLabelKey(t.taskType, t.dedupeKey)];
  if (type !== undefined && type !== null) writes.push({ semanticKey: 'queue.task_type', value: { type: 'dropdown', labelIds: [type] } });
  if (t.dueAt) writes.push({ semanticKey: 'queue.due', value: { type: 'datetime', iso: new Date(t.dueAt).toISOString().replace(/\.\d{3}Z$/, 'Z') } });
  writes.push({ semanticKey: 'queue.project', value: { type: 'text', text: projectFrom(t) } });
  writes.push({ semanticKey: 'queue.details', value: { type: 'long_text', text: clip(t.details, MAX_DETAILS) } });

  const itemId = t.sourceRef.monday_item_id;
  const itemUrl = itemId ? links.mondayItemUrl(t.sourceRef.board_key ?? 'presales', String(itemId)) : null;
  writes.push({ semanticKey: 'queue.monday_link', value: itemUrl ? { type: 'link', url: itemUrl, text: 'Open in monday' } : { type: 'link', url: '', text: '' } });
  const opp = t.sourceRef.sf_opportunity_id;
  writes.push({ semanticKey: 'queue.sf_link', value: opp ? { type: 'link', url: links.opportunityUrl(String(opp)), text: 'Open in Salesforce' } : { type: 'link', url: '', text: '' } });

  if (t.taskType === 'data_cleanliness') writes.push({ semanticKey: 'queue.count', value: { type: 'numbers', value: t.countValue } });
  if (t.openSince) writes.push({ semanticKey: 'queue.opened', value: { type: 'date', date: etDate(t.openSince) } });
  writes.push({ semanticKey: 'queue.reopens', value: { type: 'numbers', value: t.reopenCount } });
  writes.push({ semanticKey: 'queue.engine_key', value: { type: 'text', text: t.dedupeKey } });
  return { name: clip(t.title, MAX_NAME), writes };
}

/** Hope's status label on the board → task status (null = not one of ours). */
export function statusFromLabel(statusLabels: Record<string, number | null>, labelId: number | null): TaskStatus | null {
  if (labelId === null) return null;
  for (const [key, id] of Object.entries(statusLabels)) if (id === labelId) return key as TaskStatus;
  return null;
}
