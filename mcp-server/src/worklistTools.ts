/**
 * My Day worklist tools — storage for the morning-worklist skill
 * (.claude/skills/morning-worklist) and the /my-day page in the app.
 *
 *   get_worklist_state  what the skill needs before a run: last run time, open
 *                       and recently closed items, and the user's recent
 *                       feedback (urgency overrides, dismissals) as calibration.
 *   save_briefing       the run's single write, via the save_briefing() RPC
 *                       (supabase/migrations/add_worklist.sql), all in one
 *                       transaction.
 *
 * The rules live in the database, not here: rows are owner-only (RLS), and
 * save_briefing() never reopens what the user closed, never touches the user's
 * urgency override, keeps manual task text, and only reopens snoozed items on
 * their date. These tools only shape and validate the payload.
 *
 * Personal feature: index.ts registers these only for admins (isWorklistUser),
 * so other people's Claude never sees them. Store summaries and links only —
 * never email or chat bodies.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ok, fail, type ToolRegistrar } from './toolHelpers.js';

// ── Vocabulary (twin of app/src/components/worklist/types.ts — keep in sync) ─
const SOURCES = ['email', 'teams', 'monday', 'manual', 'claude'] as const;
const KINDS = ['respond', 'do', 'decide', 'question'] as const;
const DUE_BASES = ['stated', 'inferred', 'none'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

const ITEM_COLS =
  'id, source, source_key, kind, title, from_label, summary, link, due, due_basis, urgency, urgency_reason, ' +
  'user_urgency, effective_urgency, status, snoozed_until, first_seen, last_seen, times_seen, options, answer, answered_at';
const CLOSED_COLS = 'source_key, source, kind, title, status, closed_by, closed_at';
const FEEDBACK_COLS =
  'action, from_value, to_value, item_source, item_kind, item_title, item_from, claude_urgency, created_at';

/** YYYY-MM-DD in Eastern time. */
export function easternToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// ── Who gets these tools ──────────────────────────────────────────────────────
// One profiles lookup per user per 5 minutes; /mcp builds a fresh server per request.
const GATE_TTL_MS = 5 * 60_000;
const gateCache = new Map<string, { allowed: boolean; at: number }>();

export async function isWorklistUser(supa: SupabaseClient, userId: string): Promise<boolean> {
  const hit = gateCache.get(userId);
  if (hit && Date.now() - hit.at < GATE_TTL_MS) return hit.allowed;
  const { data, error } = await supa.from('profiles').select('role').eq('id', userId).maybeSingle();
  if (error) {
    console.error('[worklist] gate lookup failed:', error.message);
    return false; // fail closed, don't cache
  }
  const allowed = data?.role === 'admin';
  gateCache.set(userId, { allowed, at: Date.now() });
  return allowed;
}

// ── Payload schemas (shape of the Briefing type in the app) ──────────────────
const calendarEvent = z.object({
  id: z.string().max(200),
  start: z.string().regex(HHMM).describe('Local Eastern HH:MM, 24h'),
  end: z.string().regex(HHMM),
  subject: z.string().max(300),
  location: z.string().max(200).optional(),
  isOrganizer: z.boolean().optional(),
  canceled: z.boolean().optional(),
});

const readMeItem = z.object({
  id: z.string().max(200),
  text: z.string().min(1).max(500).describe('One or two sentences. A summary, never the message body.'),
  source: z.enum(SOURCES),
  link: z.string().max(2000).optional(),
});

const setAsideItem = z.object({
  id: z.string().max(200),
  title: z.string().max(300),
  reason: z.string().max(200),
  link: z.string().max(2000).optional(),
});

const briefingSchema = z.object({
  date: z.string().regex(ISO_DATE).describe('The Eastern day the briefing is for, YYYY-MM-DD'),
  ranAt: z.string().datetime({ offset: true }).optional().describe('ISO timestamp the run finished (default: now)'),
  since: z.string().datetime({ offset: true }).optional().describe('ISO timestamp the mail/chat window started'),
  missing: z.array(z.object({ source: z.string().max(50), error: z.string().max(300) })).max(10).default([]),
  sourceCounts: z
    .object({
      mail: z.number().int().min(0),
      teams: z.number().int().min(0),
      monday: z.number().int().min(0),
      manual: z.number().int().min(0),
    })
    .partial()
    .default({}),
  schedule: z.array(calendarEvent).max(40).default([]),
  openBlocks: z.array(z.string().max(40)).max(20).default([]),
  readMe: z.array(readMeItem).max(15).default([]),
  setAside: z
    .object({
      categories: z.array(z.object({ label: z.string().max(100), count: z.number().int().min(0) })).max(20).default([]),
      items: z.array(setAsideItem).max(30).default([]),
    })
    .default({ categories: [], items: [] }),
});

