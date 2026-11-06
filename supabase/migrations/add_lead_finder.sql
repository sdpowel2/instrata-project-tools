-- Lead Finder — storage for the AV lead finder (admin-only tab /lead-finder).
--
-- Ported from the standalone LeadFinder app (SQLite). The Python worker
-- (leadfinder-worker/, Fly app instrata-leadfinder) fetches, scores and stores
-- leads here; the React tab reads them and queues work in lf_job.
--
--   lf_office .. lf_geocode_cache   same shape as leadfinder/db/models.py, lf_ prefix.
--                                   ids stay text uuids so the SQLite data carries over.
--   lf_job                          the tab's command queue (run, documents, triage,
--                                   office save). The worker claims rows and writes
--                                   progress back; realtime pushes it to the page.
--   lf_lead_docs / lf_document      per-lead document summary and file list. The
--                                   worker's working copy is on its Fly volume; files
--                                   are mirrored to the lead-documents bucket.
--   lf_triage_run                   av-triage results (rating, estimate, report).
--   lf_setting                      small settings the tab edits (default radius).
--   lf_secret                       worker-only state (BuildingConnected tokens,
--                                   triage agent ids). RLS on, no policies.
--   lf_results(p)                   the Leads table/map/CSV query (port of
--                                   web/queries.py query_results).
--
-- Rules:
--   * Admins only (public.is_admin()) on every table, function and object.
--   * The worker connects as the postgres role and bypasses RLS.
--
-- Additive only. Run in the Supabase SQL Editor (house convention). Safe to re-run.

