/**
 * OAuth smoke test — exercises the token lifecycle end to end WITHOUT a
 * browser, by planting an authorization code directly (as the mcp_service
 * role) instead of going through the login + consent page. Everything after
 * that point is the real HTTP flow: code exchange, /mcp initialize +
 * tools/list, refresh rotation, replay detection, scope gating, revocation.
 *
 * Needs the JWT secret, so it's a developer/admin tool, not CI. The grant is
 * issued to the user in SMOKE_USER_ID (your own id — Supabase Dashboard →
 * Authentication → Users, or `select id from profiles where email = '…'`).
 * The script only ever calls `initialize`, `tools/list` and one deliberately
 * failing `tools/call` (no data is read), and deletes every row it created.
 *
 *   cd mcp-server
 *   SMOKE_USER_ID=<your profile uuid> npx tsx --env-file=.env scripts/oauth-smoke.mts http://localhost:8080
 *
 * Exit code 0 = all assertions passed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { SignJWT } from 'jose';

const BASE = (process.argv[2] ?? 'http://localhost:8080').replace(/\/+$/, '');
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const anon = process.env.SUPABASE_ANON_KEY ?? '';
const secret = process.env.SUPABASE_JWT_SECRET ?? '';
const userId = (process.env.SMOKE_USER_ID ?? '').trim();
if (!url || !anon || !secret) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_JWT_SECRET (run with --env-file=.env)');
  process.exit(2);
}
if (!/^[0-9a-f-]{36}$/i.test(userId)) {
  console.error('Set SMOKE_USER_ID to the profile uuid the test grant should be issued to (use your own).');
  process.exit(2);
}

// ── helpers ───────────────────────────────────────────────────────────────────
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');
let failures = 0;
function assert(label: string, cond: boolean, detail?: unknown): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond || detail === undefined ? '' : `\n      ${JSON.stringify(detail).slice(0, 300)}`}`);
  if (!cond) failures++;
}

async function serviceClient() {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ role: 'mcp_service' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject('00000000-0000-0000-0000-000000000000')
    .setAudience('authenticated')
    .setIssuer(`${url}/auth/v1`)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(secret));
  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

async function form(path: string, fields: Record<string, string>, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** Streamable HTTP POST; answers may be JSON or a single SSE event. */
async function mcp(token: string, method: string, params: unknown = {}, id = 1) {
  const res = await fetch(RESOURCE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(dataLine ? dataLine.slice(5).trim() : text); } catch { /* not json */ }
  return { status: res.status, json, wwwAuth: res.headers.get('www-authenticate') ?? '' };
}

const INIT_PARAMS = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oauth-smoke', version: '1' } };

// ── setup ─────────────────────────────────────────────────────────────────────
const supa = await serviceClient();

