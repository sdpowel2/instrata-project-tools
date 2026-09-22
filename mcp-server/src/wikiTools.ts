/**
 * Project Wiki tools — the per-project knowledge base (project context, one
 * record per room / subsystem, decisions with rationale, questions log, labor
 * buckets, links to BoM lines and files). Spec: Product Spec/project-tools-wiki-spec.md.
 *
 * Two consumers, both first-class: the AVSS bid pipeline skill writing design
 * validation output, and engineers (or a notes-aggregation skill) recording
 * project knowledge by hand. `origin` records provenance and never gates
 * anything.
 *
 * Everything runs through the per-user client, so RLS is the authorization
 * boundary: reads are org-wide, writes succeed only on projects the caller is
 * a member of (mapped to an explicit not-a-member error).
 *
 * Idempotency: upsert_project_room keys on (project_id, dtools_location) or
 * id, so a pipeline re-run reconciles instead of duplicating rooms.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ok, fail, type ToolRegistrar } from './toolHelpers.js';

// ── Vocabulary (twin of app/src/lib/projectWiki.ts — keep in sync) ───────────
const WIKI_STATUSES = ['draft', 'in_progress', 'awaiting_review', 'reviewed', 'final'] as const;
const ENTRY_KINDS = ['room', 'subsystem', 'head_end', 'zone', 'project_wide'] as const;
const SIZE_CLASSES = ['small_medium', 'large_xl', 'oversize'] as const;
const SIZE_BASES = ['sqft', 'seat_count', 'display_count', 'stated', 'undetermined'] as const;
const ROOM_STATUSES = ['pending', 'clean', 'noted', 'escalated', 'resolved', 'authored'] as const;
const ORIGINS = ['agent', 'human', 'agent_human_edited'] as const;
const DECISION_KINDS = ['validated', 'deviation_accepted', 'assumption', 'rationale', 'escalation_outcome'] as const;
const QUESTION_SEVERITIES = ['functional_conflict', 'estimating_escalation'] as const;
const QUESTION_STATUSES = ['open', 'answered', 'resolved', 'withdrawn'] as const;
const LABOR_TYPES = ['install', 'cabling', 'bench', 'commissioning', 'programming', 'engineering', 'mobilization', 'training'] as const;
/** The four per-room rows the estimating CSV requires even at 0.00 (labor-estimating-rules.md §"Every room"). */
const REQUIRED_LABOR_TYPES = ['bench', 'cabling', 'commissioning', 'programming'] as const;

const NOT_MEMBER_MSG =
  'You are not a member of this project, so you can\'t write to its wiki. ' +
  'Ask a project admin to add you as a member in the app (or use "Add me" on the Projects page).';

/** PostgREST surfaces RLS insert/update violations as code 42501. */
function rlsDenied(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42501' || /row-level security/i.test(error.message ?? '');
}

const ROOM_COLS =
  'id, project_id, room_number, room_name, floor, dtools_location, sort_order, entry_kind, room_type, ' +
  'area_sqft, size_class, size_basis, has_conferencing, typical_of_count, typical_of_rooms, status, headline, ' +
  'detail, validation_notes, origin, created_by, created_at, updated_at';
const INDEX_COLS =
  'id, project_id, sort_order, room_number, room_name, floor, dtools_location, entry_kind, room_type, size_class, ' +
  'has_conferencing, typical_of_count, status, headline, origin, updated_at, decision_count, open_question_count, ' +
  'answered_question_count, labor_hours';
const DECISION_COLS =
  'id, project_id, room_id, kind, title, rationale, source_ref, assumption_confirmed, origin, created_by, created_at, updated_at';
const QUESTION_COLS =
  'id, project_id, room_id, severity, question, context, status, answer, resolution, resulting_decision_id, ' +
  'raised_by, answered_by, raised_at, answered_at';
const LABOR_COLS = 'id, room_id, labor_type, hours, basis, origin, updated_at';
const WIKI_COLS = 'id, project_id, summary, scope_summary, design_basis, status, pipeline_run_at, created_by, created_at, updated_at';

type Row = Record<string, unknown>;

/** Drop undefined keys so PostgREST only touches the columns the caller supplied. */
function compact<T extends Row>(obj: T): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function typicalWarnings(count: number | null | undefined, rooms: string[] | null | undefined): string[] {
  if (count == null || rooms == null) return [];
  if (rooms.length !== count) {
    return [`typical_of_count is ${count} but typical_of_rooms lists ${rooms.length} room(s) — the two should agree.`];
  }
  return [];
}