-- ── reference + offices ──────────────────────────────────────────────────────
create table if not exists public.lf_office (
  id              text primary key default gen_random_uuid()::text,
  name            text not null unique,
  street          text not null,
  city            text not null,
  state           text not null,
  zip             text not null,
  lat             double precision,
  lon             double precision,
  geocode_method  text check (geocode_method in ('census_address', 'zip_centroid', 'manual')),
  geocode_match   text,
  radius_miles    integer not null default 100 check (radius_miles between 1 and 1000),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.lf_zip_centroid (
  zip         text primary key,
  lat         double precision not null,
  lon         double precision not null,
  vintage     text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.lf_place_centroid (
  state       text not null,
  place_name  text not null,
  lat         double precision not null,
  lon         double precision not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (state, place_name)
);

create table if not exists public.lf_geocode_cache (
  normalized_address  text primary key,
  lat                 double precision,
  lon                 double precision,
  method              text not null,
  matched_address     text,
  fetched_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ── sources + runs ───────────────────────────────────────────────────────────
create table if not exists public.lf_source (
  id                 text primary key,
  name               text not null,
  kind               text not null check (kind in ('api', 'portal', 'email', 'paid_feed')),
  enabled            boolean not null default true,
  daily_call_budget  integer check (daily_call_budget is null or daily_call_budget >= 0),
  last_success_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.lf_source_target (
  id           text primary key default gen_random_uuid()::text,
  source_id    text not null references public.lf_source(id),
  slug         text not null,
  agency_name  text not null,
  agency_type  text not null default 'other'
               check (agency_type in ('city', 'county', 'state', 'k12', 'higher_ed', 'special_district', 'other')),
  street       text,
  city         text,
  state        text,
  zip          text,
  lat          double precision,
  lon          double precision,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (source_id, slug)
);

create table if not exists public.lf_run (
  id           text primary key default gen_random_uuid()::text,
  trigger      text not null check (trigger in ('manual', 'scheduled', 'cli')),
  status       text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  window_from  date,
  window_to    date,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists lf_run_started_idx on public.lf_run (started_at desc);

create table if not exists public.lf_source_run (
  run_id           text not null references public.lf_run(id) on delete cascade,
  source_id        text not null references public.lf_source(id),
  status           text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  records_fetched  integer not null default 0,
  records_new      integer not null default 0,
  records_updated  integer not null default 0,
  api_calls_used   integer not null default 0,
  resume_cursor    jsonb,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (run_id, source_id)
);

create table if not exists public.lf_raw_record (
  id                text primary key default gen_random_uuid()::text,
  source_id         text not null references public.lf_source(id),
  source_record_id  text not null,
  run_id            text not null references public.lf_run(id) on delete cascade,
  payload           text not null,
  payload_hash      text not null,
  fetched_at        timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists lf_raw_source_record_idx on public.lf_raw_record (source_id, source_record_id, fetched_at desc);

-- ── opportunities ────────────────────────────────────────────────────────────
create table if not exists public.lf_opportunity (
  id                   text primary key default gen_random_uuid()::text,
  source_id            text not null references public.lf_source(id),
  source_record_id     text not null,
  group_key            text not null,
  duplicate_of         text references public.lf_opportunity(id) on delete set null,
  solicitation_number  text,
  title                text not null,
  description          text,
  agency_name          text,
  sub_agency           text,
  notice_type          text not null default 'other'
                       check (notice_type in ('solicitation', 'presolicitation', 'sources_sought', 'combined', 'rfq',
                                              'rfp', 'ifb', 'special', 'award', 'other')),
  naics_codes          jsonb not null default '[]'::jsonb,
  psc_code             text,
  set_aside            text,
  posted_at            timestamptz,
  response_due_at      timestamptz,
  status               text not null default 'unknown'
                       check (status in ('open', 'closed', 'cancelled', 'awarded', 'unknown')),
  url                  text,
  documents_url        text,
  contact_name         text,
  contact_email        text,
  contact_phone        text,
  loc_street           text,
  loc_city             text,
  loc_state            text,
  loc_zip              text,
  location_basis       text not null default 'none'
                       check (location_basis in ('place_of_performance', 'agency_address', 'contracting_office', 'none')),
  lat                  double precision,
  lon                  double precision,
  geocode_method       text not null default 'none'
                       check (geocode_method in ('census_address', 'zip_centroid', 'city_centroid', 'source_coords', 'none')),
  content_hash         text not null,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  last_changed_at      timestamptz not null default now(),
  description_fetched  boolean not null default false,
  source_status        text,
  est_value            double precision,
  extra                jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (source_id, source_record_id)
);
create index if not exists lf_opp_group_key_idx on public.lf_opportunity (group_key);
create index if not exists lf_opp_due_idx on public.lf_opportunity (response_due_at);
create index if not exists lf_opp_duplicate_idx on public.lf_opportunity (duplicate_of);

create table if not exists public.lf_opportunity_score (
  opportunity_id    text primary key references public.lf_opportunity(id) on delete cascade,
  lane              text not null check (lane in ('direct_av', 'likely_av_scope', 'none')),
  score             integer not null,
  matched_codes     jsonb not null default '[]'::jsonb,
  matched_keywords  jsonb not null default '[]'::jsonb,
  negative_hits     jsonb not null default '[]'::jsonb,
  scorer_version    text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists lf_score_lane_idx on public.lf_opportunity_score (lane, score);

create table if not exists public.lf_office_distance (
  opportunity_id  text not null references public.lf_opportunity(id) on delete cascade,
  office_id       text not null references public.lf_office(id) on delete cascade,
  distance_miles  double precision not null,
  is_nearest      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (opportunity_id, office_id)
);
create index if not exists lf_dist_office_idx on public.lf_office_distance (office_id, distance_miles);

create table if not exists public.lf_lead_review (
  opportunity_id  text primary key references public.lf_opportunity(id) on delete cascade,
  status          text not null default 'new' check (status in ('new', 'watch', 'pursue', 'pass', 'already_known')),
  notes           text check (char_length(notes) <= 4000),
  reviewed_at     timestamptz,
  reviewed_by     uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ── documents + triage ───────────────────────────────────────────────────────
-- One row per lead that has a document folder. summary is written by the worker
-- after every document action: {folder, count, total_bytes, sam_links, sam_ok,
-- sam_errors:[[url,err]], unpack_errors:[[rel,err]], zips:[...]}.
create table if not exists public.lf_lead_docs (
  opportunity_id  text primary key references public.lf_opportunity(id) on delete cascade,
  folder          text not null,
  summary         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.lf_document (
  id              text primary key default gen_random_uuid()::text,
  opportunity_id  text not null references public.lf_opportunity(id) on delete cascade,
  path            text not null,                 -- relative path in the lead folder
  size            bigint not null default 0,
  is_zip          boolean not null default false,
  unpacked        boolean not null default false, -- zips: unpacked beside themselves (not mirrored)
  storage_key     text,                           -- object in lead-documents; null = not mirrored
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (opportunity_id, path)
);

create table if not exists public.lf_triage_run (
  id              text primary key,               -- run id from the worker (t + 12 hex)
  opportunity_id  text not null references public.lf_opportunity(id) on delete cascade,
  status          text not null check (status in ('uploading', 'running', 'done', 'failed')),
  rating          text,
  tier            text,
  estimate        text,
  bid_due         text,
  rfi_due         text,
  summary         text,
  error           text,
  files           integer,
  cost_usd        numeric(10, 2),
  budget_usd      numeric(10, 2),
  session_id      text,
  report_md       text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists lf_triage_opp_idx on public.lf_triage_run (opportunity_id, started_at desc);

-- ── settings, secrets, jobs ──────────────────────────────────────────────────
create table if not exists public.lf_setting (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
insert into public.lf_setting (key, value) values ('default_radius_miles', '100'::jsonb)
on conflict (key) do nothing;

create table if not exists public.lf_secret (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.lf_job (
  id              text primary key default gen_random_uuid()::text,
  kind            text not null check (kind in ('run', 'sam_docs', 'ingest_upload', 'rescan', 'triage',
                                               'triage_resume', 'office_save', 'office_active', 'rescore',
                                               'bc_disconnect')),
  opportunity_id  text references public.lf_opportunity(id) on delete cascade,
  params          jsonb not null default '{}'::jsonb,
  status          text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  progress        jsonb not null default '{}'::jsonb,
  result          jsonb,
  error           text,
  requested_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  updated_at      timestamptz not null default now(),
  check (jsonb_typeof(params) = 'object')
);
create index if not exists lf_job_queue_idx on public.lf_job (status, created_at) where status in ('queued', 'running');
create index if not exists lf_job_opp_idx on public.lf_job (opportunity_id, created_at desc);
-- One live run at a time, and one live document/triage job per lead.
create unique index if not exists lf_job_one_active_idx
  on public.lf_job (kind, coalesce(opportunity_id, ''))
  where status in ('queued', 'running') and kind in ('run', 'sam_docs', 'triage', 'triage_resume', 'rescore');

-- ── updated_at triggers (public.set_updated_at exists from earlier migrations) ─
do $$
declare
  t text;
begin
  foreach t in array array['lf_office', 'lf_zip_centroid', 'lf_place_centroid', 'lf_geocode_cache', 'lf_source',
                           'lf_source_target', 'lf_run', 'lf_source_run', 'lf_raw_record', 'lf_opportunity',
                           'lf_opportunity_score', 'lf_office_distance', 'lf_lead_review', 'lf_lead_docs',
                           'lf_document', 'lf_triage_run', 'lf_setting', 'lf_secret', 'lf_job'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I
                      for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── Pursue on a SAM.gov lead queues its attachment download ─────────────────
create or replace function public.lf_review_queue_docs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'pursue'
     and (tg_op = 'INSERT' or old.status is distinct from 'pursue')
     and exists (select 1 from public.lf_opportunity o where o.id = new.opportunity_id and o.source_id = 'sam_gov') then
    insert into public.lf_job (kind, opportunity_id, requested_by)
    values ('sam_docs', new.opportunity_id, auth.uid())
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists lf_review_queue_docs on public.lf_lead_review;
create trigger lf_review_queue_docs after insert or update of status on public.lf_lead_review
  for each row execute function public.lf_review_queue_docs();

-- ── RLS: admins only ─────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  -- read-only for the tab (the worker writes these)
  foreach t in array array['lf_office', 'lf_zip_centroid', 'lf_place_centroid', 'lf_geocode_cache',
                           'lf_source_target', 'lf_run', 'lf_source_run', 'lf_raw_record', 'lf_opportunity',
                           'lf_opportunity_score', 'lf_office_distance', 'lf_lead_docs', 'lf_document',
                           'lf_triage_run'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Admins read" on public.%I', t);
    execute format('create policy "Admins read" on public.%I for select using (public.is_admin())', t);
  end loop;

  -- the tab writes these directly
  foreach t in array array['lf_source', 'lf_lead_review', 'lf_setting'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Admins read" on public.%I', t);
    execute format('drop policy if exists "Admins manage" on public.%I', t);
    execute format('create policy "Admins manage" on public.%I for all
                      using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- Jobs: admins read all and queue new ones; only the worker changes them.
alter table public.lf_job enable row level security;
drop policy if exists "Admins read jobs" on public.lf_job;
create policy "Admins read jobs" on public.lf_job for select using (public.is_admin());
drop policy if exists "Admins queue jobs" on public.lf_job;
create policy "Admins queue jobs" on public.lf_job for insert
  with check (public.is_admin() and status = 'queued' and requested_by = auth.uid());

-- Worker-only.
alter table public.lf_secret enable row level security;

-- The tab may not create sources, only toggle them.
revoke insert, delete on public.lf_source from authenticated, anon;
revoke all on public.lf_secret from authenticated, anon;

-- ── lf_results: the Leads view ───────────────────────────────────────────────
-- Port of leadfinder/web/queries.py query_results. p keys (all optional):
--   office_id text, office_mode 'in_range'|'nearest', in_range_only bool,
--   lanes text[], min_score int, status text|'all', due_after date|null,
--   changed ''|'new'|'updated'|'new_or_updated', review text, source text,
--   bb_status ''|'active'|<Bid Board state>, location_unknown bool
-- Returns {last_run: {started_at, finished_at}|null, rows: [...]} — one row per
-- group_key (the latest notice), sorted by due date, -score, title. Returned as
-- one jsonb value so the API's max-rows cap never truncates it.
create or replace function public.lf_results(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_office      text := nullif(p->>'office_id', '');
  v_mode        text := coalesce(p->>'office_mode', 'in_range');
  v_in_range    boolean := coalesce((p->>'in_range_only')::boolean, true);
  v_lanes       text[] := case when jsonb_typeof(p->'lanes') = 'array'
                                then array(select jsonb_array_elements_text(p->'lanes'))
                                else array['direct_av', 'likely_av_scope'] end;
  v_min_score   integer := greatest(0, least(100, coalesce((p->>'min_score')::integer, 0)));
  v_status      text := coalesce(nullif(p->>'status', ''), 'open');
  v_due_after   timestamptz := (nullif(p->>'due_after', '')::date)::timestamp at time zone 'UTC';
  v_changed     text := coalesce(p->>'changed', '');
  v_review      text := coalesce(p->>'review', '');
  v_source      text := coalesce(p->>'source', '');
  v_bb          text := coalesce(p->>'bb_status', '');
  v_unknown     boolean := coalesce((p->>'location_unknown')::boolean, false);
  v_apply_off   boolean;
  v_lo          timestamptz;
  v_hi          timestamptz;
  v_run         jsonb;
  v_rows        jsonb;
begin
  if not public.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;
  v_apply_off := v_in_range or v_office is not null;

  select r.started_at, coalesce(r.finished_at, r.started_at),
         jsonb_build_object('started_at', r.started_at, 'finished_at', r.finished_at)
    into v_lo, v_hi, v_run
    from lf_run r
   where r.status in ('succeeded', 'partial') and r.finished_at is not null
   order by r.started_at desc
   limit 1;

  with base as (
    select o.*, s.lane, s.score, rv.status as review_status
      from lf_opportunity o
      join lf_opportunity_score s on s.opportunity_id = o.id
      left join lf_lead_review rv on rv.opportunity_id = o.id
     where o.duplicate_of is null
       and s.lane = any(v_lanes)
       and s.score >= v_min_score
       and (v_status = 'all' or o.status = v_status)
       and (v_due_after is null or o.response_due_at is null or o.response_due_at >= v_due_after)
       and (v_source = '' or o.source_id = v_source)
       and (v_bb = '' or o.source_status = any(case when v_bb = 'active' then array['UNDECIDED', 'WILL_SUBMIT']
                                                     else array[v_bb] end))
       and (v_review = ''
            or (v_review = 'new' and (rv.status is null or rv.status = 'new'))
            or (v_review <> 'new' and rv.status = v_review))
       and (v_changed = '' or v_lo is null
            or (v_changed in ('new', 'new_or_updated') and o.first_seen_at between v_lo and v_hi)
            or (v_changed in ('updated', 'new_or_updated') and o.last_changed_at between v_lo and v_hi
                and not (o.first_seen_at between v_lo and v_hi)))
       and (
         case
           when v_apply_off then
             exists (select 1
                       from lf_office_distance d
                       join lf_office f on f.id = d.office_id
                      where d.opportunity_id = o.id and f.active
                        and (v_office is null or f.id = v_office)
                        and (not (v_mode = 'nearest' and v_office is not null) or d.is_nearest)
                        and (not v_in_range or d.distance_miles <= f.radius_miles))
           else o.lat is not null
         end
         or (v_unknown and o.lat is null
             and o.loc_state in (select f.state from lf_office f
                                  where f.active and (v_office is null or f.id = v_office)))
       )
  ),
  group_value as (
    select group_key, max(est_value) filter (where est_value is not null and est_value <> 0) as est_value
      from base group by group_key
  ),
  picked as (
    select distinct on (group_key) *
      from base
     order by group_key, posted_at desc nulls last, last_seen_at desc, source_record_id desc
  ),
  group_all as (
    select g.group_key,
           count(*)::integer as notices,
           coalesce(array_agg(distinct g.extra->>'trade') filter (where g.source_id = 'buildingconnected'
                                                                  and nullif(g.extra->>'trade', '') is not null),
                    array[]::text[]) as trades,
           (count(distinct lower(btrim(coalesce(g.agency_name, ''))))
              filter (where g.source_id = 'buildingconnected'))::integer as gcs
      from lf_opportunity g
     where g.duplicate_of is null and g.group_key in (select group_key from picked)
     group by g.group_key
  ),
  nearest as (
    select d.opportunity_id, f.name, d.distance_miles
      from lf_office_distance d
      join lf_office f on f.id = d.office_id
     where d.is_nearest and d.opportunity_id in (select id from picked)
  ),
  out as (
    select pk.response_due_at, pk.score, pk.title,
           jsonb_build_object(
             'id', pk.id, 'group_key', pk.group_key, 'source_id', pk.source_id,
             'source_record_id', pk.source_record_id, 'title', pk.title, 'url', pk.url,
             'solicitation_number', pk.solicitation_number, 'agency_name', pk.agency_name,
             'sub_agency', pk.sub_agency, 'notice_type', pk.notice_type,
             'loc_city', pk.loc_city, 'loc_state', pk.loc_state, 'loc_zip', pk.loc_zip,
             'location_basis', pk.location_basis, 'geocode_method', pk.geocode_method,
             'lat', pk.lat, 'lon', pk.lon,
             'posted_at', pk.posted_at, 'response_due_at', pk.response_due_at,
             'first_seen_at', pk.first_seen_at, 'status', pk.status, 'source_status', pk.source_status,
             'lane', pk.lane, 'score', pk.score, 'review', coalesce(pk.review_status, 'new'),
             'notices', coalesce(ga.notices, 1), 'trades', coalesce(to_jsonb(ga.trades), '[]'::jsonb),
             'gcs', coalesce(ga.gcs, 0), 'est_value', gv.est_value,
             'nearest_office', n.name, 'nearest_distance', n.distance_miles,
             'badge', case
                        when v_lo is null then null
                        when pk.first_seen_at between v_lo and v_hi then 'New'
                        when pk.last_changed_at between v_lo and v_hi then 'Updated'
                      end,
             'approximate', pk.geocode_method in ('zip_centroid', 'city_centroid')
                            or pk.location_basis = 'agency_address'
           ) as row
      from picked pk
      left join group_all ga on ga.group_key = pk.group_key
      left join group_value gv on gv.group_key = pk.group_key
      left join nearest n on n.opportunity_id = pk.id
  )
  select coalesce(jsonb_agg(row order by response_due_at asc nulls last, score desc, title collate "C" asc), '[]'::jsonb)
    into v_rows
    from out;

  return jsonb_build_object('last_run', v_run, 'rows', v_rows);
end;
$$;

revoke all on function public.lf_results(jsonb) from public, anon;
grant execute on function public.lf_results(jsonb) to authenticated;

-- ── Storage: lead-documents (private) ────────────────────────────────────────
-- Keys: <opportunity_id>/<16-hex>-<ascii name> for mirrored files (worker),
--       <opportunity_id>/_inbox/<uuid>/<name> for files the tab uploads; the
--       worker moves those into the lead folder and deletes the inbox object.
-- The bucket limit only applies up to the project's global upload limit
-- (Storage settings): raise that to 500 MB as well.
insert into storage.buckets (id, name, public, file_size_limit)
values ('lead-documents', 'lead-documents', false, 524288000)  -- 500 MB
on conflict (id) do nothing;

drop policy if exists "Admins read lead documents" on storage.objects;
create policy "Admins read lead documents" on storage.objects for select
  using (bucket_id = 'lead-documents' and public.is_admin());

drop policy if exists "Admins upload lead documents" on storage.objects;
create policy "Admins upload lead documents" on storage.objects for insert
  with check (bucket_id = 'lead-documents' and public.is_admin()
              and (storage.foldername(name))[2] = '_inbox');

-- ── Realtime: job progress and document/triage updates reach the tab ─────────
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['lf_job', 'lf_lead_docs', 'lf_triage_run'] loop
      if not exists (
        select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
