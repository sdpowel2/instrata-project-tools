-- OAuth 2.1 authorization server storage for the Project Tools MCP server.
--
-- Replaces the placeholder personal-token scheme (mcp_tokens / resolve_mcp_token)
-- with a real OAuth 2.1 AS hosted by mcp-server itself, so claude.ai custom
-- connectors, Claude Code, Claude Desktop and MCP Inspector all connect through
-- the standard discovery → DCR/CIMD → PKCE → token flow. See
--   Product Spec/project-tools-mcp-auth-spec.md               (requirements)
--   Product Spec/project-tools-mcp-auth-implementation-plan.md (design, §6)
--
-- What lives here:
--   oauth_clients          registered clients (DCR + CIMD). The admin
--                          pre-registered client is env-configured on the
--                          server, NOT a row — so token tables carry no FK to
--                          this table.
--   oauth_auth_codes       one-time authorization codes (10 min TTL)
--   oauth_refresh_tokens   30-day sliding, rotated on every use; reuse of a
--                          rotated token revokes the whole family
--   oauth_access_tokens    1-hour opaque bearer tokens the MCP endpoint checks
--
-- Every token/code is stored as its SHA-256 hex hash only. Plaintext is never
-- persisted anywhere.
--
-- ── Access model: a dedicated PostgREST role, not the service-role key ─────────
--
-- The MCP server holds no service-role key by design (PROJECT_DOCS §7). Its
-- existing pattern — SECURITY DEFINER RPCs granted to `authenticated`, called
-- with a JWT the server mints from the legacy HS256 secret — is NOT safe for an
-- authorization server: every signed-in app user has the `authenticated` role,
-- so they could call token-issuing RPCs for any user_id.
--
-- Instead this migration creates `mcp_service`, a nologin role granted to
-- `authenticator`, which is what lets PostgREST `SET ROLE mcp_service` when a
-- request's JWT carries { "role": "mcp_service" }. Only holders of the JWT
-- secret (the MCP server) can mint such a JWT. The role gets table privileges
-- on the four oauth_* tables and execute on the three atomic RPCs below, and
-- nothing else. `anon` and `authenticated` get no access, except the narrow
-- own-row select/revoke on the two token tables that powers the Settings
-- "Connected apps" card.
--
-- ORDER OF OPERATIONS:
--   1. Run this migration (additive; nothing running today depends on it).
--   2. Verify PostgREST honours the role — see "Verification" at the bottom.
--   3. Deploy the OAuth-enabled mcp-server.
--   4. Only then run drop_mcp_tokens.sql to remove the placeholder scheme.

create extension if not exists pgcrypto;

-- ── Role ──────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mcp_service') then
    create role mcp_service nologin noinherit;
  end if;
end
$$;

-- PostgREST connects as `authenticator` and switches to the JWT's role claim;
-- it can only switch to roles it is a member of.
grant mcp_service to authenticator;
grant usage on schema public to mcp_service;

-- ── Tables ────────────────────────────────────────────────────────────────────

create table if not exists public.oauth_clients (
  client_id                  text primary key,                 -- uuid (DCR) or the https:// metadata URL (CIMD)
  client_name                text,
  redirect_uris              text[] not null,                  -- validated against the server allowlist at registration
  token_endpoint_auth_method text not null default 'none',     -- 'none' (public) | 'client_secret_post'
  grant_types                text[] not null default '{authorization_code,refresh_token}',
  scope                      text,                             -- space-separated scopes the client asked for at registration
  source                     text not null check (source in ('dcr', 'cimd')),
  metadata                   jsonb not null default '{}'::jsonb, -- full registered metadata document, echoed back on lookups
  created_at                 timestamptz not null default now(),
  last_used_at               timestamptz                       -- bumped when the client obtains tokens; drives cleanup
);

create table if not exists public.oauth_auth_codes (
  code_hash      text primary key,                             -- sha256 hex of the code
  client_id      text not null,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  redirect_uri   text not null,                                -- must match on exchange
  code_challenge text not null,                                -- PKCE S256 challenge
  scope          text not null,                                -- granted scopes (space-separated)
  resource       text,                                         -- RFC 8707 resource indicator, if the client sent one
  expires_at     timestamptz not null,
  used_at        timestamptz,                                  -- non-null = burned; a second exchange is invalid_grant
  created_at     timestamptz not null default now()
);

create table if not exists public.oauth_refresh_tokens (
  token_hash   text primary key,
  client_id    text not null,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  scope        text not null,
  resource     text,
  family_id    uuid not null,                                  -- shared by every token descended from one consent
  expires_at   timestamptz not null,                           -- sliding: each rotation issues a fresh 30-day expiry
  revoked_at   timestamptz,                                    -- explicit revocation (user disconnect, /oauth/revoke, family kill)
  replaced_by  text,                                           -- hash of the token that rotated this one; non-null = spent
  created_at   timestamptz not null default now()
);

