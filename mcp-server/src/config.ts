/**
 * Environment configuration. Fails fast at startup if anything required is
 * missing so we never run half-configured.
 *
 * Secrets (set via `fly secrets set`):
 *   SUPABASE_URL            — e.g. https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY       — public anon key (used as the PostgREST apikey)
 *   SUPABASE_JWT_SECRET     — legacy HS256 JWT secret, used ONLY to mint
 *                             short-lived per-user tokens. See README for the
 *                             legacy-key dependency warning.
 * Optional:
 *   PORT                    — listen port (default 8080, matches fly.toml)
 *   JWT_TTL_SECONDS         — minted token lifetime (default 300)
 *   RATE_LIMIT_PER_MIN      — per-token request cap per minute (default 120)
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export const config = {
  supabaseUrl: required('SUPABASE_URL').replace(/\/+$/, ''),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  supabaseJwtSecret: required('SUPABASE_JWT_SECRET'),
  port: Number(process.env.PORT ?? 8080),
  jwtTtlSeconds: Number(process.env.JWT_TTL_SECONDS ?? 300),
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 120),
} as const;
