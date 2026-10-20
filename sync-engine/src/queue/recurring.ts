/**
 * Recurring report tasks for Hope's Queue (spec §6.2; schedules Seth 2026-10-20):
 *   report_pm_weekly        Thursday 5 pm ET, keyed by ISO week
 *   report_presales_weekly  Friday 5 pm ET (sent Friday so updates are back Monday)
 *   report_avss_monthly     3rd business day 5 pm ET, keyed by month, for last month
 * Schedules live in config_settings (null = generator off). A task appears at the
 * start of its week / month and is opened ONCE per period: Hope closing it ("sent")
 * never reopens it, and a period whose due time already passed is skipped (so a
 * first deploy late in the week doesn't create an overdue task).
 * Pure except openRecurringTasks.
 */
import type { Queryable } from '../db/pool.ts';
import { openTask } from '../db/store.ts';
import type { TaskType } from '../reconcile/types.ts';
import { addDays, zonedParts, zonedTime } from './time.ts';

export { zonedTime } from './time.ts';

export interface WeeklySchedule { weekday: number; due_time: string; tz: string } // weekday: ISO, 1 = Monday
export interface MonthlySchedule { business_day: number; due_time: string; tz: string }

export interface RecurringTask {
  taskType: TaskType;
  dedupeKey: string;
  title: string;
  details: string;
  dueAt: string; // ISO UTC
}

const TZ_DEFAULT = 'America/New_York';

/** ISO week key 'YYYY-Www' of a calendar date. */
export function isoWeekKey(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const monthName = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDate = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const WEEKLY: { key: 'report_pm_weekly' | 'report_presales_weekly'; title: string; details: string }[] = [
  { key: 'report_pm_weekly', title: 'Send the PM weekly report', details: "Send this week's PM report. Mark Done when it's sent." },
  {
    key: 'report_presales_weekly', title: 'Send the weekly pre-sales report by salesperson',
    details: 'Run the weekly pre-sales report by salesperson (Claude skill "weekly-presales-by-salesperson") and send each salesperson their tab, ' +
      "so their updates are back by Monday. Mark Done when it's sent.",
  },
];

export function recurringTasks(settings: Record<string, unknown>, now: Date): RecurringTask[] {
  const out: RecurringTask[] = [];

  for (const w of WEEKLY) {
    const s = settings[w.key] as WeeklySchedule | null | undefined;
    if (!s || !Number.isInteger(s.weekday) || s.weekday < 1 || s.weekday > 7) continue;
    const tz = s.tz || TZ_DEFAULT;
    const today = zonedParts(now, tz);
    const monday = addDays(today.y, today.m, today.d, 1 - today.isoWeekday);
    const dueDay = addDays(monday.y, monday.m, monday.d, s.weekday - 1);
    const due = zonedTime(dueDay.y, dueDay.m, dueDay.d, s.due_time || '17:00', tz);
    if (now > due) continue;
    out.push({
      taskType: w.key, dedupeKey: `${w.key}:${isoWeekKey(monday.y, monday.m, monday.d)}`,
      title: `${w.title} (week of ${shortDate(monday.y, monday.m, monday.d)})`, details: w.details, dueAt: due.toISOString(),
    });
  }

  const ms = settings.report_avss_monthly as MonthlySchedule | null | undefined;
  if (ms && Number.isInteger(ms.business_day) && ms.business_day >= 1) {
    const tz = ms.tz || TZ_DEFAULT;
    const today = zonedParts(now, tz);
    let n = 0;
    let day = { y: today.y, m: today.m, d: 1 };
    for (let i = 0; i < 31; i++) {
      const wd = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
      if (wd !== 0 && wd !== 6 && ++n === ms.business_day) break;
      day = addDays(day.y, day.m, day.d, 1);
    }
    const due = zonedTime(day.y, day.m, day.d, ms.due_time || '17:00', tz);
    if (now <= due) {
      const prev = today.m === 1 ? { y: today.y - 1, m: 12 } : { y: today.y, m: today.m - 1 };
      out.push({
        taskType: 'report_avss_monthly', dedupeKey: `report_avss_monthly:${today.y}-${String(today.m).padStart(2, '0')}`,
        title: `Send the AVSS monthly report to Lee (${monthName(prev.y, prev.m)})`,
        details: `Run the AVSS monthly report for ${monthName(prev.y, prev.m)} (Claude skill "avss-monthly-report") and send it to Lee. Mark Done when it's sent.`,
        dueAt: due.toISOString(),
      });
    }
  }
  return out;
}

/** Open each due-period task once; an existing row (open or done) is left alone. Returns how many were opened. */
export async function openRecurringTasks(q: Queryable, settings: Record<string, unknown>, now: Date): Promise<number> {
  let opened = 0;
  for (const t of recurringTasks(settings, now)) {
    const { rows } = await q.query<{ n: number }>('select count(*)::int as n from task where dedupe_key = $1', [t.dedupeKey]);
    if (rows[0].n > 0) continue;
    await openTask(q, { op: 'open', taskType: t.taskType, dedupeKey: t.dedupeKey, title: t.title, details: t.details, sourceRef: {} }, null, t.dueAt);
    opened++;
  }
  return opened;
}
