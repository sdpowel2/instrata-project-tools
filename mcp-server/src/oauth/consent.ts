/**
 * Login + consent page (spec §5.5 steps 3–6).
 *
 * The MCP server is a different origin from the SPA and shares no session
 * with it, so "show the existing Project Tools login" means: this server
 * renders one page that collects the user's Project Tools email + password
 * and their Allow/Deny decision, verifies the credentials against Supabase
 * Auth (the same identity store the app uses), and issues the authorization
 * code. Stateless — every authorization params ride along as hidden fields
 * and are re-validated on POST exactly as the GET validated them. No cookies,
 * so there is no session to CSRF.
 *
 * GET  /oauth/authorize  → SDK validates → provider.authorize() → renderConsentPage()
 * POST /oauth/consent    → consentRouter() below
 */
import express, { type Request, type Response, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from '../config.js';
import { ISSUER, MCP_RESOURCE_URL, OAUTH_PATHS } from './metadata.js';
import { SCOPE_LABELS, isSupportedScope, resolveRequestedScopes, unsupportedScopes } from './scopes.js';
import { insertAuthCode } from './store.js';
import { randomToken, sha256Hex } from './tokens.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// ── Rendering ─────────────────────────────────────────────────────────────────

export interface ConsentContext {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  scopes: string[];
  error?: string;
  email?: string;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hidden(name: string, value: string | undefined): string {
  return value === undefined || value === '' ? '' : `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

function setPageHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
}

export function renderConsentPage(res: Response, ctx: ConsentContext, status = 200): void {
  const { client, params, scopes } = ctx;
  const redirectHost = new URL(params.redirectUri).host;
  const loopback = LOOPBACK_HOSTS.has(new URL(params.redirectUri).hostname);
  const clientName = client.client_name?.trim() || 'An MCP client';

  const scopeItems = scopes
    .filter(isSupportedScope)
    .map((s) => `<li>${esc(SCOPE_LABELS[s])}</li>`)
    .join('');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect to Instrata Project Tools</title>
<style>
  :root { --navy:#1B3A5C; --orange:#E8872B; --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --bg:#f3f4f6; --danger:#b91c1c; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:var(--navy); font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color:var(--ink); display:flex; align-items:center; justify-content:center; padding:24px 16px; }
  .card { background:#fff; width:100%; max-width:440px; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.25); overflow:hidden; }
  .brand { padding:22px 28px 14px; border-bottom:4px solid var(--orange); }
  .brand .name { font-size:20px; font-weight:700; color:var(--navy); letter-spacing:.01em; }
  .brand .sub { font-size:10px; font-weight:700; letter-spacing:.15em; text-transform:uppercase; color:var(--orange); margin-top:2px; }
  .body { padding:22px 28px 26px; }
  h1 { font-size:18px; margin:0 0 6px; }
  p { margin:0 0 12px; line-height:1.45; }
  .muted { color:var(--muted); font-size:13px; }
  ul { margin:8px 0 16px; padding-left:20px; line-height:1.5; font-size:14px; }
  .notice { font-size:13px; background:var(--bg); border-radius:8px; padding:10px 12px; margin-bottom:16px; }
  .warn { background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; }
  .error { color:var(--danger); font-size:14px; margin-bottom:12px; }
  label { display:block; font-size:13px; font-weight:600; margin:12px 0 4px; }
  input[type=email], input[type=password] { width:100%; font-size:15px; padding:10px 12px; border:1px solid var(--line); border-radius:8px; }
  input:focus { outline:2px solid var(--orange); outline-offset:1px; border-color:transparent; }
  .actions { display:flex; gap:10px; margin-top:20px; }
  button { flex:1; font-size:15px; font-weight:600; padding:11px 14px; border-radius:8px; cursor:pointer; border:1px solid transparent; }
  .allow { background:var(--orange); color:#fff; }
  .deny { background:#fff; color:var(--ink); border-color:var(--line); }
  .foot { font-size:12px; color:var(--muted); margin-top:16px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand"><div class="name">Instrata</div><div class="sub">Project Tools</div></div>
    <div class="body">
      <h1>Connect ${esc(clientName)}</h1>
      <p class="muted">${esc(clientName)} is asking to access your Project Tools account. It will be able to:</p>
      <ul>${scopeItems}</ul>
      <div class="notice${loopback ? ' warn' : ''}">
        After you approve, you'll be sent back to <strong>${esc(redirectHost)}</strong>.
        ${loopback ? ' This is an address on <em>this computer</em> — expected for Claude Code and other desktop tools. If you did not start this from an app on your own machine, choose Deny.' : ''}
      </div>
      ${ctx.error ? `<div class="error" role="alert">${esc(ctx.error)}</div>` : ''}
      <form method="post" action="${esc(OAUTH_PATHS.consent)}" autocomplete="on">
        ${hidden('client_id', client.client_id)}
        ${hidden('redirect_uri', params.redirectUri)}
        ${hidden('scope', scopes.join(' '))}
        ${hidden('state', params.state)}
        ${hidden('code_challenge', params.codeChallenge)}
        ${hidden('code_challenge_method', 'S256')}
        ${hidden('resource', params.resource?.href)}
        <label for="email">Project Tools email</label>
        <input id="email" name="email" type="email" required autocomplete="username" value="${esc(ctx.email)}" autofocus>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password">
        <div class="actions">
          <button type="submit" name="decision" value="deny" class="deny" formnovalidate>Deny</button>
          <button type="submit" name="decision" value="allow" class="allow">Sign in &amp; allow</button>
        </div>
      </form>
      <p class="foot">Signing in here uses your regular Project Tools login. You can disconnect at any time from Settings → Connected apps in Project Tools.</p>
    </div>
  </main>
</body>
</html>`;

  setPageHeaders(res);
  res.status(status).type('html').send(html);
}

// ── POST /oauth/consent ───────────────────────────────────────────────────────

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const ConsentBodySchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  scope: z.preprocess(emptyToUndefined, z.string().optional()),
  state: z.preprocess(emptyToUndefined, z.string().optional()),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  resource: z.preprocess(emptyToUndefined, z.string().url().optional()),
  decision: z.enum(['allow', 'deny']),
  email: z.preprocess(emptyToUndefined, z.string().email().optional()),
  password: z.preprocess(emptyToUndefined, z.string().optional()),
});