create table if not exists public.oauth_access_tokens (
  token_hash   text primary key,
  client_id    text not null,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  scope        text not null,
  resource     text,
  family_id    uuid,                                           -- null when issued without offline_access (no refresh token)
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);

-- Indexes: per-user listing (Connected apps), family revocation, and cleanup.
create index if not exists idx_oauth_auth_codes_expires      on public.oauth_auth_codes (expires_at);
create index if not exists idx_oauth_refresh_user            on public.oauth_refresh_tokens (user_id, created_at desc);
create index if not exists idx_oauth_refresh_family          on public.oauth_refresh_tokens (family_id);
create index if not exists idx_oauth_refresh_expires         on public.oauth_refresh_tokens (expires_at);
create index if not exists idx_oauth_access_user             on public.oauth_access_tokens (user_id);
create index if not exists idx_oauth_access_family           on public.oauth_access_tokens (family_id);
create index if not exists idx_oauth_access_expires          on public.oauth_access_tokens (expires_at);
create index if not exists idx_oauth_clients_source_created  on public.oauth_clients (source, created_at);

-- ── Table privileges ──────────────────────────────────────────────────────────
--
-- Supabase's default privileges grant ALL on new public tables to anon,
-- authenticated and service_role. Strip anon/authenticated back to exactly
-- what the app needs; RLS below is the second lock.

revoke all on public.oauth_clients        from anon, authenticated;
revoke all on public.oauth_auth_codes     from anon, authenticated;
revoke all on public.oauth_refresh_tokens from anon, authenticated;
revoke all on public.oauth_access_tokens  from anon, authenticated;

grant select, insert, update, delete on public.oauth_clients        to mcp_service;
grant select, insert, update, delete on public.oauth_auth_codes     to mcp_service;
grant select, insert, update, delete on public.oauth_refresh_tokens to mcp_service;
grant select, insert, update, delete on public.oauth_access_tokens  to mcp_service;
grant select (id) on public.profiles to mcp_service;               -- FK checks only

-- Connected apps card: a signed-in user may list their own grants and set
-- revoked_at on them (column-level, so nothing else on the row is writable).
grant select on public.oauth_refresh_tokens              to authenticated;
grant select on public.oauth_access_tokens               to authenticated;
grant select (client_id, client_name, source) on public.oauth_clients to authenticated;
grant update (revoked_at) on public.oauth_refresh_tokens to authenticated;
grant update (revoked_at) on public.oauth_access_tokens  to authenticated;

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table public.oauth_clients        enable row level security;
alter table public.oauth_auth_codes     enable row level security;
alter table public.oauth_refresh_tokens enable row level security;
alter table public.oauth_access_tokens  enable row level security;

drop policy if exists "mcp_service full access"          on public.oauth_clients;
drop policy if exists "mcp_service full access"          on public.oauth_auth_codes;
drop policy if exists "mcp_service full access"          on public.oauth_refresh_tokens;
drop policy if exists "mcp_service full access"          on public.oauth_access_tokens;
drop policy if exists "Users can read client names"      on public.oauth_clients;
drop policy if exists "Users can read own refresh tokens"   on public.oauth_refresh_tokens;
drop policy if exists "Users can revoke own refresh tokens" on public.oauth_refresh_tokens;
drop policy if exists "Users can read own access tokens"    on public.oauth_access_tokens;
drop policy if exists "Users can revoke own access tokens"  on public.oauth_access_tokens;

create policy "mcp_service full access" on public.oauth_clients
  for all to mcp_service using (true) with check (true);
create policy "mcp_service full access" on public.oauth_auth_codes
  for all to mcp_service using (true) with check (true);
create policy "mcp_service full access" on public.oauth_refresh_tokens
  for all to mcp_service using (true) with check (true);
create policy "mcp_service full access" on public.oauth_access_tokens
  for all to mcp_service using (true) with check (true);

-- Client display names are not sensitive (they're what the consent screen
-- already showed the user); needed to label rows in Connected apps.
create policy "Users can read client names" on public.oauth_clients
  for select to authenticated using (auth.uid() is not null);

create policy "Users can read own refresh tokens" on public.oauth_refresh_tokens
  for select to authenticated using (user_id = auth.uid());
create policy "Users can revoke own refresh tokens" on public.oauth_refresh_tokens
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "Users can read own access tokens" on public.oauth_access_tokens
  for select to authenticated using (user_id = auth.uid());
