/**
 * Token resolution + per-user JWT minting — the heart of the "same security as
 * the app" guarantee.
 *
 *   1. resolveToken(): the opaque token a user pasted into their Claude client
 *      is exchanged (via the anon-callable resolve_mcp_token RPC) for a user_id.
 *      No data is reachable here — the RPC only returns an id for a valid,
 *      non-revoked token.
 *   2. mintUserJwt(): we sign a SHORT-LIVED Supabase-format JWT for that user.
 *      PostgREST then enforces RLS exactly as it does for the logged-in app,
 *      because every policy keys off auth.uid() == this token's `sub`.
 *
 * ⚠️  LEGACY-KEY DEPENDENCY: the JWT is signed with the project's legacy HS256
 *   secret (SUPABASE_JWT_SECRET — currently the dashboard "Previous Key", still
 *   trusted for verification, and the same key the app's anon key relies on).
 *   When you rotate Supabase keys / revoke the legacy HS256 secret, this minting
 *   approach stops working and must be replaced (relay Supabase-issued tokens,
 *   or OAuth). See README.md → "Auth & the legacy key".
 */
import { SignJWT } from 'jose';
import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

// Anon-key client with no user context — used solely to call resolve_mcp_token.
const anonClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const jwtSecret = new TextEncoder().encode(config.supabaseJwtSecret);

/** Resolve a presented bearer token to a user_id, or null if invalid/revoked. */
export async function resolveToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const { data, error } = await anonClient.rpc('resolve_mcp_token', { p_token: token });
  if (error) {
    console.error('[auth] resolve_mcp_token error:', error.message);
    return null;
  }
  return (data as string | null) ?? null;
}

/** Mint a short-lived Supabase JWT impersonating `userId` as an authenticated user. */
export async function mintUserJwt(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setIssuer(`${config.supabaseUrl}/auth/v1`)
    .setIssuedAt(now)
    .setExpirationTime(now + config.jwtTtlSeconds)
    .sign(jwtSecret);
}
