/** Shared helpers for MCP tool handlers (tools.ts + submittalTools.ts). */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_SCOPES } from './oauth/scopes.js';

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

export const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
});

/** Escape a free-text term for use inside a PostgREST `.or()` ilike pattern. */
export function sanitize(term: string): string {
  return term.replace(/[(),*%]/g, ' ').trim();
}

export type CutsheetSource = 'repository' | 'staging' | 'legacy' | null;

/**
 * Derive cutsheet match status from a submittal_items row. Mirrors the app's
 * hasCutsheet() (app/src/utils/cutsheetSource.ts) — there is no stored flag;
 * an item "has a cutsheet" when any of the three source columns is set.
 */
export function cutsheetStatus(row: {
  cutsheet_repository_id?: unknown;
  cutsheet_staging_id?: unknown;
  cut_sheet_url?: unknown;
}): { has_cutsheet: boolean; cutsheet_source: CutsheetSource } {
  const source: CutsheetSource = row.cutsheet_repository_id
    ? 'repository'
    : row.cutsheet_staging_id
      ? 'staging'
      : row.cut_sheet_url
        ? 'legacy'
        : null;
  return { has_cutsheet: source !== null, cutsheet_source: source };
}

// ── Scope-gated registration ──────────────────────────────────────────────────

/** The one method tool modules need from McpServer. Lets us hand them a gated wrapper. */
export type ToolRegistrar = Pick<McpServer, 'registerTool'>;

type AnyRegister = (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => RegisteredTool;

/**
 * Wraps a per-request McpServer so each tool is registered only in the sense
 * the caller's OAuth scopes allow:
 *   - scope granted   → registered normally, with a belt-and-suspenders check
 *                       of extra.authInfo.scopes inside the handler
 *   - scope not held  → registered then disabled, so it is absent from
 *                       tools/list and a direct call gets the SDK's standard
 *                       JSON-RPC "tool disabled" error (never an HTTP 401)
 * A tool missing from TOOL_SCOPES throws: see assertToolScopesComplete().
 */
export function scopedRegistrar(server: McpServer, grantedScopes: readonly string[]): ToolRegistrar {
  const register: AnyRegister = (name, config, handler) => {
    const required = TOOL_SCOPES[name];
    if (!required) throw new Error(`Tool "${name}" has no entry in TOOL_SCOPES (src/oauth/scopes.ts)`);

    const gated = async (...args: unknown[]) => {
      const extra = args[args.length - 1] as { authInfo?: { scopes?: string[] } } | undefined;
      const scopes = extra?.authInfo?.scopes ?? grantedScopes;
      if (!scopes.includes(required)) {
        return fail(`This connection lacks the "${required}" scope that ${name} requires. Reconnect Claude and approve it.`);
      }
      return handler(...args);
    };

    const tool = (server.registerTool as unknown as AnyRegister)(name, config, gated);
    if (!grantedScopes.includes(required)) tool.disable();
    return tool;
  };
  return { registerTool: register as unknown as McpServer['registerTool'] };
}

/** Registrar that only records tool names — used at startup to audit TOOL_SCOPES. */
export function collectingRegistrar(names: string[]): ToolRegistrar {
  const register: AnyRegister = (name) => {
    names.push(name);
    return {} as RegisteredTool;
  };
  return { registerTool: register as unknown as McpServer['registerTool'] };
}

/** Fail fast if the registered tool set and TOOL_SCOPES disagree. */
export function assertToolScopesComplete(registeredNames: readonly string[]): void {
  const missing = registeredNames.filter((n) => !TOOL_SCOPES[n]);
  const stale = Object.keys(TOOL_SCOPES).filter((n) => !registeredNames.includes(n));
  if (missing.length || stale.length) {
    throw new Error(
      `TOOL_SCOPES out of sync — missing: [${missing.join(', ')}] stale: [${stale.join(', ')}]. Update src/oauth/scopes.ts.`,
    );
  }
}
