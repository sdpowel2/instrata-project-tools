// My Day: Seth's personal worklist, built each morning by the
// morning-worklist skill and saved to Supabase through the save_briefing MCP
// tool. useWorklist reads it live; ?sample=1 (or offline demo mode) shows the
// fictional sample briefing instead.

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Plus, CircleCheck, CircleAlert, Sparkles, RefreshCw, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Card, PageHeader } from '../components/ui';
import { WorkItemRow } from '../components/worklist/WorkItemRow';
import { ScheduleCard, ReadMeCard, SetAsideCard, ClosedCard } from '../components/worklist/SidePanels';
import { useWorklist } from '../hooks/useWorklist';
import { formatClock, formatDayClock, formatDue, formatLongDate, URGENCY_STYLE } from '../components/worklist/format';
import type { Briefing, WorkItem, WorkItemKind, Urgency } from '../components/worklist/types';
import { KIND_LABEL, URGENCY_LABEL } from '../components/worklist/types';

type KindFilter = 'all' | Exclude<WorkItemKind, 'question'>;

export function MyDayPage() {
  const { isAdmin } = useAuth();
  const wl = useWorklist();
  const { briefing, items, today, setStatus, setUrgency, addTask, answer } = wl;
  const [filter, setFilter] = useState<KindFilter>('all');

  const questions = items.filter((i) => i.kind === 'question' && i.status === 'open');
  const tasks = items.filter((i) => i.kind !== 'question');
  const open = tasks.filter((i) => i.status === 'open');
  const done = tasks.filter((i) => i.status === 'done');
  const snoozedOrDismissed = tasks.filter((i) => i.status === 'snoozed' || i.status === 'dismissed');
  const needsACall = open.filter((i) => i.carriedDays >= 3);

  const visible = filter === 'all' ? open : open.filter((i) => i.kind === filter);
  const byUrgency: Record<Urgency, WorkItem[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const i of visible) byUrgency[i.urgency].push(i);

  if (!isAdmin) return <Navigate to="/" replace />;

  if (wl.loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 h-64">
        <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-orange" />
        {wl.error && <p className="text-sm text-status-warn-fg">{wl.error}</p>}
      </div>
    );
  }

  const rowProps = { today, onStatus: setStatus, onUrgency: setUrgency, onAnswer: answer };

  const counts = (k: KindFilter) => (k === 'all' ? open.length : open.filter((i) => i.kind === k).length);

  return (
    <div className="p-8 max-w-[1320px]">
      <PageHeader
        eyebrow="My Day"
        title={formatLongDate(today)}
        subtitle={briefing ? <RunHealth briefing={briefing} /> : 'No briefing yet. Run /morning-worklist in Claude Code.'}
        actions={
          <>
            {wl.mode === 'sample' && (
              <span className="self-center text-[11px] font-semibold uppercase tracking-[0.08em] text-violet-700 bg-violet-50 border border-violet-200 rounded-full px-2.5 py-1">
                Sample data
              </span>
            )}
            <button
              disabled
              title="Coming later: run the briefing from here"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-fg-3 bg-white border border-border rounded-lg cursor-not-allowed"
            >
              <RefreshCw size={13} /> Re-run briefing
            </button>
          </>
        }
      />

      {wl.error && (
        <div role="alert" className="flex items-start justify-between gap-3 mb-4 bg-status-danger-bg border border-red-200 rounded-xl px-4 py-2.5 text-sm text-status-danger-fg">
          <span>{wl.error}</span>
          <button onClick={wl.dismissError} aria-label="Dismiss" className="flex-shrink-0 hover:opacity-70"><X size={15} /></button>
        </div>
      )}

      {wl.stale && briefing && (
        <div className="mb-4 bg-status-warn-bg border border-yellow-300/60 rounded-xl px-4 py-2.5 text-sm text-status-warn-fg">
          Today's briefing hasn't run yet. Showing open items, with the schedule and read-me from{' '}
          <span className="font-semibold">{formatLongDate(briefing.date)}</span>.
        </div>
      )}

      {/* Urgency summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {([1, 2, 3, 4] as Urgency[]).map((u) => (
          <div key={u} className="bg-white border border-border rounded-xl px-4 py-3 shadow-sm">
            <div className="flex items-center justify-between">
              <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${URGENCY_STYLE[u]}`}>{URGENCY_LABEL[u]}</span>
              <span className="text-2xl font-bold text-navy tabular-nums">{open.filter((i) => i.urgency === u).length}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6 items-start">
        {/* Main column */}
        <div className="space-y-6 min-w-0">
          {questions.length > 0 && (
            <Card
              eyebrow={<span className="text-violet-700">Phase 2 preview</span>}
              title={<span className="flex items-center gap-2"><Sparkles size={16} className="text-violet-600" /> Claude needs your input</span>}
              flush
            >
              {questions.map((q) => (
                <WorkItemRow key={q.id} item={q} {...rowProps} />
              ))}
            </Card>
          )}

          <Card
            title="Worklist"
            action={
              <div className="flex gap-1">
                {(['all', 'respond', 'do', 'decide'] as KindFilter[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => setFilter(k)}
                    className={[
                      'text-xs font-medium px-2.5 py-1 rounded-lg transition-colors',
                      filter === k ? 'bg-navy text-white' : 'text-fg-2 hover:bg-surface',
                    ].join(' ')}
                  >
                    {k === 'all' ? 'All' : KIND_LABEL[k]} <span className="opacity-60">{counts(k)}</span>
                  </button>
                ))}
              </div>
            }
            flush
          >
            <AddTaskForm onAdd={addTask} />

            {([1, 2, 3, 4] as Urgency[]).map((u) =>
              byUrgency[u].length === 0 ? null : (
                <section key={u}>
                  <div className="px-5 py-1.5 bg-surface border-y border-border-soft text-[11px] font-bold uppercase tracking-[0.1em] text-fg-2">
                    {URGENCY_LABEL[u]} <span className="text-fg-3 font-medium">· {byUrgency[u].length}</span>
                  </div>
                  {byUrgency[u].map((i) => (
                    <WorkItemRow key={i.id} item={i} {...rowProps} />
                  ))}
                </section>
              ),
            )}

            {visible.length === 0 && (
              <div className="px-5 py-10 text-center text-sm text-fg-2">Nothing here. Nice.</div>
            )}

            {(done.length > 0 || snoozedOrDismissed.length > 0) && (
              <details className="border-t border-border">
                <summary className="px-5 py-2.5 text-xs text-fg-3 cursor-pointer hover:text-fg-2">
                  {done.length} done today · {snoozedOrDismissed.length} snoozed or dismissed
                </summary>
                <div className="opacity-70">
                  {done.map((i) => (
                    <WorkItemRow key={i.id} item={i} {...rowProps} />
                  ))}
                </div>
                {snoozedOrDismissed.map((i) => (
                  <div key={i.id} className="flex items-center justify-between gap-3 px-5 py-2 border-t border-border-soft text-xs text-fg-3">
                    <span className="truncate">{i.title}</span>
                    <span className="flex items-center gap-2 flex-shrink-0">
                      {i.status === 'snoozed'
                        ? `Snoozed until ${i.snoozedUntil ? formatDue(i.snoozedUntil, today).label.toLowerCase() : 'later'}`
                        : 'Dismissed'}
                      <button onClick={() => setStatus(i.id, 'open')} className="text-navy font-medium hover:underline">Undo</button>
                    </span>
                  </div>
                ))}
              </details>
            )}
          </Card>

          {needsACall.length > 0 && (
            <div className="bg-status-warn-bg border border-yellow-300/60 rounded-xl px-5 py-3 text-sm text-status-warn-fg">
              <span className="font-semibold">Needs a call:</span>{' '}
              {needsACall.map((i) => i.title).join(' · ')} has been on the list {needsACall.length > 1 ? 'for days' : `${needsACall[0].carriedDays + 1} days`}.
              Do it, delegate it, or drop it.
            </div>
          )}
        </div>

        {/* Side column */}
        {briefing && (
          <div className="space-y-6">
            {!wl.stale && <ScheduleCard briefing={briefing} />}
            <ReadMeCard briefing={briefing} />
            <ClosedCard briefing={briefing} />
            <SetAsideCard briefing={briefing} />
          </div>
        )}
      </div>
    </div>
  );
}

