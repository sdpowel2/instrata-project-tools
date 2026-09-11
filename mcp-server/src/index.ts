/**
 * Instrata Project Tools — MCP server. Read-only, except for scoped write
 * tools covering the cutsheet submittal workflow (see submittalTools.ts).
 *
 * Stateless Streamable HTTP transport. Each request must carry a personal
 * access token (generated from the app's Settings → "Connect Claude" card) as
 * `Authorization: Bearer <token>`. We resolve it to a user, mint a short-lived
 * user-scoped Supabase JWT, and expose tools that query as that user so RLS
 * governs everything — including the write tools, which only succeed on
 * projects the user is a member of. No service-role key is used. See README.md.
 */
import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { resolveToken } from './auth.js';
import { clientForUser } from './supabase.js';
import { registerTools } from './tools.js';
import { registerSubmittalTools } from './submittalTools.js';
import { allow, keyFor } from './rateLimit.js';

const SERVER_INFO = { name: 'instrata-project-tools', version: '1.0.0' };

function bearer(req: Request): string | undefined {
  const h = req.header('authorization') ?? req.header('Authorization');
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : undefined;
}

/**
 * Fallback: token as a `?key=` query param, for clients that can't send custom
 * headers — claude.ai org custom connectors currently only offer OAuth or
 * no-auth (static request headers are a gated beta). A "no auth" connector
 * pointed at `/mcp?key=instrata_mcp_...` works today. Trade-off: the token is
 * visible in the connector's URL field (org admins + assigned users) and in
 * any URL-level logging, so treat it as a pilot workaround — rotate the token
 * from Settings → Connect Claude if it leaks, and prefer the Authorization
 * header wherever headers are supported.
 */
function queryKey(req: Request): string | undefined {
  const k = req.query.key;
  return typeof k === 'string' && k.trim() !== '' ? k.trim() : undefined;
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: status === 401 ? -32001 : status === 429 ? -32002 : -32000, message },
    id: null,
  });
}

const app = express();
// 8mb: attach_cutsheet accepts base64 PDFs up to ~4 MB decoded (~5.6 MB encoded).
app.use(express.json({ limit: '8mb' }));

// Health check (Fly).
app.get('/', (_req, res) => res.json({ ok: true, service: SERVER_INFO.name }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// MCP endpoint — stateless: a fresh server + transport per request.
app.post('/mcp', async (req: Request, res: Response) => {
  const reqId = randomUUID().slice(0, 8);
  const token = bearer(req) ?? queryKey(req);

  if (!token) return jsonRpcError(res, 401, 'Missing bearer token. Generate one in the app under Settings → Connect Claude.');
  if (!allow(keyFor(token))) return jsonRpcError(res, 429, 'Rate limit exceeded, slow down.');

  const userId = await resolveToken(token);
  if (!userId) return jsonRpcError(res, 401, 'Invalid or revoked token.');

  try {
    const supa = await clientForUser(userId);
    const server = new McpServer(SERVER_INFO);
    registerTools(server, supa, userId);
    registerSubmittalTools(server, supa, userId);

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
});

// Stateless server: GET (SSE stream) and DELETE (session teardown) are unused.
const methodNotAllowed = (_req: Request, res: Response) =>
  jsonRpcError(res, 405, 'Method not allowed.');
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

app.listen(config.port, () => {
  console.log(`[mcp] ${SERVER_INFO.name} listening on :${config.port}`);
});
