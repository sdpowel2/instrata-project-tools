import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  Mail, MessageSquare, LayoutGrid, PenLine, Sparkles, ExternalLink, CheckCircle2, Bookmark, BookmarkCheck, EyeOff, Brain, Share2,
} from 'lucide-react';
import { Card } from '../ui';
import type { Project } from '../../types';
import type { Briefing, NoteTarget, ReadMeItem, ReadMeState, WorkItemSource, WorkTypeAccuracy } from './types';
import { ScopeChip, ScopeMenu } from './NoteScope';
import { targetLabel } from './projects';
import { WORK_TYPE_LABEL } from './types';
import { formatHHMM, formatTimeRange } from './format';

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
              <span key={b} className="text-xs font-mono bg-white border border-border rounded px-1.5 py-0.5 text-fg-2">{formatTimeRange(b)}</span>
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

interface ReadMeProps {
  briefing: Briefing;
  /** Log / Hide (2.5). Without these the card is read-only. */
  stateOf?: (line: ReadMeItem) => ReadMeState | undefined;
  onSet?: (line: ReadMeItem, state: ReadMeState | null) => void;
  /** "Less like this": open the tuning-rule form for a hidden line. */
  onLessLike?: (line: ReadMeItem) => void;
  /** Who a line is for when logged (2.6). Without these, lines have no scope controls. */
  targetOf?: (line: ReadMeItem) => NoteTarget;
  onTarget?: (line: ReadMeItem, target: NoteTarget) => void;
  /** Open the project picker for a line. */
  onPickProject?: (line: ReadMeItem) => void;
  projectsById?: Map<string, Project>;
}

