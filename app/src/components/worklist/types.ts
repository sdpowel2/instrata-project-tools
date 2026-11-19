// Data model for the My Day worklist. The page view of the Supabase
// worklist_briefings / worklist_items tables (supabase/migrations/add_worklist.sql),
// which the morning-worklist skill fills through the save_briefing MCP tool.

/** respond = reply owed, do = work owed, decide = a call only Seth can make,
 *  question = Claude is blocked and needs Seth's input (Phase 2). */
export type WorkItemKind = 'respond' | 'do' | 'decide' | 'question';

export type WorkItemSource = 'email' | 'teams' | 'monday' | 'manual' | 'claude';

/** 1 Now · 2 Today · 3 This week · 4 Whenever */
export type Urgency = 1 | 2 | 3 | 4;

export type WorkItemStatus = 'open' | 'done' | 'snoozed' | 'dismissed';

export interface WorkItem {
  id: string;
  /** worklist_items.source_key (live mode); ties a task to its reviewed row. */
  sourceKey?: string;
  kind: WorkItemKind;
  source: WorkItemSource;
  title: string;
  /** Who it's from, or "you promised X" for self-commitments. */
  from: string;
  /** YYYY-MM-DD, or null when no date was given. */
  due: string | null;
  dueBasis: 'stated' | 'inferred' | 'none';
  urgency: Urgency;
  /** One line: why this urgency. Always present. */
  urgencyReason: string;
  link?: string;
  /** How many briefings this has appeared on before today (0 = new today). */
  carriedDays: number;
  status: WorkItemStatus;
  /** Seth changed the urgency by hand; feeds back into the next briefing. */
  userOverridden?: boolean;
  /** Phase 2 questions: the options Claude is offering. */
  options?: string[];
  /** One or two lines of context from the briefing (never a message body). */
  summary?: string;
  /** Claude's own urgency; differs from `urgency` when Seth overrode it. */
  claudeUrgency?: Urgency;
  /** YYYY-MM-DD the item comes back, when snoozed. */
  snoozedUntil?: string;
  /** Seth's pick, for an answered question. */
  answer?: string;
  /** Which phase 3 worker could do it (2.3): Seth's pick if he checked it, else the run's tag. */
  workType?: WorkType;
  /** The run's own tag and confidence, before Seth's check. */
  claudeWorkType?: WorkType;
  workConfidence?: number;
  /** Seth confirmed or corrected the work type. */
  workTypeChecked?: boolean;
  /** The project Seth linked this task to (2.4). Only Seth links; the run can't. */
  projectId?: string;
  /** The morning run's suggested project, shown as "Link to ...?" until confirmed or dismissed. */
  suggestedProjectId?: string;
}

/** One row of a project's activity log (2.4), written by the database when a linked task changes. */
export interface ProjectActivity {
  id: string;
  itemId?: string;
  kind: 'linked' | 'unlinked' | 'done' | 'reopened' | 'note';
  title: string;
  detail?: string;
  occurredAt: string;
}

export interface CalendarEvent {
  id: string;
  /** Local HH:MM, 24h. */
  start: string;
  end: string;
  subject: string;
  location?: string;
  isOrganizer?: boolean;
  canceled?: boolean;
}

export interface ReadMeItem {
  id: string;
  text: string;
  source: WorkItemSource;
  link?: string;
  /** The run's project suggestion (2.6): exact matches only. Logging the line shares it there. */
  projectId?: string;
}

/** Seth's call on a read-me line (2.5): logged into the second brain, or hidden (less like this). */
export type ReadMeState = 'logged' | 'hidden';

/**
 * Who a captured note is for (2.6). personal = only you. project = the project
 * wiki's Notes (everyone who can see the project). general = the team's shared pages.
 */
export type NoteScope = 'personal' | 'project' | 'general';
export interface NoteTarget {
  scope: NoteScope;
  /** Set when scope is project. */
  projectId?: string;
}

export interface SetAsideItem {
  id: string;
  title: string;
  reason: string;
  link?: string;
}

export interface Briefing {
  /** worklist_briefings.id (live mode); used to load the reviewed log. */
  id?: string;
  /** YYYY-MM-DD the briefing is for. */
  date: string;
  /** ISO timestamp the run finished. */
  ranAt: string;
  /** ISO timestamp the window started. */
  since: string;
  /** Sources that failed this run (empty = complete). */
  missing: { source: string; error: string }[];
  sourceCounts: { mail: number; teams: number; monday: number; manual: number };
  schedule: CalendarEvent[];
  /** Open 60+ minute blocks, 24h "HH:MM–HH:MM" (the page shows "10:00am–11:30am"). */
  openBlocks: string[];
  items: WorkItem[];
  readMe: ReadMeItem[];
  setAside: {
    categories: { label: string; count: number }[];
    items: SetAsideItem[];
  };
  closedSinceLast: { id: string; title: string }[];
}

