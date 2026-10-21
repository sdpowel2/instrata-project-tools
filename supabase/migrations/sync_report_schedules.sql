-- Sync: report task schedules for Hope's Queue, 2026-10-20 (open items O-6, O-7).
-- Run once in the SQL Editor; safe to re-run. Both schemas.
--
--   report_pm_weekly        Thursday 5 pm ET (unchanged)
--   report_presales_weekly  Friday 5 pm ET: Hope sends it Friday so updates are back Monday (Seth)
--   report_avss_monthly     3rd business day 5 pm ET, for the previous month (Seth)
-- A task appears at the start of its week / month, is due at the time above, and
-- stays open until Hope marks it Done. weekday is ISO (1 = Monday).
do $$
declare
  s text;
begin
  foreach s in array array['public', 'sync_sandbox'] loop
    if to_regclass(format('%I.config_settings', s)) is null then
      continue;
    end if;
    execute format($q$
      update %I.config_settings set value = v.value::jsonb, description = v.description, updated_at = now()
        from (values
          ('report_presales_weekly', '{"weekday": 5, "due_time": "17:00", "tz": "America/New_York"}',
           'Friday 5 pm ET (Seth 2026-10-20: sent Friday so updates are back Monday).'),
          ('report_avss_monthly',    '{"business_day": 3, "due_time": "17:00", "tz": "America/New_York"}',
           '3rd business day of the month, 5 pm ET, for the previous month (Seth 2026-10-20).')
        ) as v(key, value, description)
       where config_settings.key = v.key
    $q$, s);
  end loop;
end $$;
