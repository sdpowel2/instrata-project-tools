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
}

export interface SetAsideItem {
  id: string;
  title: string;
  reason: string;
  link?: string;
}

export interface Briefing {
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
  /** Open 60+ minute blocks, e.g. "10:00–11:30". */
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
