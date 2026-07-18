/**
 * Daily-log and change-event tools (spec §6.7, §6.8).
 *
 * Daily logs: Procore's daily log is many sub-resources; v1 pulls notes,
 * manpower, delay, and work logs and concatenates them per day.
 * Change events: GET /rest/v1.0/projects/{project_id}/change_events[/{id}].
 *
 * NOTE: exact daily-log endpoint paths/params vary across Procore versions and
 * should be confirmed against the sandbox; requests degrade to empty sections
 * rather than throwing when a sub-resource is unavailable.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ProjectRef } from '../procore/types.js';
import { ok, fail, clampLimit, resolveSince, MAX_LIMIT } from './helpers.js';
import { ballInCourt, personName, withinSince, firstStr } from './normalize.js';
import { resolveProject, orientation } from './scope.js';

// ── Daily logs ────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

type DailyEntry = { type: string; company?: string; text?: string };
type DailyDay = { date: string; entries: DailyEntry[] };

const orgName = (o: any): string | undefined =>
  typeof o === 'string' ? o : o?.name ?? o?.vendor?.name ?? o?.company?.name;

const LOG_TYPES: Array<{ type: string; path: string; text: (e: any) => string | undefined }> = [
  { type: 'notes', path: 'notes_logs', text: (e) => firstStr(e.comments, e.comment, e.notes, e.description) },
  {
    type: 'manpower',
    path: 'manpower_logs',
    text: (e) => {
      const workers = e.num_workers ?? e.number_of_workers ?? e.man_count;
      const hours = e.hours ?? e.man_hours;
      const parts = [workers != null ? `${workers} workers` : undefined, hours != null ? `${hours} hrs` : undefined];
      return firstStr(parts.filter(Boolean).join(', ') || undefined, e.comments, e.notes);
    },
  },
  { type: 'delay', path: 'delay_logs', text: (e) => firstStr([e.delay_type, e.comment ?? e.comments].filter(Boolean).join(' — ') || undefined, e.description) },
  { type: 'work', path: 'work_logs', text: (e) => firstStr(e.description, e.comments, e.comment) },
];

const logDate = (e: any): string | undefined => firstStr(e.date, e.log_date, e.datetime, e.created_at)?.slice(0, 10);

async function fetchLogType(
  ctx: AppContext,
  ref: ProjectRef,
  path: string,
  startDate: string,
  endDate: string,
): Promise<any[]> {
  try {
    return await ctx.rest.get<any[]>(`/rest/v1.0/projects/${ref.project_id}/${path}`, {
      companyId: ref.company_id,
      query: { start_date: startDate, end_date: endDate, per_page: MAX_LIMIT },
    });
  } catch {
    return []; // a missing/forbidden sub-log shouldn't sink the whole daily-log call
  }
}

export async function fetchDailyLogs(
  ctx: AppContext,
  ref: ProjectRef,
  opts: { startDate: string; endDate: string },
): Promise<DailyDay[]> {
  const byDate = new Map<string, DailyEntry[]>();
  for (const lt of LOG_TYPES) {
    const rows = await fetchLogType(ctx, ref, lt.path, opts.startDate, opts.endDate);
    for (const e of rows) {
      const date = logDate(e) ?? opts.endDate;
      const entry: DailyEntry = { type: lt.type, company: orgName(e), text: lt.text(e) };
      if (!entry.text && !entry.company) continue;
      (byDate.get(date) ?? byDate.set(date, []).get(date)!).push(entry);
    }
  }
  return [...byDate.entries()]
    .map(([date, entries]) => ({ date, entries }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// ── Change events ──────────────────────────────────────────────────────────────

export type ChangeEventItem = {
  change_event_id: number;
  number?: string;
  title?: string;
  status?: string;
  scope?: string;
  origin?: string;
  created_at?: string;
  updated_at?: string;
};

const statusName = (s: any): string | undefined => (typeof s === 'string' ? s : s?.name ?? s?.status);

function normalizeChangeEvent(c: any): ChangeEventItem {
  return {
    change_event_id: c.id,
    number: firstStr(c.number != null ? String(c.number) : undefined, c.formatted_number),
    title: c.title,
    status: statusName(c.status),
    scope: firstStr(c.scope, c.change_reason?.name, c.reason),
    origin: firstStr(c.origin?.name, c.origin_id != null ? String(c.origin_id) : undefined),
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

export async function fetchChangeEvents(
  ctx: AppContext,
  ref: ProjectRef,
  opts: { since: string; limit: number; status?: string },
): Promise<{ items: ChangeEventItem[]; has_more: boolean }> {
  const raw = await ctx.rest.get<any[]>(`/rest/v1.0/projects/${ref.project_id}/change_events`, {
    companyId: ref.company_id,
    query: { sort: 'updated_at', per_page: MAX_LIMIT },
  });
  let items = raw.map(normalizeChangeEvent).filter((c) => withinSince(c.updated_at, opts.since));
  if (opts.status) items = items.filter((c) => (c.status ?? '').toLowerCase() === opts.status!.toLowerCase());
  items.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  return { items: items.slice(0, opts.limit), has_more: items.length > opts.limit };
}

export async function fetchChangeEvent(ctx: AppContext, ref: ProjectRef, id: number): Promise<unknown> {
  const c = await ctx.rest.get<any>(`/rest/v1.0/projects/${ref.project_id}/change_events/${id}`, {
    companyId: ref.company_id,
  });
  const lineItems = Array.isArray(c.line_items) ? c.line_items : [];
  return {
    ...orientation(ref),
    ...normalizeChangeEvent(c),
    description: c.description,
    created_by: personName(c.created_by),
    line_items: lineItems.map((li: any) => ({
      description: li.description,
      cost_code: li.cost_code?.full_code ?? li.cost_code?.name,
      amount: li.amount ?? li.total,
    })),
  };
}

// ── Registration ────────────────────────────────────────────────────────────────

export function registerLogTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_daily_logs',
    {
      title: 'List daily logs',
      description:
        'Daily log entries (notes, manpower, delays, work) for a project over a date range ' +
        '(default last 7 days), grouped per day. Useful for status/awareness.',
      inputSchema: {
        project_id: z.number().int().describe('Procore project id'),
        start_date: z.string().optional().describe('ISO date (default 7 days ago)'),
        end_date: z.string().optional().describe('ISO date (default today)'),
      },
    },
    async ({ project_id, start_date, end_date }) => {
      try {
        const ref = await resolveProject(ctx, project_id);
        const end = firstStr(end_date, new Date().toISOString().slice(0, 10))!;
        const start = firstStr(start_date, new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10))!;
        const days = await fetchDailyLogs(ctx, ref, { startDate: start, endDate: end });
        return ok({ ...orientation(ref), start_date: start, end_date: end, days });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    'list_change_events',
    {
      title: 'List change events',
      description: 'Change events for a project updated within the window (default 14 days), newest first.',
      inputSchema: {
        project_id: z.number().int().describe('Procore project id'),
        since: z.string().optional().describe('ISO date (default 14 days ago)'),
        status: z.string().optional().describe('Filter to an exact status'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Max rows (default 25)'),
      },
    },
    async ({ project_id, since, status, limit }) => {
      try {
        const ref = await resolveProject(ctx, project_id);
        const res = await fetchChangeEvents(ctx, ref, { since: resolveSince(Date.now(), since), limit: clampLimit(limit), status });
        return ok({ ...orientation(ref), ...res });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    'get_change_event',
    {
      title: 'Get change event detail',
      description: 'Description and line-item summaries for one change event (cost figures only if permissions allow).',
      inputSchema: {
        project_id: z.number().int().describe('Procore project id'),
        change_event_id: z.number().int().describe('Change event id (from list_change_events)'),
      },
    },
    async ({ project_id, change_event_id }) => {
      try {
        const ref = await resolveProject(ctx, project_id);
        return ok(await fetchChangeEvent(ctx, ref, change_event_id));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );
}
