// Small display helpers for the worklist. Dates are plain YYYY-MM-DD strings
// compared as calendar days, so time zones can't shift them.

import type { Urgency } from './types';

function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whole calendar days from a to b (b - a), both YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

/** YYYY-MM-DD plus n days. */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The Eastern calendar day (YYYY-MM-DD) of a moment, default now. */
export function easternDate(at: Date | string = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(typeof at === 'string' ? new Date(at) : at);
}

/** "Today", "Tomorrow", "Fri", "Nov 13", or "3d overdue". */
export function formatDue(due: string, today: string): { label: string; overdue: boolean } {
  const diff = dayNumber(due) - dayNumber(today);
  if (diff < 0) return { label: `${-diff}d overdue`, overdue: true };
  if (diff === 0) return { label: 'Today', overdue: false };
  if (diff === 1) return { label: 'Tomorrow', overdue: false };
  const [y, m, d] = due.split('-').map(Number);
  if (diff < 7) return { label: WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()], overdue: false };
  return { label: `${MONTH[m - 1]} ${d}`, overdue: false };
}

/** "Thursday, Nov 5" */
export function formatLongDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return `${weekday}, ${MONTH[m - 1]} ${d}`;
}

/** " PM" → "pm": the compact US style used across My Day ("5:00pm"). */
const compactAmPm = (s: string) => s.replace(/\s?([AP])M\b/g, (_, ap: string) => `${ap.toLowerCase()}m`);

/** "6:04am" from an ISO timestamp, in Eastern time. */
export function formatClock(iso: string): string {
  return compactAmPm(new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  }));
}

/** "Wed 5:00pm" from an ISO timestamp, in Eastern time. */
export function formatDayClock(iso: string): string {
  return compactAmPm(new Date(iso).toLocaleString('en-US', {
    weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  }));
}

/** "14:00" → "2:00pm" */
export function formatHHMM(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')}${suffix}`;
}

/** "08:00–17:00" (24h, any dash) → "8:00am–5:00pm". Anything else is shown as-is. */
export function formatTimeRange(range: string): string {
  const m = range.trim().match(/^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/);
  return m ? `${formatHHMM(m[1])}–${formatHHMM(m[2])}` : range;
}

/** Tailwind classes for the urgency pill. */
export const URGENCY_STYLE: Record<Urgency, string> = {
  1: 'bg-status-danger-bg text-status-danger-fg',
  2: 'bg-orange/15 text-orange-dark',
  3: 'bg-status-info-bg text-status-info-fg',
  4: 'bg-status-neutral-bg text-status-neutral-fg',
};
