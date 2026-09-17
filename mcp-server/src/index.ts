/**
 * Instrata Project Tools — MCP server. Read tools plus scoped write tools for
 * the cutsheet submittal workflow (submittalTools.ts).
 *
 * Auth: this process is its own OAuth 2.1 authorization server (src/oauth/).
 * Clients discover it from a 401 on /mcp, register (DCR/CIMD or the admin
 * pre-registered client), send the user through our login + consent page, and
 * exchange the code for opaque bearer tokens. Every /mcp request must carry
 * `Authorization: Bearer <access token>`; we resolve it to a Project Tools
 * user, mint a short-lived user-scoped Supabase JWT, and run the tools as that
 * user so RLS governs everything — including the write tools. Tool visibility
 * follows the token's scopes (mcp:read / mcp:write). No service-role key is
 * used anywhere. See README.md.
 *
 * Transport: stateless Streamable HTTP — a fresh McpServer + transport per
 * request, no sessions.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { config } from './config.js';
import { clientForUser } from './supabase.js';
import { registerTools } from './tools.js';
import { registerSubmittalTools } from './submittalTools.js';
import { assertToolScopesComplete, collectingRegistrar, scopedRegistrar } from './toolHelpers.js';
import { allow, keyFor } from './rateLimit.js';
import { ProjectToolsOAuthProvider } from './oauth/provider.js';
import { consentRouter } from './oauth/consent.js';
import { ISSUER, MCP_RESOURCE_URL, OAUTH_PATHS, PRM_URL, metadataRouter } from './oauth/metadata.js';

const SERVER_INFO = { name: 'instrata-project-tools', version: '2.0.0' };

// ── Startup audit: every tool must have a scope (src/oauth/scopes.ts) ─────────
{
  const names: string[] = [];
  const collector = collectingRegistrar(names);
  const noClient = null as unknown as SupabaseClient; // handlers are never invoked here
  registerTools(collector, noClient, '');
  registerSubmittalTools(collector, noClient, '');
  assertToolScopesComplete(names);
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: status === 401 ? -32001 : status === 429 ? -32002 : -32000, message },
    id: null,
  });
}

const provider = new ProjectToolsOAuthProvider();

const app = express();
// Fly terminates TLS and proxies to us; needed so rate limits key on the real client IP.
app.set('trust proxy', 1);
app.disable('x-powered-by');
// 8mb: attach_cutsheet accepts base64 PDFs up to ~4 MB decoded (~5.6 MB encoded).
// Only parses application/json, so it never touches the form-encoded OAuth endpoints.
app.use(express.json({ limit: '8mb' }));

// Health check (Fly).
app.get('/', (_req, res) => res.json({ ok: true, service: SERVER_INFO.name }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ── OAuth 2.1 authorization server ────────────────────────────────────────────
// Per-IP limits per spec §9 (30 req/min on token + register). Discovery docs
// are static and unlimited.
const perMinute = (limit: number) => ({ windowMs: 60_000, limit });

app.use(metadataRouter());
app.use(OAUTH_PATHS.authorize, authorizationHandler({ provider, rateLimit: perMinute(30) }));
app.use(OAUTH_PATHS.consent, consentRouter(provider));
app.use(
  OAUTH_PATHS.token,
  express.urlencoded({ extended: false }),
  basicClientAuthShim,
  tokenHandler({ provider, rateLimit: perMinute(30) }),
);
app.use(
  OAUTH_PATHS.register,
  clientRegistrationHandler({ clientsStore: provider.clientsStore, clientSecretExpirySeconds: 0, rateLimit: perMinute(30) }),
);
app.use(OAUTH_PATHS.revoke, revocationHandler({ provider, rateLimit: perMinute(30) }));

/**
 * The SDK's client authentication reads client_id / client_secret from the
 * form body (client_secret_post). RFC 6749 §2.3.1 also allows HTTP Basic;
 * decode it into the body so both work. Body fields win if both are present.
 */
function basicClientAuthShim(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header && /^Basic\s+/i.test(header)) {
    try {
      const decoded = Buffer.from(header.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep > 0) {
        const body = (req.body ??= {}) as Record<string, unknown>;
        body.client_id ??= decodeURIComponent(decoded.slice(0, sep));
        body.client_secret ??= decodeURIComponent(decoded.slice(sep + 1));
      }
    } catch {
      /* malformed Basic header → fall through; the SDK will reject as invalid_client */
    }
  }
  next();
}

// ── MCP endpoint ──────────────────────────────────────────────────────────────
// requireBearerAuth answers every unauthenticated / invalid / expired request
// with HTTP 401 + `WWW-Authenticate: Bearer error="invalid_token",
// resource_metadata="<PRM_URL>"`, which is what starts OAuth discovery in
// Claude. On success it sets req.auth, which the transport forwards to tool
// handlers as extra.authInfo.
const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: PRM_URL });

async function handleMcp(req: Request, res: Response): Promise<void> {
  const reqId = randomUUID().slice(0, 8);
  const auth = req.auth;
  if (!auth) return jsonRpcError(res, 401, 'Unauthorized.');
  if (!allow(keyFor(auth.token))) return jsonRpcError(res, 429, 'Rate limit exceeded, slow down.');

  const userId = auth.extra?.userId;
  if (typeof userId !== 'string' || !userId) {
    console.error(`[${reqId}] access token verified but carries no userId`);
    return jsonRpcError(res, 500, 'Internal server error.');
  }

  try {
    const supa = await clientForUser(userId);
    const server = new McpServer(SERVER_INFO);
    const registrar = scopedRegistrar(server, auth.scopes);
    registerTools(registrar, supa, userId);
    registerSubmittalTools(registrar, supa, userId);

    // Stateless mode: no session id generator.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[${reqId}] handler error:`, err);
    if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error.');
  }
}

app.post('/mcp', bearer, handleMcp);

// Stateless server: GET (SSE stream) and DELETE (session teardown) are unused.
// Bearer check first so an unauthenticated probe still gets the 401 + discovery header.
const methodNotAllowed = (_req: Request, res: Response) => jsonRpcError(res, 405, 'Method not allowed.');
app.get('/mcp', bearer, methodNotAllowed);
app.delete('/mcp', bearer, methodNotAllowed);

app.listen(config.port, () => {
  console.log(`[mcp] ${SERVER_INFO.name} v${SERVER_INFO.version} listening on :${config.port}`);
  console.log(`[mcp] issuer ${ISSUER} · resource ${MCP_RESOURCE_URL}`);
  console.log(`[mcp] admin client: ${config.adminClientId ? `${config.adminClientId} (${config.adminClientSecret ? 'confidential' : 'public'})` : 'not configured'}`);
});