export function registerWikiTools(server: ToolRegistrar, supa: SupabaseClient, userId: string): void {
  // ═══════════════════════════════════════════════════════════════════════════
  // READ
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    'get_project_wiki',
    {
      title: 'Get a project wiki',
      description:
        'Return the project-level wiki context (summary, scope, design basis, status) plus the room ' +
        'index: one line per room / subsystem with status, headline, decision count and open-question ' +
        'count, in display order. Rooms at status "escalated" and questions at "open" are the blocking ' +
        'set. wiki is null if no project-level context has been written yet (rooms can still exist). ' +
        'Start here, then drill into get_project_room or search_project_wiki.',
      inputSchema: { project_id: z.string().describe('Project uuid (from list_projects)') },
    },
    async ({ project_id }) => {
      const [{ data: wiki, error: wErr }, { data: rooms, error: rErr }, { data: questions, error: qErr }] = await Promise.all([
        supa.from('project_wiki').select(WIKI_COLS).eq('project_id', project_id).maybeSingle(),
        supa.from('wiki_room_index').select(INDEX_COLS).eq('project_id', project_id).order('sort_order').order('room_number'),
        supa.from('wiki_questions').select('id, severity, status, room_id').eq('project_id', project_id).in('status', ['open', 'answered']),
      ]);
      if (wErr) return fail(wErr.message);
      if (rErr) return fail(rErr.message);
      if (qErr) return fail(qErr.message);
      const idx = (rooms ?? []) as unknown as Row[];
      const openItems = (questions ?? []) as Row[];
      return ok({
        wiki: wiki ?? null,
        room_count: idx.length,
        blocking: {
          escalated_rooms: idx.filter((r) => r.status === 'escalated').length,
          open_functional_conflicts: openItems.filter((q) => q.status === 'open' && q.severity === 'functional_conflict').length,
          open_estimating_escalations: openItems.filter((q) => q.status === 'open' && q.severity === 'estimating_escalation').length,
          answered_unresolved: openItems.filter((q) => q.status === 'answered').length,
        },
        rooms: idx,
      });
    },
  );

  server.registerTool(
    'list_project_rooms',
    {
      title: 'List wiki rooms',
      description:
        'Room index rows for a project (one per room / subsystem), optionally filtered by status, ' +
        'room_type or entry_kind. Each row carries decision_count, open_question_count and labor_hours.',
      inputSchema: {
        project_id: z.string().describe('Project uuid'),
        status: z.enum(ROOM_STATUSES).optional(),
        room_type: z.string().optional().describe('Exact room_type text, e.g. "Small Conference"'),
        entry_kind: z.enum(ENTRY_KINDS).optional(),
      },
    },
    async ({ project_id, status, room_type, entry_kind }) => {
      let q = supa.from('wiki_room_index').select(INDEX_COLS).eq('project_id', project_id).order('sort_order').order('room_number');
      if (status) q = q.eq('status', status);
      if (room_type) q = q.eq('room_type', room_type);
      if (entry_kind) q = q.eq('entry_kind', entry_kind);
      const { data, error } = await q;
      return error ? fail(error.message) : ok(data);
    },
  );

  server.registerTool(
    'get_project_room',
    {
      title: 'Get one wiki room in full',
      description:
        'Full record for one room / subsystem: the room fields (headline, detail, validation_notes, ' +
        'sizing, typical-of roster), its decisions with rationale, its questions with answers, its ' +
        'labor buckets, and linked BoM lines / files. Look up by room_id, or by project_id plus ' +
        'dtools_location or room_number.',
      inputSchema: {
        room_id: z.string().optional().describe('Room uuid (from get_project_wiki / list_project_rooms)'),
        project_id: z.string().optional().describe('Required when looking up by location or number'),
        dtools_location: z.string().optional().describe('Full D-Tools location string'),
        room_number: z.string().optional().describe('Room number, e.g. "311"'),
      },
    },
    async ({ room_id, project_id, dtools_location, room_number }) => {
      let roomQ = supa.from('wiki_rooms').select(ROOM_COLS);
      if (room_id) roomQ = roomQ.eq('id', room_id);
      else if (project_id && dtools_location) roomQ = roomQ.eq('project_id', project_id).eq('dtools_location', dtools_location);
      else if (project_id && room_number) roomQ = roomQ.eq('project_id', project_id).eq('room_number', room_number);
      else return fail('Provide room_id, or project_id with dtools_location or room_number.');
      const { data: rooms, error: rErr } = await roomQ.limit(2);
      if (rErr) return fail(rErr.message);
      if (!rooms || rooms.length === 0) return fail('Room not found (it may not exist, or you may not have access).');
      if (rooms.length > 1) return fail('More than one room matched — use room_id or dtools_location instead.');
      const room = rooms[0] as unknown as Row;
      const id = room.id as string;

      const [dec, qs, lab, bom, files] = await Promise.all([
        supa.from('wiki_decisions').select(DECISION_COLS).eq('room_id', id).order('created_at'),
        supa.from('wiki_questions').select(QUESTION_COLS).eq('room_id', id).order('raised_at'),
        supa.from('wiki_labor').select(LABOR_COLS).eq('room_id', id).order('labor_type'),
        supa
          .from('wiki_room_bom_lines')
          .select('id, bom_item_id, note, created_at, project_bom_items(manufacturer, model, description, qty, item_type, locations)')
          .eq('room_id', id),
        supa
          .from('wiki_room_files')
          .select('id, file_id, note, created_at, project_files(filename, category, doc_type, sharepoint_web_url)')
          .eq('room_id', id),
      ]);
      const firstErr = [dec, qs, lab, bom, files].find((r) => r.error)?.error;
      if (firstErr) return fail(firstErr.message);

      return ok({
        ...room,
        warnings: typicalWarnings(room.typical_of_count as number | null, room.typical_of_rooms as string[] | null),
        decisions: dec.data ?? [],
        questions: qs.data ?? [],
        labor: lab.data ?? [],
        bom_lines: bom.data ?? [],
        files: files.data ?? [],
      });
    },
  );

  server.registerTool(
    'list_room_decisions',
    {
      title: 'List wiki decisions',
      description:
        'Decisions (with rationale) for a project. Scope to one room with room_id, or to project-level ' +
        'decisions only with project_level_only. Filter by kind. "assumption" rows are the ones a review ' +
        'should challenge; assumption_confirmed records whether a human has confirmed each one.',
      inputSchema: {
        project_id: z.string().describe('Project uuid'),
        room_id: z.string().optional().describe('Only decisions on this room'),
        project_level_only: z.boolean().optional().describe('Only decisions with no room (default false)'),
        kind: z.enum(DECISION_KINDS).optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 200)'),
      },
    },
    async ({ project_id, room_id, project_level_only, kind, limit }) => {
      let q = supa
        .from('wiki_decisions')
        .select(`${DECISION_COLS}, wiki_rooms(room_number, room_name)`)
        .eq('project_id', project_id)
        .order('created_at')
        .limit(limit ?? 200);
      if (room_id) q = q.eq('room_id', room_id);
      else if (project_level_only) q = q.is('room_id', null);
      if (kind) q = q.eq('kind', kind);
      const { data, error } = await q;
      return error ? fail(error.message) : ok(data);
    },
  );

  server.registerTool(
    'list_project_questions',
    {
      title: 'List wiki questions',
      description:
        'The questions log for a project, oldest first. Filter by severity ("functional_conflict" = ' +
        'blocks the design, answer one at a time; "estimating_escalation" = batch into one needs-your-input ' +
        'list) and status. Default returns open and answered-but-unresolved questions — the "needs ' +
        'your input" set. Pass status "all" for the full history.',
      inputSchema: {
        project_id: z.string().describe('Project uuid'),
        room_id: z.string().optional().describe('Only questions on this room'),
        severity: z.enum(QUESTION_SEVERITIES).optional(),
        status: z.enum([...QUESTION_STATUSES, 'all']).optional().describe('Default: open + answered'),
      },
    },
    async ({ project_id, room_id, severity, status }) => {
      let q = supa
        .from('wiki_questions')
        .select(`${QUESTION_COLS}, wiki_rooms(room_number, room_name)`)
        .eq('project_id', project_id)
        .order('raised_at');
      if (room_id) q = q.eq('room_id', room_id);
      if (severity) q = q.eq('severity', severity);
      if (!status) q = q.in('status', ['open', 'answered']);
      else if (status !== 'all') q = q.eq('status', status);
      const { data, error } = await q;
      return error ? fail(error.message) : ok(data);
    },
  );

  server.registerTool(
    'search_project_wiki',
    {
      title: 'Search a project wiki',
      description:
        'Full-text search across a project\'s wiki: room headlines / detail / validation notes, ' +
        'decision titles / rationale, questions / answers, and the project-level context. This is how ' +
        'you answer "why are there 3 transmitters and 4 receivers in room 311?" — search, then read ' +
        'the matching decision\'s rationale or open the room with get_project_room. Supports web-style ' +
        'syntax: quoted phrases, OR, and -excluded words. Snippets mark matches with <b>…</b>.',
      inputSchema: {
        project_id: z.string().describe('Project uuid'),
        query: z.string().min(1).describe('Search terms, e.g. "transmitter receiver count" or "311 DSP"'),
        limit: z.number().int().min(1).max(200).optional().describe('Max hits (default 25)'),
      },
    },
    async ({ project_id, query, limit }) => {
      const { data, error } = await supa.rpc('search_project_wiki', {
        p_project_id: project_id,
        p_query: query,
        p_limit: limit ?? 25,
      });
      return error ? fail(error.message) : ok({ query, hits: data ?? [] });
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // WRITE
  // ═══════════════════════════════════════════════════════════════════════════

  server.registerTool(
    'upsert_project_wiki',
    {
      title: 'Create or update project-level wiki context',
      description:
        'Create the project wiki record or update it. Only the fields you pass are changed. Long-form ' +
        'fields are markdown. Set pipeline_run_at (ISO timestamp) when a pipeline run produced the ' +
        'content. Status "awaiting_review" is the explicit human-gate marker.',
      inputSchema: {
        project_id: z.string().describe('Project uuid'),
        summary: z.string().nullable().optional().describe('Project-level orientation, markdown'),
        scope_summary: z.string().nullable().optional().describe('What the AV scope covers, prose'),
        design_basis: z.string().nullable().optional().describe('Consultant documents the design derives from, with revision/date'),
        status: z.enum(WIKI_STATUSES).optional(),
        pipeline_run_at: z.string().nullable().optional().describe('ISO timestamp of the pipeline run; null for hand-authored'),
      },
    },
    async ({ project_id, ...rest }) => {
      const patch = compact(rest);
      const { data, error } = await supa
        .from('project_wiki')
        .upsert({ project_id, ...patch }, { onConflict: 'project_id' })
        .select(WIKI_COLS)
        .single();
      if (rlsDenied(error)) return fail(NOT_MEMBER_MSG);
      if (error) return fail(error.message);
      return ok(data);
    },
  );

  server.registerTool(
    'upsert_project_room',
    {
      title: 'Create or update a wiki room / subsystem',
      description:
        'Idempotent create-or-update of one room / subsystem record. Matches an existing row by room_id, ' +
        'else by (project_id, dtools_location); otherwise inserts. Only supplied fields change on update. ' +
        'headline (one line, the index entry) is required on create; status defaults to "pending" for ' +
        'agent origin and "authored" for human origin. Not every entry is a physical room — use ' +
        'entry_kind head_end / zone / subsystem / project_wide as appropriate, with room_number null. ' +
        'For "Typical of N" locations set typical_of_count and list every covered room in ' +
        'typical_of_rooms so none is silently unmentioned. Returns the row plus created: true|false.',
      inputSchema: {
        project_id: z.string().describe('Project uuid'),
        room_id: z.string().optional().describe('Existing room uuid to update'),
        dtools_location: z.string().nullable().optional().describe('Full D-Tools location string, e.g. "2nd Floor: 236 - Md Conference 2". The re-run reconciliation key.'),
        room_number: z.string().nullable().optional(),
        room_name: z.string().optional().describe('Required on create'),
        floor: z.string().nullable().optional(),
        sort_order: z.number().int().optional().describe('Display order; mirror D-Tools location ordering'),
        entry_kind: z.enum(ENTRY_KINDS).optional(),
        room_type: z.string().nullable().optional().describe('Free text, groups typicals, e.g. "Small Conference"'),
        area_sqft: z.number().nullable().optional(),
        size_class: z.enum(SIZE_CLASSES).nullable().optional(),
        size_basis: z.enum(SIZE_BASES).nullable().optional(),
        has_conferencing: z.boolean().nullable().optional(),
        typical_of_count: z.number().int().min(1).nullable().optional(),
        typical_of_rooms: z.array(z.string()).nullable().optional(),
        status: z.enum(ROOM_STATUSES).optional(),
        headline: z.string().optional().describe('One-line index entry. Required on create; keep short.'),
        detail: z.string().nullable().optional().describe('Long-form design notes, markdown'),
        validation_notes: z.string().nullable().optional().describe('The math: counts, coverage, headroom, power'),
        origin: z.enum(ORIGINS).optional().describe('Provenance (default "agent" on create; unchanged on update unless passed)'),
      },
    },
    async ({ project_id, room_id, ...rest }) => {
      const patch = compact(rest);
      if (typeof patch.headline === 'string' && !patch.headline.trim()) return fail('headline cannot be blank.');

      // Locate an existing row: by id, else by location.
      let existing: Row | null = null;
      if (room_id) {
        const { data, error } = await supa.from('wiki_rooms').select('id, project_id, origin').eq('id', room_id).maybeSingle();
        if (error) return fail(error.message);
        if (!data) return fail('room_id not found (it may not exist, or you may not have access).');
        existing = data as Row;
      } else if (typeof patch.dtools_location === 'string' && patch.dtools_location) {
        const { data, error } = await supa
          .from('wiki_rooms')
          .select('id, project_id, origin')
          .eq('project_id', project_id)
          .eq('dtools_location', patch.dtools_location)
          .maybeSingle();
        if (error) return fail(error.message);
        existing = (data as Row | null) ?? null;
      }

      const warnings = typicalWarnings(
        patch.typical_of_count as number | null | undefined,
        patch.typical_of_rooms as string[] | null | undefined,
      );

      if (existing) {
        if (existing.project_id !== project_id) return fail('room_id belongs to a different project.');
        if (Object.keys(patch).length === 0) return fail('Provide at least one field to update.');
        const { data, error } = await supa.from('wiki_rooms').update(patch).eq('id', existing.id as string).select(ROOM_COLS);
        if (rlsDenied(error)) return fail(NOT_MEMBER_MSG);
        if (error) return fail(error.message);
        if (!data || data.length === 0) return fail(`Update touched no rows — ${NOT_MEMBER_MSG}`);
        return ok({ created: false, warnings, ...(data[0] as unknown as Row) });
      }

      if (!patch.room_name || !patch.headline) return fail('room_name and headline are required to create a room.');
      const origin = (patch.origin as string | undefined) ?? 'agent';
      const insert: Row = {
        project_id,
        ...patch,
        origin,
        status: patch.status ?? (origin === 'human' ? 'authored' : 'pending'),
      };
      const { data, error } = await supa.from('wiki_rooms').insert(insert).select(ROOM_COLS).single();
      if (rlsDenied(error)) return fail(NOT_MEMBER_MSG);
      if (error) {
        if (error.code === '23505') return fail('A room with that dtools_location already exists on this project (race). Retry the upsert.');
        return fail(error.message);
      }
      return ok({ created: true, warnings, ...(data as unknown as Row) });
    },
  );

  server.registerTool(
    'set_room_status',
    {
      title: 'Set a wiki room\'s status',
      description:
        'Transition a room\'s status, optionally updating its one-line headline at the same time. ' +
        'Statuses: pending (not yet evaluated), clean (validated, no issues), noted (non-functional ' +
        'deviation accepted), escalated (question raised, unresolved — blocking), resolved (question ' +
        'answered, decision logged), authored (human-written, no pipeline validation).',
      inputSchema: {
        room_id: z.string().describe('Room uuid'),
        status: z.enum(ROOM_STATUSES),
        headline: z.string().optional().describe('New one-line index entry'),
      },
    },
    async ({ room_id, status, headline }) => {
      if (headline !== undefined && !headline.trim()) return fail('headline cannot be blank.');
      const patch: Row = { status };
      if (headline !== undefined) patch.headline = headline;
      const { data, error } = await supa.from('wiki_rooms').update(patch).eq('id', room_id).select(ROOM_COLS);
      if (rlsDenied(error)) return fail(NOT_MEMBER_MSG);
      if (error) return fail(error.message);
      if (!data || data.length === 0) return fail(`Room not found — it may not exist, or: ${NOT_MEMBER_MSG}`);
      return ok(data[0]);
    },
  );

  server.registerTool(
    'append_room_decision',
    {
      title: 'Append a decision (with rationale)',
      description:
        'Record a decision on a room, or project-wide when room_id is omitted. Append-only by design: ' +
        'to change your mind, append a new decision and say in its rationale what it supersedes. ' +
        'title is the decision in one line (e.g. "3 transmitters, 4 receivers"); rationale is the why — ' +
        'this is what future readers will search for. Use kind "assumption" for anything not ' +
        'confirmed by a document or a human, and cite the consultant sheet / spec section in source_ref.',
      inputSchema: {
        project_id: z.string().describe('Project uuid (required; ignored in favour of the room\'s project when room_id is set)'),
        room_id: z.string().nullable().optional().describe('Room uuid; omit / null for a project-level decision'),
        kind: z.enum(DECISION_KINDS),
        title: z.string().min(1).describe('The decision, one line'),
        rationale: z.string().describe('Why. Markdown.'),
        source_ref: z.string().nullable().optional().describe('Consultant doc, sheet number, spec section'),
        assumption_confirmed: z.boolean().nullable().optional().describe('Only meaningful when kind = "assumption"'),
        origin: z.enum(ORIGINS).optional().describe('Default "agent"'),
      },
    },
    async ({ project_id, room_id, kind, title, rationale, source_ref, assumption_confirmed, origin }) => {
      if (!title.trim()) return fail('title cannot be blank.');
      const { data, error } = await supa
        .from('wiki_decisions')
        .insert(compact({
          project_id,
          room_id: room_id ?? null,
          kind,
          title,
          rationale,
          source_ref,
          assumption_confirmed,
          origin: origin ?? 'agent',
        }))
        .select(DECISION_COLS)
        .single();
      if (rlsDenied(error)) return fail(NOT_MEMBER_MSG);
      if (error) return fail(error.message);
      return ok(data);
    },
  );

  server.registerTool(
    'set_room_labor',
    {
      title: 'Replace a room\'s labor buckets',
      description:
        'Replace the full labor set for one room. hours of 0 is meaningful and is stored — never omit ' +
        'a bucket to mean zero. By default the four rows the estimating CSV requires (bench, cabling, ' +
        'commissioning, programming) are filled in at 0.00 when you don\'t supply them; pass ' +
        'fill_required_with_zero: false to store exactly what you send. basis records the inputs that ' +
        'produced the number, e.g. "2 displays + 12 speakers + 1 rack".',
      inputSchema: {
        room_id: z.string().describe('Room uuid'),
        labor: z
          .array(
            z.object({
              labor_type: z.enum(LABOR_TYPES),
              hours: z.number().min(0).describe('Decimal hours; 0 is valid and stored'),
              basis: z.string().nullable().optional(),
            }),
          )
          .describe('One entry per bucket; duplicates of a labor_type are rejected'),
        fill_required_with_zero: z.boolean().optional().describe('Default true'),
        origin: z.enum(ORIGINS).optional().describe('Default "agent"'),
      },
    },
    async ({ room_id, labor, fill_required_with_zero, origin }) => {
      const seen = new Set<string>();
      for (const l of labor) {
        if (seen.has(l.labor_type)) return fail(`labor_type "${l.labor_type}" appears more than once.`);
        seen.add(l.labor_type);
      }
      const rows = labor.map((l) => ({ room_id, labor_type: l.labor_type, hours: l.hours, basis: l.basis ?? null, origin: origin ?? 'agent' }));
      if (fill_required_with_zero !== false) {
        for (const t of REQUIRED_LABOR_TYPES) {
          if (!seen.has(t)) rows.push({ room_id, labor_type: t, hours: 0, basis: null, origin: origin ?? 'agent' });
        }
      }
      // Confirm the room is visible (and get its project for the insert's RLS check).
      const { data: room, error: roomErr } = await supa.from('wiki_rooms').select('id, project_id').eq('id', room_id).maybeSingle();
      if (roomErr) return fail(roomErr.message);
      if (!room) return fail('Room not found (it may not exist, or you may not have access).');

      const { error: delErr } = await supa.from('wiki_labor').delete().eq('room_id', room_id);
      if (rlsDenied(delErr)) return fail(NOT_MEMBER_MSG);
      if (delErr) return fail(delErr.message);
      if (rows.length === 0) return ok({ room_id, labor: [] });

      const { data, error } = await supa
        .from('wiki_labor')
        .insert(rows.map((r) => ({ ...r, project_id: room.project_id })))
        .select(LABOR_COLS)
        .order('labor_type');
      if (rlsDenied(error)) return fail(NOT_MEMBER_MSG);
      if (error) return fail(error.message);
      const total = (data ?? []).reduce((s, r) => s + Number((r as Row).hours ?? 0), 0);
      return ok({ room_id, total_hours: total, labor: data });
    },
  );

  server.registerTool(
    'raise_room_question',
    {
      title: 'Raise a question',
      description:
        'Log a question at status "open", on a room or project-wide (omit room_id). severity drives ' +
        'how a human is interrupted: "functional_conflict" for anything that blocks the design (the ' +
        'consultant\'s drawings contradict each other, a count can\'t work) — one at a time; ' +
        '"estimating_escalation" for judgement calls that can wait for a batched review. By default a ' +
        'room with a newly open question moves to status "escalated" (pass escalate_room: false to leave it).',
      inputSchema: {
        project_id: z.string().describe('Project uuid (ignored in favour of the room\'s project when room_id is set)'),
        room_id: z.string().nullable().optional(),
        severity: z.enum(QUESTION_SEVERITIES),
        question: z.string().min(1),
        context: z.string().nullable().optional().describe('What you saw that prompted it'),
        escalate_room: z.boolean().optional().describe('Also set the room to "escalated" (default true)'),
      },
    },
    async ({ project_id, room_id, severity, question, context, escalate_room }) => {
      if (!question.trim()) return fail('question cannot be blank.');
      const { data, error } = await supa
        .from('wiki_questions')
        .insert(compact({ project_id, room_id: room_id ?? null, severity, question, context, status: 'open', raised_by: userId }))
        .select(QUESTION_COLS)
        .single();
      if (rlsDenied(error)) return fail(NOT_MEMBER_MSG);
      if (error) return fail(error.message);

      let roomStatusChanged = false;
      if (room_id && escalate_room !== false) {
        const { data: upd } = await supa.from('wiki_rooms').update({ status: 'escalated' }).eq('id', room_id).neq('status', 'escalated').select('id');
        roomStatusChanged = !!upd && upd.length > 0;
      }
      return ok({ ...(data as unknown as Row), room_status_changed_to_escalated: roomStatusChanged });
    },
  );

  server.registerTool(
    'answer_room_question',
    {
      title: 'Answer a question',
      description:
        'Record the human\'s answer to a question (verbatim in answer), optionally the resulting ' +
        'resolution in prose, and optionally log the resulting decision in one step (decision: {kind, ' +
        'title, rationale, source_ref}) — the question is then linked to it and moves to "resolved"; ' +
        'without a decision it moves to "answered" (or the status you pass, e.g. "withdrawn"). When the ' +
        'question\'s room is "escalated" and this leaves it with no open questions, the room moves to ' +
        '"resolved" if a decision was logged.',
      inputSchema: {
        question_id: z.string().describe('Question uuid'),
        answer: z.string().describe('The answer, verbatim'),
        resolution: z.string().nullable().optional().describe('The resulting decision, in prose'),
        status: z.enum(['answered', 'resolved', 'withdrawn']).optional().describe('Default: "resolved" when a decision is given, else "answered"'),
        decision: z
          .object({
            kind: z.enum(DECISION_KINDS).optional().describe('Default "escalation_outcome"'),
            title: z.string().min(1),
            rationale: z.string(),
            source_ref: z.string().nullable().optional(),
          })
          .optional()
          .describe('Log this decision and link the question to it'),
        origin: z.enum(ORIGINS).optional().describe('Origin for the logged decision (default "agent")'),
      },
    },
    async ({ question_id, answer, resolution, status, decision, origin }) => {
      const { data: q, error: qErr } = await supa
        .from('wiki_questions')
        .select('id, project_id, room_id, status')
        .eq('id', question_id)
        .maybeSingle();
      if (qErr) return fail(qErr.message);
      if (!q) return fail('Question not found (it may not exist, or you may not have access).');
      const qRow = q as Row;

      let decisionRow: Row | null = null;
      if (decision) {
        const { data: d, error: dErr } = await supa
          .from('wiki_decisions')
          .insert(compact({
            project_id: qRow.project_id,
            room_id: qRow.room_id ?? null,
            kind: decision.kind ?? 'escalation_outcome',
            title: decision.title,
            rationale: decision.rationale,
            source_ref: decision.source_ref,
            origin: origin ?? 'agent',
          }))
          .select(DECISION_COLS)
          .single();
        if (rlsDenied(dErr)) return fail(NOT_MEMBER_MSG);
        if (dErr) return fail(dErr.message);
        decisionRow = d as Row;
      }

      const newStatus = status ?? (decisionRow ? 'resolved' : 'answered');
      const patch: Row = {
        answer,
        status: newStatus,
        answered_by: userId,
        answered_at: new Date().toISOString(),
      };
      if (resolution !== undefined) patch.resolution = resolution;
      if (decisionRow) patch.resulting_decision_id = decisionRow.id;
      const { data: updated, error: uErr } = await supa.from('wiki_questions').update(patch).eq('id', question_id).select(QUESTION_COLS);
      if (rlsDenied(uErr)) return fail(NOT_MEMBER_MSG);
      if (uErr) return fail(uErr.message);
      if (!updated || updated.length === 0) return fail(`Update touched no rows — ${NOT_MEMBER_MSG}`);

      // Room follow-through: escalated → resolved once nothing is left open and a decision exists.
      let roomStatus: string | null = null;
      const roomId = qRow.room_id as string | null;
      if (roomId && decisionRow && newStatus === 'resolved') {
        const { count } = await supa.from('wiki_questions').select('id', { count: 'exact', head: true }).eq('room_id', roomId).eq('status', 'open');
        if ((count ?? 0) === 0) {
          const { data: r } = await supa.from('wiki_rooms').update({ status: 'resolved' }).eq('id', roomId).eq('status', 'escalated').select('status');
          if (r && r.length > 0) roomStatus = 'resolved';
        }
      }
      return ok({ question: updated[0], decision: decisionRow, room_status_changed_to: roomStatus });
    },
  );

  server.registerTool(
    'link_room_bom_lines',
    {
      title: 'Link BoM line items to a wiki room',
      description:
        'Tie a room to the project BoM lines that serve it (ids from get_project_bom). Already-linked ' +
        'items are skipped, so this is safe to repeat. Returns the room\'s full link set.',
      inputSchema: {
        room_id: z.string().describe('Room uuid'),
        bom_item_ids: z.array(z.string()).min(1).describe('project_bom_items ids'),
        note: z.string().nullable().optional().describe('Applied to each new link'),
      },
    },
    async ({ room_id, bom_item_ids, note }) => {
      const { data: room, error: roomErr } = await supa.from('wiki_rooms').select('id, project_id').eq('id', room_id).maybeSingle();
      if (roomErr) return fail(roomErr.message);
      if (!room) return fail('Room not found (it may not exist, or you may not have access).');
      const rows = [...new Set(bom_item_ids)].map((bom_item_id) => ({ room_id, project_id: room.project_id, bom_item_id, note: note ?? null }));
      const { error } = await supa.from('wiki_room_bom_lines').upsert(rows, { onConflict: 'room_id,bom_item_id', ignoreDuplicates: true });
      if (rlsDenied(error)) return fail(NOT_MEMBER_MSG);
      if (error) return fail(error.message);
      const { data, error: listErr } = await supa
        .from('wiki_room_bom_lines')
        .select('id, bom_item_id, note, created_at, project_bom_items(manufacturer, model, description, qty, item_type)')
        .eq('room_id', room_id);
      return listErr ? fail(listErr.message) : ok({ room_id, bom_lines: data });
    },
  );

  server.registerTool(
    'link_room_files',
    {
      title: 'Link project files to a wiki room',
      description:
        'Tie a room to project files (drawings, sketches, RCPs — ids from list_project_files). ' +
        'Already-linked files are skipped. Returns the room\'s full link set.',
      inputSchema: {
        room_id: z.string().describe('Room uuid'),
        file_ids: z.array(z.string()).min(1).describe('project_files ids'),
        note: z.string().nullable().optional().describe('Applied to each new link'),
      },
    },
    async ({ room_id, file_ids, note }) => {
      const { data: room, error: roomErr } = await supa.from('wiki_rooms').select('id, project_id').eq('id', room_id).maybeSingle();
      if (roomErr) return fail(roomErr.message);
      if (!room) return fail('Room not found (it may not exist, or you may not have access).');
      const rows = [...new Set(file_ids)].map((file_id) => ({ room_id, project_id: room.project_id, file_id, note: note ?? null }));
      const { error } = await supa.from('wiki_room_files').upsert(rows, { onConflict: 'room_id,file_id', ignoreDuplicates: true });
      if (rlsDenied(error)) return fail(NOT_MEMBER_MSG);
      if (error) return fail(error.message);
      const { data, error: listErr } = await supa
        .from('wiki_room_files')
        .select('id, file_id, note, created_at, project_files(filename, category, doc_type, sharepoint_web_url)')
        .eq('room_id', room_id);
      return listErr ? fail(listErr.message) : ok({ room_id, files: data });
    },
  );
}
