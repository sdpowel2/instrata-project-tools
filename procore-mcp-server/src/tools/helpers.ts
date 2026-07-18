/**
 * Shared tool-result helpers and list conventions. The ok()/fail()/sanitize()
 * helpers mirror the existing Supabase MCP server (mcp-server/src/tools.ts) so
 * both servers speak the same shape to Claude.
 */

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Success: compact-but-readable JSON payload. */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

/** Failure: human-readable message, flagged so Claude knows the call failed. */
export const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
});

/** Strip characters that would break a free-text query before interpolation. */
export function sanitize(term: string): string {
  return term.replace(/[(),*%]/g, ' ').trim();
}

// ── Shared list conventions (spec §6) ────────────────────────────────────────

/** Default lookback window for list tools when the caller omits `since`. */
export const DEFAULT_SINCE_DAYS = 14;
/** Default page size for list tools. */
export const DEFAULT_LIMIT = 25;
/** Hard ceiling on page size. */
export const MAX_LIMIT = 100;

/** Clamp a caller-supplied limit into [1, MAX_LIMIT], defaulting when absent. */
export function clampLimit(limit?: number): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/**
 * Resolve a `since` window to an ISO timestamp. Accepts an ISO date string; when
 * absent, defaults to DEFAULT_SINCE_DAYS ago. `nowMs` is injected (not read from
 * the clock here) so callers/tests stay deterministic.
 */
export function resolveSince(nowMs: number, since?: string): string {
  if (since) {
    const t = Date.parse(since);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date(nowMs - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
