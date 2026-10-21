/** Time-zone helpers for queue due dates (no I/O). */

/** Calendar date + ISO weekday (1 = Monday) of an instant in a time zone. */
export function zonedParts(at: Date, tz: string): { y: number; m: number; d: number; isoWeekday: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), isoWeekday: wd };
}

/** Wall-clock time in `tz` → UTC instant (handles DST). */
export function zonedTime(y: number, m: number, d: number, hhmm: string, tz: string): Date {
  const [hh, mm] = hhmm.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    guess += wanted - shown;
  }
  return new Date(guess);
}

export function addDays(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** `n` business days (Mon–Fri, no holiday calendar) after `from`'s calendar day, at `at` local time. */
export function businessDaysAfter(from: Date, n: number, tz = 'America/New_York', at = '17:00'): Date {
  let day = zonedParts(from, tz);
  let left = n;
  let cur = { y: day.y, m: day.m, d: day.d };
  while (left > 0) {
    cur = addDays(cur.y, cur.m, cur.d, 1);
    const wd = new Date(Date.UTC(cur.y, cur.m - 1, cur.d)).getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return zonedTime(cur.y, cur.m, cur.d, at, tz);
}
