import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    '[Supabase] Missing environment variables. Running in offline/demo mode.\n' +
    'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env to enable persistence.'
  );
}

// Singleton pattern: survive Vite HMR by storing on window.
// Without this, every HMR update creates a new client that fights
// for the Navigator Lock used by Supabase auth, causing
// NavigatorLockAcquireTimeoutError and breaking sign-out.
const GLOBAL_KEY = '__supabase_client__';

function getOrCreateClient(): SupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w[GLOBAL_KEY]) return w[GLOBAL_KEY];

  const client = createClient(
    supabaseUrl || 'https://placeholder.supabase.co',
    supabaseAnonKey || 'placeholder-key',
  );
  w[GLOBAL_KEY] = client;
  return client;
}

export let supabase = getOrCreateClient();

/**
 * Destroy the cached Supabase client and create a fresh one.
 * Use this when the client's internal auth state has become corrupted
 * (e.g. after a Navigator Lock timeout on page refresh).
 */
export function resetSupabaseClient(): void {
  const w = window as any;
  delete w[GLOBAL_KEY];
  supabase = getOrCreateClient();
}

/** Returns true if Supabase is properly configured with real credentials */
export function isSupabaseConfigured(): boolean {
  return !!(
    supabaseUrl &&
    supabaseAnonKey &&
    !supabaseUrl.includes('placeholder') &&
    !supabaseUrl.includes('your-project') &&
    !supabaseAnonKey.includes('placeholder') &&
    !supabaseAnonKey.includes('your-anon-key')
  );
}
