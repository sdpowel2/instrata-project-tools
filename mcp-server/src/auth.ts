/**
 * JWT minting — the heart of the "same security as the app" guarantee.
 *
 * Caller identity now comes from the OAuth 2.1 layer (src/oauth/): a bearer
 * access token is resolved to a `user_id` by the provider. This module then
 * mints the Supabase-format JWTs the server needs to talk to PostgREST:
 *
 *   mintUserJwt(userId)  — SHORT-LIVED `authenticated` JWT with sub = the
 *                          user. PostgREST enforces RLS exactly as it does for
 *                          the logged-in app, because every policy keys off
 *                          auth.uid() == this token's `sub`.
 *   mintServiceJwt()     — SHORT-LIVED JWT with role = `mcp_service`, the
 *                          dedicated PostgREST role that owns the oauth_*
 *                          tables (supabase/migrations/add_oauth_server.sql).
 *                          Only holders of the JWT secret can mint it, so only
 *                          this server can read/write OAuth state. It carries a
 *                          nil `sub`: auth.uid() is null for it, by design.
 *
 * ⚠️  LEGACY-KEY DEPENDENCY: both are signed with the project's legacy HS256
 *   secret (SUPABASE_JWT_SECRET — currently the dashboard "Previous Key", still
 *   trusted for verification, and the same key the app's anon key relies on).
 *   When you rotate Supabase keys / revoke the legacy HS256 secret, this minting
 *   approach stops working and must be replaced. See README.md →
 *   "Auth & the legacy key".
 */
import { SignJWT } from 'jose';
import { config } from './config.js';

const jwtSecret = new TextEncoder().encode(config.supabaseJwtSecret);

/** Placeholder subject for the service JWT — no real user is impersonated. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Lifetime of the service-role JWT; supabase.ts caches the client for slightly less. */
export const SERVICE_JWT_TTL_SECONDS = 300;

async function sign(role: string, subject: string, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(subject)
    .setAudience('authenticated')
    .setIssuer(`${config.supabaseUrl}/auth/v1`)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(jwtSecret);
}

/** Mint the server's own `mcp_service` JWT for OAuth-table access. */
export async function mintServiceJwt(): Promise<string> {
  return sign('mcp_service', NIL_UUID, SERVICE_JWT_TTL_SECONDS);
}

/** Mint a short-lived Supabase JWT impersonating `userId` as an authenticated user. */
export async function mintUserJwt(userId: string): Promise<string> {
  return sign('authenticated', userId, config.jwtTtlSeconds);
}
