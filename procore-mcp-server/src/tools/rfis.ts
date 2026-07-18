/**
 * RFI tools: list_rfis, get_rfi (spec §6.5).
 * Procore: GET /rest/v1.0/projects/{project_id}/rfis[/{id}] with the
 * Procore-Company-Id header. Listing is sorted newest-first and trimmed to the
 * `since` window client-side (robust across Procore filter-param variations).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ProjectRef } from '../procore/types.js';
import { ok, fail, clampLimit, resolveSince, MAX_LIMIT } from './helpers.js';
import { ballInCourt, personName, withinSince, firstStr } from './normalize.js';
import { resolveProject, orientation } from './scope.js';

export type RfiListItem = {
  rfi_id: number;
  number?: string;
  subject?: string;
  status?: string;
  due_date?: string;
  ball_in_court?: string;
  created_at?: string;
  updated_at?: string;
};

function normalizeRfi(r: any): RfiListItem {
  return {
    rfi_id: r.id,
    number: firstStr(r.full_number, r.number != null ? String(r.number) : undefined),
    subject: r.subject,
    status: r.status,
    due_date: firstStr(r.due_date, r.rfi_due_date),
    ball_in_court: ballInCourt(r.ball_in_court),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function fetchRfis(
  ctx: AppContext,
  ref: ProjectRef,
  opts: { since: string; limit: number; status?: string },
): Promise<{ items: RfiListItem[]; has_more: boolean }> {
  const raw = await ctx.rest.get<any[]>(`/rest/v1.0/projects/${ref.project_id}/rfis`, {
    companyId: ref.company_id,
    query: { sort: 'updated_at', per_page: MAX_LIMIT },
  });
  let items = raw.map(normalizeRfi).filter((r) => withinSince(r.updated_at, opts.since));
  if (opts.status) items = items.filter((r) => (r.status ?? '').toLowerCase() === opts.status!.toLowerCase());
  items.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  const has_more = items.length > opts.limit;
  return { items: items.slice(0, opts.limit), has_more };
}

export async function fetchRfi(ctx: AppContext, ref: ProjectRef, rfiId: number): Promise<unknown> {
  const r = await ctx.rest.get<any>(`/rest/v1.0/projects/${ref.project_id}/rfis/${rfiId}`, {
    companyId: ref.company_id,
  });
  const questions = Array.isArray(r.questions) ? r.questions : [];
  return {
    ...orientation(ref),
    rfi_id: r.id,
    number: firstStr(r.full_number, r.number != null ? String(r.number) : undefined),
    subject: r.subject,
    status: r.status,
    due_date: firstStr(r.due_date, r.rfi_due_date),
    ball_in_court: ballInCourt(r.ball_in_court),
    created_by: personName(r.created_by),
    assignees: Array.isArray(r.assignees) ? r.assignees.map(personName).filter(Boolean) : undefined,
    questions: questions.map((q: any) => ({
      body: q.body ?? q.plain_text_body,
      answers: Array.isArray(q.answers)
        ? q.answers.map((a: any) => ({ body: a.body ?? a.plain_text_body, by: personName(a.created_by), at: a.created_at }))
        : [],
    })),
    attachments: Array.isArray(r.attachments)
      ? r.attachments.map((a: any) => ({ file_id: a.id, filename: a.name ?? a.filename, size: a.size }))
      : [],
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function registerRfiTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_rfis',
    {
      title: 'List RFIs',
      description:
        'List a project\'s RFIs updated within the window (default last 14 days), newest first. ' +
        'Returns number, subject, status, due date, and ball-in-court.',
      inputSchema: {
        project_id: z.number().int().describe('Procore project id'),
        since: z.string().optional().describe('ISO date; only RFIs updated on/after this (default 14 days ago)'),
        status: z.string().optional().describe('Filter to an exact status, e.g. "Open"'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Max rows (default 25)'),
      },
    },
    async ({ project_id, since, status, limit }) => {
      try {
        const ref = await resolveProject(ctx, project_id);
        const res = await fetchRfis(ctx, ref, { since: resolveSince(Date.now(), since), limit: clampLimit(limit), status });
        return ok({ ...orientation(ref), ...res });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    'get_rfi',
    {
      title: 'Get RFI detail',
      description: 'Full question/answer text, assignees, and attachment metadata for one RFI.',
      inputSchema: {
        project_id: z.number().int().describe('Procore project id'),
        rfi_id: z.number().int().describe('RFI id (from list_rfis)'),
      },
    },
    async ({ project_id, rfi_id }) => {
      try {
        const ref = await resolveProject(ctx, project_id);
        return ok(await fetchRfi(ctx, ref, rfi_id));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );
}
