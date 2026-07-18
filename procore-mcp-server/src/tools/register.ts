/**
 * Registers all read-only Procore tools onto an McpServer, bound to one user's
 * context. Every tool acts as the connecting user via ctx.rest, so Procore's own
 * permissions govern what comes back.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { registerProjectTools } from './projects.js';
import { registerRfiTools } from './rfis.js';
import { registerSubmittalTools } from './submittals.js';
import { registerLogTools } from './logs.js';
import { registerDocumentTools } from './documents.js';

export function registerTools(server: McpServer, ctx: AppContext): void {
  registerProjectTools(server, ctx); // whoami, list_companies, list_projects, find_project, get_project_activity
  registerRfiTools(server, ctx); // list_rfis, get_rfi
  registerSubmittalTools(server, ctx); // list_submittals, get_submittal
  registerLogTools(server, ctx); // list_daily_logs, list_change_events, get_change_event
  registerDocumentTools(server, ctx); // list_recent_documents, read_document
}
