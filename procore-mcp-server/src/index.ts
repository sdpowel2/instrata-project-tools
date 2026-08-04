/**
 * Instrata Procore MCP server — read-only, per-user.
 *
 * Streamable HTTP transport with explicit session management. Claude authorizes
 * via this server's OAuth 2.1 endpoints (DCR + PKCE), which chain into a per-user
 * Procore login. Every MCP session is bound to exactly one user; every tool call
 * runs with that user's own Procore token. No service account. See README.md.
 */
import 'dotenv/config'; // load .env locally before config is evaluated (no-op when env is already set, e.g. on Fly)
import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { config } from './config.js';
import { getPool, initDb, closeDb } from './store/db.js';
import { PgTokenStore } from './store/pgTokenStore.js';
import { PgClientStore } from './auth/clientStore.js';
import { PgRefreshTokenStore } from './auth/refreshStore.js';
import { ProcoreOAuth } from './auth/procoreOAuth.js';
import { ProcoreSession, getUserId } from './auth/procoreSession.js';
import { InstrataOAuthProvider } from './auth/provider.js';
import { ProcoreClient } from './procore/client.js';
import { CompanyDirectory } from './procore/directory.js';
import { registerTools } from './tools/register.js';
import type { AppContext } from './context.js';

const SERVER_INFO = { name: 'instrata-procore-mcp', version: '0.1.0' };

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: status === 401 ? -32001 : status === 429 ? -32002 : -32000, message },
    id: null,
  });
}

async function main(): Promise<void> {
  await initDb();
  const pool = getPool();

  const procoreTokens = new PgTokenStore(pool, config.tokenEncryptionKey);
  const clients = new PgClientStore(pool);
  const refreshTokens = new PgRefreshTokenStore(pool);
  const procore = new ProcoreOAuth();
  const session = new ProcoreSession(procoreTokens, procore);
  const provider = new InstrataOAuthProvider({ clients, refreshTokens, procoreTokens, procore });

  const app = express();
  app.disable('x-powered-by');

  // OAuth 2.1 authorization-server endpoints (DCR, authorize, token, revoke,
  // metadata) mounted at the app root, per the SDK's requirement.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.baseUrl),
      scopesSupported: ['procore'],
      resourceName: 'Instrata Procore',
      resourceServerUrl: new URL(`${config.baseUrl}/mcp`),
    }),
  );

  // Procore redirects here after the user consents.
  app.get('/procore/callback', (req, res) => {
    void provider.handleProcoreCallback(req, res);
  });

  // Health checks (no auth).
  app.get('/', (_req, res) => res.json({ ok: true, service: SERVER_INFO.name }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Protect the MCP endpoint; 401s carry WWW-Authenticate → resource metadata.
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(`${config.baseUrl}/mcp`));
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

  // Stateful sessions: one transport + McpServer per initialized session, each
  // pinned to the user who opened it.
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sessionUser = new Map<string, string>();

  // CORS for browser-based MCP clients (e.g. the Inspector). Server-to-server
  // clients (claude.ai) ignore these; harmless in production.
  const mcpCors = (req: Request, res: Response, next: () => void) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id');
    res.header('Access-Control-Expose-Headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };

  // Log every MCP request + its final status so connection issues are visible.
  const mcpLog = (req: Request, res: Response, next: () => void) => {
    const sid = req.header('mcp-session-id') ? 'yes' : 'no';
    const auth = req.header('authorization') ? 'yes' : 'no';
    res.on('finish', () => console.log(`[mcp] ${req.method} sid=${sid} auth=${auth} -> ${res.statusCode}`));
    next();
  };

  app.options('/mcp', mcpCors);
  app.post('/mcp', mcpCors, mcpLog, bearer, express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
   try {
    const userId = getUserId(req);
    const sid = req.header('mcp-session-id');
    let transport = sid ? transports.get(sid) : undefined;

    if (transport) {
      if (sessionUser.get(sid!) !== userId) {
        return jsonRpcError(res, 403, 'This session does not belong to the authenticated user.');
      }
    } else if (isInitializeRequest(req.body)) {
      // Fresh initialize — create a new session even if a stale mcp-session-id
      // is present (e.g. after a server restart); we mint a new id below.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
          sessionUser.set(id, userId);
        },
      });
      transport.onclose = () => {
        const id = transport!.sessionId;
        if (id) {
          transports.delete(id);
          sessionUser.delete(id);
        }
      };
      const server = new McpServer(SERVER_INFO);
      const rest = new ProcoreClient(userId, session);
      const ctx: AppContext = { userId, procore: session, rest, directory: new CompanyDirectory(rest) };
      registerTools(server, ctx);
      await server.connect(transport);
    } else {
      return jsonRpcError(res, 400, 'No valid session. Send an initialize request first (no mcp-session-id).');
    }

    await transport!.handleRequest(req, res, req.body);
   } catch (err) {
     console.error('[mcp] POST handler error:', err);
     if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error.');
   }
  });

  // GET (SSE stream) and DELETE (teardown) for an existing session.
  const handleSessionRequest = async (req: Request, res: Response) => {
    const sid = req.header('mcp-session-id');
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) return jsonRpcError(res, 404, 'Unknown or missing session id.');
    if (sessionUser.get(sid!) !== getUserId(req)) {
      return jsonRpcError(res, 403, 'This session does not belong to the authenticated user.');
    }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', mcpCors, mcpLog, bearer, handleSessionRequest);
  app.delete('/mcp', mcpCors, mcpLog, bearer, handleSessionRequest);

  const server = app.listen(config.port, () => {
    console.log(`[procore-mcp] ${SERVER_INFO.name} listening on :${config.port}`);
  });

  const shutdown = async () => {
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[procore-mcp] fatal startup error:', err);
  process.exit(1);
});