function RunHealth({ briefing }: { briefing: Briefing }) {
    const c = briefing.sourceCounts;
    const ok = briefing.missing.length === 0;
    return (
      <span className="flex items-center gap-1.5 flex-wrap">
        {ok ? (
          <CircleCheck size={14} className="text-status-success-fg" />
        ) : (
          <CircleAlert size={14} className="text-status-warn-fg" />
        )}
        <span>
          Briefing ran {formatClock(briefing.ranAt)} · covers since {formatDayClock(briefing.since)} ·{' '}
          mail {c.mail} · Teams {c.teams} · monday {c.monday} · manual {c.manual}
        </span>
        {!ok && (
          <span className="text-status-warn-fg font-medium">
            · Missing: {briefing.missing.map((m) => m.source).join(', ')}
          </span>
        )}
      </span>
    );
}

function AddTaskForm({ onAdd }: { onAdd: (title: string, due: string | null) => void }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onAdd(title.trim(), due || null);
    setTitle('');
    setDue('');
  };

  return (
    <form onSubmit={submit} className="flex items-center gap-2 px-5 py-2.5 border-b border-border-soft">
      <Plus size={16} className="text-fg-3 flex-shrink-0" />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a task…"
        aria-label="New task"
        className="flex-1 min-w-0 text-sm bg-transparent outline-none placeholder:text-fg-3"
      />
      <input
        type="date"
        value={due}
        onChange={(e) => setDue(e.target.value)}
        aria-label="Due date"
        className="text-xs text-fg-2 bg-transparent border border-border rounded-md px-1.5 py-1"
      />
      <button
        type="submit"
        disabled={!title.trim()}
        className="text-xs font-medium px-3 py-1.5 rounded-lg bg-navy text-white disabled:opacity-40"
      >
        Add
      </button>
    </form>
  );
}
