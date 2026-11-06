// Formatting for Lead Finder (Eastern time, like the standalone app) and the
// CSV export, which keeps the old export's column order (web/export.py).

import type { LeadFilters, LeadRow } from './types';

const ET = 'America/New_York';

/** "Nov 20, 2026 2:00 PM EST"; date only when the time is midnight / 23:59 ET. */
export function fmtDateTime(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, hour: 'numeric', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const dateOnly = !withTime || (hh === 0 && mm === 0) || (hh === 23 && mm === 59);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET, month: 'short', day: 'numeric', year: 'numeric',
    ...(dateOnly ? {} : { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
  }).format(d);
}

export const fmtDate = (iso: string | null | undefined) => fmtDateTime(iso, false);

/** Days from today (Eastern) until a due date; negative when past. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const key = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: ET }).format(d);
  const a = new Date(`${key(new Date())}T00:00:00Z`).getTime();
  const b = new Date(`${key(new Date(iso))}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 10_000) return `$${Math.round(v / 1000)}K`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

export function fmtBytes(n: number | null | undefined): string {
  let v = Number(n || 0);
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (v < 1024 || unit === 'GB') {
      return unit === 'B' || unit === 'KB'
        ? `${Math.round(v).toLocaleString('en-US')} ${unit}`
        : `${v.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${unit}`;
    }
    v /= 1024;
  }
  return `${v.toFixed(1)} GB`;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return fmtDate(iso);
}

export function titleCase(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function location(r: Pick<LeadRow, 'loc_city' | 'loc_state'>): string {
  if (!r.loc_city && !r.loc_state) return '—';
  return [titleCase(r.loc_city), r.loc_state].filter(Boolean).join(', ');
}

/** Today's date in Eastern time, YYYY-MM-DD. */
export function todayEt(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ET }).format(new Date());
}

export function defaultFilters(): LeadFilters {
  return {
    office_id: '',
    office_mode: 'in_range',
    in_range_only: true,
    lanes: ['direct_av', 'likely_av_scope'],
    min_score: 0,
    status: 'open',
    due_after: new Date().toISOString().slice(0, 10), // UTC day, as queries.py does
    changed: '',
    review: '',
    source: '',
    bb_status: '',
    location_unknown: false,
  };
}

const CSV_COLUMNS = [
  'lane', 'score', 'title', 'agency', 'solicitation_number', 'notice_type', 'loc_city', 'loc_state',
  'loc_zip', 'location_basis', 'nearest_office', 'distance_miles', 'posted_at', 'response_due_at',
  'status', 'source', 'url', 'review_status', 'first_seen_at',
  'est_value', 'bid_board_status', 'trades', 'bb_invites', 'bb_gcs',
];

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Same columns and values as the standalone app's export (web/export.py). */
export function toCsv(rows: LeadRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([
      r.lane, r.score, r.title, r.agency_name ?? '', r.solicitation_number ?? '', r.notice_type,
      r.loc_city ?? '', r.loc_state ?? '', r.loc_zip ?? '', r.location_basis, r.nearest_office ?? '',
      r.nearest_distance == null ? '' : r.nearest_distance.toFixed(1), r.posted_at ?? '', r.response_due_at ?? '',
      r.status, r.source_id, r.url ?? '', r.review, r.first_seen_at ?? '',
      r.est_value == null ? '' : Math.round(r.est_value), r.source_status ?? '',
      r.trades.join('; '), r.source_id === 'buildingconnected' ? r.notices : '', r.gcs || '',
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

export function downloadText(filename: string, text: string, type = 'text/csv') {
  // BOM so Excel opens accented agency names correctly (as the old export did).
  const blob = new Blob(['﻿', text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