create policy "Users can revoke own access tokens" on public.oauth_access_tokens
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── RPCs used by the server (mcp_service only) ────────────────────────────────
--
-- All SECURITY INVOKER: they run as mcp_service with that role's grants and
-- policies, never elevated. Postgres grants EXECUTE to PUBLIC by default (and
-- Supabase's default privileges add anon/authenticated), so each is revoked
-- from those and granted only to mcp_service — see revoke_resolve_mcp_token_anon.sql
-- for why revoking from anon alone is not enough.

-- oauth_revoke_family ─── kill every live token descended from one consent.
create or replace function public.oauth_revoke_family(p_family_id uuid)
returns void
language sql
set search_path = public
as $$
  update public.oauth_refresh_tokens
     set revoked_at = now()
   where family_id = p_family_id and revoked_at is null;
  update public.oauth_access_tokens
     set revoked_at = now()
   where family_id = p_family_id and revoked_at is null;
$$;

-- oauth_consume_auth_code ─── atomically burn a code. Returns the row when the
-- code was live (unused + unexpired); returns no rows otherwise, and the server
-- maps that to invalid_grant. Single UPDATE, so two concurrent exchanges can
-- never both succeed.
create or replace function public.oauth_consume_auth_code(p_code_hash text)
returns setof public.oauth_auth_codes
language sql
set search_path = public
as $$
  update public.oauth_auth_codes
     set used_at = now()
   where code_hash = p_code_hash
     and used_at is null
     and expires_at > now()
  returning *;
$$;

-- oauth_rotate_refresh_token ─── one transaction: validate the presented
-- refresh token, mark it spent, insert its replacement plus a new access token,
-- and return the grant the server needs for the token response.
--
-- Returns no rows (→ invalid_grant) when the token is unknown, expired, or
-- revoked. If the token was already ROTATED (replaced_by set) the presenter is
-- replaying a spent token — someone has a copy they shouldn't — so the entire
-- family is revoked before returning nothing, forcing a clean re-consent.
--
-- p_scope lets the server narrow scopes on refresh (RFC 6749 §6). The server
-- must check the requested set ⊆ the original before calling; this function
-- stores whatever it's given, defaulting to the original scope.
create or replace function public.oauth_rotate_refresh_token(
  p_old_hash           text,
  p_new_refresh_hash   text,
  p_new_access_hash    text,
  p_access_expires_at  timestamptz,
  p_refresh_expires_at timestamptz,
  p_scope              text default null
)
returns table (user_id uuid, client_id text, scope text, resource text, family_id uuid)
language plpgsql
set search_path = public
as $$
declare
  v_old   public.oauth_refresh_tokens%rowtype;
  v_scope text;
begin
  select * into v_old
    from public.oauth_refresh_tokens
   where token_hash = p_old_hash
     for update;

  if not found then
    return;                                     -- unknown token
  end if;

  if v_old.replaced_by is not null then
    perform public.oauth_revoke_family(v_old.family_id);   -- reuse detected
    return;
  end if;

  if v_old.revoked_at is not null or v_old.expires_at <= now() then
    return;                                     -- dead token, nothing to rotate
  end if;

  v_scope := coalesce(nullif(trim(p_scope), ''), v_old.scope);

  update public.oauth_refresh_tokens
     set replaced_by = p_new_refresh_hash
   where token_hash = p_old_hash;

  insert into public.oauth_refresh_tokens
         (token_hash, client_id, user_id, scope, resource, family_id, expires_at)
  values (p_new_refresh_hash, v_old.client_id, v_old.user_id, v_scope, v_old.resource,
          v_old.family_id, p_refresh_expires_at);

  insert into public.oauth_access_tokens
         (token_hash, client_id, user_id, scope, resource, family_id, expires_at)
  values (p_new_access_hash, v_old.client_id, v_old.user_id, v_scope, v_old.resource,
          v_old.family_id, p_access_expires_at);

  update public.oauth_clients
     set last_used_at = now()
   where oauth_clients.client_id = v_old.client_id;

  return query
    select v_old.user_id, v_old.client_id, v_scope, v_old.resource, v_old.family_id;
end;
$$;

revoke execute on function public.oauth_revoke_family(uuid)                                            from public, anon, authenticated;
revoke execute on function public.oauth_consume_auth_code(text)                                        from public, anon, authenticated;
revoke execute on function public.oauth_rotate_refresh_token(text, text, text, timestamptz, timestamptz, text) from public, anon, authenticated;

grant  execute on function public.oauth_revoke_family(uuid)                                            to mcp_service;
grant  execute on function public.oauth_consume_auth_code(text)                                        to mcp_service;
grant  execute on function public.oauth_rotate_refresh_token(text, text, text, timestamptz, timestamptz, text) to mcp_service;

-- ── RPC used by the app (authenticated) ───────────────────────────────────────
--
-- oauth_disconnect ─── "Disconnect Claude" from Settings. Revokes one family
-- (p_family_id) or every grant the caller owns (null). SECURITY INVOKER, so it
-- runs under the caller's RLS + column grants above and can only ever touch
-- rows where user_id = auth.uid(). Returns the number of refresh-token rows
-- revoked so the UI can confirm something happened.
create or replace function public.oauth_disconnect(p_family_id uuid default null)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  update public.oauth_access_tokens
     set revoked_at = now()
   where user_id = auth.uid()
     and revoked_at is null
     and (p_family_id is null or family_id = p_family_id);

  update public.oauth_refresh_tokens
     set revoked_at = now()
   where user_id = auth.uid()
     and revoked_at is null
     and (p_family_id is null or family_id = p_family_id);
  get diagnostics v_count = row_count;

  return v_count;
end;
$$;

revoke execute on function public.oauth_disconnect(uuid) from public, anon;
grant  execute on function public.oauth_disconnect(uuid) to authenticated;

-- ── Cleanup ───────────────────────────────────────────────────────────────────
--
-- Purges spent/expired rows and DCR clients that never obtained a token within
-- 7 days (spec §5.4). Scheduled nightly via pg_cron when the extension is
-- enabled (Dashboard → Database → Extensions → pg_cron). If it isn't, the
-- server calls this itself on a 24h timer — it's granted to mcp_service for
-- that reason.

create or replace function public.oauth_cleanup()
returns table (auth_codes integer, access_tokens integer, refresh_tokens integer, clients integer)
language plpgsql
set search_path = public
as $$
declare
  v_codes int; v_access int; v_refresh int; v_clients int;
begin
  delete from public.oauth_auth_codes
   where expires_at < now() - interval '1 day';
  get diagnostics v_codes = row_count;

  delete from public.oauth_access_tokens
   where expires_at < now() - interval '7 days';
  get diagnostics v_access = row_count;

  -- Keep spent/revoked refresh rows 30 days for reuse-detection forensics.
  delete from public.oauth_refresh_tokens
   where (expires_at < now() or revoked_at is not null or replaced_by is not null)
     and created_at < now() - interval '30 days';
  get diagnostics v_refresh = row_count;

  delete from public.oauth_clients c
   where c.source = 'dcr'
     and c.created_at < now() - interval '7 days'
     and not exists (select 1 from public.oauth_refresh_tokens t where t.client_id = c.client_id)
     and not exists (select 1 from public.oauth_access_tokens  t where t.client_id = c.client_id);
  get diagnostics v_clients = row_count;

  return query select v_codes, v_access, v_refresh, v_clients;
end;
$$;

revoke execute on function public.oauth_cleanup() from public, anon, authenticated;
grant  execute on function public.oauth_cleanup() to mcp_service;

-- Nightly at 03:15 UTC when pg_cron is available. cron.schedule() with a job
-- name upserts, so re-running this migration doesn't duplicate the job.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('oauth-cleanup-nightly', '15 3 * * *', 'select public.oauth_cleanup();');
    raise notice 'pg_cron present: scheduled oauth-cleanup-nightly';
  else
    raise notice 'pg_cron not enabled: mcp-server will run oauth_cleanup() on its own 24h timer';
  end if;
end
$$;

-- PostgREST picks up new tables/functions via Supabase's DDL event trigger;
-- this is a harmless belt-and-suspenders nudge.
notify pgrst, 'reload schema';

-- ── Verification (run by hand, not part of the migration) ─────────────────────
--
-- 1. Role plumbing:
--      select rolname from pg_roles where rolname = 'mcp_service';
--      select r.rolname as member_of from pg_auth_members m
--        join pg_roles r on r.oid = m.roleid
--        join pg_roles u on u.oid = m.member where u.rolname = 'authenticator';
--    → 'mcp_service' appears in both.
--
-- 2. Row-level privileges, without leaving the SQL editor:
--      set local role mcp_service;  select count(*) from public.oauth_clients;  reset role;
--      set local role authenticated; select count(*) from public.oauth_auth_codes; reset role;
--    → first succeeds (0), second fails with "permission denied".
--
-- 3. Through PostgREST (the assumption the server design depends on): mint a
--    JWT with the legacy HS256 secret and claims
--      { "role": "mcp_service", "sub": "00000000-0000-0000-0000-000000000000",
--        "aud": "authenticated", "iss": "<SUPABASE_URL>/auth/v1", "exp": <now+60> }
--    then
--      curl -s "<SUPABASE_URL>/rest/v1/oauth_clients?select=client_id" \
--        -H "apikey: <anon key>" -H "Authorization: Bearer <jwt>"
--    → HTTP 200 and `[]`. A 401/403 mentioning the role means the
--    authenticator grant didn't take; see implementation plan §6.2 fallback.
