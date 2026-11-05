/**
 * Worklist smoke test — calls the admin-only My Day tools (worklistTools.ts)
 * over real HTTP, the way Claude does: plant an OAuth code (as mcp_service),
 * exchange it, then tools/list, get_worklist_state, save_briefing and a payload
 * the tool must reject.
 *
 * Writes go to a fake day (2000-01-01) with source_keys starting "smoke:", and
 * the finally block deletes them (as the user, through RLS) along with every
 * OAuth row the script created. Your real worklist is never touched.
 *
 *   cd mcp-server
 *   SMOKE_USER_ID=<your profile uuid> npx tsx --env-file=.env scripts/worklist-smoke.mts http://localhost:8080
 *
 * SMOKE_USER_ID must be an admin (the tools are admin-only). Exit 0 = all passed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { SignJWT } from 'jose';

const BASE = (process.argv[2] ?? 'http://localhost:8080').replace(/\/+$/, '');
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const SMOKE_DATE = '2000-01-01';

const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const anon = process.env.SUPABASE_ANON_KEY ?? '';
const secret = process.env.SUPABASE_JWT_SECRET ?? '';
const userId = (process.env.SMOKE_USER_ID ?? '').trim();
if (!url || !anon || !secret) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_JWT_SECRET (run with --env-file=.env)');
  process.exit(2);
}
if (!/^[0-9a-f-]{36}$/i.test(userId)) {
  console.error('Set SMOKE_USER_ID to your (admin) profile uuid.');
  process.exit(2);
}

// ── helpers ───────────────────────────────────────────────────────────────────
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');
let failures = 0;
function assert(label: string, cond: boolean, detail?: unknown): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond || detail === undefined ? '' : `\n      ${JSON.stringify(detail).slice(0, 400)}`}`);
  if (!cond) failures++;
}

async function clientAs(role: string, sub: string) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
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
  return { status: res.status, json };
}

/** tools/call → { isError, data } where data is the parsed JSON text payload. */
async function call(token: string, name: string, args: unknown) {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  const result = r.json.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  const text = result?.content?.[0]?.text ?? '';
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* error text */ }
  return { status: r.status, isError: result?.isError === true, data, text };
}

// ── setup ─────────────────────────────────────────────────────────────────────
const service = await clientAs('mcp_service', '00000000-0000-0000-0000-000000000000');
const asUser = await clientAs('authenticated', userId);

