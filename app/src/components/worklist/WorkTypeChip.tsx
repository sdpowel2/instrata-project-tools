// The work-type chip on a task (My Day 2.3): which phase 3 worker could do the
// first pass. Dashed = the run's guess, not checked yet; solid with a tick =
// Seth confirmed or corrected it. Every check (even "yes, that's right") is
// logged as feedback and counts toward the phase 3 gate.

import { useEffect, useRef, useState } from 'react';
import { Reply, FileSpreadsheet, Code, CircleSlash, Check, Tag } from 'lucide-react';
import type { WorkItem, WorkType } from './types';
import { WORK_TYPES, WORK_TYPE_LABEL } from './types';

const ICON: Record<WorkType, typeof Reply> = {
  reply: Reply,
  dtools_report: FileSpreadsheet,
  ipt_change: Code,
  none: CircleSlash,
};

const STYLE: Record<WorkType, string> = {
  reply: 'text-blue border-blue/40',
  dtools_report: 'text-emerald-700 border-emerald-300',
  ipt_change: 'text-violet-700 border-violet-300',
  none: 'text-fg-3 border-border',
};

interface Props {
  item: WorkItem;
  onPick: (id: string, workType: WorkType) => void;
}

export function WorkTypeChip({ item, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const wt = item.workType;
  const Icon = wt ? ICON[wt] : Tag;
  const conf = item.workConfidence;
  const unsure = !item.workTypeChecked && conf !== undefined && conf < 0.6;
  const title = !wt
    ? 'Not tagged. Click to say which worker could do this.'
    : item.workTypeChecked
      ? item.claudeWorkType && item.claudeWorkType !== wt
        ? `You changed this from ${WORK_TYPE_LABEL[item.claudeWorkType]}.`
        : 'You confirmed this.'
      : `Claude's guess${conf !== undefined ? ` (${Math.round(conf * 100)}% sure)` : ''}. Click to confirm or correct.`;

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-label={`Work type: ${wt ? WORK_TYPE_LABEL[wt] : 'not tagged'}`}
        aria-expanded={open}
        className={[
          'flex items-center gap-1 text-[10px] font-semibold rounded px-1.5 py-px border transition-colors hover:bg-surface',
          wt ? STYLE[wt] : 'text-fg-3 border-border',
          item.workTypeChecked ? 'border-solid' : 'border-dashed',
        ].join(' ')}
      >
        <Icon size={11} />
        {wt ? WORK_TYPE_LABEL[wt] : 'Tag'}
        {unsure && '?'}
        {item.workTypeChecked && <Check size={10} />}
      </button>

      {open && (
        <div role="menu" className="absolute left-0 top-full mt-1 z-30 w-56 bg-white border border-border rounded-lg shadow-lg py-1">
          <div className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-3">Who could do the first pass?</div>
          {WORK_TYPES.map((t) => {
            const I = ICON[t];
            return (
              <button
                key={t}
                role="menuitem"
                type="button"
                onClick={() => { onPick(item.id, t); setOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-surface"
              >
                <I size={13} className={STYLE[t].split(' ')[0]} />
                <span className="flex-1 text-fg">{WORK_TYPE_LABEL[t]}</span>
                {item.claudeWorkType === t && <span className="text-[10px] text-fg-3">Claude's pick</span>}
                {wt === t && item.workTypeChecked && <Check size={12} className="text-status-success-fg" />}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