export const URGENCY_LABEL: Record<Urgency, string> = {
  1: 'Now',
  2: 'Today',
  3: 'This week',
  4: 'Whenever',
};

export const KIND_LABEL: Record<WorkItemKind, string> = {
  respond: 'Respond',
  do: 'Do',
  decide: 'Decide',
  question: 'Question',
};

/** Where the run put a conversation it looked at (My Day 2.1 reviewed log). */
export type ReviewedOutcome = 'respond' | 'do' | 'decide' | 'carried' | 'read_me' | 'set_aside' | 'dropped';

/** One conversation the morning run reviewed, wherever it landed. */
export interface ReviewedRow {
  id: string;
  source: 'email' | 'teams' | 'monday';
  sourceKey: string;
  title: string;
  from: string;
  link?: string;
  outcome: ReviewedOutcome;
  /** One line from the run: why it landed there. */
  reason: string;
  /** Short stable label the drawer groups by. */
  reasonGroup: string;
  /** Set once Seth surfaced it (or it was on the list). */
  itemId?: string;
  surfacedAt?: string;
  /** Sender's address (email and Teams), lowercased. */
  sender?: string;
  /** Teams chat or channel name, or monday board name. */
  channel?: string;
  /** Tuning rules that fired on this row (2.2). */
  ruleIds?: string[];
}

/** Outcomes that already put the conversation on the list. */
export const ON_LIST_OUTCOMES: ReviewedOutcome[] = ['respond', 'do', 'decide', 'carried'];

// ── Tuning rules (My Day 2.2, supabase/migrations/add_triage_rules.sql) ──────

/**
 * Floors: min_task = always on the list · min_read_me = at least a Read me line.
 * Ceilings: max_read_me = never a task (Read me at most) · suppress = Set aside.
 * Every matching rule applies, except a ceiling a higher floor overrides.
 */
export type RuleEffect = 'min_task' | 'min_read_me' | 'max_read_me' | 'suppress';

/** hard = matched in SQL every run · lesson = a judgment call the run reads as an example */
export type RuleKind = 'hard' | 'lesson';

export type RuleOrigin = 'surface_more' | 'surface_less' | 'manual';

/** Every field given must match. Needs at least one of sender, domain, subjectTerms, channel. */
export interface RuleMatch {
  source?: ReviewedRow['source'];
  /** Exact address, any case. */
  sender?: string;
  /** Sender's domain; subdomains count. */
  domain?: string;
  /** Every word must appear in the title. */
  subjectTerms?: string[];
  /** Text the chat, channel or board name must contain. */
  channel?: string;
}

export interface TriageRule {
  id: string;
  kind: RuleKind;
  match: RuleMatch | null;
  effect: RuleEffect;
  note?: string;
  active: boolean;
  createdFrom: RuleOrigin;
  exampleId?: string;
  createdAt: string;
  /** Reviewed rows it fired on in the last 30 days. */
  hits30d: number;
  lastHitAt?: string;
}

/** What a draft hard rule would catch in one run. */
export interface RulePreview {
  briefingDate: string | null;
  matched: number;
  wouldChange: number;
  matched30d: number;
  rows: { id: string; source: ReviewedRow['source']; title: string; from: string; outcome: ReviewedOutcome; reasonGroup: string; changes: boolean }[];
}

// ── Work type (My Day 2.3, supabase/migrations/add_worklist_work_type.sql) ───

/** Which phase 3 worker could do the first pass on a task. */
export type WorkType = 'reply' | 'dtools_report' | 'ipt_change' | 'none';

export const WORK_TYPES: WorkType[] = ['reply', 'dtools_report', 'ipt_change', 'none'];

export const WORK_TYPE_LABEL: Record<WorkType, string> = {
  reply: 'Reply',
  dtools_report: 'D-Tools report',
  ipt_change: 'IPT change',
  none: 'No worker',
};

/** The phase 3 gate: how often the run's tag matched Seth's check. */
export interface WorkTypeAccuracy {
  days: number;
  checked: number;
  agreed: number;
  /** Tasks the run hadn't tagged that Seth tagged himself (not graded). */
  untagged: number;
  misses: { tagged: WorkType; was: WorkType; n: number }[];
}