const itemSchema = z.object({
  source_key: z
    .string()
    .min(1)
    .max(300)
    .describe(
      'Stable idempotency key. email:<normalized subject>|<counterpart>, teams:<chatId>:<messageId of the ask>, ' +
        'monday:<itemId>, monday-update:<updateId>, claude:<slug>. For a manual task, its existing source_key ' +
        'from get_worklist_state.',
    ),
  source: z.enum(SOURCES),
  kind: z.enum(KINDS),
  title: z.string().min(1).max(300).describe('One line, what is owed'),
  from_label: z.string().max(200).optional().describe('Who it is from, or "you promised X"'),
  summary: z.string().max(2000).optional().describe('Short context. Never paste the email or chat body.'),
  link: z.string().max(2000).optional(),
  due: z.string().regex(ISO_DATE).nullable().optional().describe('YYYY-MM-DD, or null for no date'),
  due_basis: z.enum(DUE_BASES).optional(),
  urgency: z.number().int().min(1).max(4).describe('1 Now · 2 Today · 3 This week · 4 Whenever'),
  urgency_reason: z.string().max(300).optional().describe('One line: why this urgency'),
  options: z.array(z.string().max(200)).max(6).optional().describe('Choices, for kind "question" only'),
});

export function registerWorklistTools(server: ToolRegistrar, supa: SupabaseClient, userId: string): void {
  // ── Read: everything the morning run needs before it starts ─────────────────
  server.registerTool(
    'get_worklist_state',
    {
      title: 'Get my worklist state',
      description:
        'Personal My Day worklist. Call this FIRST in a morning-worklist run. Returns: today (Eastern), ' +
        'last_briefing (date, ran_at, window_since — use ran_at as the start of the new window), open_items ' +
        '(open and snoozed, including manual tasks the user added on the page; effective_urgency honours the ' +
        "user's override), recently_closed (closed in the last 14 days; don't re-propose these), and feedback " +
        '(recent urgency overrides, dismissals, snoozes, answers) to calibrate urgency.',
      inputSchema: {
        feedback_days: z.number().int().min(1).max(60).optional().describe('Feedback lookback in days (default 14)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ feedback_days }) => {
      const days = feedback_days ?? 14;
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const closedSince = new Date(Date.now() - 14 * 86_400_000).toISOString();

      const [last, open, closed, feedback] = await Promise.all([
        supa
          .from('worklist_briefings')
          .select('briefing_date, ran_at, window_since, missing')
          .eq('user_id', userId)
          .order('briefing_date', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supa
          .from('worklist_items')
          .select(ITEM_COLS)
          .eq('user_id', userId)
          .in('status', ['open', 'snoozed'])
          .order('effective_urgency', { ascending: true })
          .order('due', { ascending: true, nullsFirst: false })
          .limit(200),
        supa
          .from('worklist_items')
          .select(CLOSED_COLS)
          .eq('user_id', userId)
          .in('status', ['done', 'dismissed'])
          .gte('closed_at', closedSince)
          .order('closed_at', { ascending: false })
          .limit(200),
        supa
          .from('worklist_feedback')
          .select(FEEDBACK_COLS)
          .eq('user_id', userId)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      const firstError = last.error ?? open.error ?? closed.error ?? feedback.error;
      if (firstError) return fail(firstError.message);

      return ok({
        today: easternToday(),
        last_briefing: last.data ?? null,
        open_items: open.data ?? [],
        recently_closed: closed.data ?? [],
        feedback: feedback.data ?? [],
      });
    },
  );

  // ── Write: the run's one save ───────────────────────────────────────────────
  server.registerTool(
    'save_briefing',
    {
      title: 'Save the morning briefing',
      description:
        "Personal My Day worklist. Save a morning-worklist run in one transaction: the day's briefing (schedule, " +
        'read-me, set-aside, run health) plus items upserted by source_key, and resolved_keys closed as done. ' +
        'Re-running the same day replaces that day\'s briefing. The database keeps anything the user closed ' +
        'closed, never changes their urgency override, keeps manual task wording, and only reopens snoozed items ' +
        'on their date. Items not sent are left as they are (they carry over). Max 100 items. Summaries and ' +
        'links only — never paste email or chat bodies.',
      inputSchema: {
        briefing: briefingSchema,
        items: z.array(itemSchema).max(100).default([]),
        resolved_keys: z
          .array(z.string().min(1).max(300))
          .max(200)
          .default([])
          .describe('source_keys of open items now resolved (e.g. you already replied). Closed as done.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ briefing, items, resolved_keys }) => {
      const badOptions = items.find((i) => i.options && i.kind !== 'question');
      if (badOptions) return fail(`"options" is only for kind "question" (item ${badOptions.source_key}).`);
      const keys = items.map((i) => i.source_key);
      const dupe = keys.find((k, idx) => keys.indexOf(k) !== idx);
      if (dupe) return fail(`Duplicate source_key in items: ${dupe}`);

      const { data, error } = await supa.rpc('save_briefing', {
        p_briefing: briefing,
        p_items: items,
        p_resolved_keys: resolved_keys,
      });
      if (error) return fail(error.message);
      return ok(data);
    },
  );
}
