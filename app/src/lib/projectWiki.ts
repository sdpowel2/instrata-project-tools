// Project Wiki — client data layer for the per-project knowledge base
// (project context, one record per room / subsystem, decisions with rationale,
// questions log, labor buckets, links to BoM lines and files). Reads and
// writes go straight to the RLS-protected tables added by
// supabase/migrations/add_project_wiki.sql; the MCP server (wikiTools.ts)
// writes the same tables. Spec: Product Spec/project-tools-wiki-spec.md.
//
// Kept out of the Zustand store on purpose: wiki content is per-project and
// potentially large, so it's fetched on demand by the Wiki page (same pattern
// as projectFiles.ts).
import { supabase, isSupabaseConfigured } from './supabase';

// ── Vocabulary (twin of mcp-server/src/wikiTools.ts — keep in sync) ──────────
export type WikiStatus = 'draft' | 'in_progress' | 'awaiting_review' | 'reviewed' | 'final';
export type EntryKind = 'room' | 'subsystem' | 'head_end' | 'zone' | 'project_wide';
export type SizeClass = 'small_medium' | 'large_xl' | 'oversize';
export type SizeBasis = 'sqft' | 'seat_count' | 'display_count' | 'stated' | 'undetermined';
export type RoomStatus = 'pending' | 'clean' | 'noted' | 'escalated' | 'resolved' | 'authored';
export type WikiOrigin = 'agent' | 'human' | 'agent_human_edited';
export type DecisionKind = 'validated' | 'deviation_accepted' | 'assumption' | 'rationale' | 'escalation_outcome';
export type QuestionSeverity = 'functional_conflict' | 'estimating_escalation';
export type QuestionStatus = 'open' | 'answered' | 'resolved' | 'withdrawn';
export type LaborType = 'install' | 'cabling' | 'bench' | 'commissioning' | 'programming' | 'engineering' | 'mobilization' | 'training';

export const WIKI_STATUSES: { key: WikiStatus; label: string }[] = [
  { key: 'draft',           label: 'Draft' },
  { key: 'in_progress',     label: 'In Progress' },
  { key: 'awaiting_review', label: 'Awaiting Review' },
  { key: 'reviewed',        label: 'Reviewed' },
  { key: 'final',           label: 'Final' },
];

export const ENTRY_KINDS: { key: EntryKind; label: string }[] = [
  { key: 'room',         label: 'Room' },
  { key: 'subsystem',    label: 'Subsystem' },
  { key: 'head_end',     label: 'Head End' },
  { key: 'zone',         label: 'Zone' },
  { key: 'project_wide', label: 'Project-wide' },
];

export const SIZE_CLASSES: { key: SizeClass; label: string }[] = [
  { key: 'small_medium', label: 'Small / Medium' },
  { key: 'large_xl',     label: 'Large / XL' },
  { key: 'oversize',     label: 'Oversize (> 1,500 sq ft)' },
];

export const SIZE_BASES: { key: SizeBasis; label: string }[] = [
  { key: 'sqft',          label: 'Square footage' },
  { key: 'seat_count',    label: 'Seat count' },
  { key: 'display_count', label: 'Display count' },
  { key: 'stated',        label: 'Stated in documents' },
  { key: 'undetermined',  label: 'Undetermined' },
];

export const ROOM_STATUSES: { key: RoomStatus; label: string; hint: string }[] = [
  { key: 'pending',   label: 'Pending',   hint: 'Record exists, not yet evaluated' },
  { key: 'clean',     label: 'Clean',     hint: 'Validated, no issues' },
  { key: 'noted',     label: 'Noted',     hint: 'Non-functional deviation accepted; proceeded on consultant\'s number' },
  { key: 'escalated', label: 'Escalated', hint: 'Question raised, unresolved — blocking' },
  { key: 'resolved',  label: 'Resolved',  hint: 'Question answered; decision logged' },
  { key: 'authored',  label: 'Authored',  hint: 'Human-written, no pipeline validation' },
];

export const DECISION_KINDS: { key: DecisionKind; label: string }[] = [
  { key: 'validated',          label: 'Validated' },
  { key: 'deviation_accepted', label: 'Deviation accepted' },
  { key: 'assumption',         label: 'Assumption' },
  { key: 'rationale',          label: 'Rationale' },
  { key: 'escalation_outcome', label: 'Escalation outcome' },
];

export const QUESTION_SEVERITIES: { key: QuestionSeverity; label: string; hint: string }[] = [
  { key: 'functional_conflict',   label: 'Functional conflict',   hint: 'Blocks the design — answer one at a time' },
  { key: 'estimating_escalation', label: 'Estimating escalation', hint: 'Judgement call — batched for review' },
];

export const QUESTION_STATUSES: { key: QuestionStatus; label: string }[] = [
  { key: 'open',      label: 'Open' },
  { key: 'answered',  label: 'Answered' },
  { key: 'resolved',  label: 'Resolved' },
  { key: 'withdrawn', label: 'Withdrawn' },
];

