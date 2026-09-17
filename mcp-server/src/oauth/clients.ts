/**
 * OAuth client store: who is allowed to ask for tokens.
 *
 * Three kinds of client, all resolved by getClient():
 *   admin  — a fixed client_id (+ optional secret) from env. The Instrata admin
 *            can paste these into the claude.ai connector's Advanced settings to
 *            bypass Dynamic Client Registration. Never a DB row; the secret
 *            lives only in a Fly secret (the SDK compares it in plaintext).
 *   cimd   — Client ID Metadata Document: client_id is an https:// URL that
 *            serves the client's metadata (Claude Code uses
 *            https://claude.ai/oauth/claude-code-client-metadata). Fetched with
 *            a tight timeout, validated, cached 1 h, mirrored to oauth_clients
 *            for display in the Connected apps card.
 *   dcr    — registered via POST /oauth/register and stored in oauth_clients.
 *
 * Redirect URIs are the security boundary of the whole flow (they decide where
 * authorization codes get sent), so every kind is checked against the same
 * allowlist in isAllowedRedirect().
 */
import { randomUUID } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OAuthClientMetadataSchema, type OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from '../config.js';
import { SCOPES, isSupportedScope, parseScopes } from './scopes.js';
import { getClientRow, upsertClientRow, type ClientRow } from './store.js';

// ── Redirect allowlist (spec §5.7) ────────────────────────────────────────────

export const CLAUDE_AI_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
const LOOPBACK_PATH = '/callback';

export const ALLOWED_REDIRECTS_HELP =
  `${CLAUDE_AI_CALLBACK}, http://localhost:<any port>${LOOPBACK_PATH}, http://127.0.0.1:<any port>${LOOPBACK_PATH}`;

/**
 * Exactly the claude.ai callback, or an http loopback URI on /callback with
 * any port (RFC 8252 §7.3). Scheme, host and path must match; no query or
 * fragment.
 */
export function isAllowedRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.href === CLAUDE_AI_CALLBACK) return true;
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname) && u.pathname === LOOPBACK_PATH && u.search === '';
}

const ALLOWED_GRANT_TYPES = ['authorization_code', 'refresh_token'];

// ── Admin pre-registered client (spec §5.9) ───────────────────────────────────

function adminClient(): OAuthClientInformationFull | undefined {
  if (!config.adminClientId) return undefined;
  return {
    client_id: config.adminClientId,
    client_secret: config.adminClientSecret,
    client_name: 'Claude (Instrata pre-registered)',
    redirect_uris: [CLAUDE_AI_CALLBACK],
    token_endpoint_auth_method: config.adminClientSecret ? 'client_secret_post' : 'none',
    grant_types: ALLOWED_GRANT_TYPES,
    response_types: ['code'],
    scope: SCOPES.join(' '),
  };
}

export function isAdminClientId(clientId: string): boolean {
  return config.adminClientId !== undefined && clientId === config.adminClientId;
}

// ── CIMD (spec §5.3) ──────────────────────────────────────────────────────────

const CIMD_CACHE_TTL_MS = 60 * 60 * 1000;
const CIMD_FETCH_TIMEOUT_MS = 5_000;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_USER_AGENT = 'instrata-project-tools-mcp/2.0 (+https://instrata-project-tools-mcp.fly.dev)';
const cimdCache = new Map<string, { client: OAuthClientInformationFull; expiresAt: number }>();

/**
 * Pinned copies of Anthropic's own client metadata documents, used when the
 * live fetch fails. claude.ai's edge has been seen returning 403 to fetches
 * from Fly's datacenter egress (2026-09-17) even though the same URL serves
 * 200 elsewhere — without this, no claude.ai user could ever connect. Safe
 * because the redirect URIs here are exactly our allowlist, and the redirect
 * allowlist (not the client_id) is what protects code delivery. The live
 * document is still preferred whenever it can be fetched, so upstream changes
 * flow through. Keep these in sync with `curl <url>` from time to time.
 */
const KNOWN_CIMD_CLIENTS: Record<string, Omit<OAuthClientInformationFull, 'client_id'>> = {
  'https://claude.ai/oauth/mcp-oauth-client-metadata': {
    client_name: 'Claude',
    client_uri: 'https://claude.ai',
    redirect_uris: [CLAUDE_AI_CALLBACK],
    grant_types: ALLOWED_GRANT_TYPES,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  'https://claude.ai/oauth/claude-code-client-metadata': {
    client_name: 'Claude Code',
    client_uri: 'https://claude.ai',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ALLOWED_GRANT_TYPES,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
};

function pinnedCimdClient(clientId: string): OAuthClientInformationFull | undefined {
  const pinned = KNOWN_CIMD_CLIENTS[clientId];
  if (!pinned) return undefined;
  console.warn(`[oauth] CIMD using pinned metadata for ${clientId}`);
  const client: OAuthClientInformationFull = { ...pinned, client_id: clientId };
  // Short cache so we retry the live document soon rather than in an hour.
  cimdCache.set(clientId, { client, expiresAt: Date.now() + 5 * 60 * 1000 });
  upsertClientRow(toRow(client, 'cimd')).catch((err) => console.error('[oauth] CIMD mirror failed:', err));
  return client;
}

export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith('https://');
}

/** SSRF guard: only fetch metadata from public hostnames. */
function isPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h.startsWith('[') || h.includes(':')) return false; // raw IPv6 (covers ::1, fc00::/7, link-local)
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224) {
      return false;
    }
  }
  return true;
}

