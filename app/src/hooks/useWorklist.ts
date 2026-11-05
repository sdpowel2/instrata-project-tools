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
import { SAMPLE_BRIEFING } from '../components/worklist/sampleData';
import { addDays, daysBetween, easternDate } from '../components/worklist/format';
import type { Briefing, WorkItem, WorkItemStatus, Urgency } from '../components/worklist/types';

const ITEM_COLS =
  'id, source, kind, title, from_label, summary, link, due, due_basis, urgency, urgency_reason, user_urgency, ' +
  'effective_urgency, status, snoozed_until, closed_at, closed_by, first_seen, options, answer';
const BRIEFING_COLS =
  'briefing_date, ran_at, window_since, missing, source_counts, schedule, open_blocks, read_me, set_aside';

interface ItemRow {
  id: string;
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
}

interface BriefingRow {
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
}

function toItem(r: ItemRow, today: string): WorkItem {
  return {
    id: r.id,
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
  };
}

function toBriefing(b: BriefingRow): Omit<Briefing, 'items' | 'closedSinceLast'> {
  return {
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
  const [b, open, closed] = await Promise.all([
    supabase.from('worklist_briefings').select(BRIEFING_COLS).eq('user_id', userId)
      .order('briefing_date', { ascending: false }).limit(2),
    supabase.from('worklist_items').select(ITEM_COLS).eq('user_id', userId)
      .in('status', ['open', 'snoozed']).limit(500),
    supabase.from('worklist_items').select(ITEM_COLS).eq('user_id', userId)
      .in('status', ['done', 'dismissed']).gte('closed_at', closedSince)
      .order('closed_at', { ascending: false }).limit(200),
  ]);
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
          .select(ITEM_COLS)
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
  };
}
