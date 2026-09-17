/**
 * Supabase clients. Neither uses a service-role key.
 *
 *   clientForUser(userId) — queries AS that user: the minted user JWT is the
 *     Authorization header, the anon key stays the PostgREST `apikey`, and Row
 *     Level Security applies identically to the app.
 *   serviceClient()       — queries as the `mcp_service` role for OAuth state
 *     (oauth_* tables + RPCs). Cached and re-minted shortly before the JWT
 *     expires so we don't create a client per lookup.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { mintUserJwt, mintServiceJwt, SERVICE_JWT_TTL_SECONDS } from './auth.js';

function withJwt(jwt: string): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

export async function clientForUser(userId: string): Promise<SupabaseClient> {
  return withJwt(await mintUserJwt(userId));
}

let cachedService: { client: SupabaseClient; expiresAt: number } | null = null;
const SERVICE_REFRESH_MARGIN_MS = 30_000;

export async function serviceClient(): Promise<SupabaseClient> {
  const now = Date.now();
  if (cachedService && cachedService.expiresAt - now > SERVICE_REFRESH_MARGIN_MS) {
    return cachedService.client;
  }
  const client = withJwt(await mintServiceJwt());
  cachedService = { client, expiresAt: now + SERVICE_JWT_TTL_SECONDS * 1000 };
  return client;
}