const reg = await fetch(`${BASE}/oauth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'oauth-smoke', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
});
const client = (await reg.json()) as { client_id: string; client_secret?: string };
assert('DCR → 201 public client', reg.status === 201 && !!client.client_id && client.client_secret === undefined, client);
const clientId = client.client_id;

async function plantCode(scope: string): Promise<{ code: string; verifier: string }> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const code = `pt_ac_${b64url(randomBytes(32))}`;
  const { error } = await supa.from('oauth_auth_codes').insert({
    code_hash: sha(code), client_id: clientId, user_id: userId, redirect_uri: REDIRECT,
    code_challenge: challenge, scope, resource: RESOURCE,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) throw new Error(`plantCode: ${error.message}`);
  return { code, verifier };
}

try {
  // ── B3/B4: full-scope grant ─────────────────────────────────────────────────
  const full = await plantCode('mcp:read mcp:write offline_access');
  const bad = await form('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: full.code, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-1', redirect_uri: REDIRECT });
  assert('wrong code_verifier → invalid_grant (code NOT burned)', bad.status === 400 && bad.json.error === 'invalid_grant', bad.json);

  const t1 = await form('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: full.code, code_verifier: full.verifier, redirect_uri: REDIRECT });
  assert('code exchange → 200', t1.status === 200, t1.json);
  assert('  token_type Bearer, expires_in 3600', t1.json.token_type === 'Bearer' && t1.json.expires_in === 3600, t1.json);
  assert('  refresh_token issued (offline_access)', typeof t1.json.refresh_token === 'string', Object.keys(t1.json));
  assert('  scope echoed', t1.json.scope === 'mcp:read mcp:write offline_access', t1.json.scope);
  assert('  Cache-Control: no-store', t1.headers.get('cache-control') === 'no-store');
  const access1 = t1.json.access_token as string;
  const refresh1 = t1.json.refresh_token as string;

  const replay = await form('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: full.code, code_verifier: full.verifier, redirect_uri: REDIRECT });
  assert('B6 replayed code → invalid_grant', replay.status === 400 && replay.json.error === 'invalid_grant', replay.json);

  const init = await mcp(access1, 'initialize', INIT_PARAMS);
  const initResult = init.json.result as { serverInfo?: { name?: string } } | undefined;
  assert('B4 initialize → 200 with serverInfo', init.status === 200 && initResult?.serverInfo?.name === 'instrata-project-tools', init.json);

  const list = await mcp(access1, 'tools/list');
  const tools = ((list.json.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name).sort();
  const WRITE = ['attach_cutsheet', 'create_submittal', 'detach_cutsheet', 'populate_submittal_from_bom', 'update_submittal'];
  assert(`B4 tools/list → ${tools.length} tools incl. all 5 write tools`, list.status === 200 && tools.length === 18 && WRITE.every((w) => tools.includes(w)), tools);

  // ── B5: refresh rotation + reuse detection ─────────────────────────────────
  const t2 = await form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh1 });
  assert('B5 refresh → 200 with a NEW pair', t2.status === 200 && t2.json.refresh_token !== refresh1 && t2.json.access_token !== access1, t2.json);
  const access2 = t2.json.access_token as string;
  const refresh2 = t2.json.refresh_token as string;
  const ok2 = await mcp(access2, 'initialize', INIT_PARAMS);
  assert('  new access token works on /mcp', ok2.status === 200);

  const narrowed = await form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh2, scope: 'mcp:read offline_access' });
  assert('  refresh with narrowed scope → 200, scope narrowed', narrowed.status === 200 && narrowed.json.scope === 'mcp:read offline_access', narrowed.json);
  const refresh3 = narrowed.json.refresh_token as string;
  const access3 = narrowed.json.access_token as string;
  const listNarrow = await mcp(access3, 'tools/list');
  const narrowTools = ((listNarrow.json.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name);
  assert('  narrowed token hides write tools', narrowTools.length === 13 && !WRITE.some((w) => narrowTools.includes(w)), narrowTools);

  const widen = await form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh3, scope: 'mcp:read mcp:write offline_access' });
  assert('  refresh asking for MORE scope → invalid_scope', widen.status === 400 && widen.json.error === 'invalid_scope', widen.json);

  const reuse = await form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh1 });
  assert('B5 old (rotated) refresh token → invalid_grant', reuse.status === 400 && reuse.json.error === 'invalid_grant', reuse.json);
  const dead = await mcp(access3, 'initialize', INIT_PARAMS);
  assert('  reuse revoked the whole family: latest access token now 401 invalid_token', dead.status === 401 && /invalid_token/.test(dead.wwwAuth), { status: dead.status, wwwAuth: dead.wwwAuth });
  const deadRefresh = await form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh3 });
  assert('  latest refresh token also dead → invalid_grant', deadRefresh.status === 400 && deadRefresh.json.error === 'invalid_grant', deadRefresh.json);

  // ── read-only grant, no offline_access ─────────────────────────────────────
  const ro = await plantCode('mcp:read');
  const t4 = await form('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code: ro.code, code_verifier: ro.verifier, redirect_uri: REDIRECT });
  assert('read-only grant → 200, NO refresh_token without offline_access', t4.status === 200 && t4.json.refresh_token === undefined, Object.keys(t4.json));
  const access4 = t4.json.access_token as string;
  const list4 = await mcp(access4, 'tools/list');
  const roTools = ((list4.json.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name);
  assert('  read-only tools/list → 13 tools, no write tools', roTools.length === 13 && !WRITE.some((w) => roTools.includes(w)), roTools);
  const call = await mcp(access4, 'tools/call', { name: 'create_submittal', arguments: { project_id: '00000000-0000-0000-0000-000000000000', submitted_to: 'x' } });
  // The SDK reports a disabled tool as an isError tool result ("MCP error -32602:
  // Tool X disabled"), which is what MCP clients surface best. Either shape is
  // a rejection at the JSON-RPC layer — never an HTTP 401.
  const callResult = call.json.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  const rejected =
    typeof call.json.error === 'object' ||
    (callResult?.isError === true && /disabled|scope/i.test(callResult.content?.[0]?.text ?? ''));
  assert('  calling a write tool with read-only token → rejected at JSON-RPC layer, HTTP 200', call.status === 200 && rejected, call.json);

  // ── revoke ─────────────────────────────────────────────────────────────────
  const rev = await form('/oauth/revoke', { client_id: clientId, token: access4, token_type_hint: 'access_token' });
  assert('revoke access token → 200', rev.status === 200, rev.text);
  const afterRevoke = await mcp(access4, 'initialize', INIT_PARAMS);
  assert('  revoked token → 401', afterRevoke.status === 401);

  // ── wrong client on exchange ───────────────────────────────────────────────
  const other = await plantCode('mcp:read');
  const reg2 = await fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'oauth-smoke-2', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) });
  const client2 = (await reg2.json()) as { client_id: string };
  const cross = await form('/oauth/token', { grant_type: 'authorization_code', client_id: client2.client_id, code: other.code, code_verifier: other.verifier, redirect_uri: REDIRECT });
  assert('code exchanged by a different client → invalid_grant', cross.status === 400 && cross.json.error === 'invalid_grant', cross.json);
  await supa.from('oauth_clients').delete().eq('client_id', client2.client_id);
} finally {
  // ── cleanup: everything keyed to our throwaway client ──────────────────────
  await supa.from('oauth_access_tokens').delete().eq('client_id', clientId);
  await supa.from('oauth_refresh_tokens').delete().eq('client_id', clientId);
  await supa.from('oauth_auth_codes').delete().eq('client_id', clientId);
  await supa.from('oauth_clients').delete().eq('client_id', clientId);
  console.log('cleanup: removed smoke-test client, codes and tokens');
}

console.log(failures === 0 ? '\nAll smoke assertions passed.' : `\n${failures} assertion(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