export function ReadMeCard({ briefing, stateOf, onSet, onLessLike, targetOf, onTarget, onPickProject, projectsById }: ReadMeProps) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const shown = briefing.readMe.filter((r) => stateOf?.(r) !== 'hidden');
  const hidden = briefing.readMe.filter((r) => stateOf?.(r) === 'hidden');
  const scoped = !!(targetOf && onTarget && onPickProject);
  return (
    <Card title="Read me" eyebrow="Worth knowing" flush>
      <ul className="m-0 p-0 list-none">
        {shown.map((r) => {
          const Icon = SOURCE_ICON[r.source];
          const logged = stateOf?.(r) === 'logged';
          const target = targetOf?.(r) ?? { scope: 'personal' as const };
          const project = target.projectId ? projectsById?.get(target.projectId) : undefined;
          const menuOpen = menuFor === r.id;
          return (
            <li key={r.id} className="group relative flex gap-2.5 px-5 py-2.5 border-b border-border-soft last:border-b-0">
              <Icon size={13} className="text-fg-3 mt-1 flex-shrink-0" />
              <span className="text-sm text-fg leading-snug flex-1">
                {r.text}
                {logged && (
                  <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-semibold text-status-success-fg align-middle">
                    <BookmarkCheck size={11} /> logged
                  </span>
                )}
                {scoped && target.scope !== 'personal' && (
                  <span className="ml-1.5">
                    <ScopeChip target={target} project={project} pending={!logged} onClick={() => setMenuFor(menuOpen ? null : r.id)} />
                  </span>
                )}
              </span>
              {scoped && menuOpen && (
                <ScopeMenu
                  target={target}
                  onPick={(t) => { onTarget!(r, t); setMenuFor(null); }}
                  onPickProject={() => { setMenuFor(null); onPickProject!(r); }}
                  onClose={() => setMenuFor(null)}
                />
              )}
              {onSet && (
                <span className="flex items-start gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  {scoped && target.scope === 'personal' && (
                    <button
                      type="button"
                      onClick={() => setMenuFor(menuOpen ? null : r.id)}
                      className="p-0.5 rounded text-fg-3 hover:text-navy"
                      title="Who it's for: just you (now), the team, or a project's wiki"
                      aria-label="Share with the team or a project"
                    >
                      <Share2 size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onSet(r, logged ? null : 'logged')}
                    className={`p-0.5 rounded ${logged ? 'text-status-success-fg' : 'text-fg-3 hover:text-navy'}`}
                    title={logged
                      ? 'Logged. Click to undo.'
                      : target.scope === 'personal'
                        ? 'Log to your second brain (more like this)'
                        : `Log it: files to ${targetLabel(target, project)} tonight (more like this)`}
                    aria-label={logged ? 'Undo log' : 'Log to second brain'}
                  >
                    {logged ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSet(r, 'hidden')}
                    className="p-0.5 rounded text-fg-3 hover:text-navy"
                    title="Hide (less like this)"
                    aria-label="Hide"
                  >
                    <EyeOff size={14} />
                  </button>
                </span>
              )}
              {r.link && (
                <a href={r.link} target="_blank" rel="noreferrer" className="text-fg-3 hover:text-navy mt-0.5" aria-label="Open source">
                  <ExternalLink size={13} />
                </a>
              )}
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-5 py-3 text-sm text-fg-3">Nothing left to read.</li>}
      </ul>
      {hidden.length > 0 && onSet && (
        <details className="border-t border-border-soft">
          <summary className="px-5 py-2 text-xs text-fg-3 cursor-pointer hover:text-fg-2">
            {hidden.length} hidden
          </summary>
          <ul className="m-0 p-0 list-none">
            {hidden.map((r) => (
              <li key={r.id} className="flex items-start gap-2 px-5 py-1.5 text-xs text-fg-3 border-t border-border-soft">
                <span className="flex-1 min-w-0 line-clamp-2">{r.text}</span>
                <button type="button" onClick={() => onSet(r, null)} className="text-navy font-medium hover:underline flex-shrink-0">
                  Undo
                </button>
                {onLessLike && (
                  <button
                    type="button"
                    onClick={() => onLessLike(r)}
                    className="text-navy font-medium hover:underline flex-shrink-0"
                    title="Make a rule so the run puts less like this in the Read me"
                  >
                    Less like this
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

interface NoteCardProps {
  onAdd: (text: string, target: NoteTarget) => void;
  inboxCount: number | null;
  /** Who the next note is for (2.6). Without these, notes are always personal. */
  target?: NoteTarget;
  onTarget?: (target: NoteTarget) => void;
  onPickProject?: () => void;
  projectsById?: Map<string, Project>;
}

/** Quick capture into the second brain's inbox (2.5). The nightly run files it (2.6). */
export function NoteCard({ onAdd, inboxCount, target, onTarget, onPickProject, projectsById }: NoteCardProps) {
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const t = target ?? { scope: 'personal' as const };
  const project = t.projectId ? projectsById?.get(t.projectId) : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onAdd(text.trim(), t);
    setText('');
    // Back to private after every note, so sharing never carries over by accident.
    if (t.scope !== 'personal') onTarget?.({ scope: 'personal' });
  };
  return (
    <Card flush>
      <form onSubmit={submit} className="relative flex items-center gap-2 px-4 py-2.5">
        <Brain size={15} className="text-violet-600 flex-shrink-0" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Jot something for your second brain…"
          aria-label="Quick note for your second brain"
          maxLength={4000}
          className="flex-1 min-w-0 text-sm bg-transparent outline-none placeholder:text-fg-3"
        />
        {onTarget && onPickProject && (
          <button
            type="button"
            onClick={() => setMenu((m) => !m)}
            className={[
              'text-[11px] px-1.5 py-0.5 rounded border max-w-[150px] truncate flex-shrink-0',
              t.scope === 'personal' ? 'border-border text-fg-3 hover:text-fg' : 'border-navy/30 text-navy font-semibold bg-navy/[0.04]',
            ].join(' ')}
            title="Who this note is for"
          >
            {targetLabel(t, project)}
          </button>
        )}
        {menu && onTarget && onPickProject && (
          <ScopeMenu
            target={t}
            onPick={(next) => { onTarget(next); setMenu(false); }}
            onPickProject={() => { setMenu(false); onPickProject(); }}
            onClose={() => setMenu(false)}
          />
        )}
        <button
          type="submit"
          disabled={!text.trim()}
          className="text-xs font-medium px-2.5 py-1 rounded-lg bg-navy text-white disabled:opacity-40"
        >
          Save
        </button>
      </form>
      {inboxCount != null && inboxCount > 0 && (
        <div className="px-4 py-1.5 border-t border-border-soft text-[11px] text-fg-3">
          {inboxCount} {inboxCount === 1 ? 'note' : 'notes'} in the inbox, waiting to be filed
        </div>
      )}
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

/** The phase 3 gate (2.3): how often the run's work-type tag matched Seth's check. */
const GATE = 0.9;
/** Checks it takes before the percentage means much. */
const SAMPLE = 30;

export function WorkTypeCard({ accuracy, unchecked }: { accuracy: WorkTypeAccuracy | null; unchecked: number }) {
  if (!accuracy && unchecked === 0) return null;
  const checked = accuracy?.checked ?? 0;
  const agreed = accuracy?.agreed ?? 0;
  const pct = checked > 0 ? agreed / checked : null;
  const passing = pct !== null && pct >= GATE && checked >= SAMPLE;

  return (
    <Card title="Work types" eyebrow="Phase 3 gate" flush>
      <div className="px-5 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-2xl font-bold text-navy tabular-nums">{pct === null ? '–' : `${Math.round(pct * 100)}%`}</span>
          <span className="text-xs text-fg-3">
            {checked === 0 ? 'no checks yet' : `${agreed} of ${checked} tags right · last ${accuracy?.days ?? 30} days`}
          </span>
        </div>
        <div className="relative h-1.5 bg-surface rounded-full mt-2 overflow-hidden" aria-hidden>
          <div
            className={`h-full rounded-full ${passing ? 'bg-status-success-fg' : 'bg-orange'}`}
            style={{ width: `${Math.round((pct ?? 0) * 100)}%` }}
          />
          <div className="absolute top-0 bottom-0 w-px bg-navy/50" style={{ left: `${GATE * 100}%` }} />
        </div>
        <p className="text-xs text-fg-2 mt-2 leading-snug">
          {passing
            ? 'Passing: 90%+ on a sample of 30 or more. Workers can start.'
            : checked < SAMPLE
              ? `Gate is 90% on a hand-checked sample. ${checked} of ${SAMPLE} checks so far.`
              : 'Below the 90% gate. Corrections teach the next run.'}
          {unchecked > 0 && <> Click the chip on a task to confirm or correct it ({unchecked} waiting).</>}
        </p>
        {accuracy && accuracy.misses.length > 0 && (
          <ul className="m-0 p-0 list-none mt-2 space-y-0.5">
            {accuracy.misses.slice(0, 3).map((m) => (
              <li key={`${m.tagged}-${m.was}`} className="text-[11px] text-fg-3">
                Tagged {WORK_TYPE_LABEL[m.tagged]}, was {WORK_TYPE_LABEL[m.was]} · {m.n}×
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
