// Live data for the My Day page: the latest briefing and the worklist items,
// read and written as the signed-in user (RLS keeps every row private to its
// owner). Writes go straight to worklist_items; the database logs each change
// to worklist_feedback, which the morning-worklist skill reads as calibration.
// A realtime subscription refetches when the morning run saves.
//
// Sample mode (offline demo, or ?sample=1) keeps the fictional briefing with
// local-only state, so the page still works without Supabase.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { SAMPLE_BRIEFING, SAMPLE_REVIEWED } from '../components/worklist/sampleData';
import { addDays, daysBetween, easternDate } from '../components/worklist/format';
import type {
  Briefing, ReadMeItem, ReadMeState, ReviewedRow, WorkItem, WorkItemKind, WorkItemStatus, Urgency, WorkType, WorkTypeAccuracy,
} from '../components/worklist/types';

const ITEM_BASE_COLS =
  'id, source, source_key, kind, title, from_label, summary, link, due, due_basis, urgency, urgency_reason, user_urgency, ' +
  'effective_urgency, status, snoozed_until, closed_at, closed_by, first_seen, options, answer';
// The work-type columns come with the 2.3 migration (add_worklist_work_type.sql),
// the project columns with 2.4 (add_worklist_projects.sql). Newest first; a load
// that hits a missing column (42703) steps down to the next set.
const ITEM_WT_COLS = `${ITEM_BASE_COLS}, work_type, work_confidence, user_work_type, effective_work_type`;
const ITEM_COLS = `${ITEM_WT_COLS}, project_id, suggested_project_id`;
const ITEM_COL_SETS = [ITEM_COLS, ITEM_WT_COLS, ITEM_BASE_COLS];
const BRIEFING_COLS =
  'id, briefing_date, ran_at, window_since, missing, source_counts, schedule, open_blocks, read_me, set_aside';
const REVIEWED_BASE_COLS =
  'id, source, source_key, title, from_label, link, outcome, reason, reason_group, item_id, surfaced_at';
// sender / channel / rule_ids come with the 2.2 migration (add_triage_rules.sql).
const REVIEWED_COLS = `${REVIEWED_BASE_COLS}, sender, channel, rule_ids`;

interface ReviewedDbRow {
  id: string;
  source: ReviewedRow['source'];
  source_key: string;
  title: string;
  from_label: string | null;
  link: string | null;
  outcome: ReviewedRow['outcome'];
  reason: string;
  reason_group: string;
  item_id: string | null;
  surfaced_at: string | null;
  sender?: string | null;
  channel?: string | null;
  rule_ids?: string[] | null;
}

function toReviewed(r: ReviewedDbRow): ReviewedRow {
  return {
    id: r.id,
    source: r.source,
    sourceKey: r.source_key,
    title: r.title,
    from: r.from_label ?? '',
    link: r.link ?? undefined,
    outcome: r.outcome,
    reason: r.reason,
    reasonGroup: r.reason_group,
    itemId: r.item_id ?? undefined,
    surfacedAt: r.surfaced_at ?? undefined,
    sender: r.sender ?? undefined,
    channel: r.channel ?? undefined,
    ruleIds: r.rule_ids ?? [],
  };
}

interface ItemRow {
  id: string;
  source_key: string;
  source: WorkItem['source'];
  kind: WorkItem['kind'];
  title: string;
  from_label: string | null;
  summary: string | null;
  link: string | null;
  due: string | null;
  due_basis: WorkItem['dueBasis'];
  urgency: Urgency;
  urgency_reason: string | null;
  user_urgency: Urgency | null;
  effective_urgency: Urgency;
  status: WorkItemStatus;
  snoozed_until: string | null;
  closed_at: string | null;
  closed_by: 'user' | 'briefing' | null;
  first_seen: string;
  options: string[] | null;
  answer: string | null;
  work_type?: WorkType | null;
  work_confidence?: number | null;
  user_work_type?: WorkType | null;
  effective_work_type?: WorkType | null;
  project_id?: string | null;
  suggested_project_id?: string | null;
}

