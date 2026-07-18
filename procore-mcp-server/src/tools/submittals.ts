/**
 * Submittal tools: list_submittals, get_submittal (spec §6.6).
 * Procore: GET /rest/v1.1/projects/{project_id}/submittals[/{id}] (v1.1 has the
 * richer payload). Responsible-contractor is exposed so Claude can filter "ours"
 * rather than the server guessing the user's vendor record.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ProjectRef } from '../procore/types.js';
import { ok, fail, clampLimit, resolveSince, MAX_LIMIT } from './helpers.js';
import { ballInCourt, personName, withinSince, firstStr } from './normalize.js';
import { resolveProject, orientation } from './scope.js';

export type SubmittalListItem = {
  submittal_id: number;
  number?: string;
  title?: string;
  revision?: string | number;
  spec_section?: string;
  status?: string;
  ball_in_court?: string;
  responsible_contractor?: string;
  due_date?: string;
  updated_at?: string;
};

const statusName = (s: any): string | undefined => (typeof s === 'string' ? s : s?.name ?? s?.status);
const specSection = (s: any): string | undefined =>
  s ? [s.number, s.description].filter(Boolean).join(' ') || undefined : undefined;
const orgName = (o: any): string | undefined => (typeof o === 'string' ? o : o?.name ?? o?.company?.name);

function normalizeSubmittal(s: any): SubmittalListItem {
  return {
    submittal_id: s.id,
    number: firstStr(s.formatted_number, s.number != null ? String(s.number) : undefined),
    title: s.title,
    revision: s.revision,
    spec_section: specSection(s.specification_section ?? s.spec_section),
    status: statusName(s.status),
    ball_in_court: ballInCourt(s.ball_in_court),
    responsible_contractor: orgName(s.responsible_contractor),
    due_date: firstStr(s.due_date, s.required_on_site_date),
    updated_at: s.updated_at,
  };
}

export async function fetchSubmittals(
  ctx: AppContext,
  ref: ProjectRef,
  opts: { since: string; limit: number; status?: string; spec_section?: string },
): Promise<{ items: SubmittalListItem[]; has_more: boolean }> {
  const raw = await ctx.rest.get<any[]>(`/rest/v1.1/projects/${ref.project_id}/submittals`, {
    companyId: ref.company_id,
    query: { sort: 'updated_at', per_page: MAX_LIMIT },
  });
  let items = raw.map(normalizeSubmittal).filter((s) => withinSince(s.updated_at, opts.since));
  if (opts.status) items = items.filter((s) => (s.status ?? '').toLowerCase() === opts.status!.toLowerCase());
  if (opts.spec_section) items = items.filter((s) => (s.spec_section ?? '').includes(opts.spec_section!));
  items.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  return { items: items.slice(0, opts.limit), has_more: items.length > opts.limit };
}

export async function fetchSubmittal(ctx: AppContext, ref: ProjectRef, submittalId: number): Promise<unknown> {
  const s = await ctx.rest.get<any>(`/rest/v1.1/projects/${ref.project_id}/submittals/${submittalId}`, {
    companyId: ref.company_id,
  });
  const workflow = Array.isArray(s.approvers) ? s.approvers : s.workflow ?? [];
  return {
    ...orientation(ref),
    ...normalizeSubmittal(s),
    description: s.description,
    workflow: Array.isArray(workflow)
      ? workflow.map((w: any) => ({ role: w.role ?? w.approver_type, name: personName(w.user ?? w), response: statusName(w.response ?? w.status), due: w.due_date }))
      : undefined,
    attachments: Array.isArray(s.attachments)
      ? s.attachments.map((a: any) => ({ file_id: a.id, filename: a.name ?? a.filename, size: a.size }))
      : [],
  };
}

export function registerSubmittalTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_submittals',
    {
      title: 'List submittals',
      description:
        'List a project\'s submittal packages updated within the window (default 14 days), newest first. ' +
        'Includes spec section, status, ball-in-court, and responsible contractor (filter "ours" client-side).',
      inputSchema: {
        project_id: z.number().int().describe('Procore project id'),
        since: z.string().optional().describe('ISO date; only submittals updated on/after this (default 14 days ago)'),
        status: z.string().optional().describe('Filter to an exact status'),
        spec_section: z.string().optional().describe('Substring match on spec section, e.g. "27" or "28 16"'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Max rows (default 25)'),
      },
    },
    async ({ project_id, since, status, spec_section, limit }) => {
      try {
        const ref = await resolveProject(ctx, project_id);
        const res = await fetchSubmittals(ctx, ref, {
          since: resolveSince(Date.now(), since),
          limit: clampLimit(limit),
          status,
          spec_section,
        });
        return ok({ ...orientation(ref), ...res });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    'get_submittal',
    {
      title: 'Get submittal detail',
      description: 'Full detail for one submittal incl. workflow/approvers and attachment metadata.',
      inputSchema: {
        project_id: z.number().int().describe('Procore project id'),
        submittal_id: z.number().int().describe('Submittal id (from list_submittals)'),
      },
    },
    async ({ project_id, submittal_id }) => {
      try {
        const ref = await resolveProject(ctx, project_id);
        return ok(await fetchSubmittal(ctx, ref, submittal_id));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );
}
