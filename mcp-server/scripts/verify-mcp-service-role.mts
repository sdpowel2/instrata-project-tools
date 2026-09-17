/**
 * Verify that PostgREST honours the `mcp_service` role created by
 * supabase/migrations/add_oauth_server.sql — the assumption the OAuth server
 * design depends on (implementation plan §6.2).
 *
 * Mints a JWT with the legacy HS256 secret carrying { role: "mcp_service" } and
 * probes PostgREST. Also checks that the same request as `authenticated` and as
 * `anon` is refused, so the privilege boundary is real and not just untested.
 *
 *   cd mcp-server
 *   npx tsx --env-file=.env scripts/verify-mcp-service-role.mts
 *
 * Prints status codes and response bodies only — never the secret or the JWT.
 */
import { SignJWT } from 'jose';

const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const anon = process.env.SUPABASE_ANON_KEY ?? '';
const secret = process.env.SUPABASE_JWT_SECRET ?? '';
if (!url || !anon || !secret) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_JWT_SECRET (run with --env-file=.env)');
  process.exit(2);
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const key = new TextEncoder().encode(secret);

async function mint(role: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(NIL_UUID)
    .setAudience('authenticated')
    .setIssuer(`${url}/auth/v1`)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(key);
}

type Probe = { label: string; role: string | null; path: string; method?: string; body?: unknown; expect: number[] };

const probes: Probe[] = [
  { label: 'mcp_service  → select oauth_clients',        role: 'mcp_service',   path: '/rest/v1/oauth_clients?select=client_id&limit=1', expect: [200] },
  { label: 'mcp_service  → select oauth_auth_codes',     role: 'mcp_service',   path: '/rest/v1/oauth_auth_codes?select=code_hash&limit=1', expect: [200] },
  { label: 'mcp_service  → rpc oauth_consume_auth_code', role: 'mcp_service',   path: '/rest/v1/rpc/oauth_consume_auth_code', method: 'POST', body: { p_code_hash: 'probe-no-such-code' }, expect: [200] },
  { label: 'mcp_service  → rpc oauth_cleanup',           role: 'mcp_service',   path: '/rest/v1/rpc/oauth_cleanup', method: 'POST', body: {}, expect: [200] },
  { label: 'authenticated → select oauth_auth_codes',    role: 'authenticated', path: '/rest/v1/oauth_auth_codes?select=code_hash&limit=1', expect: [401, 403] },
  { label: 'authenticated → rpc oauth_consume_auth_code',role: 'authenticated', path: '/rest/v1/rpc/oauth_consume_auth_code', method: 'POST', body: { p_code_hash: 'x' }, expect: [401, 403, 404] },
  { label: 'anon          → select oauth_clients',       role: null,            path: '/rest/v1/oauth_clients?select=client_id&limit=1', expect: [401, 403] },
];

let failures = 0;
for (const p of probes) {
  const headers: Record<string, string> = { apikey: anon, 'Content-Type': 'application/json' };
  headers.Authorization = `Bearer ${p.role ? await mint(p.role) : anon}`;
  const res = await fetch(url + p.path, { method: p.method ?? 'GET', headers, body: p.body ? JSON.stringify(p.body) : undefined });
  const text = (await res.text()).slice(0, 200);
  const ok = p.expect.includes(res.status);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${p.label.padEnd(44)} HTTP ${res.status}  ${text}`);
}

console.log(failures === 0 ? '\nAll probes passed: PostgREST honours mcp_service and refuses anon/authenticated.' : `\n${failures} probe(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
