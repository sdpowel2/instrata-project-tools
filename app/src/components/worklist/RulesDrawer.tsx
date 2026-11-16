// The rules page (My Day 2.2), as a right-hand drawer like the reviewed log:
// every tuning rule with its match, effect, note and 30-day hit count, and
// controls to edit, switch off or delete it.

import { useEffect, useState } from 'react';
import { X, Plus, Pencil, Trash2 } from 'lucide-react';
import type { TriageRule } from './types';
import { EFFECT_SHORT, describeMatch } from './rules';
import { daysBetween, easternDate } from './format';

interface Props {
  open: boolean;
  onClose: () => void;
  rules: TriageRule[] | null;
  loading: boolean;
  error: string | null;
  today: string;
  onNew: () => void;
  onEdit: (rule: TriageRule) => void;
  onActive: (id: string, active: boolean) => void;
  onDelete: (id: string) => void;
}

const EFFECT_STYLE = {
  min_task: 'bg-orange/10 text-orange',
  min_read_me: 'bg-sky-50 text-sky-700',
  suppress: 'bg-surface text-fg-2',
} as const;

export function RulesDrawer({ open, onClose, rules, loading, error, today, onNew, onEdit, onActive, onDelete }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const all = rules ?? [];
  const hard = all.filter((r) => r.kind === 'hard');
  const lessons = all.filter((r) => r.kind === 'lesson');

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Triage rules">
      <button className="absolute inset-0 bg-navy/20 cursor-default" aria-label="Close" onClick={onClose} />
      <div className="relative w-full max-w-[540px] h-full bg-white shadow-2xl flex flex-col">
        <div className="px-5 pt-4 pb-3 border-b border-border">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-orange">Tune the morning run</div>
              <div className="text-lg font-bold text-navy mt-0.5">
                {loading ? 'Loading…' : `${all.length} rule${all.length === 1 ? '' : 's'}`}
              </div>
              <div className="text-xs text-fg-3 mt-0.5">
                Hard rules are applied in code every run. Lessons are examples Claude reads first.
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={onNew}
                className="flex items-center gap-1 whitespace-nowrap text-xs font-medium px-2.5 py-1.5 rounded-lg bg-navy text-white hover:bg-navy/90"
              >
                <Plus size={13} /> New rule
              </button>
              <button onClick={onClose} className="p-1.5 rounded-md text-fg-3 hover:text-navy hover:bg-surface" aria-label="Close">
                <X size={18} />
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && <div className="mx-5 mt-4 text-sm text-status-warn-fg bg-status-warn-bg rounded-lg px-3 py-2">{error}</div>}
          {!loading && !error && all.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-fg-2">
              No rules yet. Open “See what was reviewed” and use <b>More like this</b> or <b>Less like this</b> on a conversation.
            </div>
          )}
          {[
            { label: 'Hard rules', list: hard },
            { label: 'Lessons', list: lessons },
          ].map(({ label, list }) =>
            list.length === 0 ? null : (
              <section key={label}>
                <div className="sticky top-0 px-5 py-1.5 bg-surface border-y border-border-soft text-[11px] font-bold uppercase tracking-[0.1em] text-fg-2">
                  {label} <span className="text-fg-3 font-medium">· {list.length}</span>
                </div>
                {list.map((r) => (
                  <RuleLine key={r.id} rule={r} today={today} onEdit={onEdit} onActive={onActive} onDelete={onDelete} />
                ))}
              </section>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function RuleLine({ rule, today, onEdit, onActive, onDelete }: {
  rule: TriageRule;
  today: string;
  onEdit: Props['onEdit'];
  onActive: Props['onActive'];
  onDelete: Props['onDelete'];
}) {
  const [confirming, setConfirming] = useState(false);
  const hits = rule.hits30d === 0
    ? rule.kind === 'lesson' ? 'Not applied in the last 30 days' : 'No hits in the last 30 days'
    : `${rule.kind === 'lesson' ? 'Applied' : 'Fired'} ${rule.hits30d}× in 30 days${rule.lastHitAt ? ` · last ${ago(rule.lastHitAt, today)}` : ''}`;

  return (
    <div className={`px-5 py-3 border-b border-border-soft last:border-b-0 ${rule.active ? '' : 'opacity-55'}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${EFFECT_STYLE[rule.effect]}`}>{EFFECT_SHORT[rule.effect]}</span>
            <span className="text-sm text-fg">{describeMatch(rule.match)}</span>
          </div>
          {rule.note && <div className="text-xs italic text-fg-2 mt-1">“{rule.note}”</div>}
          <div className="text-[11px] text-fg-3 mt-1">
            {hits}
            {!rule.active && ' · switched off'}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <label className="flex items-center gap-1.5 text-[11px] text-fg-3 cursor-pointer mr-1" title={rule.active ? 'Switch off' : 'Switch on'}>
            <input
              type="checkbox"
              checked={rule.active}
              onChange={() => onActive(rule.id, !rule.active)}
              className="accent-navy"
              aria-label={rule.active ? 'Rule is on' : 'Rule is off'}
            />
            On
          </label>
          <button onClick={() => onEdit(rule)} className="p-1.5 rounded-md text-fg-3 hover:text-navy hover:bg-surface" aria-label="Edit rule">
            <Pencil size={13} />
          </button>
          <button onClick={() => setConfirming(true)} className="p-1.5 rounded-md text-fg-3 hover:text-status-danger-fg hover:bg-surface" aria-label="Delete rule">
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {confirming && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-fg-2">Delete this rule? Switching it off keeps it for later.</span>
          <button onClick={() => onDelete(rule.id)} className="font-medium px-2 py-0.5 rounded-md bg-status-danger-bg text-status-danger-fg hover:opacity-80">Delete</button>
          <button onClick={() => setConfirming(false)} className="font-medium px-2 py-0.5 rounded-md text-fg-2 hover:bg-surface">Keep</button>
        </div>
      )}
    </div>
  );
}

/** "today", "yesterday", or "Nov 12" (Eastern). */
function ago(iso: string, today: string): string {
  const n = daysBetween(easternDate(iso), today);
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}
