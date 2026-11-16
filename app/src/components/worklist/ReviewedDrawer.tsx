// The reviewed log (My Day 2.1): every conversation the morning run looked at,
// wherever it landed, grouped by the run's reason. Anything that didn't make
// the list gets "Surface this", which puts it on the list right away and
// teaches the next run (see Product Spec/my-day-roadmap.md, 2.1). "More like
// this" / "Less like this" open the tuning-rule form (2.2).

import { useEffect, useMemo, useState } from 'react';
import { X, Search, Mail, MessageSquare, LayoutGrid, ExternalLink, Plus, Check, ThumbsUp, ThumbsDown, SlidersHorizontal } from 'lucide-react';
import type { ReviewedOutcome, ReviewedRow, Urgency, WorkItemKind } from './types';
import { KIND_LABEL, ON_LIST_OUTCOMES, URGENCY_LABEL } from './types';
import { OUTCOME_LABEL } from './rules';

type Filter = 'all' | 'list' | 'read_me' | 'set_aside' | 'dropped';
type SurfaceKind = Exclude<WorkItemKind, 'question'>;

const FILTERS: { key: Filter; label: string; match: (o: ReviewedOutcome) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'list', label: 'On the list', match: (o) => ON_LIST_OUTCOMES.includes(o) },
  { key: 'read_me', label: 'Read me', match: (o) => o === 'read_me' },
  { key: 'set_aside', label: 'Set aside', match: (o) => o === 'set_aside' },
  { key: 'dropped', label: 'Dropped', match: (o) => o === 'dropped' },
];

const SOURCE_ICON = { email: Mail, teams: MessageSquare, monday: LayoutGrid } as const;

interface Props {
  open: boolean;
  onClose: () => void;
  rows: ReviewedRow[] | null;
  loading: boolean;
  error: string | null;
  /** The run line's message counts, for the header. */
  counts: { mail: number; teams: number; monday: number };
  onSurface: (id: string, kind: SurfaceKind, urgency: Urgency) => void;
  /** Open the rule form pre-filled from this conversation. */
  onTune: (row: ReviewedRow, direction: 'more' | 'less') => void;
  onOpenRules: () => void;
}

