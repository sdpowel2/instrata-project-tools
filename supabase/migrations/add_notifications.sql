-- Notification system — Phase 3.
--
-- notifications: one row per in-app alert delivered to a user.
-- notification_preferences: per-user opt-in/out per notification type.
--   Default is enabled — a missing row means the user hasn't changed the
--   setting, so the application treats absence as opted-in.

-- ── Notifications ─────────────────────────────────────────────────────────────

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  type        text not null,         -- e.g. 'bug_status_changed'
  title       text not null,
  message     text,                  -- optional longer body (admin resolution note)
  related_id  uuid,                  -- bug_report id for deep-linking later
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table public.notifications enable row level security;

-- Users can only see their own notifications
create policy "Users can read own notifications"
  on public.notifications for select
  using (user_id = auth.uid());

-- Users mark their own notifications read
create policy "Users can update own notifications"
  on public.notifications for update
  using (user_id = auth.uid());

-- Admins insert notifications on behalf of any user (e.g. bug status changes)
create policy "Admins can insert notifications"
  on public.notifications for insert
  with check (exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

create index if not exists idx_notifications_user_unread
  on public.notifications (user_id, read, created_at desc);

-- ── Notification Preferences ──────────────────────────────────────────────────

create table if not exists public.notification_preferences (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  type     text not null,
  enabled  boolean not null default true,
  primary key (user_id, type)
);

alter table public.notification_preferences enable row level security;

create policy "Users can read own preferences"
  on public.notification_preferences for select
  using (user_id = auth.uid());

create policy "Users can manage own preferences"
  on public.notification_preferences for all
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());
