/**
 * OAuth scopes and the tool → scope map.
 *
 *   mcp:read        every read tool
 *   mcp:write       the cutsheet submittal write tools (submittalTools.ts)
 *   offline_access  issue a refresh token so the client stays connected
 *
 * TOOL_SCOPES must list EVERY registered tool. index.ts checks this at startup
 * and refuses to boot on a mismatch, so a new tool can't silently vanish from
 * tools/list because nobody assigned it a scope.
 */

export const SCOPES = ['mcp:read', 'mcp:write', 'offline_access'] as const;
export type Scope = (typeof SCOPES)[number];
export type ToolScope = Extract<Scope, 'mcp:read' | 'mcp:write'>;

/** What a client gets if it asks for no scope at all. */
export const DEFAULT_SCOPES: readonly Scope[] = SCOPES;

/** Plain-language consent copy, in the order shown on the consent screen. */
export const SCOPE_LABELS: Record<Scope, string> = {
  'mcp:read':
    'Read your Project Tools data: projects, BoMs, RFIs, submittals, purchasing, schedule, catalog, directory and project files',
  'mcp:write': 'Create and update cutsheet submittal packages on projects you belong to',
  offline_access: 'Stay connected without signing in again (for up to 30 days at a time)',
};

export const TOOL_SCOPES: Record<string, ToolScope> = {
  // tools.ts
  get_me: 'mcp:read',
  list_projects: 'mcp:read',
  get_project: 'mcp:read',
  get_project_bom: 'mcp:read',
  list_rfis: 'mcp:read',
  list_submittals: 'mcp:read',
  list_purchasing: 'mcp:read',
  list_milestones: 'mcp:read',
  search_catalog: 'mcp:read',
  search_vendor_contacts: 'mcp:read',
  list_project_files: 'mcp:read',
  get_project_file: 'mcp:read',
  // submittalTools.ts
  search_cutsheet_repository: 'mcp:read',
  create_submittal: 'mcp:write',
  update_submittal: 'mcp:write',
  populate_submittal_from_bom: 'mcp:write',
  attach_cutsheet: 'mcp:write',
  detach_cutsheet: 'mcp:write',
};

export function isSupportedScope(s: string): s is Scope {
  return (SCOPES as readonly string[]).includes(s);
}

/** Split a space-separated scope string (or array) into a de-duplicated list. */
export function parseScopes(scope: string | readonly string[] | undefined | null): string[] {
  const parts: readonly string[] = typeof scope === 'string' ? scope.split(/\s+/) : (scope ?? []);
  return [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
}

/** Requested scopes, or the defaults when none were requested. */
export function resolveRequestedScopes(scope: string | readonly string[] | undefined | null): string[] {
  const parsed = parseScopes(scope);
  return parsed.length > 0 ? parsed : [...DEFAULT_SCOPES];
}

export function unsupportedScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => !isSupportedScope(s));
}

export function isSubset(requested: readonly string[], granted: readonly string[]): boolean {
  return requested.every((s) => granted.includes(s));
}
