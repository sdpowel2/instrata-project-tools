/**
 * Project-level tools: whoami, list_companies, list_projects, find_project,
 * get_project_activity (spec §6.1–§6.4, §6.11).
 *
 * get_project_activity is the workhorse for "give me updates on <project>": it
 * fans out to the section fetchers in parallel and degrades gracefully — a 403 on
 * one section (e.g. no daily-log access) yields "access":"forbidden" for that
 * section instead of failing the whole digest.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { ok, fail, clampLimit, resolveSince, MAX_LIMIT } from './helpers.js';
import { resolveProject, orientation } from './scope.js';
import { ForbiddenError } from '../errors.js';
import { fetchRfis } from './rfis.js';
import { fetchSubmittals } from './submittals.js';
import { fetchChangeEvents, fetchDailyLogs } from './logs.js';
import { fetchRecentDocuments } from './documents.js';

const ACTIVITY_HEADLINE_LIMIT = 10;

/** Run one activity section, converting a 403 into a forbidden marker (never throws). */
async function section<T>(fn: () => Promise<T>): Promise<{ value: T } | { access: 'forbidden' } | { error: string }> {
  try {
    return { value: await fn() };
  } catch (err) {
    if (err instanceof ForbiddenError) return { access: 'forbidden' };
    return { error: (err as Error).message };
  }
}