const reg = await fetch(`${BASE}/oauth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'worklist-smoke', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
});
const { client_id: clientId } = (await reg.json()) as { client_id: string };
assert('DCR → 201', reg.status === 201 && !!clientId);

try {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const code = `pt_ac_${b64url(randomBytes(32))}`;
  const { error: plantErr } = await service.from('oauth_auth_codes').insert({
    code_hash: sha(code), client_id: clientId, user_id: userId, redirect_uri: REDIRECT,
    code_challenge: challenge, scope: 'mcp:read mcp:write', resource: RESOURCE,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (plantErr) throw new Error(`plantCode: ${plantErr.message}`);
  const tok = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT }).toString(),
  });
  const access = ((await tok.json()) as { access_token: string }).access_token;
  assert('code exchange → access token', tok.status === 200 && !!access);

  await mcp(access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'worklist-smoke', version: '1' } });
  const list = await mcp(access, 'tools/list');
  const tools = ((list.json.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name);
  assert('tools/list includes get_worklist_state + save_briefing', tools.includes('get_worklist_state') && tools.includes('save_briefing'), tools);

  // ── read ───────────────────────────────────────────────────────────────────
  const s1 = await call(access, 'get_worklist_state', {});
  const state1 = s1.data as { today?: string; open_items?: unknown[]; recently_closed?: unknown[]; feedback?: unknown[] };
  assert('get_worklist_state → ok with today/open_items/recently_closed/feedback',
    !s1.isError && /^\d{4}-\d{2}-\d{2}$/.test(state1.today ?? '') && Array.isArray(state1.open_items)
      && Array.isArray(state1.recently_closed) && Array.isArray(state1.feedback), s1.text);

  // ── write ──────────────────────────────────────────────────────────────────
  const save = await call(access, 'save_briefing', {
    briefing: {
      date: SMOKE_DATE,
      since: '1999-12-31T17:00:00-05:00',
      sourceCounts: { mail: 1, teams: 0, monday: 0, manual: 0 },
      schedule: [{ id: 'smoke-e1', start: '09:00', end: '09:30', subject: 'Smoke test meeting' }],
      openBlocks: ['10:00–12:00'],
      readMe: [{ id: 'smoke-r1', source: 'email', text: 'Smoke test read-me line.' }],
    },
    items: [
      { source_key: 'smoke:respond', source: 'email', kind: 'respond', title: 'Smoke test reply', urgency: 2, urgency_reason: 'test', due: SMOKE_DATE, due_basis: 'stated' },
      { source_key: 'smoke:question', source: 'claude', kind: 'question', title: 'Smoke test question?', urgency: 3, options: ['Yes', 'No'] },
    ],
  });
  const saved = save.data as { inserted?: number; briefing_date?: string };
  assert('save_briefing → inserted 2 on the smoke date', !save.isError && saved.inserted === 2 && saved.briefing_date === SMOKE_DATE, save.text);

  const again = await call(access, 'save_briefing', {
    briefing: { date: SMOKE_DATE },
    items: [{ source_key: 'smoke:respond', source: 'email', kind: 'respond', title: 'Smoke test reply (updated)', urgency: 1 }],
    resolved_keys: ['smoke:question'],
  });
  const again2 = again.data as { inserted?: number; updated?: number; resolved?: number };
  assert('re-run same day → updated 1, resolved 1, no duplicates', !again.isError && again2.inserted === 0 && again2.updated === 1 && again2.resolved === 1, again.text);

  const s2 = await call(access, 'get_worklist_state', {});
  const open2 = ((s2.data as { open_items?: { source_key: string; title: string; urgency: number }[] }).open_items ?? []).filter((i) => i.source_key.startsWith('smoke:'));
  assert('open smoke item shows the update', open2.length === 1 && open2[0].title === 'Smoke test reply (updated)' && open2[0].urgency === 1, open2);
  const closed2 = ((s2.data as { recently_closed?: { source_key: string; closed_by: string }[] }).recently_closed ?? []).filter((i) => i.source_key.startsWith('smoke:'));
  assert('resolved question is in recently_closed, closed_by briefing', closed2.length === 1 && closed2[0].closed_by === 'briefing', closed2);

  // ── rejections ─────────────────────────────────────────────────────────────
  const badOpts = await call(access, 'save_briefing', {
    briefing: { date: SMOKE_DATE },
    items: [{ source_key: 'smoke:bad', source: 'email', kind: 'do', title: 'x', urgency: 3, options: ['a'] }],
  });
  assert('options on a non-question → rejected', badOpts.isError && /options/.test(badOpts.text), badOpts.text);
  const badDate = await call(access, 'save_briefing', { briefing: { date: 'tomorrow' }, items: [] });
  assert('bad briefing date → rejected', badDate.isError, badDate.text);
} finally {
  // ── cleanup ────────────────────────────────────────────────────────────────
  const delItems = await asUser.from('worklist_items').delete().eq('user_id', userId).like('source_key', 'smoke:%').select('id');
  const delBrief = await asUser.from('worklist_briefings').delete().eq('user_id', userId).eq('briefing_date', SMOKE_DATE).select('id');
  console.log(`cleanup: removed ${delItems.data?.length ?? 0} smoke items, ${delBrief.data?.length ?? 0} smoke briefing(s)${delItems.error || delBrief.error ? ` — ERROR ${delItems.error?.message ?? delBrief.error?.message}` : ''}`);
  await service.from('oauth_access_tokens').delete().eq('client_id', clientId);
  await service.from('oauth_refresh_tokens').delete().eq('client_id', clientId);
  await service.from('oauth_auth_codes').delete().eq('client_id', clientId);
  await service.from('oauth_clients').delete().eq('client_id', clientId);
  console.log('cleanup: removed smoke-test OAuth client, code and tokens');
}

console.log(failures === 0 ? '\nAll worklist smoke assertions passed.' : `\n${failures} assertion(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
