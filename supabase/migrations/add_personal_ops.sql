-- Personal Ops Dashboard: email triage + task management (admin-only)
-- Phase 1+2: Graph tokens, email flag state

-- ── Microsoft Graph OAuth tokens ─────────────────────────────────────────────
create table if not exists public.ms_graph_tokens (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  access_token   text not null,
  refresh_token  text not null,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique(user_id)
);

alter table public.ms_graph_tokens enable row level security;

create policy "tokens_admin_own" on public.ms_graph_tokens for all
  using (
    auth.uid() = user_id
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- ── Email triage flags ───────────────────────────────────────────────────────
create table if not exists public.personal_ops_email_flags (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  message_id     text not null,
  status         text not null default 'active'
    check (status in ('active', 'flagged', 'deferred', 'dismissed')),
  urgency_score  numeric,
  urgency_reason text,
  session_type   text
    check (session_type in ('morning', 'midday', 'eod')),
  deferred_to    text
    check (deferred_to in ('morning', 'midday', 'eod')),
  first_seen_at  timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.personal_ops_email_flags enable row level security;

create policy "email_flags_admin_own" on public.personal_ops_email_flags for all
  using (
    auth.uid() = user_id
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

create index idx_email_flags_user_message
  on public.personal_ops_email_flags (user_id, message_id);
