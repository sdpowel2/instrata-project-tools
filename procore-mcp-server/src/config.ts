/**
 * Environment configuration. Fails fast at startup if anything required is
 * missing so we never run half-configured (pattern from the sibling Supabase
 * server, mcp-server/src/config.ts).
 *
 * Secrets are provided at runtime (never build args, never committed):
 *   BASE_URL              — public URL of this server (OAuth metadata + redirects)
 *   PROCORE_CLIENT_ID     — Procore Developer app client id
 *   PROCORE_CLIENT_SECRET — Procore Developer app client secret
 *   PROCORE_BASE_URL      — Procore REST base (sandbox vs api.procore.com)
 *   DATABASE_URL          — dedicated Postgres for the encrypted token store
 *   TOKEN_ENCRYPTION_KEY  — 32-byte AES-256-GCM key (base64 or hex)
 *   SESSION_SECRET        — signs the JWTs we issue to Claude
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : fallback;
}

const stripTrailingSlash = (u: string) => u.replace(/\/+$/, '');

const procoreBaseUrl = stripTrailingSlash(required('PROCORE_BASE_URL'));

export const config = {
  baseUrl: stripTrailingSlash(required('BASE_URL')),
  port: Number(process.env.PORT ?? 8080),

  procoreClientId: required('PROCORE_CLIENT_ID'),
  procoreClientSecret: required('PROCORE_CLIENT_SECRET'),
  procoreBaseUrl,
  // OAuth authorize/token host. Sandbox serves OAuth from the same host; prod
  // uses https://login.procore.com. Defaults to the API base, overridable.
  procoreAuthUrl: stripTrailingSlash(optional('PROCORE_AUTH_URL', procoreBaseUrl)),

  databaseUrl: required('DATABASE_URL'),
  tokenEncryptionKey: required('TOKEN_ENCRYPTION_KEY'),
  sessionSecret: required('SESSION_SECRET'),

  logLevel: optional('LOG_LEVEL', 'info'),
  accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 3600),
  procoreMaxConcurrency: Number(process.env.PROCORE_MAX_CONCURRENCY ?? 5),
} as const;

/** The redirect URI registered with the Procore Developer app. */
export const procoreRedirectUri = `${config.baseUrl}/procore/callback`;
