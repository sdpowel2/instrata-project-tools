/**
 * Environment configuration. Fails fast at startup if anything required is
 * missing so we never run half-configured.
 *
 * Secrets (set via `fly secrets set`):
 *   SUPABASE_URL              — e.g. https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY         — public anon key (used as the PostgREST apikey)
 *   SUPABASE_JWT_SECRET       — legacy HS256 JWT secret, used ONLY to mint
 *                               short-lived per-user tokens and the server's
 *                               own `mcp_service` role token. See README for
 *                               the legacy-key dependency warning.
 *   PUBLIC_BASE_URL           — this server's public origin, e.g.
 *                               https://instrata-project-tools-mcp.fly.dev
 *                               It is the OAuth issuer and the base for every
 *                               OAuth URL and the protected-resource `resource`
 *                               value, so it must match the URL clients use
 *                               exactly. https only (http allowed for localhost).
 * Optional:
 *   OAUTH_ADMIN_CLIENT_ID     — pre-registered client id an admin can paste into
 *                               the claude.ai connector's Advanced settings
 *                               (bypasses Dynamic Client Registration).
 *   OAUTH_ADMIN_CLIENT_SECRET — its secret. Omit to make it a public client.
 *   ACCESS_TOKEN_TTL_SECONDS  — default 3600 (1 h)
 *   REFRESH_TOKEN_TTL_SECONDS — default 2592000 (30 d, sliding)
 *   AUTH_CODE_TTL_SECONDS     — default 600 (10 min)
 *   PORT                      — listen port (default 8080, matches fly.toml)
 *   JWT_TTL_SECONDS           — minted per-user Supabase JWT lifetime (default 300)
 *   RATE_LIMIT_PER_MIN        — per-access-token MCP request cap per minute (default 120)
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

/** PUBLIC_BASE_URL must be a bare origin: https, no path/query/fragment. */
function parsePublicBaseUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_BASE_URL must be an absolute URL, got "${raw}"`);
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !loopback) {
    throw new Error('PUBLIC_BASE_URL must use https:// (http:// is allowed only for localhost / 127.0.0.1)');
  }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
    throw new Error('PUBLIC_BASE_URL must be an origin only — no path, query, fragment, or credentials');
  }
  return u;
}

export const config = {
  supabaseUrl: required('SUPABASE_URL').replace(/\/+$/, ''),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  supabaseJwtSecret: required('SUPABASE_JWT_SECRET'),
  publicBaseUrl: parsePublicBaseUrl(required('PUBLIC_BASE_URL')),
  adminClientId: optional('OAUTH_ADMIN_CLIENT_ID'),
  adminClientSecret: optional('OAUTH_ADMIN_CLIENT_SECRET'),
  accessTokenTtlSeconds: positiveInt('ACCESS_TOKEN_TTL_SECONDS', 3600),
  refreshTokenTtlSeconds: positiveInt('REFRESH_TOKEN_TTL_SECONDS', 30 * 24 * 60 * 60),
  authCodeTtlSeconds: positiveInt('AUTH_CODE_TTL_SECONDS', 600),
  port: positiveInt('PORT', 8080),
  jwtTtlSeconds: positiveInt('JWT_TTL_SECONDS', 300),
  rateLimitPerMin: positiveInt('RATE_LIMIT_PER_MIN', 120),
} as const;
