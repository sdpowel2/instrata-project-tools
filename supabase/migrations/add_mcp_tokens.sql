-- MCP personal access tokens.
--
-- Backs the read-only MCP server (see /mcp-server) that lets staff connect a
-- Claude client to their Project Tools data. Each staff member generates one or
-- more opaque tokens here and pastes them into their Claude client. The token
-- itself is never stored — only its SHA-256 hash — exactly like a password.
--
-- Auth model / how this stays "same as the app":
--   The MCP server resolves a presented token to a user_id via resolve_mcp_token(),
--   then mints a short-lived Supabase JWT for that user and queries PostgREST with
--   it, so every read is governed by the SAME RLS policies the user hits in the
--   browser. The token grants no extra access; it's just a second front door
--   protected by the same lock. This migration adds no service-role surface.
--
-- ⚠️  LEGACY-KEY DEPENDENCY: the MCP server signs those short-lived JWTs with the
--   project's legacy HS256 JWT secret (currently the dashboard "Previous Key",
--   still trusted for verification). This is the same key your app's anon key
--   depends on. When you eventually rotate Supabase keys / revoke the legacy
--   HS256 secret, the MCP server's auth must be upgraded at the same time
--   (relay Supabase-issued tokens, or OAuth). See /mcp-server/README.md.

create extension if not exists pgcrypto;

-- ── Table ─────────────────────────────────────────────────────────────────────

create table if not exists public.mcp_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  token_hash    text not null unique,           -- SHA-256 of the plaintext token (hex)
  name          text not null default '',        -- user-supplied label, e.g. "Laptop / Claude Desktop"
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,                     -- bumped by resolve_mcp_token on each use
  revoked_at    timestamptz                      -- non-null = revoked, no longer resolvable
);

create index if not exists idx_mcp_tokens_user on public.mcp_tokens (user_id, created_at desc);

alter table public.mcp_tokens enable row level security;

-- ── RLS ─── users manage only their own tokens (mirrors notifications) ──────────

drop policy if exists "Users can read own mcp tokens"   on public.mcp_tokens;
drop policy if exists "Users can insert own mcp tokens"  on public.mcp_tokens;
drop policy if exists "Users can update own mcp tokens"  on public.mcp_tokens;
drop policy if exists "Users can delete own mcp tokens"  on public.mcp_tokens;

create policy "Users can read own mcp tokens"
  on public.mcp_tokens for select
  using (user_id = auth.uid());

-- Insert happens through create_mcp_token() (SECURITY INVOKER), so the row must
-- still satisfy this check — belt and suspenders.
create policy "Users can insert own mcp tokens"
  on public.mcp_tokens for insert
  with check (user_id = auth.uid());

-- Revoke = set revoked_at on your own row.
create policy "Users can update own mcp tokens"
  on public.mcp_tokens for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete own mcp tokens"
  on public.mcp_tokens for delete
  using (user_id = auth.uid());

-- ── create_mcp_token ─── generate a token, store its hash, return plaintext once ─
--
-- Runs as the caller (SECURITY INVOKER) so auth.uid() is the signed-in user and
-- the insert is subject to the RLS check above. The plaintext is returned EXACTLY
-- ONCE here and never persisted; the UI shows it to the user immediately.

create or replace function public.create_mcp_token(p_name text default '')
returns text
language plpgsql
set search_path = public, extensions
as $$
declare
  v_token text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- 'instrata_mcp_' + 64 hex chars (32 random bytes)
  v_token := 'instrata_mcp_' || encode(gen_random_bytes(32), 'hex');

  insert into public.mcp_tokens (user_id, token_hash, name)
  values (auth.uid(), encode(digest(v_token, 'sha256'), 'hex'), coalesce(p_name, ''));

  return v_token;
end;
$$;

-- ── resolve_mcp_token ─── token → user_id, for the MCP server ───────────────────
--
-- SECURITY DEFINER + anon-executable: the MCP server connects with the public
-- anon key (role `anon`) and has no user context yet, so this must run outside
-- RLS to look the token up. Safe because the caller must present the real token,
-- whose hash matches a stored row (like verifying a password). Bumps last_used_at
-- and returns null for unknown/revoked tokens.

create or replace function public.resolve_mcp_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid;
begin
  update public.mcp_tokens
     set last_used_at = now()
   where token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and revoked_at is null
  returning user_id into v_user_id;

  return v_user_id;  -- null if no active token matched
end;
$$;

-- Grants: create_mcp_token for signed-in users; resolve_mcp_token for the anon
-- role the MCP server uses (and authenticated, harmless).
grant execute on function public.create_mcp_token(text)   to authenticated;
grant execute on function public.resolve_mcp_token(text)  to anon, authenticated;