interface BriefingRow {
  id: string;
  briefing_date: string;
  ran_at: string;
  window_since: string | null;
  missing: Briefing['missing'];
  source_counts: Partial<Briefing['sourceCounts']>;
  schedule: Briefing['schedule'];
  open_blocks: string[];
  read_me: Briefing['readMe'];
  set_aside: Briefing['setAside'];
}

export type WorklistMode = 'live' | 'sample';

export interface Worklist {
  mode: WorklistMode;
  loading: boolean;
  error: string | null;
  /** Eastern calendar day, YYYY-MM-DD. */
  today: string;
  /** Latest briefing (items included), or null if none has run yet. */
  briefing: Briefing | null;
  /** True when the latest briefing is from an earlier day. */
  stale: boolean;
  items: WorkItem[];
  setStatus: (id: string, status: WorkItemStatus) => void;
  setUrgency: (id: string, urgency: Urgency) => void;
  addTask: (title: string, due: string | null) => void;
  answer: (id: string, option: string) => void;
  dismissError: () => void;
  /** The latest run's reviewed log; null until loadReviewed() has run. */
  reviewed: ReviewedRow[] | null;
  reviewedLoading: boolean;
  reviewedError: string | null;
  loadReviewed: () => void;
  /** "Surface this": put a reviewed conversation on the list. */
  surface: (reviewedId: string, kind: Exclude<WorkItemKind, 'question'>, urgency: Urgency) => void;
  /** Confirm or correct a task's work type (2.3); both count toward the phase 3 gate. */
  setWorkType: (id: string, workType: WorkType) => void;
  /** Of the run's tags Seth checked in the last 30 days, how many he agreed with. Null until loaded. */
  workTypeAccuracy: WorkTypeAccuracy | null;
  /** Connect a task to a project, or unlink it (null) (2.4). */
  linkProject: (id: string, projectId: string | null) => void;
  /** Yes or no to the run's suggested project. No is remembered, so it isn't suggested again. */
  answerSuggestion: (id: string, accept: boolean) => void;
  /** Log / Hide state of a line in the shown briefing's Read me (2.5). */
  readMeState: (line: ReadMeItem) => ReadMeState | undefined;
  /** Log or hide a read-me line; null undoes. Logging puts it in the second brain's inbox. */
  setReadMe: (line: ReadMeItem, state: ReadMeState | null) => void;
  /** A quick note straight into the second brain's inbox. */
  addNote: (text: string) => void;
  /** Notes waiting in the inbox (status new); null until loaded or before the 2.5 migration. */
  inboxCount: number | null;
}

function toItem(r: ItemRow, today: string): WorkItem {
  return {
    id: r.id,
    sourceKey: r.source_key,
    kind: r.kind,
    source: r.source,
    title: r.title,
    from: r.from_label ?? '',
    due: r.due,
    dueBasis: r.due_basis,
    urgency: r.effective_urgency,
    claudeUrgency: r.urgency,
    urgencyReason: r.urgency_reason ?? '',
    link: r.link ?? undefined,
    carriedDays: Math.max(0, daysBetween(r.first_seen, today)),
    status: r.status,
    userOverridden: r.user_urgency != null,
    options: r.options ?? undefined,
    summary: r.summary ?? undefined,
    snoozedUntil: r.snoozed_until ?? undefined,
    answer: r.answer ?? undefined,
    workType: r.effective_work_type ?? undefined,
    claudeWorkType: r.work_type ?? undefined,
    workConfidence: r.work_confidence == null ? undefined : Number(r.work_confidence),
    workTypeChecked: r.user_work_type != null,
    projectId: r.project_id ?? undefined,
    suggestedProjectId: r.suggested_project_id ?? undefined,
  };
}

function toBriefing(b: BriefingRow): Omit<Briefing, 'items' | 'closedSinceLast'> {
  return {
    id: b.id,
    date: b.briefing_date,
    ranAt: b.ran_at,
    since: b.window_since ?? b.ran_at,
    missing: b.missing ?? [],
    sourceCounts: { mail: 0, teams: 0, monday: 0, manual: 0, ...b.source_counts },
    schedule: b.schedule ?? [],
    openBlocks: b.open_blocks ?? [],
    readMe: b.read_me ?? [],
    setAside: { categories: b.set_aside?.categories ?? [], items: b.set_aside?.items ?? [] },
  };
}

