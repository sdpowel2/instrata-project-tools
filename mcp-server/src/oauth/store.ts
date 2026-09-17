/**
 * All reads/writes of OAuth state, via the `mcp_service` PostgREST role
 * (see supabase/migrations/add_oauth_server.sql). Nothing here sees plaintext
 * tokens — callers pass SHA-256 hashes.
 *
 * Errors are thrown as plain Errors: the SDK handlers map anything that isn't
 * an OAuthError to a 500 `server_error`, which is the right answer for a
 * database failure.
 */
import { serviceClient } from '../supabase.js';

export type ClientSource = 'dcr' | 'cimd';

export interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  scope: string | null;
  source: ClientSource;
  metadata: Record<string, unknown>;
  created_at?: string;
  last_used_at?: string | null;
}

export interface AuthCodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string | null;
  expires_at: string;
  used_at: string | null;
}

export interface AccessTokenRow {
  token_hash: string;
  client_id: string;
  user_id: string;
  scope: string;
  resource: string | null;
  family_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  last_used_at?: string | null;
}

export interface RefreshTokenRow {
  token_hash: string;
  client_id: string;
  user_id: string;
  scope: string;
  resource: string | null;
  family_id: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by: string | null;
}

/** What oauth_rotate_refresh_token hands back on success. */
export interface RefreshGrant {
  user_id: string;
  client_id: string;
  scope: string;
  resource: string | null;
  family_id: string;
}

type Result<T> = { data: T; error: { message: string; code?: string } | null };

function unwrap<T>(res: Result<T>, what: string): T {
  if (res.error) throw new Error(`[oauth-store] ${what}: ${res.error.message}`);
  return res.data;
}

function logAsync(what: string, p: PromiseLike<Result<unknown>>): void {
  Promise.resolve(p)
    .then((r) => {
      if (r.error) console.error(`[oauth-store] ${what}: ${r.error.message}`);
    })
    .catch((err) => console.error(`[oauth-store] ${what}:`, err));
}

// ── Clients ───────────────────────────────────────────────────────────────────

export async function getClientRow(clientId: string): Promise<ClientRow | null> {
  const supa = await serviceClient();
  const res = await supa.from('oauth_clients').select('*').eq('client_id', clientId).maybeSingle();
  return unwrap(res, 'getClientRow') as ClientRow | null;
}

export async function upsertClientRow(row: ClientRow): Promise<void> {
  const supa = await serviceClient();
  unwrap(await supa.from('oauth_clients').upsert(row, { onConflict: 'client_id' }), 'upsertClientRow');
}

export function touchClient(clientId: string): void {
  void serviceClient().then((supa) =>
    logAsync(
      'touchClient',
      supa.from('oauth_clients').update({ last_used_at: new Date().toISOString() }).eq('client_id', clientId),
    ),
  );
}

// ── Authorization codes ───────────────────────────────────────────────────────

export async function insertAuthCode(row: Omit<AuthCodeRow, 'used_at'>): Promise<void> {
  const supa = await serviceClient();
  unwrap(await supa.from('oauth_auth_codes').insert(row), 'insertAuthCode');
}

/** Read a still-live code without consuming it (used for the PKCE challenge lookup). */
export async function peekAuthCode(codeHash: string): Promise<AuthCodeRow | null> {
  const supa = await serviceClient();
  const res = await supa
    .from('oauth_auth_codes')
    .select('*')
    .eq('code_hash', codeHash)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  return unwrap(res, 'peekAuthCode') as AuthCodeRow | null;
}

/** Atomically burn a code. Null when it was unknown, expired, or already used. */
export async function consumeAuthCode(codeHash: string): Promise<AuthCodeRow | null> {
  const supa = await serviceClient();
  const rows = unwrap(await supa.rpc('oauth_consume_auth_code', { p_code_hash: codeHash }), 'consumeAuthCode') as
    | AuthCodeRow[]
    | null;
  return rows?.[0] ?? null;
}

// ── Access tokens ─────────────────────────────────────────────────────────────

export async function insertAccessToken(row: Omit<AccessTokenRow, 'revoked_at' | 'last_used_at'>): Promise<void> {
  const supa = await serviceClient();
  unwrap(await supa.from('oauth_access_tokens').insert(row), 'insertAccessToken');
}

export async function getAccessToken(tokenHash: string): Promise<AccessTokenRow | null> {
  const supa = await serviceClient();
  const res = await supa.from('oauth_access_tokens').select('*').eq('token_hash', tokenHash).maybeSingle();
  return unwrap(res, 'getAccessToken') as AccessTokenRow | null;
}

export function touchAccessToken(tokenHash: string): void {
  void serviceClient().then((supa) =>
    logAsync(
      'touchAccessToken',
      supa.from('oauth_access_tokens').update({ last_used_at: new Date().toISOString() }).eq('token_hash', tokenHash),
    ),
  );
}

export async function revokeAccessToken(tokenHash: string, clientId: string): Promise<void> {
  const supa = await serviceClient();
  unwrap(
    await supa
      .from('oauth_access_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('token_hash', tokenHash)
      .eq('client_id', clientId)
      .is('revoked_at', null),
    'revokeAccessToken',
  );
}

// ── Refresh tokens ────────────────────────────────────────────────────────────

export async function insertRefreshToken(row: Omit<RefreshTokenRow, 'revoked_at' | 'replaced_by'>): Promise<void> {
  const supa = await serviceClient();
  unwrap(await supa.from('oauth_refresh_tokens').insert(row), 'insertRefreshToken');
}

export async function getRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
  const supa = await serviceClient();
  const res = await supa.from('oauth_refresh_tokens').select('*').eq('token_hash', tokenHash).maybeSingle();
  return unwrap(res, 'getRefreshToken') as RefreshTokenRow | null;
}

export interface RotateArgs {
  oldHash: string;
  newRefreshHash: string;
  newAccessHash: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  scope?: string;
}

/**
 * One transaction in Postgres: validate, mark spent, insert replacements.
 * Null means invalid_grant (unknown / expired / revoked / replayed — a replay
 * has already revoked the whole family by the time this returns).
 */
export async function rotateRefreshToken(args: RotateArgs): Promise<RefreshGrant | null> {
  const supa = await serviceClient();
  const rows = unwrap(
    await supa.rpc('oauth_rotate_refresh_token', {
      p_old_hash: args.oldHash,
      p_new_refresh_hash: args.newRefreshHash,
      p_new_access_hash: args.newAccessHash,
      p_access_expires_at: args.accessExpiresAt.toISOString(),
      p_refresh_expires_at: args.refreshExpiresAt.toISOString(),
      p_scope: args.scope ?? null,
    }),
    'rotateRefreshToken',
  ) as RefreshGrant[] | null;
  return rows?.[0] ?? null;
}

export async function revokeFamily(familyId: string): Promise<void> {
  const supa = await serviceClient();
  unwrap(await supa.rpc('oauth_revoke_family', { p_family_id: familyId }), 'revokeFamily');
}