/** D-Tools vocabulary, in D-Tools order. Travel is deliberately absent (human-quoted). */
export const LABOR_TYPES: { key: LaborType; label: string }[] = [
  { key: 'install',       label: 'Install' },
  { key: 'cabling',       label: 'Cabling' },
  { key: 'bench',         label: 'Bench' },
  { key: 'commissioning', label: 'Commissioning' },
  { key: 'programming',   label: 'Programming' },
  { key: 'engineering',   label: 'Engineering' },
  { key: 'mobilization',  label: 'Mobilization' },
  { key: 'training',      label: 'Training' },
];

/** The four per-room rows the estimating CSV requires even at 0.00. */
export const REQUIRED_LABOR_TYPES: LaborType[] = ['bench', 'cabling', 'commissioning', 'programming'];

export const ORIGIN_LABELS: Record<WikiOrigin, string> = {
  agent: 'Agent',
  human: 'Human',
  agent_human_edited: 'Agent · human-edited',
};

export function labelFor<K extends string>(list: { key: K; label: string }[], key: K | null | undefined): string {
  return list.find((x) => x.key === key)?.label ?? (key ?? '—');
}

// ── Types (camelCase views of the rows) ───────────────────────────────────────
export interface ProjectWiki {
  id: string;
  projectId: string;
  summary: string | null;
  scopeSummary: string | null;
  designBasis: string | null;
  status: WikiStatus;
  pipelineRunAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WikiRoom {
  id: string;
  projectId: string;
  roomNumber: string | null;
  roomName: string;
  floor: string | null;
  dtoolsLocation: string | null;
  sortOrder: number;
  entryKind: EntryKind;
  roomType: string | null;
  areaSqft: number | null;
  sizeClass: SizeClass | null;
  sizeBasis: SizeBasis | null;
  hasConferencing: boolean | null;
  typicalOfCount: number | null;
  typicalOfRooms: string[] | null;
  status: RoomStatus;
  headline: string;
  detail: string | null;
  validationNotes: string | null;
  origin: WikiOrigin;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Row of the wiki_room_index view (§5.1). */
export interface WikiRoomIndexRow {
  id: string;
  projectId: string;
  sortOrder: number;
  roomNumber: string | null;
  roomName: string;
  floor: string | null;
  dtoolsLocation: string | null;
  entryKind: EntryKind;
  roomType: string | null;
  sizeClass: SizeClass | null;
  hasConferencing: boolean | null;
  typicalOfCount: number | null;
  status: RoomStatus;
  headline: string;
  origin: WikiOrigin;
  updatedAt: string;
  decisionCount: number;
  openQuestionCount: number;
  answeredQuestionCount: number;
  laborHours: number;
}

export interface WikiDecision {
  id: string;
  projectId: string;
  roomId: string | null;
  kind: DecisionKind;
  title: string;
  rationale: string;
  sourceRef: string | null;
  assumptionConfirmed: boolean | null;
  origin: WikiOrigin;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on project-wide listings (joined). */
  roomLabel?: string | null;
}

export interface WikiQuestion {
  id: string;
  projectId: string;
  roomId: string | null;
  severity: QuestionSeverity;
  question: string;
  context: string | null;
  status: QuestionStatus;
  answer: string | null;
  resolution: string | null;
  resultingDecisionId: string | null;
  raisedBy: string | null;
  answeredBy: string | null;
  raisedAt: string;
  answeredAt: string | null;
  roomLabel?: string | null;
}

export interface WikiLabor {
  id: string;
  roomId: string;
  laborType: LaborType;
  hours: number;
  basis: string | null;
  origin: WikiOrigin;
}

export interface WikiBomLink {
  id: string;
  bomItemId: string;
  note: string | null;
  manufacturer: string;
  model: string;
  description: string;
  qty: number;
  itemType: string;
}

export interface WikiFileLink {
  id: string;
  fileId: string;
  note: string | null;
  filename: string;
  category: string;
  sharepointWebUrl: string | null;
}

export interface WikiRoomBundle {
  room: WikiRoom;
  decisions: WikiDecision[];
  questions: WikiQuestion[];
  labor: WikiLabor[];
  bomLinks: WikiBomLink[];
  fileLinks: WikiFileLink[];
}

export interface WikiSearchHit {
  kind: 'wiki' | 'room' | 'decision' | 'question';
  id: string;
  roomId: string | null;
  roomLabel: string | null;
  title: string;
  /** ts_headline output — matches wrapped in <b>…</b>. Render via renderSnippet(). */
  snippet: string;
  rank: number;
}

// ── Row mappers ───────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number => (v == null ? 0 : Number(v));
const nn = (v: unknown): number | null => (v == null ? null : Number(v));
const b = (v: unknown): boolean | null => (v == null ? null : Boolean(v));

function mapWiki(r: Row): ProjectWiki {
  return {
    id: String(r.id), projectId: String(r.project_id),
    summary: s(r.summary), scopeSummary: s(r.scope_summary), designBasis: s(r.design_basis),
    status: r.status as WikiStatus, pipelineRunAt: s(r.pipeline_run_at),
    createdBy: s(r.created_by), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function mapRoom(r: Row): WikiRoom {
  return {
    id: String(r.id), projectId: String(r.project_id),
    roomNumber: s(r.room_number), roomName: String(r.room_name ?? ''), floor: s(r.floor),
    dtoolsLocation: s(r.dtools_location), sortOrder: n(r.sort_order),
    entryKind: (r.entry_kind as EntryKind) ?? 'room', roomType: s(r.room_type),
    areaSqft: nn(r.area_sqft), sizeClass: (r.size_class as SizeClass | null) ?? null,
    sizeBasis: (r.size_basis as SizeBasis | null) ?? null, hasConferencing: b(r.has_conferencing),
    typicalOfCount: nn(r.typical_of_count), typicalOfRooms: (r.typical_of_rooms as string[] | null) ?? null,
    status: r.status as RoomStatus, headline: String(r.headline ?? ''),
    detail: s(r.detail), validationNotes: s(r.validation_notes),
    origin: (r.origin as WikiOrigin) ?? 'human', createdBy: s(r.created_by),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function mapIndex(r: Row): WikiRoomIndexRow {
  return {
    id: String(r.id), projectId: String(r.project_id), sortOrder: n(r.sort_order),
    roomNumber: s(r.room_number), roomName: String(r.room_name ?? ''), floor: s(r.floor),
    dtoolsLocation: s(r.dtools_location), entryKind: (r.entry_kind as EntryKind) ?? 'room',
    roomType: s(r.room_type), sizeClass: (r.size_class as SizeClass | null) ?? null,
    hasConferencing: b(r.has_conferencing), typicalOfCount: nn(r.typical_of_count),
    status: r.status as RoomStatus, headline: String(r.headline ?? ''),
    origin: (r.origin as WikiOrigin) ?? 'human', updatedAt: String(r.updated_at),
    decisionCount: n(r.decision_count), openQuestionCount: n(r.open_question_count),
    answeredQuestionCount: n(r.answered_question_count), laborHours: n(r.labor_hours),
  };
}

function roomLabelOf(j: unknown): string | null {
  const r = j as { room_number?: string | null; room_name?: string | null } | null;
  if (!r) return null;
  return [r.room_number, r.room_name].filter(Boolean).join(' ') || null;
}

function mapDecision(r: Row): WikiDecision {
  return {
    id: String(r.id), projectId: String(r.project_id), roomId: s(r.room_id),
    kind: r.kind as DecisionKind, title: String(r.title ?? ''), rationale: String(r.rationale ?? ''),
    sourceRef: s(r.source_ref), assumptionConfirmed: b(r.assumption_confirmed),
    origin: (r.origin as WikiOrigin) ?? 'human', createdBy: s(r.created_by),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    roomLabel: roomLabelOf(r.wiki_rooms),
  };
}

function mapQuestion(r: Row): WikiQuestion {
  return {
    id: String(r.id), projectId: String(r.project_id), roomId: s(r.room_id),
    severity: r.severity as QuestionSeverity, question: String(r.question ?? ''), context: s(r.context),
    status: r.status as QuestionStatus, answer: s(r.answer), resolution: s(r.resolution),
    resultingDecisionId: s(r.resulting_decision_id), raisedBy: s(r.raised_by), answeredBy: s(r.answered_by),
    raisedAt: String(r.raised_at), answeredAt: s(r.answered_at),
    roomLabel: roomLabelOf(r.wiki_rooms),
  };
}

function mapLabor(r: Row): WikiLabor {
  return {
    id: String(r.id), roomId: String(r.room_id), laborType: r.labor_type as LaborType,
    hours: n(r.hours), basis: s(r.basis), origin: (r.origin as WikiOrigin) ?? 'human',
  };
}

function mapBomLink(r: Row): WikiBomLink {
  const it = (r.project_bom_items as Row | null) ?? {};
  return {
    id: String(r.id), bomItemId: String(r.bom_item_id), note: s(r.note),
    manufacturer: String(it.manufacturer ?? ''), model: String(it.model ?? ''),
    description: String(it.description ?? ''), qty: n(it.qty), itemType: String(it.item_type ?? 'Product'),
  };
}

function mapFileLink(r: Row): WikiFileLink {
  const f = (r.project_files as Row | null) ?? {};
  return {
    id: String(r.id), fileId: String(r.file_id), note: s(r.note),
    filename: String(f.filename ?? ''), category: String(f.category ?? 'general'),
    sharepointWebUrl: s(f.sharepoint_web_url),
  };
}

const ROOM_COLS =
  'id, project_id, room_number, room_name, floor, dtools_location, sort_order, entry_kind, room_type, ' +
  'area_sqft, size_class, size_basis, has_conferencing, typical_of_count, typical_of_rooms, status, headline, ' +
  'detail, validation_notes, origin, created_by, created_at, updated_at';
const DECISION_COLS = 'id, project_id, room_id, kind, title, rationale, source_ref, assumption_confirmed, origin, created_by, created_at, updated_at';
const QUESTION_COLS =
  'id, project_id, room_id, severity, question, context, status, answer, resolution, resulting_decision_id, raised_by, answered_by, raised_at, answered_at';

function must<T>(data: T | null, error: { message: string } | null, what: string): T {
  if (error) throw new Error(`${what}: ${error.message}`);
  if (data == null) throw new Error(`${what}: no data returned`);
  return data;
}

// ── Project-level context ─────────────────────────────────────────────────────
export async function fetchWiki(projectId: string): Promise<ProjectWiki | null> {
  if (!isSupabaseConfigured()) return null;
  const { data, error } = await supabase.from('project_wiki').select('*').eq('project_id', projectId).maybeSingle();
  if (error) throw new Error(`Failed to load wiki: ${error.message}`);
  return data ? mapWiki(data as Row) : null;
}

export interface WikiPatch {
  summary?: string | null;
  scopeSummary?: string | null;
  designBasis?: string | null;
  status?: WikiStatus;
}

/** Create-or-patch the project-level record. Only supplied fields change. */
export async function upsertWiki(projectId: string, patch: WikiPatch): Promise<ProjectWiki> {
  const row: Row = { project_id: projectId };
  if (patch.summary !== undefined) row.summary = patch.summary;
  if (patch.scopeSummary !== undefined) row.scope_summary = patch.scopeSummary;
  if (patch.designBasis !== undefined) row.design_basis = patch.designBasis;
  if (patch.status !== undefined) row.status = patch.status;
  const { data, error } = await supabase.from('project_wiki').upsert(row, { onConflict: 'project_id' }).select('*').single();
  return mapWiki(must(data, error, 'Failed to save wiki') as Row);
}

// ── Rooms ─────────────────────────────────────────────────────────────────────
export async function fetchRoomIndex(projectId: string): Promise<WikiRoomIndexRow[]> {
  if (!isSupabaseConfigured()) return [];
  const { data, error } = await supabase
    .from('wiki_room_index')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order')
    .order('room_number');
  if (error) throw new Error(`Failed to load rooms: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapIndex);
}

export interface RoomInput {
  roomNumber?: string | null;
  roomName: string;
  floor?: string | null;
  dtoolsLocation?: string | null;
  sortOrder?: number;
  entryKind?: EntryKind;
  roomType?: string | null;
  areaSqft?: number | null;
  sizeClass?: SizeClass | null;
  sizeBasis?: SizeBasis | null;
  hasConferencing?: boolean | null;
  typicalOfCount?: number | null;
  typicalOfRooms?: string[] | null;
  status?: RoomStatus;
  headline: string;
  detail?: string | null;
  validationNotes?: string | null;
}

function roomRow(input: Partial<RoomInput>): Row {
  const r: Row = {};
  const set = (k: string, v: unknown) => { if (v !== undefined) r[k] = v; };
  set('room_number', input.roomNumber);
  set('room_name', input.roomName);
  set('floor', input.floor);
  set('dtools_location', input.dtoolsLocation);
  set('sort_order', input.sortOrder);
  set('entry_kind', input.entryKind);
  set('room_type', input.roomType);
  set('area_sqft', input.areaSqft);
  set('size_class', input.sizeClass);
  set('size_basis', input.sizeBasis);
  set('has_conferencing', input.hasConferencing);
  set('typical_of_count', input.typicalOfCount);
  set('typical_of_rooms', input.typicalOfRooms);
  set('status', input.status);
  set('headline', input.headline);
  set('detail', input.detail);
  set('validation_notes', input.validationNotes);
  return r;
}

export async function createRoom(projectId: string, input: RoomInput): Promise<WikiRoom> {
  const row = { project_id: projectId, origin: 'human', status: input.status ?? 'authored', ...roomRow(input) };
  const { data, error } = await supabase.from('wiki_rooms').insert(row).select(ROOM_COLS).single();
  return mapRoom(must(data, error, 'Failed to create room') as unknown as Row);
}

/**
 * Patch a room. A human editing an agent-authored room flips origin to
 * agent_human_edited so provenance stays honest (pass currentOrigin).
 */
export async function updateRoom(roomId: string, patch: Partial<RoomInput>, currentOrigin?: WikiOrigin): Promise<WikiRoom> {
  const row = roomRow(patch);
  if (currentOrigin === 'agent') row.origin = 'agent_human_edited';
  const { data, error } = await supabase.from('wiki_rooms').update(row).eq('id', roomId).select(ROOM_COLS).single();
  return mapRoom(must(data, error, 'Failed to save room') as unknown as Row);
}

export async function deleteRoom(roomId: string): Promise<void> {
  const { error } = await supabase.from('wiki_rooms').delete().eq('id', roomId);
  if (error) throw new Error(`Failed to delete room: ${error.message}`);
}

export async function fetchRoomBundle(roomId: string): Promise<WikiRoomBundle> {
  const [room, dec, qs, lab, bom, files] = await Promise.all([
    supabase.from('wiki_rooms').select(ROOM_COLS).eq('id', roomId).single(),
    supabase.from('wiki_decisions').select(DECISION_COLS).eq('room_id', roomId).order('created_at'),
    supabase.from('wiki_questions').select(QUESTION_COLS).eq('room_id', roomId).order('raised_at'),
    supabase.from('wiki_labor').select('*').eq('room_id', roomId),
    supabase.from('wiki_room_bom_lines').select('id, bom_item_id, note, project_bom_items(manufacturer, model, description, qty, item_type)').eq('room_id', roomId),
    supabase.from('wiki_room_files').select('id, file_id, note, project_files(filename, category, sharepoint_web_url)').eq('room_id', roomId),
  ]);
  const firstErr = [room, dec, qs, lab, bom, files].find((r) => r.error)?.error;
  if (firstErr) throw new Error(`Failed to load room: ${firstErr.message}`);
  const order = new Map(LABOR_TYPES.map((t, i) => [t.key, i]));
  return {
    room: mapRoom(room.data as unknown as Row),
    decisions: ((dec.data ?? []) as unknown as Row[]).map(mapDecision),
    questions: ((qs.data ?? []) as unknown as Row[]).map(mapQuestion),
    labor: ((lab.data ?? []) as Row[]).map(mapLabor).sort((a, b2) => (order.get(a.laborType) ?? 99) - (order.get(b2.laborType) ?? 99)),
    bomLinks: ((bom.data ?? []) as unknown as Row[]).map(mapBomLink),
    fileLinks: ((files.data ?? []) as unknown as Row[]).map(mapFileLink),
  };
}

// ── Decisions ─────────────────────────────────────────────────────────────────
export interface DecisionInput {
  kind: DecisionKind;
  title: string;
  rationale: string;
  sourceRef?: string | null;
  assumptionConfirmed?: boolean | null;
}

export async function addDecision(projectId: string, roomId: string | null, input: DecisionInput): Promise<WikiDecision> {
  const { data, error } = await supabase
    .from('wiki_decisions')
    .insert({
      project_id: projectId, room_id: roomId, kind: input.kind, title: input.title, rationale: input.rationale,
      source_ref: input.sourceRef ?? null, assumption_confirmed: input.assumptionConfirmed ?? null, origin: 'human',
    })
    .select(DECISION_COLS)
    .single();
  return mapDecision(must(data, error, 'Failed to add decision') as unknown as Row);
}

export async function updateDecision(id: string, patch: Partial<DecisionInput>, currentOrigin?: WikiOrigin): Promise<WikiDecision> {
  const row: Row = {};
  if (patch.kind !== undefined) row.kind = patch.kind;
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.rationale !== undefined) row.rationale = patch.rationale;
  if (patch.sourceRef !== undefined) row.source_ref = patch.sourceRef;
  if (patch.assumptionConfirmed !== undefined) row.assumption_confirmed = patch.assumptionConfirmed;
  if (currentOrigin === 'agent') row.origin = 'agent_human_edited';
  const { data, error } = await supabase.from('wiki_decisions').update(row).eq('id', id).select(DECISION_COLS).single();
  return mapDecision(must(data, error, 'Failed to save decision') as unknown as Row);
}

export async function deleteDecision(id: string): Promise<void> {
  const { error } = await supabase.from('wiki_decisions').delete().eq('id', id);
  if (error) throw new Error(`Failed to delete decision: ${error.message}`);
}

/** Project-wide decision list (room label joined), oldest first. */
export async function fetchProjectDecisions(projectId: string): Promise<WikiDecision[]> {
  if (!isSupabaseConfigured()) return [];
  const { data, error } = await supabase
    .from('wiki_decisions')
    .select(`${DECISION_COLS}, wiki_rooms(room_number, room_name)`)
    .eq('project_id', projectId)
    .order('created_at');
  if (error) throw new Error(`Failed to load decisions: ${error.message}`);
  return ((data ?? []) as unknown as Row[]).map(mapDecision);
}

// ── Questions ─────────────────────────────────────────────────────────────────
export async function fetchProjectQuestions(projectId: string): Promise<WikiQuestion[]> {
  if (!isSupabaseConfigured()) return [];
  const { data, error } = await supabase
    .from('wiki_questions')
    .select(`${QUESTION_COLS}, wiki_rooms(room_number, room_name)`)
    .eq('project_id', projectId)
    .order('raised_at');
  if (error) throw new Error(`Failed to load questions: ${error.message}`);
  return ((data ?? []) as unknown as Row[]).map(mapQuestion);
}

export async function raiseQuestion(
  projectId: string,
  roomId: string | null,
  input: { severity: QuestionSeverity; question: string; context?: string | null },
  opts?: { escalateRoom?: boolean },
): Promise<WikiQuestion> {
  const { data, error } = await supabase
    .from('wiki_questions')
    .insert({ project_id: projectId, room_id: roomId, severity: input.severity, question: input.question, context: input.context ?? null, status: 'open' })
    .select(QUESTION_COLS)
    .single();
  const q = mapQuestion(must(data, error, 'Failed to raise question') as unknown as Row);
  if (roomId && opts?.escalateRoom !== false) {
    await supabase.from('wiki_rooms').update({ status: 'escalated' }).eq('id', roomId).neq('status', 'escalated');
  }
  return q;
}

export interface AnswerInput {
  answer: string;
  resolution?: string | null;
  status?: Extract<QuestionStatus, 'answered' | 'resolved' | 'withdrawn'>;
  /** Log this decision and link the question to it (→ resolved). */
  decision?: DecisionInput;
}

export async function answerQuestion(q: WikiQuestion, input: AnswerInput, userId: string | null): Promise<{ question: WikiQuestion; decision: WikiDecision | null; roomResolved: boolean }> {
  let decision: WikiDecision | null = null;
  if (input.decision) decision = await addDecision(q.projectId, q.roomId, input.decision);
  const status = input.status ?? (decision ? 'resolved' : 'answered');
  const row: Row = { answer: input.answer, status, answered_by: userId, answered_at: new Date().toISOString() };
  if (input.resolution !== undefined) row.resolution = input.resolution;
  if (decision) row.resulting_decision_id = decision.id;
  const { data, error } = await supabase.from('wiki_questions').update(row).eq('id', q.id).select(QUESTION_COLS).single();
  const updated = mapQuestion(must(data, error, 'Failed to answer question') as unknown as Row);

  let roomResolved = false;
  if (q.roomId && decision && status === 'resolved') {
    const { count } = await supabase.from('wiki_questions').select('id', { count: 'exact', head: true }).eq('room_id', q.roomId).eq('status', 'open');
    if ((count ?? 0) === 0) {
      const { data: r } = await supabase.from('wiki_rooms').update({ status: 'resolved' }).eq('id', q.roomId).eq('status', 'escalated').select('id');
      roomResolved = !!r && r.length > 0;
    }
  }
  return { question: updated, decision, roomResolved };
}

export async function setQuestionStatus(id: string, status: QuestionStatus): Promise<void> {
  const { error } = await supabase.from('wiki_questions').update({ status }).eq('id', id);
  if (error) throw new Error(`Failed to update question: ${error.message}`);
}

export async function deleteQuestion(id: string): Promise<void> {
  const { error } = await supabase.from('wiki_questions').delete().eq('id', id);
  if (error) throw new Error(`Failed to delete question: ${error.message}`);
}

// ── Labor ─────────────────────────────────────────────────────────────────────
/** Replace the room's labor set. Rows with hours 0 are stored — zero is meaningful. */
export async function setRoomLabor(
  room: Pick<WikiRoom, 'id' | 'projectId'>,
  rows: { laborType: LaborType; hours: number; basis?: string | null }[],
): Promise<WikiLabor[]> {
  const { error: delErr } = await supabase.from('wiki_labor').delete().eq('room_id', room.id);
  if (delErr) throw new Error(`Failed to save labor: ${delErr.message}`);
  if (rows.length === 0) return [];
  const { data, error } = await supabase
    .from('wiki_labor')
    .insert(rows.map((r) => ({ room_id: room.id, project_id: room.projectId, labor_type: r.laborType, hours: r.hours, basis: r.basis ?? null, origin: 'human' })))
    .select('*');
  if (error) throw new Error(`Failed to save labor: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapLabor);
}

// ── Links ─────────────────────────────────────────────────────────────────────
export async function linkBomLines(room: Pick<WikiRoom, 'id' | 'projectId'>, bomItemIds: string[]): Promise<void> {
  if (bomItemIds.length === 0) return;
  const rows = [...new Set(bomItemIds)].map((bom_item_id) => ({ room_id: room.id, project_id: room.projectId, bom_item_id }));
  const { error } = await supabase.from('wiki_room_bom_lines').upsert(rows, { onConflict: 'room_id,bom_item_id', ignoreDuplicates: true });
  if (error) throw new Error(`Failed to link BoM lines: ${error.message}`);
}

export async function unlinkBomLine(linkId: string): Promise<void> {
  const { error } = await supabase.from('wiki_room_bom_lines').delete().eq('id', linkId);
  if (error) throw new Error(`Failed to unlink: ${error.message}`);
}

export async function linkFiles(room: Pick<WikiRoom, 'id' | 'projectId'>, fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  const rows = [...new Set(fileIds)].map((file_id) => ({ room_id: room.id, project_id: room.projectId, file_id }));
  const { error } = await supabase.from('wiki_room_files').upsert(rows, { onConflict: 'room_id,file_id', ignoreDuplicates: true });
  if (error) throw new Error(`Failed to link files: ${error.message}`);
}

export async function unlinkFile(linkId: string): Promise<void> {
  const { error } = await supabase.from('wiki_room_files').delete().eq('id', linkId);
  if (error) throw new Error(`Failed to unlink: ${error.message}`);
}

// ── Search ────────────────────────────────────────────────────────────────────
export async function searchWiki(projectId: string, query: string, limit = 25): Promise<WikiSearchHit[]> {
  if (!isSupabaseConfigured() || !query.trim()) return [];
  const { data, error } = await supabase.rpc('search_project_wiki', { p_project_id: projectId, p_query: query, p_limit: limit });
  if (error) throw new Error(`Search failed: ${error.message}`);
  return ((data ?? []) as Row[]).map((r) => ({
    kind: r.kind as WikiSearchHit['kind'],
    id: String(r.id),
    roomId: s(r.room_id),
    roomLabel: s(r.room_label),
    title: String(r.title ?? ''),
    snippet: String(r.snippet ?? ''),
    rank: n(r.rank),
  }));
}

/** Split a ts_headline snippet into plain / highlighted segments (no HTML injection). */
export function splitSnippet(snippet: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  const re = /<b>(.*?)<\/b>/gs;
  let last = 0;
  for (const m of snippet.matchAll(re)) {
    if (m.index! > last) parts.push({ text: snippet.slice(last, m.index), hit: false });
    parts.push({ text: m[1], hit: true });
    last = m.index! + m[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}

// ── Display helpers ───────────────────────────────────────────────────────────
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function roomLabel(r: { roomNumber: string | null; roomName: string }): string {
  return [r.roomNumber, r.roomName].filter(Boolean).join(' · ');
}

/** Rooms that are blocking: escalated, or carrying an open question. */
export function isBlocking(r: WikiRoomIndexRow): boolean {
  return r.status === 'escalated' || r.openQuestionCount > 0;
}

// ── Markdown snapshot (§7) ────────────────────────────────────────────────────
// One-way export. Project Tools is the source of truth; this is a generated
// snapshot in the brief's folder shape flattened into a single document
// (wiki.md → rooms → questions log → labor breakdown).
export async function buildWikiMarkdown(project: { name: string; number: string; client: string }, projectId: string): Promise<string> {
  const [wiki, index, decisions, questions] = await Promise.all([
    fetchWiki(projectId), fetchRoomIndex(projectId), fetchProjectDecisions(projectId), fetchProjectQuestions(projectId),
  ]);
  const bundles = await Promise.all(index.map((r) => fetchRoomBundle(r.id)));
  const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');
  const out: string[] = [];

  out.push(`# ${project.name} — Project Wiki`, '', `Project ${project.number} · ${project.client}`, '');
  out.push(`Status: **${labelFor(WIKI_STATUSES, wiki?.status ?? 'draft')}**` + (wiki?.pipelineRunAt ? ` · Pipeline run ${fmt(wiki.pipelineRunAt)}` : ''), '');
  out.push(`_Generated ${new Date().toLocaleString()} from Project Tools. Project Tools is the source of truth — regenerate rather than edit._`, '');
  if (wiki?.summary) out.push('## Summary', '', wiki.summary, '');
  if (wiki?.scopeSummary) out.push('## Scope', '', wiki.scopeSummary, '');
  if (wiki?.designBasis) out.push('## Design basis', '', wiki.designBasis, '');

  const projectDecisions = decisions.filter((d) => !d.roomId);
  if (projectDecisions.length) {
    out.push('## Project-level decisions', '');
    for (const d of projectDecisions) out.push(`- **${d.title}** _(${labelFor(DECISION_KINDS, d.kind)})_ — ${d.rationale}${d.sourceRef ? ` [${d.sourceRef}]` : ''}`);
    out.push('');
  }

  out.push('## Room index', '', '| # | Room | Status | Headline | Decisions | Open Qs |', '|---|---|---|---|---|---|');
  for (const r of index) {
    out.push(`| ${r.roomNumber ?? ''} | ${r.roomName} | ${labelFor(ROOM_STATUSES, r.status)} | ${r.headline.replace(/\|/g, '\\|')} | ${r.decisionCount} | ${r.openQuestionCount} |`);
  }
  out.push('');

  out.push('---', '', '# 01 Design', '');
  for (const b of bundles) {
    const r = b.room;
    out.push(`## ${roomLabel(r)}`, '');
    const meta: string[] = [];
    if (r.floor) meta.push(`Floor: ${r.floor}`);
    if (r.dtoolsLocation) meta.push(`D-Tools: ${r.dtoolsLocation}`);
    meta.push(`Kind: ${labelFor(ENTRY_KINDS, r.entryKind)}`);
    if (r.roomType) meta.push(`Type: ${r.roomType}`);
    if (r.areaSqft != null) meta.push(`Area: ${r.areaSqft} sq ft`);
    if (r.sizeClass) meta.push(`Size: ${labelFor(SIZE_CLASSES, r.sizeClass)}${r.sizeBasis ? ` (${labelFor(SIZE_BASES, r.sizeBasis)})` : ''}`);
    if (r.hasConferencing != null) meta.push(`Conferencing: ${r.hasConferencing ? 'yes' : 'no'}`);
    if (r.typicalOfCount) meta.push(`Typical of ${r.typicalOfCount}${r.typicalOfRooms?.length ? `: ${r.typicalOfRooms.join(', ')}` : ''}`);
    meta.push(`Status: ${labelFor(ROOM_STATUSES, r.status)}`, `Origin: ${ORIGIN_LABELS[r.origin]}`);
    out.push(meta.map((m) => `- ${m}`).join('\n'), '');
    out.push(`**${r.headline}**`, '');
    if (r.detail) out.push(r.detail, '');
    if (r.validationNotes) out.push('### Validation', '', r.validationNotes, '');
    if (b.decisions.length) {
      out.push('### Decisions', '');
      for (const d of b.decisions) {
        out.push(`- **${d.title}** _(${labelFor(DECISION_KINDS, d.kind)}${d.kind === 'assumption' ? `, ${d.assumptionConfirmed ? 'confirmed' : 'unconfirmed'}` : ''})_`);
        if (d.rationale) out.push(`  ${d.rationale.replace(/\n/g, '\n  ')}`);
        if (d.sourceRef) out.push(`  Source: ${d.sourceRef}`);
      }
      out.push('');
    }
    if (b.labor.length) {
      out.push('### Labor', '', '| Type | Hours | Basis |', '|---|---|---|');
      for (const l of b.labor) out.push(`| ${labelFor(LABOR_TYPES, l.laborType)} | ${l.hours.toFixed(2)} | ${l.basis ?? ''} |`);
      out.push('');
    }
    if (b.bomLinks.length) {
      out.push('### Linked BoM lines', '');
      for (const l of b.bomLinks) out.push(`- ${l.qty} × ${l.manufacturer} ${l.model}${l.description ? ` — ${l.description}` : ''}${l.note ? ` _(${l.note})_` : ''}`);
      out.push('');
    }
    if (b.fileLinks.length) {
      out.push('### Linked files', '');
      for (const f of b.fileLinks) out.push(`- ${f.sharepointWebUrl ? `[${f.filename}](${f.sharepointWebUrl})` : f.filename}${f.note ? ` _(${f.note})_` : ''}`);
      out.push('');
    }
  }

  out.push('---', '', '# Questions log', '');
  if (!questions.length) out.push('_No questions raised._', '');
  for (const q of questions) {
    out.push(`## ${q.roomLabel ?? 'Project-level'} — ${labelFor(QUESTION_SEVERITIES, q.severity)} · ${labelFor(QUESTION_STATUSES, q.status)}`, '');
    out.push(`Raised ${fmt(q.raisedAt)}`, '', `**Q:** ${q.question}`, '');
    if (q.context) out.push(`_Context:_ ${q.context}`, '');
    if (q.answer) out.push(`**A:** ${q.answer}${q.answeredAt ? ` _(${fmt(q.answeredAt)})_` : ''}`, '');
    if (q.resolution) out.push(`**Resolution:** ${q.resolution}`, '');
  }

  out.push('---', '', '# 02 Estimating — equipment & labor breakdown', '');
  out.push('| Room | ' + LABOR_TYPES.map((t) => t.label).join(' | ') + ' | Total |');
  out.push('|---|' + LABOR_TYPES.map(() => '---').join('|') + '|---|');
  const totals = new Map<LaborType, number>();
  for (const b of bundles) {
    const by = new Map(b.labor.map((l) => [l.laborType, l.hours]));
    const rowTotal = b.labor.reduce((s2, l) => s2 + l.hours, 0);
    for (const l of b.labor) totals.set(l.laborType, (totals.get(l.laborType) ?? 0) + l.hours);
    out.push(`| ${roomLabel(b.room)} | ${LABOR_TYPES.map((t) => (by.has(t.key) ? by.get(t.key)!.toFixed(2) : '')).join(' | ')} | ${rowTotal.toFixed(2)} |`);
  }
  const grand = [...totals.values()].reduce((s2, v) => s2 + v, 0);
  out.push(`| **Total** | ${LABOR_TYPES.map((t) => (totals.get(t.key) ?? 0).toFixed(2)).join(' | ')} | **${grand.toFixed(2)}** |`, '');

  return out.join('\n');
}

export function downloadMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