interface Fetched {
  briefings: BriefingRow[];
  rows: ItemRow[];
  today: string;
  error: string | null;
}

async function fetchWorklist(userId: string): Promise<Fetched> {
  const today = easternDate();
  // Closed items from the last few days feed "done today" and "closed since last briefing".
  const closedSince = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const items = (cols: string) =>
    Promise.all([
      supabase.from('worklist_items').select(cols).eq('user_id', userId)
        .in('status', ['open', 'snoozed']).limit(500),
      supabase.from('worklist_items').select(cols).eq('user_id', userId)
        .in('status', ['done', 'dismissed']).gte('closed_at', closedSince)
        .order('closed_at', { ascending: false }).limit(200),
    ]);
  const [b, first] = await Promise.all([
    supabase.from('worklist_briefings').select(BRIEFING_COLS).eq('user_id', userId)
      .order('briefing_date', { ascending: false }).limit(2),
    items(ITEM_COL_SETS[0]),
  ]);
  // A migration not applied yet means missing columns (42703): fall back a step.
  let [open, closed] = first;
  for (let i = 1; i < ITEM_COL_SETS.length && open.error?.code === '42703'; i++) {
    [open, closed] = await items(ITEM_COL_SETS[i]);
  }
  const err = b.error ?? open.error ?? closed.error;
  return {
    briefings: (b.data ?? []) as unknown as BriefingRow[],
    rows: [...(open.data ?? []), ...(closed.data ?? [])] as unknown as ItemRow[],
    today,
    error: err ? `Couldn't load your worklist: ${err.message}` : null,
  };
}

function wantsSample(): boolean {
  if (!isSupabaseConfigured()) return true;
  try {
    return new URLSearchParams(window.location.search).has('sample');
  } catch {
    return false;
  }
}

