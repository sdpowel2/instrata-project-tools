/** Shared helpers for MCP tool handlers (tools.ts + submittalTools.ts). */

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
