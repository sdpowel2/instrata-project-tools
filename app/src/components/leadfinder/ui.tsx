// Small Lead Finder building blocks in the Project Tools style.

import { useEffect, type ReactNode } from 'react';
import { X, Loader2, CircleAlert, CircleCheck } from 'lucide-react';
import type { Job, Lane, ReviewStatus } from './types';
import { LANE_COLOR, LANE_LABEL, REVIEWS, REVIEW_LABEL } from './types';

const LANE_BG: Record<Lane, string> = {
  direct_av: '#DCFCE7',
  likely_av_scope: 'rgba(246,141,46,0.12)',
  none: '#F3F4F6',
};

export function LanePill({ lane }: { lane: Lane }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
      style={{ background: LANE_BG[lane], color: LANE_COLOR[lane] }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: LANE_COLOR[lane] }} />
      {LANE_LABEL[lane]}
    </span>
  );
}

type Tone = 'neutral' | 'info' | 'success' | 'warn' | 'danger' | 'navy' | 'orange';
const TONE: Record<Tone, string> = {
  neutral: 'bg-status-neutral-bg text-status-neutral-fg',
  info: 'bg-status-info-bg text-status-info-fg',
  success: 'bg-status-success-bg text-status-success-fg',
  warn: 'bg-status-warn-bg text-status-warn-fg',
  danger: 'bg-status-danger-bg text-status-danger-fg',
  navy: 'bg-navy/[0.08] text-navy',
  orange: 'bg-orange/[0.12] text-orange-dark',
};

export function Chip({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${TONE[tone]}`}>
      {children}
    </span>
  );
}

export function RatingChip({ rating }: { rating: string | null }) {
  const r = (rating || '').toUpperCase();
  const tone: Tone = r === 'GREEN' ? 'success' : r === 'YELLOW' ? 'warn' : r === 'RED' ? 'danger' : 'neutral';
  return <Chip tone={tone}>{rating || 'No rating'}</Chip>;
}

export function ReviewSelect({
  value, onChange, disabled, compact,
}: { value: ReviewStatus; onChange: (v: ReviewStatus) => void; disabled?: boolean; compact?: boolean }) {
  return (
    <select
      aria-label="Review status"
      value={value}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value as ReviewStatus)}
      className={compact
        ? `text-[12px] font-semibold rounded-md border border-border bg-white px-1.5 py-1 cursor-pointer focus:outline-none focus:border-navy ${value === 'pursue' ? 'text-orange-dark' : 'text-navy'}`
        : 'input'}
      style={compact ? undefined : { width: 'auto' }}
    >
      {REVIEWS.map((r) => <option key={r} value={r}>{REVIEW_LABEL[r]}</option>)}
    </select>
  );
}

export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} />;
}

export function Banner({ tone, children, onClose }: { tone: 'ok' | 'error' | 'warn' | 'info'; children: ReactNode; onClose?: () => void }) {
  const cls = {
    ok: 'bg-status-success-bg border-green-200 text-status-success-fg',
    error: 'bg-status-danger-bg border-red-200 text-status-danger-fg',
    warn: 'bg-status-warn-bg border-yellow-300/60 text-status-warn-fg',
    info: 'bg-status-info-bg border-blue-200 text-status-info-fg',
  }[tone];
  const Icon = tone === 'ok' ? CircleCheck : CircleAlert;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2.5 border rounded-xl px-4 py-2.5 text-sm ${cls}`}>
      <Icon size={16} className="mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">{children}</div>
      {onClose && (
        <button onClick={onClose} aria-label="Dismiss" className="flex-shrink-0 hover:opacity-70"><X size={15} /></button>
      )}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mt-6 mb-2.5">
      <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-navy m-0">{children}</h3>
      {action}
    </div>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px] m-0">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-fg-3">{k}</dt>
          <dd className="m-0 text-fg break-words">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Right-hand slide-over panel (Project Tools has only centered modals). */
export function SlideOver({ open, onClose, children, title, header }: {
  open: boolean; onClose: () => void; children: ReactNode; title: string; header?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <div className={`fixed inset-0 z-40 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      <div
        className={`absolute inset-0 bg-navy-dark/30 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-label={title}
        className={`absolute right-0 top-0 h-full w-full max-w-[720px] bg-white shadow-2xl flex flex-col transition-transform duration-200 ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-border">
          <div className="min-w-0 flex-1">{header}</div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-surface text-fg-2 flex-shrink-0">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-8">{open && children}</div>
      </aside>
    </div>
  );
}

export function JobLine({ job, label }: { job: Job; label: string }) {
  if (job.status === 'queued') {
    return <span className="inline-flex items-center gap-1.5 text-[13px] text-fg-2"><Spinner size={13} /> {label}: waiting for the worker…</span>;
  }
  if (job.status === 'running') {
    return <span className="inline-flex items-center gap-1.5 text-[13px] text-navy"><Spinner size={13} /> {label}…</span>;
  }
  return null;
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <th className={`px-4 py-2.5 font-semibold uppercase tracking-[0.05em] ${className}`}>{children}</th>;
}