/** Cache → live document → pinned fallback for Anthropic's own clients. */
async function fetchCimdClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const cached = cimdCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.client;
  return (await fetchLiveCimdClient(clientId)) ?? pinnedCimdClient(clientId);
}

async function fetchLiveCimdClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hash || url.username || url.password || !isPublicHost(url.hostname)) {
    console.warn(`[oauth] CIMD rejected (unsafe URL): ${clientId}`);
    return undefined;
  }

  let text: string;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CIMD_USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[oauth] CIMD fetch ${clientId} → HTTP ${res.status}`);
      return undefined;
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > CIMD_MAX_BYTES) return undefined;
    text = await res.text();
  } catch (err) {
    console.warn(`[oauth] CIMD fetch failed for ${clientId}: ${(err as Error).message}`);
    return undefined;
  }
  if (text.length > CIMD_MAX_BYTES) return undefined;

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    console.warn(`[oauth] CIMD document is not JSON: ${clientId}`);
    return undefined;
  }
  const parsed = OAuthClientMetadataSchema.safeParse(json);
  if (!parsed.success) {
    console.warn(`[oauth] CIMD document invalid for ${clientId}: ${parsed.error.message}`);
    return undefined;
  }
  // The document must claim the URL it was fetched from as its client_id.
  const docClientId = (json as { client_id?: unknown }).client_id;
  if (docClientId !== clientId) {
    console.warn(`[oauth] CIMD client_id mismatch for ${clientId}`);
    return undefined;
  }
  // We don't author this document, so keep the redirect URIs we accept and
  // drop the rest; the authorize handler still requires an exact match against
  // what's left. Zero survivors = unusable client.
  const redirectUris = parsed.data.redirect_uris.filter(isAllowedRedirect);
  if (redirectUris.length === 0) {
    console.warn(`[oauth] CIMD document has no allowlisted redirect_uris: ${clientId}`);
    return undefined;
  }

  const client: OAuthClientInformationFull = {
    ...parsed.data,
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ALLOWED_GRANT_TYPES,
    response_types: ['code'],
  };
  cimdCache.set(clientId, { client, expiresAt: Date.now() + CIMD_CACHE_TTL_MS });
  upsertClientRow(toRow(client, 'cimd')).catch((err) => console.error('[oauth] CIMD mirror failed:', err));
  return client;
}

// ── Row mapping ───────────────────────────────────────────────────────────────

function toRow(client: OAuthClientInformationFull, source: ClientRow['source']): ClientRow {
  // Never persist a secret (DCR clients here are always public anyway).
  const { client_secret: _secret, client_secret_expires_at: _exp, ...metadata } = client;
  return {
    client_id: client.client_id,
    client_name: client.client_name ?? null,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: client.token_endpoint_auth_method ?? 'none',
    grant_types: client.grant_types ?? ALLOWED_GRANT_TYPES,
    scope: client.scope ?? null,
    source,
    metadata: JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>,
  };
}

function fromRow(row: ClientRow): OAuthClientInformationFull {
  return {
    ...(row.metadata as Partial<OAuthClientInformationFull>),
    client_id: row.client_id,
    client_name: row.client_name ?? undefined,
    redirect_uris: row.redirect_uris,
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    grant_types: row.grant_types,
    response_types: ['code'],
    scope: row.scope ?? undefined,
    client_secret: undefined,
  };
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class ProjectToolsClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (isAdminClientId(clientId)) return adminClient();
    if (isCimdClientId(clientId)) return fetchCimdClient(clientId);
    const row = await getClientRow(clientId);
    return row ? fromRow(row) : undefined;
  }

  /**
   * Dynamic Client Registration (spec §5.4). The SDK handler has already
   * validated the metadata shape and generated a client_id; we enforce the
   * redirect allowlist and force the client to be public. A client that asked
   * for a secret gets back `token_endpoint_auth_method: "none"` and no secret
   * (RFC 7591 lets the server override requested metadata); if it sends a
   * secret anyway the token endpoint ignores it.
   */
  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    const incoming = client as OAuthClientInformationFull; // handler sets client_id when clientIdGeneration is on

    const rejected = incoming.redirect_uris.filter((u) => !isAllowedRedirect(u));
    if (rejected.length > 0) {
      throw new InvalidClientMetadataError(
        `redirect_uris not allowed: ${rejected.join(', ')}. Allowed: ${ALLOWED_REDIRECTS_HELP}`,
      );
    }

    const grantTypes = (incoming.grant_types ?? ALLOWED_GRANT_TYPES).filter((g) => ALLOWED_GRANT_TYPES.includes(g));
    if (!grantTypes.includes('authorization_code')) {
      throw new InvalidClientMetadataError('grant_types must include authorization_code');
    }

    const requestedScopes = parseScopes(incoming.scope).filter(isSupportedScope);
    const now = Math.floor(Date.now() / 1000);

    const stored: OAuthClientInformationFull = {
      ...incoming,
      client_id: incoming.client_id || randomUUID(),
      client_id_issued_at: incoming.client_id_issued_at ?? now,
      client_secret: undefined,
      client_secret_expires_at: undefined,
      token_endpoint_auth_method: 'none',
      grant_types: grantTypes,
      response_types: ['code'],
      scope: requestedScopes.length > 0 ? requestedScopes.join(' ') : undefined,
    };

    await upsertClientRow(toRow(stored, 'dcr'));
    return stored;
  }
}
