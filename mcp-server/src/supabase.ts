/**
 * Build a Supabase client that queries AS a specific user, so Row Level
 * Security applies identically to the app. We attach the minted user JWT as the
 * Authorization header; the anon key remains the PostgREST `apikey`. No
 * service-role key is ever used.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { mintUserJwt } from './auth.js';

export async function clientForUser(userId: string): Promise<SupabaseClient> {
  const jwt = await mintUserJwt(userId);
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}
