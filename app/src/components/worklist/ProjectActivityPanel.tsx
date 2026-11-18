// "Your My Day" panel on a project's overview (My Day 2.4): the open tasks
// linked to this project and the activity log the database writes when a
// linked task changes. Owner-only (RLS), so each person sees only their own;
// ProjectOverview renders it for admins (the My Day users) only. Renders
// nothing until there is something to show, or if the 2.4 migration isn't in.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Link2Off, CircleCheck, RotateCcw, StickyNote, ArrowRight } from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../../lib/supabase';
import { Card } from '../ui';
import { SAMPLE_BRIEFING, SAMPLE_PROJECT_ACTIVITY } from './sampleData';
import { easternDate, formatDue, URGENCY_STYLE } from './format';
import type { ProjectActivity, Urgency, WorkItemKind } from './types';
import { KIND_LABEL, URGENCY_LABEL } from './types';

interface OpenTask {
  id: string;
  kind: WorkItemKind;
  title: string;
  urgency: Urgency;
  due: string | null;
}

const KIND_ICON: Record<ProjectActivity['kind'], typeof Link2> = {
  linked: Link2,
  unlinked: Link2Off,
  done: CircleCheck,
  reopened: RotateCcw,
  note: StickyNote,
};

const KIND_VERB: Record<ProjectActivity['kind'], string> = {
  linked: 'Linked',
  unlinked: 'Unlinked',
  done: 'Done',
  reopened: 'Reopened',
  note: 'Note',
};

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

export function ProjectActivityPanel({ projectId }: { projectId: string }) {
  const sample = !isSupabaseConfigured();
  const [live, setLive] = useState<{ projectId: string; tasks: OpenTask[]; activity: ProjectActivity[] } | null>(null);

  const sampleData = useMemo(() => (sample ? {
    tasks: SAMPLE_BRIEFING.items
      .filter((i) => i.projectId === projectId && i.status === 'open')
      .map((i) => ({ id: i.id, kind: i.kind, title: i.title, urgency: i.urgency, due: i.due })),
    activity: SAMPLE_PROJECT_ACTIVITY[projectId] ?? [],
  } : null), [sample, projectId]);

  useEffect(() => {
    if (sample) return;
    let cancelled = false;
    void Promise.all([
      supabase
        .from('worklist_items')
        .select('id, kind, title, effective_urgency, due')
        .eq('project_id', projectId)
        .in('status', ['open', 'snoozed'])
        .order('effective_urgency', { ascending: true })
        .limit(20),
      supabase
        .from('project_activity')
        .select('id, item_id, kind, title, detail, occurred_at')
        .eq('project_id', projectId)
        .order('occurred_at', { ascending: false })
        .limit(15),
    ]).then(([t, a]) => {
      if (cancelled) return;
      // Before the 2.4 migration the column/table is missing: show nothing.
      if (t.error || a.error) { setLive({ projectId, tasks: [], activity: [] }); return; }
      const tasks = (t.data ?? []).map((r) => ({
        id: r.id as string, kind: r.kind as WorkItemKind, title: r.title as string,
        urgency: r.effective_urgency as Urgency, due: (r.due as string | null) ?? null,
      }));
      const activity = (a.data ?? []).map((r) => ({
        id: r.id as string, itemId: (r.item_id as string | null) ?? undefined, kind: r.kind as ProjectActivity['kind'],
        title: r.title as string, detail: (r.detail as string | null) ?? undefined, occurredAt: r.occurred_at as string,
      }));
      setLive({ projectId, tasks, activity });
    });
    return () => { cancelled = true; };
  }, [projectId, sample]);

  const data = sampleData ?? (live?.projectId === projectId ? live : null);
  if (!data || (data.tasks.length === 0 && data.activity.length === 0)) return null;
  const { tasks, activity } = data;
  const today = easternDate();

  return (
    <div className="mt-5">
      <Card
        eyebrow="Only you see this"
        title="Your My Day"
        action={
          <Link to="/my-day" className="flex items-center gap-1 text-xs font-medium text-navy hover:underline">
            Open My Day <ArrowRight size={12} />
          </Link>
        }
        flush
      >
        <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x divide-border-soft">
          <section className="px-5 py-3">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-fg-2 mb-2">Open tasks · {tasks.length}</h3>
            {tasks.length === 0 && <p className="text-sm text-fg-3">Nothing open for this project.</p>}
            <ul className="space-y-1.5">
              {tasks.map((t) => {
                const due = t.due ? formatDue(t.due, today) : null;
                return (
                  <li key={t.id} className="flex items-start gap-2 text-sm">
                    <span className={`mt-0.5 text-[10px] font-semibold rounded-full px-1.5 py-px flex-shrink-0 ${URGENCY_STYLE[t.urgency]}`}>
                      {URGENCY_LABEL[t.urgency]}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="text-fg">{t.title}</span>
                      <span className="text-xs text-fg-3">
                        {' · '}{KIND_LABEL[t.kind]}
                        {due && (
                          <span className={due.overdue ? 'text-status-danger-fg' : ''}>
                            {' · '}{due.overdue ? due.label : `due ${due.label}`}
                          </span>
                        )}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
          <section className="px-5 py-3 border-t md:border-t-0 border-border-soft">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-fg-2 mb-2">Activity</h3>
            {activity.length === 0 && <p className="text-sm text-fg-3">No activity yet.</p>}
            <ul className="space-y-1.5">
              {activity.map((a) => {
                const Icon = KIND_ICON[a.kind];
                return (
                  <li key={a.id} className="flex items-start gap-2 text-sm" title={a.detail}>
                    <Icon size={14} className={`mt-0.5 flex-shrink-0 ${a.kind === 'done' ? 'text-status-success-fg' : 'text-fg-3'}`} />
                    <span className="flex-1 min-w-0">
                      <span className="text-fg-2">{KIND_VERB[a.kind]}:</span> <span className="text-fg">{a.title}</span>
                      {a.detail && <span className="block text-xs text-fg-3">{a.detail}</span>}
                    </span>
                    <span className="text-xs text-fg-3 tabular-nums flex-shrink-0">{shortDate(a.occurredAt)}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </Card>
    </div>
  );
}
