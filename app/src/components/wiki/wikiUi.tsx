// Small presentational pieces shared by the Project Wiki page and the room
// detail editor: status / severity / origin chips, a minimal markdown
// renderer for long-form notes, and a labelled form field. Components only
// (react-refresh) — helpers live in lib/projectWiki.ts.
import type { ReactNode } from 'react';
import {
  ROOM_STATUSES, WIKI_STATUSES, QUESTION_SEVERITIES, QUESTION_STATUSES, DECISION_KINDS, ORIGIN_LABELS, labelFor,
  type RoomStatus, type WikiStatus, type QuestionSeverity, type QuestionStatus, type DecisionKind, type WikiOrigin,
} from '../../lib/projectWiki';

// bg / fg pairs, inline so Tailwind purging can't drop dynamic classes.
const ROOM_STATUS_COLORS: Record<RoomStatus, [string, string]> = {
  pending:   ['#F3F4F6', '#4B5563'],
  clean:     ['#DCFCE7', '#15803D'],
  noted:     ['#FEF9C3', '#A16207'],
  escalated: ['#FEE2E2', '#B91C1C'],
  resolved:  ['rgba(34,50,110,0.1)', '#22326E'],
  authored:  ['rgba(0,114,206,0.1)', '#0072CE'],
};

const WIKI_STATUS_COLORS: Record<WikiStatus, [string, string]> = {
  draft:           ['#F3F4F6', '#4B5563'],
  in_progress:     ['rgba(246,141,46,0.1)', '#E07A1A'],
  awaiting_review: ['#FEE2E2', '#B91C1C'],
  reviewed:        ['#DBEAFE', '#1D4ED8'],
  final:           ['#DCFCE7', '#15803D'],
};

const SEVERITY_COLORS: Record<QuestionSeverity, [string, string]> = {
  functional_conflict:   ['#FEE2E2', '#B91C1C'],
  estimating_escalation: ['#FEF9C3', '#A16207'],
};

const QUESTION_STATUS_COLORS: Record<QuestionStatus, [string, string]> = {
  open:      ['#DBEAFE', '#1D4ED8'],
  answered:  ['rgba(34,50,110,0.1)', '#22326E'],
  resolved:  ['#DCFCE7', '#15803D'],
  withdrawn: ['#F9FAFB', '#9CA3AF'],
};

const DECISION_KIND_COLORS: Record<DecisionKind, [string, string]> = {
  validated:          ['#DCFCE7', '#15803D'],
  deviation_accepted: ['#FEF9C3', '#A16207'],
  assumption:         ['#FEE2E2', '#B91C1C'],
  rationale:          ['rgba(34,50,110,0.1)', '#22326E'],
  escalation_outcome: ['#DBEAFE', '#1D4ED8'],
};

function Chip({ colors, children, title }: { colors: [string, string]; children: ReactNode; title?: string }) {
  const [bg, fg] = colors;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
      style={{ background: bg, color: fg }}
      title={title}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: fg }} />
      {children}
    </span>
  );
}

export function RoomStatusChip({ status }: { status: RoomStatus }) {
  const def = ROOM_STATUSES.find((s) => s.key === status);
  return <Chip colors={ROOM_STATUS_COLORS[status] ?? ROOM_STATUS_COLORS.pending} title={def?.hint}>{def?.label ?? status}</Chip>;
}

export function WikiStatusChip({ status }: { status: WikiStatus }) {
  return <Chip colors={WIKI_STATUS_COLORS[status] ?? WIKI_STATUS_COLORS.draft}>{labelFor(WIKI_STATUSES, status)}</Chip>;
}

export function SeverityChip({ severity }: { severity: QuestionSeverity }) {
  const def = QUESTION_SEVERITIES.find((s) => s.key === severity);
  return <Chip colors={SEVERITY_COLORS[severity]} title={def?.hint}>{def?.label ?? severity}</Chip>;
}

export function QuestionStatusChip({ status }: { status: QuestionStatus }) {
  return <Chip colors={QUESTION_STATUS_COLORS[status] ?? QUESTION_STATUS_COLORS.open}>{labelFor(QUESTION_STATUSES, status)}</Chip>;
}

export function DecisionKindChip({ kind }: { kind: DecisionKind }) {
  return <Chip colors={DECISION_KIND_COLORS[kind] ?? DECISION_KIND_COLORS.rationale}>{labelFor(DECISION_KINDS, kind)}</Chip>;
}

/** Muted provenance tag. Agent-written content is marked so readers know to weigh it. */
export function OriginTag({ origin }: { origin: WikiOrigin }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-surface text-fg-3 border border-border-soft">
      {ORIGIN_LABELS[origin]}
    </span>
  );
}

export function Field({ label, hint, required, children, className = '' }: { label: string; hint?: string; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="text-sm font-medium text-fg">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {hint && <span className="block text-xs text-fg-3 mt-0.5">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-fg-2 m-0">{children}</h3>
      {action}
    </div>
  );
}

// ── Minimal markdown ─────────────────────────────────────────────────────────
// Handles what agents and engineers actually write in notes: headings, bullet
// and numbered lists, **bold**, `code`, blank-line paragraphs. Everything is
// rendered as React text nodes, so there is no HTML injection surface. Not a
// full markdown parser — tables and links render as plain text.

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={`${key}-b${i++}`}>{tok.slice(2, -2)}</strong>);
    else out.push(<code key={`${key}-c${i++}`} className="px-1 py-0.5 rounded bg-surface text-[0.92em] font-mono">{tok.slice(1, -1)}</code>);
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownText({ text, className = '' }: { text: string | null | undefined; className?: string }) {
  if (!text || !text.trim()) return <p className={`text-sm text-fg-3 italic m-0 ${className}`}>Nothing written yet.</p>;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      blocks.push(<p key={`p${blocks.length}`} className="m-0">{inline(para.join(' '), `p${blocks.length}`)}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const Tag = list.ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={`l${blocks.length}`} className={`m-0 pl-5 space-y-0.5 ${list.ordered ? 'list-decimal' : 'list-disc'}`}>
          {list.items.map((it, i) => <li key={i}>{inline(it, `l${blocks.length}-${i}`)}</li>)}
        </Tag>,
      );
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (h) {
      flushPara(); flushList();
      const level = h[1].length;
      const cls = level === 1 ? 'text-base font-bold text-navy' : level === 2 ? 'text-[15px] font-semibold text-navy' : 'text-sm font-semibold text-fg';
      blocks.push(<div key={`h${blocks.length}`} className={`${cls} mt-1`}>{inline(h[2], `h${blocks.length}`)}</div>);
      continue;
    }
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      const item = (ul ?? ol)![1];
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push(item);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();

  return <div className={`text-sm text-fg leading-relaxed space-y-2 ${className}`}>{blocks}</div>;
}
