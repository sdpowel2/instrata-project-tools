/**
 * My Day worklist tools — storage for the morning-worklist skill
 * (.claude/skills/morning-worklist) and the /my-day page in the app.
 *
 *   get_worklist_state  what the skill needs before a run: last run time, open
 *                       and recently closed items, and the user's recent
 *                       feedback (urgency overrides, dismissals) as calibration.
 *   save_briefing       the run's single write, via the save_briefing() RPC
 *                       (supabase/migrations/add_worklist.sql), all in one
 *                       transaction, then the reviewed log (save_reviewed()).
 *   match_triage_rules  which of the user's hard tuning rules apply to the
 *                       run's candidate conversations (My Day 2.2,
 *                       supabase/migrations/add_triage_rules.sql). Read-only.
 *   find_projects       batch lookup of projects by code, number or monday item
 *                       id, so the run can suggest a project for a task (My Day
 *                       2.4). Read-only. The run only ever suggests; linking is
 *                       the user's call (add_worklist_projects.sql enforces it).
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
/** Which phase 3 worker could pick a task up (My Day 2.3). */
const WORK_TYPES = ['reply', 'dtools_report', 'ipt_change', 'none'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

const ITEM_COLS =
  'id, source, source_key, kind, title, from_label, summary, link, due, due_basis, urgency, urgency_reason, ' +
  'user_urgency, effective_urgency, status, snoozed_until, first_seen, last_seen, times_seen, options, answer, answered_at, ' +
  'work_type, work_confidence, user_work_type, effective_work_type, ' +
  'project_id, suggested_project_id, dismissed_project_id';
const CLOSED_COLS = 'source_key, source, kind, title, status, closed_by, closed_at';
const SURFACED_COLS =
  'source, source_key, title, from_label, outcome, reason, reason_group, surfaced_at, item:worklist_items(kind, effective_urgency)';
const RULE_COLS = 'id, kind, effect, match, note, example_id, hits_30d, last_hit_at, created_at';
const EXAMPLE_COLS = 'id, source, title, from_label, outcome, reason, reason_group';
const README_STATE_COLS = 'briefing_date, readme_id, state, readme_text, readme_source, readme_link, at';
/** 2.6 adds where a logged line was filed to; dropped again if that migration isn't applied yet. */
const README_STATE_COLS_26 = `${README_STATE_COLS}, scope, project_id`;
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
  /** Suggested project (2.6): exact matches only, same rules as Step 8c. Logging the line shares it there. */
  projectId: z.string().uuid().transform((s) => s.toLowerCase()).optional(),
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

const REVIEW_OUTCOMES = ['respond', 'do', 'decide', 'read_me', 'set_aside', 'dropped', 'carried'] as const;

/** One conversation the run looked at, wherever it landed (My Day 2.1 reviewed log). */
const reviewedSchema = z.object({
  source_key: z.string().min(1).max(300).describe('Same key rules as items'),
  source: z.enum(['email', 'teams', 'monday']),
  title: z.string().min(1).max(300).describe('Subject, chat name, or monday item name'),
  from_label: z.string().max(200).optional(),
  link: z.string().max(2000).optional(),
  outcome: z.enum(REVIEW_OUTCOMES).describe('Where it landed. "carried" = already open from an earlier run'),
  reason: z.string().min(1).max(300).describe('One line: why it landed there'),
  reason_group: z.string().min(1).max(80).describe('Short stable label to group by, e.g. "CC only, no ask"'),
  sender: z
    .string()
    .max(200)
    .optional()
    .describe("Email: the counterpart's address. Teams: the asker's address. monday: leave out."),
  channel: z.string().max(200).optional().describe('Teams chat or channel name, or monday board name'),
  lesson_ids: z
    .array(z.string().uuid())
    .max(10)
    .optional()
    .describe('ids of the triage_rules lessons that changed where this landed'),
});

/** One conversation to check against the user's hard rules (same fields as a reviewed row). */
const candidateSchema = z.object({
  key: z.string().min(1).max(300).describe('The source_key the conversation will have'),
  source: z.enum(['email', 'teams', 'monday']),
  sender: z.string().max(200).optional(),
  title: z.string().min(1).max(300),
  channel: z.string().max(200).optional(),
});

/** Postgres "relation/function does not exist": the 2.1 migration hasn't been applied yet. */
function notMigrated(error: { code?: string } | null): boolean {
  return !!error && (error.code === '42P01' || error.code === '42883' || error.code === 'PGRST202' || error.code === 'PGRST205');
}

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
  work_type: z
    .enum(WORK_TYPES)
    .optional()
    .describe(
      'Which future worker could do the first pass: reply (a written answer someone is waiting on), ' +
        'dtools_report (a BoM, equipment list or other D-Tools report), ipt_change (a bug or feature request ' +
        'for Instrata Project Tools), none (anything else). Send it on every task.',
    ),
  work_confidence: z.number().min(0).max(1).optional().describe('0-1: how sure you are of work_type'),
  source_ref: z
    .record(z.string().max(60), z.string().max(300))
    .optional()
    .describe('Ids a worker will need later, e.g. {conversation_id, message_id} or {chat_id, message_id}. Ids only.'),
  suggested_project_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      'A project id from find_projects, only for a confident match (monday item id, or the project code or ' +
        'exact number in the subject or summary). Shown to the user as a suggestion; you can never link a task. ' +
        'Skipped if the task is already linked or the user dismissed that project for it.',
    ),
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
        "user's override), recently_closed (closed in the last 14 days; don't re-propose these), feedback " +
        '(recent urgency overrides, dismissals, snoozes, answers, surfaces, and work_type checks: from_value = your ' +
        'tag, to_value = the user’s pick, equal means confirmed) to calibrate, and ' +
        'recently_surfaced (conversations the user pulled out of the reviewed list in the last 30 days: each is ' +
        'a miss, with where the run had put it and why). Treat every recently_surfaced row as a lesson. Also ' +
        "triage_rules: the user's active tuning rules with 30-day hit counts. kind \"lesson\" = a judgment call in " +
        'their words (note) with an example row: read these before classifying. kind "hard" = applied by ' +
        'match_triage_rules, listed here for reference. Each open item carries project_id (linked by the user), ' +
        'suggested_project_id (your earlier suggestion, still pending) and dismissed_project_id (a project the ' +
        'user said no to for that task: never suggest it again). And readme_feedback: the user’s calls on recent ' +
        'Read me lines (last 14 days): state "logged" = worth knowing, more like this; "hidden" = less like this. ' +
        'readme_text is the line as you wrote it; scope / project_id say where a logged line was filed (personal, ' +
        'project or general), so a line the user filed under a project tells you that kind of line belongs there.',
      inputSchema: {
        feedback_days: z.number().int().min(1).max(60).optional().describe('Feedback lookback in days (default 14)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ feedback_days }) => {
      const days = feedback_days ?? 14;
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const closedSince = new Date(Date.now() - 14 * 86_400_000).toISOString();

      const surfacedSince = new Date(Date.now() - 30 * 86_400_000).toISOString();

      const readmeSince = easternToday(new Date(Date.now() - 14 * 86_400_000));
      const [last, open, closed, feedback, surfaced, rules, readme] = await Promise.all([
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
        supa
          .from('worklist_reviewed')
          .select(SURFACED_COLS)
          .eq('user_id', userId)
          .gte('surfaced_at', surfacedSince)
          .order('surfaced_at', { ascending: false })
          .limit(100),
        supa
          .from('triage_rules_with_hits')
          .select(RULE_COLS)
          .eq('user_id', userId)
          .eq('active', true)
          .order('created_at', { ascending: true })
          .limit(200),
        (async () => {
          const query = (cols: string) =>
            supa
              .from('worklist_readme_state')
              .select(cols)
              .eq('user_id', userId)
              .gte('briefing_date', readmeSince)
              .order('at', { ascending: false })
              .limit(100);
          const res = await query(README_STATE_COLS_26);
          // 42703: the 2.6 columns aren't there yet.
          return res.error?.code === '42703' ? query(README_STATE_COLS) : res;
        })(),
      ]);

      const firstError = last.error ?? open.error ?? closed.error ?? feedback.error;
      if (firstError) return fail(firstError.message);
      // Tolerate the reviewed log not existing yet, so deploy order doesn't matter.
      if (surfaced.error && !notMigrated(surfaced.error)) return fail(surfaced.error.message);
      if (rules.error && !notMigrated(rules.error)) return fail(rules.error.message);
      if (readme.error && !notMigrated(readme.error)) return fail(readme.error.message);

      // Attach each rule's example conversation (lessons lean on it).
      const ruleRows = (rules.error ? [] : (rules.data ?? [])) as unknown as Array<Record<string, unknown>>;
      const exampleIds = ruleRows.map((r) => r.example_id).filter((id): id is string => typeof id === 'string');
      let examples = new Map<string, unknown>();
      if (exampleIds.length > 0) {
        const ex = await supa.from('worklist_reviewed').select(EXAMPLE_COLS).in('id', exampleIds);
        if (ex.error) return fail(ex.error.message);
        examples = new Map((ex.data ?? []).map((e) => [(e as { id: string }).id, e]));
      }
      const triageRules = ruleRows.map(({ example_id, ...r }) => ({
        ...r,
        example: typeof example_id === 'string' ? (examples.get(example_id) ?? null) : null,
      }));

      return ok({
        today: easternToday(),
        last_briefing: last.data ?? null,
        open_items: open.data ?? [],
        recently_closed: closed.data ?? [],
        feedback: feedback.data ?? [],
        recently_surfaced: surfaced.error ? [] : (surfaced.data ?? []),
        triage_rules: triageRules,
        readme_feedback: readme.error ? [] : (readme.data ?? []),
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
        'on their date. Items not sent are left as they are (they carry over). Max 100 items. Also send ' +
        '`reviewed`: one row per conversation the run looked at, wherever it landed (max 400), so the user can ' +
        "see and surface anything that was missed. The result's reviewed.violations lists rows whose outcome breaks " +
        "one of the user's hard rules; fix those and call save_briefing once more with the corrected payload. " +
        'reviewed.dismissed / dismissed_keys are open items a "Read me at most" rule took off the list. ' +
        'A read-me line may carry projectId: an exact-match project suggestion (same rules as tasks); if the user ' +
        'logs that line it is shared to the project wiki, so only suggest exact matches. ' +
        'Summaries and links only — never paste email or chat bodies.',
      inputSchema: {
        briefing: briefingSchema,
        items: z.array(itemSchema).max(100).default([]),
        resolved_keys: z
          .array(z.string().min(1).max(300))
          .max(200)
          .default([])
          .describe('source_keys of open items now resolved (e.g. you already replied). Closed as done.'),
        reviewed: z
          .array(reviewedSchema)
          .max(400)
          .optional()
          .describe('Every conversation the run looked at (email thread, Teams chat ask, monday item), one row each.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ briefing, items, resolved_keys, reviewed }) => {
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
      const result: Record<string, unknown> = { ...(data as Record<string, unknown>) };

      // Work-type tags (2.3) and the reviewed log are separate writes after the
      // briefing. If one fails, report it alongside the result instead of failing the run.
      const tags = items
        .filter((i) => i.work_type || i.source_ref || i.suggested_project_id)
        .map((i) => ({
          source_key: i.source_key,
          ...(i.work_type ? { work_type: i.work_type } : {}),
          ...(i.work_confidence !== undefined ? { work_confidence: Math.round(i.work_confidence * 100) / 100 } : {}),
          ...(i.source_ref ? { source_ref: i.source_ref } : {}),
          ...(i.suggested_project_id ? { suggested_project_id: i.suggested_project_id.toLowerCase() } : {}),
        }));
      if (tags.length > 0) {
        const wt = await supa.rpc('save_work_tags', { p_tags: tags });
        result.work_tags = wt.error
          ? { error: notMigrated(wt.error) ? 'work-type tagging not set up yet (migration pending)' : wt.error.message }
          : wt.data;
      }

      if (reviewed) {
        const rv = await supa.rpc('save_reviewed', { p_date: briefing.date, p_rows: reviewed });
        result.reviewed = rv.error
          ? { error: notMigrated(rv.error) ? 'reviewed log not set up yet (migration pending)' : rv.error.message }
          : rv.data;
      }
      return ok(result);
    },
  );

  // ── Read: which hard tuning rules apply to this run's conversations ─────────
  server.registerTool(
    'match_triage_rules',
    {
      title: 'Match my triage rules',
      description:
        'Personal My Day worklist (2.2 tuning rules). Call once in a morning-worklist run, after gathering every ' +
        'conversation and before deciding where each lands. Send one candidate per conversation (the same ' +
        'conversations as the reviewed rows): key (its source_key), source, sender address, title, and chat / ' +
        'board name. Returns hard_rules (how many are active) and matched: for each candidate a hard rule ' +
        'matches, `effects` (every effect to honour, floors first), `effect` (the first of them) and the rule ' +
        'ids. Effects are binding: min_task = must be a task (respond, do or decide), min_read_me = at least a ' +
        'Read me line, max_read_me = never a task (Read me, Set aside or dropped; this one also applies to items ' +
        'already open, which the database dismisses once the run lands them below the list), suppress = Set ' +
        'aside (never moves an item that is already open). A floor beats a ceiling it conflicts with, so ' +
        'min_read_me + max_read_me means exactly a Read me line. Matching is done by the database, so it is ' +
        'the same every run.',
      inputSchema: {
        candidates: z.array(candidateSchema).max(500),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ candidates }) => {
      const { data, error } = await supa.rpc('match_triage_rules', { p_candidates: candidates });
      if (error) {
        if (notMigrated(error)) return ok({ hard_rules: 0, candidates: candidates.length, matched: [], note: 'tuning rules not set up yet' });
        return fail(error.message);
      }
      return ok(data);
    },
  );

  // ── Read: projects for the run's suggestions (2.4) ─────────────────────────
  server.registerTool(
    'find_projects',
    {
      title: 'Find projects by code, number or monday item',
      description:
        'Personal My Day worklist (2.4 connect project). Batch lookup for suggesting a project on a task: send ' +
        'the project codes (INST-YYYY-NNNN) and exact project numbers seen in subjects or summaries, and the ' +
        'monday item ids of monday tasks. Returns each matching project (id, project_code, number, name, client, ' +
        'status) with matched_by saying which input found it (code, number, monday_presales or ' +
        'monday_postsales). Exact matches only. Use the id as suggested_project_id on that task in save_briefing.',
      inputSchema: {
        codes: z.array(z.string().min(1).max(40)).max(100).optional(),
        numbers: z.array(z.string().min(1).max(60)).max(100).optional(),
        monday_item_ids: z.array(z.number().int().positive()).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ codes, numbers, monday_item_ids }) => {
      const cols = 'id, project_code, number, name, client, status, monday_presales_item_id, monday_postsales_item_id';
      const codeList = [...new Set((codes ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean))];
      const numberList = [...new Set((numbers ?? []).map((n) => n.trim()).filter(Boolean))];
      const ids = [...new Set(monday_item_ids ?? [])];
      if (codeList.length + numberList.length + ids.length === 0) return ok({ projects: [] });

      const empty = Promise.resolve({ data: [] as Record<string, unknown>[], error: null });
      const [byCode, byNumber, byPre, byPost] = await Promise.all([
        codeList.length ? supa.from('projects').select(cols).in('project_code', codeList) : empty,
        numberList.length ? supa.from('projects').select(cols).in('number', numberList) : empty,
        ids.length ? supa.from('projects').select(cols).in('monday_presales_item_id', ids) : empty,
        ids.length ? supa.from('projects').select(cols).in('monday_postsales_item_id', ids) : empty,
      ]);
      const err = byCode.error ?? byNumber.error ?? byPre.error ?? byPost.error;
      if (err) return fail(err.message);

      const found = new Map<string, Record<string, unknown> & { matched_by: string[] }>();
      const add = (rows: unknown[] | null, how: string) => {
        for (const row of (rows ?? []) as Array<Record<string, unknown>>) {
          const id = row.id as string;
          const hit = found.get(id) ?? { ...row, matched_by: [] };
          if (!hit.matched_by.includes(how)) hit.matched_by.push(how);
          found.set(id, hit);
        }
      };
      add(byCode.data, 'code');
      add(byNumber.data, 'number');
      add(byPre.data, 'monday_presales');
      add(byPost.data, 'monday_postsales');
      return ok({ projects: [...found.values()] });
    },
  );
}