export function ReviewedDrawer({ open, onClose, rows, loading, error, counts, onSurface, onTune, onOpenRules }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const all = useMemo(() => rows ?? [], [rows]);
  const q = query.trim().toLowerCase();
  const visible = all.filter(
    (r) =>
      FILTERS.find((f) => f.key === filter)!.match(r.outcome) &&
      (!q || `${r.title} ${r.from} ${r.reason} ${r.reasonGroup}`.toLowerCase().includes(q)),
  );

  // Group by reason, biggest groups first.
  const groups = useMemo(() => {
    const map = new Map<string, ReviewedRow[]>();
    for (const r of visible) map.set(r.reasonGroup, [...(map.get(r.reasonGroup) ?? []), r]);
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [visible]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Reviewed by the morning run">
      <button className="absolute inset-0 bg-navy/20 cursor-default" aria-label="Close" onClick={onClose} />
      <div className="relative w-full max-w-[540px] h-full bg-white shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-5 pt-4 pb-3 border-b border-border">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-orange">Reviewed by the morning run</div>
              <div className="text-lg font-bold text-navy mt-0.5">
                {loading ? 'Loading…' : `${all.length} conversation${all.length === 1 ? '' : 's'}`}
              </div>
              <div className="text-xs text-fg-3 mt-0.5">
                From {counts.mail} emails · {counts.teams} Teams messages · {counts.monday} monday items
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={onOpenRules}
                className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-border text-navy hover:bg-surface"
              >
                <SlidersHorizontal size={13} /> Rules
              </button>
              <button onClick={onClose} className="p-1.5 rounded-md text-fg-3 hover:text-navy hover:bg-surface" aria-label="Close">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="flex gap-1 mt-3 flex-wrap">
            {FILTERS.map((f) => {
              const n = all.filter((r) => f.match(r.outcome)).length;
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={[
                    'text-xs font-medium px-2.5 py-1 rounded-lg transition-colors',
                    filter === f.key ? 'bg-navy text-white' : 'text-fg-2 hover:bg-surface',
                  ].join(' ')}
                >
                  {f.label} <span className="opacity-60">{n}</span>
                </button>
              );
            })}
          </div>

          <label className="mt-2.5 flex items-center gap-2 border border-border rounded-lg px-2.5 py-1.5">
            <Search size={14} className="text-fg-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search subject, sender or reason"
              aria-label="Search reviewed conversations"
              className="flex-1 min-w-0 text-sm bg-transparent outline-none placeholder:text-fg-3"
            />
          </label>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {error && <div className="mx-5 mt-4 text-sm text-status-warn-fg bg-status-warn-bg rounded-lg px-3 py-2">{error}</div>}
          {!loading && !error && all.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-fg-2">
              This run didn't record what it reviewed. Runs from skill v1.1 on include it.
            </div>
          )}
          {!loading && all.length > 0 && visible.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-fg-2">Nothing matches.</div>
          )}

          {groups.map(([group, list]) => (
            <section key={group}>
              <div className="sticky top-0 px-5 py-1.5 bg-surface border-y border-border-soft text-[11px] font-bold uppercase tracking-[0.1em] text-fg-2">
                {group} <span className="text-fg-3 font-medium">· {list.length}</span>
              </div>
              {list.map((r) => (
                <ReviewedLine key={r.id} row={r} onSurface={onSurface} onTune={onTune} />
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewedLine({ row, onSurface, onTune }: { row: ReviewedRow; onSurface: Props['onSurface']; onTune: Props['onTune'] }) {
  const [picking, setPicking] = useState(false);
  const [urgency, setUrgency] = useState<Urgency>(2);
  const Icon = SOURCE_ICON[row.source];
  const onList = ON_LIST_OUTCOMES.includes(row.outcome);
  // More: anything below the list. Less: anything that took up space (list or Read me).
  const canMore = !onList;
  const canLess = onList || row.outcome === 'read_me';
  const fired = row.ruleIds?.length ?? 0;

  return (
    <div className="px-5 py-2.5 border-b border-border-soft last:border-b-0">
      <div className="flex items-start gap-2.5">
        <Icon size={14} className="text-fg-3 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fg leading-snug">{row.title}</div>
          <div className="text-xs text-fg-2 mt-0.5">
            {row.from && <span>{row.from} · </span>}
            <span className="italic text-fg-3">{row.reason}</span>
            {fired > 0 && (
              <span
                className="ml-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-orange bg-orange/10 rounded px-1 py-px not-italic"
                title={`${fired} of your rules applied to this`}
              >
                Your rule
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {row.surfacedAt ? (
            <span className="flex items-center gap-1 text-[11px] font-semibold text-status-success-fg">
              <Check size={12} /> Surfaced
            </span>
          ) : onList ? (
            <span className="text-[11px] text-fg-3">{OUTCOME_LABEL[row.outcome]}</span>
          ) : (
            <>
              <span className="text-[11px] text-fg-3">{OUTCOME_LABEL[row.outcome]}</span>
              <button
                onClick={() => setPicking((p) => !p)}
                className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg border border-border text-navy hover:bg-surface"
                aria-expanded={picking}
              >
                <Plus size={12} /> Surface
              </button>
            </>
          )}
          {canMore && (
            <button onClick={() => onTune(row, 'more')} className="p-1 text-fg-3 hover:text-navy" title="Surface more like this" aria-label="Surface more like this">
              <ThumbsUp size={13} />
            </button>
          )}
          {canLess && (
            <button onClick={() => onTune(row, 'less')} className="p-1 text-fg-3 hover:text-navy" title="Surface less like this" aria-label="Surface less like this">
              <ThumbsDown size={13} />
            </button>
          )}
          {row.link && (
            <a href={row.link} target="_blank" rel="noreferrer" className="p-1 text-fg-3 hover:text-navy" aria-label="Open original">
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </div>

      {picking && !row.surfacedAt && (
        <div className="mt-2 ml-6 flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-fg-3">Add as</span>
          {(['respond', 'do', 'decide'] as SurfaceKind[]).map((k) => (
            <button
              key={k}
              onClick={() => { onSurface(row.id, k, urgency); setPicking(false); }}
              className="text-xs font-medium px-2.5 py-1 rounded-lg bg-navy text-white hover:bg-navy/90"
            >
              {KIND_LABEL[k]}
            </button>
          ))}
          <select
            value={urgency}
            onChange={(e) => setUrgency(Number(e.target.value) as Urgency)}
            aria-label="Urgency for the surfaced task"
            className="text-xs border border-border rounded-md px-1.5 py-1 text-fg-2 bg-white"
          >
            {([1, 2, 3, 4] as Urgency[]).map((u) => (
              <option key={u} value={u}>{URGENCY_LABEL[u]}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