export function registerProjectTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I (Procore)',
      description:
        'Return the authenticated Procore user (name, email, procore_user_id) and how many companies ' +
        'they belong to. Useful for confirming the connector is linked to the right account.',
      inputSchema: {},
    },
    async () => {
      try {
        const id = await ctx.procore.identity(ctx.userId);
        if (!id) return fail('Not connected to Procore. Reconnect the Procore connector to authorize access.');
        let companyCount: number | undefined;
        try {
          companyCount = (await ctx.directory.companies()).length;
        } catch {
          companyCount = undefined;
        }
        return ok({ procore_user_id: id.procoreUserId, name: id.name, email: id.email, company_count: companyCount });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    'list_companies',
    {
      title: 'List companies',
      description: 'List the Procore companies (GC accounts) the authenticated user belongs to.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok({ companies: await ctx.directory.companies() });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List the user\'s projects across all their companies. Optionally filter by company_id, a name/number ' +
        'substring, and active status. Use find_project for fuzzy "the LEGO project" lookups.',
      inputSchema: {
        company_id: z.number().int().optional().describe('Restrict to one company'),
        query: z.string().optional().describe('Substring match on project name or number'),
        active_only: z.boolean().optional().describe('Only active projects (default true)'),
      },
    },
    async ({ company_id, query, active_only }) => {
      try {
        let projects = await ctx.directory.projects();
        if (active_only !== false) projects = projects.filter((p) => p.active !== false);
        if (company_id !== undefined) projects = projects.filter((p) => p.company_id === company_id);
        if (query) {
          const q = query.toLowerCase();
          projects = projects.filter(
            (p) => p.name.toLowerCase().includes(q) || (p.project_number ?? '').toLowerCase().includes(q),
          );
        }
        const skipped = await ctx.directory.skippedCompanies();
        return ok({ count: projects.length, projects, ...(skipped.length ? { skipped_companies: skipped } : {}) });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    'find_project',
    {
      title: 'Find a project (fuzzy)',
      description:
        'Fuzzy/substring search for a project by nickname across ALL companies (case-insensitive; matches name ' +
        'and project number). The entry point for "the LEGO project". Returns ranked matches; if several are ' +
        'strong, all are returned so you can ask the user which they mean.',
      inputSchema: { query: z.string().describe('Project name or nickname, e.g. "LEGO"') },
    },
    async ({ query }) => {
      try {
        const q = query.trim().toLowerCase();
        const scored = (await ctx.directory.projects())
          .map((p) => {
            const name = p.name.toLowerCase();
            const num = (p.project_number ?? '').toLowerCase();
            let score = 0;
            if (name === q) score = 100;
            else if (name.startsWith(q)) score = 80;
            else if (name.includes(q)) score = 60;
            else if (num.includes(q)) score = 40;
            return { p, score };
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score);
        return ok({ match_count: scored.length, matches: scored.map((s) => s.p) });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    'get_project_activity',
    {
      title: 'Get project activity digest',
      description:
        'One-call digest of recent activity on a project (default last 14 days): counts + headline items across ' +
        'RFIs, submittals, change events, daily logs, and recently updated documents. The workhorse for "give me ' +
        'updates on <project>". Sections the user cannot access are marked access:"forbidden" rather than failing.',
      inputSchema: {
        project_id: z.number().int().describe('Procore project id'),
        since: z.string().optional().describe('ISO date; activity on/after this (default 14 days ago)'),
      },
    },
    async ({ project_id, since }) => {
      try {
        const ref = await resolveProject(ctx, project_id);
        const sinceIso = resolveSince(Date.now(), since);
        const startDate = sinceIso.slice(0, 10);
        const endDate = new Date().toISOString().slice(0, 10);
        const opts = { since: sinceIso, limit: ACTIVITY_HEADLINE_LIMIT };

        const [rfis, submittals, changeEvents, dailyLogs, documents] = await Promise.all([
          section(() => fetchRfis(ctx, ref, opts)),
          section(() => fetchSubmittals(ctx, ref, opts)),
          section(() => fetchChangeEvents(ctx, ref, opts)),
          section(() => fetchDailyLogs(ctx, ref, { startDate, endDate })),
          section(() => fetchRecentDocuments(ctx, ref, { since: sinceIso, limit: ACTIVITY_HEADLINE_LIMIT })),
        ]);

        const digest = {
          rfis: summarize(rfis, (v) =>
            v.items.map((r) => ({ type: 'rfi', id: r.rfi_id, title: r.subject, status: r.status, updated_at: r.updated_at, one_line_summary: `RFI ${r.number ?? ''}: ${r.subject ?? ''} [${r.status ?? ''}]${r.ball_in_court ? ` — ball-in-court ${r.ball_in_court}` : ''}` })),
          ),
          submittals: summarize(submittals, (v) =>
            v.items.map((s) => ({ type: 'submittal', id: s.submittal_id, title: s.title, status: s.status, updated_at: s.updated_at, one_line_summary: `Submittal ${s.number ?? ''}: ${s.title ?? ''} [${s.status ?? ''}]${s.spec_section ? ` (${s.spec_section})` : ''}` })),
          ),
          change_events: summarize(changeEvents, (v) =>
            v.items.map((c) => ({ type: 'change_event', id: c.change_event_id, title: c.title, status: c.status, updated_at: c.updated_at, one_line_summary: `CE ${c.number ?? ''}: ${c.title ?? ''} [${c.status ?? ''}]` })),
          ),
          daily_logs: summarize(dailyLogs, (v) =>
            v.map((d) => ({ type: 'daily_log', id: d.date, title: d.date, updated_at: d.date, one_line_summary: `${d.date}: ${d.entries.length} entr${d.entries.length === 1 ? 'y' : 'ies'}` })),
          ),
          documents: summarize(documents, (v) =>
            v.items.map((f) => ({ type: 'document', id: f.file_id, title: f.filename, updated_at: f.updated_at, one_line_summary: `${f.folder_path ? `${f.folder_path} — ` : ''}${f.filename ?? ''}` })),
          ),
        };

        return ok({ ...orientation(ref), since: sinceIso, window_end: endDate, ...digest });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );
}

/** Shape one section's result into { count, items } | { access } | { error }. */
function summarize<T>(
  result: { value: T } | { access: 'forbidden' } | { error: string },
  toItems: (v: T) => unknown[],
): unknown {
  if ('access' in result) return { access: 'forbidden' };
  if ('error' in result) return { error: result.error };
  const items = toItems(result.value);
  return { count: items.length, items };
}
