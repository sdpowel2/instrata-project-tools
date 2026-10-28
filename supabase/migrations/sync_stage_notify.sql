-- Sync: leadership moves statuses by hand, 2026-10-28 (Seth, after go-live).
-- Run once in the SQL Editor AFTER the engine with the 'notify' action is
-- deployed (older engines read an empty confirmed_win_pcts as ["100%"]). Safe to re-run.
--
--   1. New stage action 'notify': a Salesforce stage change changes NOTHING in
--      monday; the engine emails config_settings.stage_change_recipients
--      (Lee, Isaac, Kelina) through Salesforce's Send Email action. Rebid, On Hold,
--      Closed Won, Closed Lost, Declined to Bid and Canceled use it in production.
--      (They were set to 'none' by hand at 10:50 ET until this deploy.)
--   2. No Win % means Confirmed to Win any more: 99% and 100% write the 75% label
--      (sales inflates 99%; 75% is already the high-probability bucket).
--      confirmed_win_pcts = [] (the hand fix used ["off"]).
--
-- The check constraint is widened in both schemas; the data changes are production
-- (public) only — staging keeps its old behaviour until someone asks.
do $$
declare s text;
begin
  foreach s in array array['public', 'sync_sandbox'] loop
    if to_regclass(format('%I.map_stage_action', s)) is null then
      continue;
    end if;
    execute format('alter table %I.map_stage_action drop constraint if exists map_stage_action_action_check', s);
    execute format($q$
      alter table %I.map_stage_action add constraint map_stage_action_action_check
        check (action in ('none', 'set_status', 'stage_check_delivered', 'stage_check_contract',
                          'won', 'lost', 'declined', 'canceled', 'notify'))
    $q$, s);
  end loop;
end $$;

update public.map_stage_action
   set action = 'notify',
       notes  = '2026-10-28 (Seth): no status change from Salesforce; email stage_change_recipients'
 where stage in ('Rebid', 'On Hold', 'Closed Won', 'Closed Lost', 'Declined to Bid', 'Canceled');

insert into public.config_settings (key, value, description) values
  ('stage_change_recipients', '["lee.thompson@instrata.com", "isaac.garner@instrata.com", "kelina.bauman@instrata.com"]',
   'Who gets the email when an opportunity on a monday item moves to a ''notify'' stage (Closed Won, Closed Lost, …). [] = no email.')
on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = now();

update public.config_settings
   set value = '[]'::jsonb,
       description = 'Win % values that mean Confirmed to Win (status Won). [] since 2026-10-28: 99% and 100% map to the 75% label.',
       updated_at = now()
 where key = 'confirmed_win_pcts';

insert into public.map_win_pct (sf_value, monday_label_id, notes) values
  ('99%',  3, '2026-10-28 (Seth): shows as 75% in monday, not Confirmed to Win'),
  ('100%', 3, '2026-10-28 (Seth): shows as 75% in monday, not Confirmed to Win')
on conflict (sf_value) do update set monday_label_id = 3, active = true, notes = excluded.notes;

select 'stage' as kind, stage as key, action as value from public.map_stage_action
 where stage in ('Rebid', 'On Hold', 'Closed Won', 'Closed Lost', 'Declined to Bid', 'Canceled')
union all
select 'win_pct', sf_value, coalesce(monday_label_id::text, 'null') from public.map_win_pct where sf_value in ('99%', '100%')
union all
select 'setting', key, value::text from public.config_settings where key in ('confirmed_win_pcts', 'stage_change_recipients');
