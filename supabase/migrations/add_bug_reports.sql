-- Bug reporting system — Phase 1.
--
-- Any authenticated user can submit a bug report. Only admins can read all
-- reports and update status/resolution. Reporters can read their own reports
-- to check status later (needed for Phase 3 notifications).
--
-- Screenshots are stored in the 'bug-screenshots' Storage bucket created below.

create table if not exists public.bug_reports (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid references public.profiles(id) on delete set null,
  title           text not null,
  body            text not null,
  image_url       text,
  page_url        text not null default '',
  status          text not null default 'open'
                    check (status in ('open', 'in_progress', 'resolved', 'wont_fix', 'duplicate')),
  resolution_note text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.bug_reports enable row level security;

-- Reporters can submit
create policy "Users can insert bug reports"
  on public.bug_reports for insert
  with check (auth.uid() is not null);

-- Reporters can read their own reports (for status checks / Phase 3)
create policy "Users can read own bug reports"
  on public.bug_reports for select
  using (reporter_id = auth.uid());

-- Admins can read and update all reports
create policy "Admins can read all bug reports"
  on public.bug_reports for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "Admins can update bug reports"
  on public.bug_reports for update
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create index if not exists idx_bug_reports_status     on public.bug_reports (status);
create index if not exists idx_bug_reports_reporter   on public.bug_reports (reporter_id);
create index if not exists idx_bug_reports_created_at on public.bug_reports (created_at desc);

-- Storage bucket for screenshot uploads.
-- public = true so URLs work without signed tokens (internal tool, acceptable tradeoff).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bug-screenshots',
  'bug-screenshots',
  true,
  5242880,  -- 5 MB
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
)
on conflict (id) do nothing;

-- Any authenticated user can upload to the bucket
create policy "Authenticated users can upload bug screenshots"
  on storage.objects for insert
  with check (bucket_id = 'bug-screenshots' and auth.uid() is not null);

-- Public read (bucket is public, but policy is still required for the API path)
create policy "Anyone can read bug screenshots"
  on storage.objects for select
  using (bucket_id = 'bug-screenshots');