function badRequest(res: Response, error: string, description: string): void {
  setPageHeaders(res);
  res.status(400).json({ error, error_description: description });
}

/**
 * Verify Project Tools credentials against Supabase Auth. Returns the user id,
 * or null on any failure. The session Supabase creates for this check is
 * signed out immediately so no stray refresh token lingers in auth.sessions.
 */
async function authenticateUser(email: string, password: string): Promise<string | null> {
  const supa = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await supa.auth.signInWithPassword({ email, password });
  if (error || !data.user) return null;
  supa.auth.signOut().catch(() => undefined); // best effort, fire and forget
  return data.user.id;
}

export function consentRouter(provider: OAuthServerProvider): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many sign-in attempts from this address. Wait a minute and try again.',
    }),
  );

  router.post('/', async (req: Request, res: Response) => {
    const parsed = ConsentBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, 'invalid_request', 'Malformed consent submission');
    const body = parsed.data;

    // Phase 1 — anything wrong with the client or redirect_uri is a direct
    // 400; we must never redirect to an unverified URI.
    let client: OAuthClientInformationFull | undefined;
    try {
      client = await provider.clientsStore.getClient(body.client_id);
    } catch (err) {
      console.error('[oauth] consent getClient failed:', err);
    }
    if (!client) return badRequest(res, 'invalid_client', 'Unknown client_id');
    if (!client.redirect_uris.some((registered) => redirectUriMatches(body.redirect_uri, registered))) {
      return badRequest(res, 'invalid_request', 'Unregistered redirect_uri');
    }

    // Phase 2 — the redirect URI is trusted; remaining errors go back to the client.
    const redirectWith = (qs: Record<string, string>): void => {
      const target = new URL(body.redirect_uri);
      for (const [k, v] of Object.entries(qs)) target.searchParams.set(k, v);
      if (body.state) target.searchParams.set('state', body.state);
      target.searchParams.set('iss', ISSUER); // RFC 9207 issuer identification
      setPageHeaders(res);
      res.redirect(302, target.href);
    };

    const scopes = resolveRequestedScopes(body.scope);
    const bad = unsupportedScopes(scopes);
    if (bad.length > 0) return redirectWith({ error: 'invalid_scope', error_description: `Unsupported scope(s): ${bad.join(' ')}` });

    if (body.decision === 'deny') {
      return redirectWith({ error: 'access_denied', error_description: 'The user denied the request' });
    }

    const params: AuthorizationParams = {
      state: body.state,
      scopes,
      codeChallenge: body.code_challenge,
      redirectUri: body.redirect_uri,
      resource: body.resource ? new URL(body.resource) : undefined,
    };
    const rerender = (error: string, status: number) =>
      renderConsentPage(res, { client: client!, params, scopes, error, email: body.email }, status);

    if (!body.email || !body.password) return rerender('Enter your Project Tools email and password to continue.', 400);

    let userId: string | null;
    try {
      userId = await authenticateUser(body.email, body.password);
    } catch (err) {
      console.error('[oauth] consent sign-in error:', err);
      return rerender('Sign-in is temporarily unavailable. Try again in a moment.', 503);
    }
    if (!userId) return rerender('Incorrect email or password.', 401);

    const code = randomToken('pt_ac');
    try {
      await insertAuthCode({
        code_hash: sha256Hex(code),
        client_id: client.client_id,
        user_id: userId,
        redirect_uri: body.redirect_uri,
        code_challenge: body.code_challenge,
        scope: scopes.join(' '),
        resource: body.resource ?? MCP_RESOURCE_URL,
        expires_at: new Date(Date.now() + config.authCodeTtlSeconds * 1000).toISOString(),
      });
    } catch (err) {
      console.error('[oauth] consent insertAuthCode failed:', err);
      return redirectWith({ error: 'server_error', error_description: 'Could not issue an authorization code' });
    }

    return redirectWith({ code });
  });

  return router;
}
