/**
 * Per-session context handed to every tool handler. Bound to exactly one user at
 * MCP session creation, so a tool can only ever act as the connecting user.
 * The Procore REST client (Phase 3) is added here and is likewise user-scoped.
 */
import type { ProcoreSession } from './auth/procoreSession.js';
import type { ProcoreClient } from './procore/client.js';
import type { CompanyDirectory } from './procore/directory.js';

export type AppContext = {
  /** The authenticated user id (= Procore user id) for this session. */
  userId: string;
  /** Resolves fresh Procore access tokens for this user. */
  procore: ProcoreSession;
  /** Per-user Procore REST client. */
  rest: ProcoreClient;
  /** Per-user companies + project→company directory. */
  directory: CompanyDirectory;
};
