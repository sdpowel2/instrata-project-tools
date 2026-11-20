// Who a captured note is for (My Day 2.6): just you, the team, or a project's wiki.
// Personal is the default and nothing becomes shared without a click here (or a
// Log on a line the run suggested a project for, which shows the project first).
import { useEffect, useRef } from 'react';
import { FolderOpen, Lock, Users, Check } from 'lucide-react';
import type { Project } from '../../types';
import type { NoteTarget } from './types';
import { targetLabel } from './projects';

/** Small chip for a shared target; nothing for personal. */
export function ScopeChip({
  target, project, pending, onClick,
}: { target: NoteTarget; project: Project | undefined; pending?: boolean; onClick?: () => void }) {
  if (target.scope === 'personal') return null;
  const Icon = target.scope === 'project' ? FolderOpen : Users;
  const where = target.scope === 'project' ? `${project?.name ?? 'the project'}'s wiki notes` : 'the team’s shared pages';
  const title = pending ? `Logging this shares it with ${where}. Click to change.` : `Goes to ${where}. Click to change.`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={[
        'inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold text-navy max-w-[240px] align-middle',
        pending ? 'border border-dashed border-navy/35 bg-white' : 'border border-navy/25 bg-navy/[0.04]',
      ].join(' ')}
    >
      <Icon size={10} className="flex-shrink-0" />
      <span className="truncate">{targetLabel(target, project)}</span>
    </button>
  );
}

/** The three choices. Project… hands off to the project picker. */
export function ScopeMenu({
  target, onPick, onPickProject, onClose, align = 'right',
}: {
  target: NoteTarget;
  onPick: (target: NoteTarget) => void;
  onPickProject: () => void;
  onClose: () => void;
  align?: 'left' | 'right';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [onClose]);

  const row = (key: NoteTarget['scope'], Icon: typeof Lock, label: string, hint: string, action: () => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={action}
      className="w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-surface"
    >
      <Icon size={13} className="text-fg-3 mt-0.5 flex-shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-medium text-fg">{label}</span>
        <span className="block text-[10px] text-fg-3 leading-snug">{hint}</span>
      </span>
      {target.scope === key && <Check size={12} className="text-navy mt-0.5" />}
    </button>
  );

  return (
    <div
      ref={ref}
      role="menu"
      className={`absolute z-30 top-full mt-1 ${align === 'right' ? 'right-0' : 'left-0'} w-56 bg-white border border-border rounded-lg shadow-lg py-1`}
    >
      {row('personal', Lock, 'Just me', 'Your private second brain', () => onPick({ scope: 'personal' }))}
      {row('general', Users, 'Team', 'Shared pages everyone can read', () => onPick({ scope: 'general' }))}
      {row('project', FolderOpen, 'Project…', "The project wiki's Notes", onPickProject)}
    </div>
  );
}
