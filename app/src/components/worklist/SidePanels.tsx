import { Mail, MessageSquare, LayoutGrid, PenLine, Sparkles, ExternalLink, CheckCircle2 } from 'lucide-react';
import { Card } from '../ui';
import type { Briefing, WorkItemSource } from './types';
import { formatHHMM } from './format';

const SOURCE_ICON: Record<WorkItemSource, typeof Mail> = {
  email: Mail,
  teams: MessageSquare,
  monday: LayoutGrid,
  manual: PenLine,
  claude: Sparkles,
};

export function ScheduleCard({ briefing }: { briefing: Briefing }) {
  const live = briefing.schedule.filter((e) => !e.canceled);
  const canceled = briefing.schedule.filter((e) => e.canceled);

  return (
    <Card title="Today's schedule" flush>
      <div className="px-5 py-3">
        {live.length === 0 && <p className="text-sm text-fg-2 m-0">No meetings today.</p>}
        <ol className="m-0 p-0 list-none">
          {live.map((e) => (
            <li key={e.id} className="flex gap-3 py-1.5">
              <div className="w-[72px] flex-shrink-0 text-xs font-mono text-fg-2 pt-px">{formatHHMM(e.start)}</div>
              <div className="min-w-0 border-l-2 border-navy/20 pl-3">
                <div className="text-sm font-medium text-fg leading-snug">{e.subject}</div>
                <div className="text-xs text-fg-3">
                  until {formatHHMM(e.end)}{e.location ? ` · ${e.location}` : ''}{e.isOrganizer ? ' · you organize' : ''}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
      {briefing.openBlocks.length > 0 && (
        <div className="px-5 py-3 border-t border-border-soft bg-status-success-bg/40">
          <div className="text-[11px] font-semibold text-status-success-fg uppercase tracking-[0.08em] mb-1">Open blocks</div>
          <div className="flex flex-wrap gap-1.5">
            {briefing.openBlocks.map((b) => (
              <span key={b} className="text-xs font-mono bg-white border border-border rounded px-1.5 py-0.5 text-fg-2">{b}</span>
            ))}
          </div>
        </div>
      )}
      {canceled.length > 0 && (
        <div className="px-5 py-2 border-t border-border-soft text-xs text-fg-3">
          Canceled: {canceled.map((e) => e.subject).join(', ')}
        </div>
      )}
    </Card>
  );
}

export function ReadMeCard({ briefing }: { briefing: Briefing }) {
  return (
    <Card title="Read me" eyebrow="Worth knowing" flush>
      <ul className="m-0 p-0 list-none">
        {briefing.readMe.map((r) => {
          const Icon = SOURCE_ICON[r.source];
          return (
            <li key={r.id} className="flex gap-2.5 px-5 py-2.5 border-b border-border-soft last:border-b-0">
              <Icon size={13} className="text-fg-3 mt-1 flex-shrink-0" />
              <span className="text-sm text-fg leading-snug flex-1">{r.text}</span>
              {r.link && (
                <a href={r.link} target="_blank" rel="noreferrer" className="text-fg-3 hover:text-navy mt-0.5" aria-label="Open source">
                  <ExternalLink size={13} />
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function SetAsideCard({ briefing }: { briefing: Briefing }) {
  const total = briefing.setAside.categories.reduce((n, c) => n + c.count, 0);
  return (
    <Card flush>
      <details className="group">
        <summary className="flex items-center justify-between px-5 py-3 cursor-pointer list-none">
          <span className="text-sm font-semibold text-navy">Set aside</span>
          <span className="text-xs text-fg-3">{total} items · tap to check Claude's work</span>
        </summary>
        <div className="border-t border-border-soft px-5 py-3 space-y-1">
          {briefing.setAside.categories.map((c) => (
            <div key={c.label} className="flex justify-between text-xs text-fg-2">
              <span>{c.label}</span><span className="font-mono">{c.count}</span>
            </div>
          ))}
        </div>
        {briefing.setAside.items.length > 0 && (
          <ul className="m-0 p-0 list-none border-t border-border-soft">
            {briefing.setAside.items.map((s) => (
              <li key={s.id} className="px-5 py-2 text-xs border-b border-border-soft last:border-b-0">
                <div className="text-fg">{s.title}</div>
                <div className="text-fg-3 italic">{s.reason}</div>
              </li>
            ))}
          </ul>
        )}
      </details>
    </Card>
  );
}

export function ClosedCard({ briefing }: { briefing: Briefing }) {
  if (briefing.closedSinceLast.length === 0) return null;
  return (
    <Card flush>
      <div className="px-5 py-3">
        <div className="text-xs font-semibold text-fg-2 mb-1.5">Closed since last briefing</div>
        <ul className="m-0 p-0 list-none space-y-1">
          {briefing.closedSinceLast.map((c) => (
            <li key={c.id} className="flex items-center gap-1.5 text-xs text-fg-3">
              <CheckCircle2 size={12} className="text-status-success-fg" />
              <span className="line-through">{c.title}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