export function useWorklist(): Worklist {
  const { user } = useAuth();
  const [mode] = useState<WorklistMode>(() => (wantsSample() ? 'sample' : 'live'));
  const [today, setToday] = useState(() => (mode === 'sample' ? SAMPLE_BRIEFING.date : easternDate()));

  const [rows, setRows] = useState<ItemRow[]>([]);
  const [briefingRows, setBriefingRows] = useState<BriefingRow[]>([]);
  const [sampleItems, setSampleItems] = useState<WorkItem[]>(SAMPLE_BRIEFING.items);
  const [loading, setLoading] = useState(mode === 'live');
  const [error, setError] = useState<string | null>(null);

  const userId = user?.id;
  const fetchSeq = useRef(0);

  // ── Load ────────────────────────────────────────────────────────────────────
  // Results are applied in promise callbacks; fetchSeq drops a stale response
  // when a newer load has started.
  const apply = useCallback((seq: number, f: Fetched) => {
    if (seq !== fetchSeq.current) return;
    if (f.error) {
      setError(f.error);
    } else {
      setBriefingRows(f.briefings);
      setRows(f.rows);
      setError((prev) => (prev?.startsWith('Still loading') ? null : prev));
    }
    setToday(f.today);
    setLoading(false);
  }, []);

  const load = useCallback(() => {
    if (mode !== 'live' || !userId) return;
    const seq = ++fetchSeq.current;
    void fetchWorklist(userId).then((f) => apply(seq, f));
  }, [mode, userId, apply]);

  useEffect(() => {
    if (mode !== 'live' || !userId) return;
    const seq = ++fetchSeq.current;
    void fetchWorklist(userId).then((f) => apply(seq, f));
  }, [mode, userId, apply]);

  // The app's Supabase auth lock occasionally stalls every request after a
  // sign-in; say so instead of spinning forever.
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(
      () => setError('Still loading after 15 seconds. Reload the page; if it keeps happening, sign out and back in.'),
      15_000,
    );
    return () => clearTimeout(t);
  }, [loading]);

  // ── Realtime: refetch when the morning run (or another tab) changes rows ────
  useEffect(() => {
    if (mode !== 'live' || !userId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refetch = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    };
    const channel = supabase
      .channel(`worklist:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'worklist_items', filter: `user_id=eq.${userId}` }, refetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'worklist_briefings', filter: `user_id=eq.${userId}` }, refetch)
      .subscribe();
    // Pick up a new day (and anything missed) when the tab comes back.
    const onVisible = () => { if (document.visibilityState === 'visible') refetch(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      void supabase.removeChannel(channel);
    };
  }, [mode, userId, load]);

  // ── Derived view ────────────────────────────────────────────────────────────
  const view = useMemo(() => {
    if (mode === 'sample') {
      return { briefing: { ...SAMPLE_BRIEFING, items: sampleItems }, items: sampleItems };
    }
    const [latest, previous] = briefingRows;
    // Only today's closures show in the "done today" section; older ones are history.
    const visible = rows.filter((r) => r.status === 'open' || r.status === 'snoozed' || (r.closed_at && easternDate(r.closed_at) === today));
    const items = visible.map((r) => toItem(r, today));
    if (!latest) return { briefing: null, items };

    // Timestamps come back in mixed formats (+00:00 vs Z), so compare as numbers.
    const since = previous ? Date.parse(previous.ran_at) : Date.parse(latest.ran_at) - 86_400_000;
    const closedSinceLast = rows
      .filter((r) => r.closed_by === 'briefing' && r.closed_at && Date.parse(r.closed_at) > since)
      .map((r) => ({ id: r.id, title: r.title }));
    return { briefing: { ...toBriefing(latest), items, closedSinceLast }, items };
  }, [mode, sampleItems, briefingRows, rows, today]);

  // ── Writes (optimistic; refetch on failure to resync) ──────────────────────
  const patchRow = useCallback((id: string, patch: Partial<ItemRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const write = useCallback(
    async (label: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
      const { error: e } = await run();
      if (e) {
        setError(`${label} didn't save: ${e.message}`);
        load();
      }
    },
    [load],
  );

  const setStatus = useCallback(
    (id: string, status: WorkItemStatus) => {
      if (mode === 'sample') {
        setSampleItems((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));
        return;
      }
      const snoozed_until = status === 'snoozed' ? addDays(easternDate(), 1) : null;
      const closed = status === 'done' || status === 'dismissed';
      patchRow(id, {
        status,
        snoozed_until,
        closed_at: closed ? new Date().toISOString() : null,
        closed_by: closed ? 'user' : null,
      });
      void write('That change', () =>
        supabase.from('worklist_items').update({ status, snoozed_until }).eq('id', id),
      );
    },
    [mode, patchRow, write],
  );

  const setUrgency = useCallback(
    (id: string, urgency: Urgency) => {
      if (mode === 'sample') {
        setSampleItems((prev) => prev.map((i) => (i.id === id ? { ...i, urgency, userOverridden: true } : i)));
        return;
      }
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      // Picking Claude's own urgency again clears the override.
      const user_urgency = urgency === row.urgency ? null : urgency;
      patchRow(id, { user_urgency, effective_urgency: urgency });
      void write('The urgency change', () =>
        supabase.from('worklist_items').update({ user_urgency }).eq('id', id),
      );
    },
    [mode, rows, patchRow, write],
  );

  const addTask = useCallback(
    (title: string, due: string | null) => {
      if (mode === 'sample') {
        setSampleItems((prev) => [
          {
            id: `m-${Date.now()}`, kind: 'do', source: 'manual', title, from: 'manual',
            due, dueBasis: due ? 'stated' : 'none', urgency: 3,
            urgencyReason: 'Added by you', carriedDays: 0, status: 'open',
          },
          ...prev,
        ]);
        return;
      }
      void (async () => {
        const { data, error: e } = await supabase
          .from('worklist_items')
          .insert({
            source: 'manual', kind: 'do', title, from_label: 'manual',
            due, due_basis: due ? 'stated' : 'none', urgency: 3, urgency_reason: 'Added by you',
          })
          .select(ITEM_BASE_COLS) // a new manual task has no work type yet
          .single();
        if (e) {
          setError(`The task didn't save: ${e.message}`);
          return;
        }
        const added = data as unknown as ItemRow;
        setRows((prev) => (prev.some((r) => r.id === added.id) ? prev : [added, ...prev]));
      })();
    },
    [mode],
  );

  const answer = useCallback(
    (id: string, option: string) => {
      if (mode === 'sample') {
        setSampleItems((prev) => prev.map((i) => (i.id === id ? { ...i, answer: option, status: 'done' } : i)));
        return;
      }
      patchRow(id, { answer: option, status: 'done', closed_at: new Date().toISOString(), closed_by: 'user' });
      void write('Your answer', () =>
        supabase.from('worklist_items').update({ answer: option, status: 'done' }).eq('id', id),
      );
    },
    [mode, patchRow, write],
  );

  const dismissError = useCallback(() => setError(null), []);

  // ── Work type (2.3) ────────────────────────────────────────────────────────
  const [accuracy, setAccuracy] = useState<WorkTypeAccuracy | null>(null);

  const loadAccuracy = useCallback(() => {
    if (mode !== 'live' || !userId) return;
    void supabase.rpc('work_type_accuracy', { p_days: 30 }).then(({ data, error: e }) => {
      if (!e && data) setAccuracy(data as WorkTypeAccuracy);
    });
  }, [mode, userId]);

  useEffect(() => { loadAccuracy(); }, [loadAccuracy]);

  const sampleAccuracy = useMemo((): WorkTypeAccuracy | null => {
    if (mode !== 'sample') return null;
    const graded = sampleItems.filter((i) => i.workTypeChecked && i.claudeWorkType);
    const misses = new Map<string, { tagged: WorkType; was: WorkType; n: number }>();
    for (const i of graded) {
      if (i.claudeWorkType === i.workType || !i.workType || !i.claudeWorkType) continue;
      const k = `${i.claudeWorkType}>${i.workType}`;
      const m = misses.get(k) ?? { tagged: i.claudeWorkType, was: i.workType, n: 0 };
      misses.set(k, { ...m, n: m.n + 1 });
    }
    return {
      days: 30,
      checked: graded.length,
      agreed: graded.filter((i) => i.claudeWorkType === i.workType).length,
      untagged: sampleItems.filter((i) => i.workTypeChecked && !i.claudeWorkType).length,
      misses: [...misses.values()].sort((a, b) => b.n - a.n),
    };
  }, [mode, sampleItems]);

  const setWorkType = useCallback(
    (id: string, workType: WorkType) => {
      if (mode === 'sample') {
        setSampleItems((prev) => prev.map((i) => (i.id === id ? { ...i, workType, workTypeChecked: true } : i)));
        return;
      }
      patchRow(id, { user_work_type: workType, effective_work_type: workType });
      void (async () => {
        const { error: e } = await supabase.from('worklist_items').update({ user_work_type: workType }).eq('id', id);
        if (e) {
          setError(`The work type didn't save: ${e.message}`);
          load();
          return;
        }
        loadAccuracy();
      })();
    },
    [mode, patchRow, load, loadAccuracy],
  );

  // ── Connect project (2.4) ──────────────────────────────────────────────────
  const linkProject = useCallback(
    (id: string, projectId: string | null) => {
      if (mode === 'sample') {
        setSampleItems((prev) => prev.map((i) => (i.id === id
          ? { ...i, projectId: projectId ?? undefined, suggestedProjectId: projectId ? undefined : i.suggestedProjectId }
          : i)));
        return;
      }
      // Linking clears the suggestion (the database does the same).
      patchRow(id, projectId ? { project_id: projectId, suggested_project_id: null } : { project_id: null });
      void write(projectId ? 'The project link' : 'Unlinking', () =>
        supabase.from('worklist_items').update({ project_id: projectId }).eq('id', id),
      );
    },
    [mode, patchRow, write],
  );

  const answerSuggestion = useCallback(
    (id: string, accept: boolean) => {
      if (mode === 'sample') {
        setSampleItems((prev) => prev.map((i) => (i.id === id
          ? { ...i, projectId: accept ? i.suggestedProjectId : i.projectId, suggestedProjectId: undefined }
          : i)));
        return;
      }
      const suggested = rows.find((r) => r.id === id)?.suggested_project_id;
      if (!suggested) return;
      if (accept) {
        linkProject(id, suggested);
        return;
      }
      patchRow(id, { suggested_project_id: null });
      void write('Dismissing the suggestion', () =>
        supabase.from('worklist_items').update({ suggested_project_id: null, dismissed_project_id: suggested }).eq('id', id),
      );
    },
    [mode, rows, linkProject, patchRow, write],
  );

  // ── Read me Log / Hide + quick notes (2.5) ─────────────────────────────────
  // States are keyed by read-me id, but a same-day re-run reuses ids for other
  // lines, so a state only applies while its text snapshot still matches.
  const briefingDate = view.briefing?.date;
  const [readMe, setReadMeMap] = useState<{ date?: string; states: Map<string, { state: ReadMeState; text: string }> }>(
    () => ({ states: new Map() }),
  );
  const [inboxCount, setInboxCount] = useState<number | null>(mode === 'sample' ? 2 : null);

  const loadInbox = useCallback(() => {
    if (mode !== 'live' || !userId) return;
    void supabase.from('brain_raw').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'new')
      .then(({ count, error: e }) => { if (!e) setInboxCount(count ?? 0); });
  }, [mode, userId]);

  useEffect(() => { loadInbox(); }, [loadInbox]);

  useEffect(() => {
    if (mode !== 'live' || !userId || !briefingDate) return;
    let cancelled = false;
    void supabase.from('worklist_readme_state').select('readme_id, state, readme_text')
      .eq('user_id', userId).eq('briefing_date', briefingDate)
      .then(({ data, error: e }) => {
        if (cancelled || e) return; // before the 2.5 migration: no states
        const states = new Map<string, { state: ReadMeState; text: string }>();
        for (const r of (data ?? []) as { readme_id: string; state: ReadMeState; readme_text: string }[]) {
          states.set(r.readme_id, { state: r.state, text: r.readme_text });
        }
        setReadMeMap({ date: briefingDate, states });
      });
    return () => { cancelled = true; };
  }, [mode, userId, briefingDate]);

  const readMeState = useCallback(
    (line: ReadMeItem): ReadMeState | undefined => {
      if (readMe.date !== undefined && readMe.date !== briefingDate) return undefined;
      const s = readMe.states.get(line.id);
      return s && s.text === line.text.trim().slice(0, 500) ? s.state : undefined;
    },
    [readMe, briefingDate],
  );

  const setReadMe = useCallback(
    (line: ReadMeItem, state: ReadMeState | null) => {
      if (!briefingDate) return;
      const text = line.text.trim();
      const prev = readMe.states.get(line.id);
      const apply = (next: { state: ReadMeState; text: string } | undefined) =>
        setReadMeMap((m) => {
          const states = new Map(m.date === briefingDate ? m.states : []);
          if (next) states.set(line.id, next); else states.delete(line.id);
          return { date: briefingDate, states };
        });
      apply(state ? { state, text: text.slice(0, 500) } : undefined);
      const wasLogged = prev?.state === 'logged' && prev.text === text.slice(0, 500);
      const delta = (state === 'logged' ? 1 : 0) - (wasLogged ? 1 : 0);
      if (delta) setInboxCount((c) => (c == null ? c : Math.max(0, c + delta)));
      if (mode === 'sample') return;
      void supabase
        .rpc('set_readme_state', {
          p_date: briefingDate, p_readme_id: line.id, p_state: state, p_text: text,
          p_source: line.source, p_link: line.link ?? null,
        })
        .then(({ error: e }) => {
          if (!e) return;
          apply(prev);
          setError(`That read-me change didn't save: ${e.message}`);
          loadInbox();
        });
    },
    [briefingDate, readMe, mode, loadInbox],
  );

  const addNote = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      setInboxCount((c) => (c == null ? (mode === 'sample' ? 1 : c) : c + 1));
      if (mode === 'sample') return;
      void supabase.from('brain_raw').insert({ source: 'note', text: t.slice(0, 4000) }).then(({ error: e }) => {
        if (e) setError(`The note didn't save: ${e.message}`);
        loadInbox();
      });
    },
    [mode, loadInbox],
  );

  // ── Reviewed log (2.1): loaded only when the drawer opens ─────────────────
  const [reviewed, setReviewed] = useState<ReviewedRow[] | null>(null);
  const [reviewedLoading, setReviewedLoading] = useState(false);
  const [reviewedError, setReviewedError] = useState<string | null>(null);
  // Which briefing the cached rows belong to; a new morning run makes them stale.
  const [reviewedFor, setReviewedFor] = useState<string | undefined>(undefined);
  const latestBriefingId = mode === 'sample' ? 'sample' : briefingRows[0]?.id;

  const loadReviewed = useCallback(() => {
    if (mode === 'sample') {
      setReviewed((prev) => prev ?? SAMPLE_REVIEWED);
      setReviewedFor('sample');
      return;
    }
    if (!userId || !latestBriefingId) {
      setReviewed([]);
      setReviewedFor(latestBriefingId);
      return;
    }
    setReviewedLoading(true);
    setReviewedError(null);
    const query = (cols: string) =>
      supabase.from('worklist_reviewed').select(cols).eq('user_id', userId).eq('briefing_id', latestBriefingId).limit(500);
    void query(REVIEWED_COLS)
      // Before the 2.2 migration the rule columns don't exist yet (42703): fall back.
      .then((res) => (res.error?.code === '42703' ? query(REVIEWED_BASE_COLS) : res))
      .then(({ data, error: e }) => {
        if (e) {
          const missing = e.code === '42P01' || e.code === 'PGRST205';
          setReviewedError(missing ? "The reviewed log isn't set up yet." : `Couldn't load the reviewed log: ${e.message}`);
          setReviewed([]);
        } else {
          setReviewed(((data ?? []) as unknown as ReviewedDbRow[]).map(toReviewed));
        }
        setReviewedFor(latestBriefingId);
        setReviewedLoading(false);
      });
  }, [mode, userId, latestBriefingId]);

  const surface = useCallback(
    (reviewedId: string, kind: Exclude<WorkItemKind, 'question'>, urgency: Urgency) => {
      const row = reviewed?.find((r) => r.id === reviewedId);
      if (!row) return;
      const now = new Date().toISOString();
      if (mode === 'sample') {
        const id = `s-${Date.now()}`;
        setSampleItems((prev) => [
          {
            id, kind, source: row.source, title: row.title, from: row.from, due: null, dueBasis: 'none',
            urgency, urgencyReason: 'Surfaced by you from the reviewed list', link: row.link,
            carriedDays: 0, status: 'open', userOverridden: true,
          },
          ...prev,
        ]);
        setReviewed((prev) => prev?.map((r) => (r.id === reviewedId ? { ...r, itemId: id, surfacedAt: now } : r)) ?? null);
        return;
      }
      setReviewed((prev) => prev?.map((r) => (r.id === reviewedId ? { ...r, surfacedAt: now } : r)) ?? null);
      void supabase
        .rpc('surface_reviewed', { p_id: reviewedId, p_kind: kind, p_urgency: urgency })
        .then(({ data, error: e }) => {
          if (e) {
            setError(`Surfacing didn't save: ${e.message}`);
            setReviewed((prev) => prev?.map((r) => (r.id === reviewedId ? { ...r, surfacedAt: undefined } : r)) ?? null);
            return;
          }
          setReviewed((prev) => prev?.map((r) => (r.id === reviewedId ? { ...r, itemId: data as string } : r)) ?? null);
          load();
        });
    },
    [mode, reviewed, load],
  );

  return {
    mode,
    loading,
    error,
    today,
    briefing: view.briefing,
    stale: !!view.briefing && view.briefing.date !== today,
    items: view.items,
    setStatus,
    setUrgency,
    addTask,
    answer,
    dismissError,
    reviewed: reviewedFor === latestBriefingId ? reviewed : null,
    reviewedLoading,
    reviewedError,
    loadReviewed,
    surface,
    setWorkType,
    workTypeAccuracy: mode === 'sample' ? sampleAccuracy : accuracy,
    linkProject,
    answerSuggestion,
    readMeState,
    setReadMe,
    addNote,
    inboxCount,
  };
}
