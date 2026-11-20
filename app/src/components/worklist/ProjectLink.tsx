// Connect a task to a project (My Day 2.4). Linking is always Seth's call: the
// morning run can only suggest (suggested_project_id), and the database puts
// back any link the run tries to make. A link writes the project's activity log.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderOpen, X, Check, Search } from 'lucide-react';
import type { Project } from '../../types';
import { projectCode, searchProjects, shortName } from './projects';

// ── The chip on a linked task ─────────────────────────────────────────────────
export function ProjectChip({ project, onUnlink }: { project: Project | undefined; onUnlink?: () => void }) {
  const label = project ? `${projectCode(project)} · ${shortName(project.name)}` : 'Linked project';
  return (
    <span className="inline-flex items-center rounded border border-navy/25 bg-navy/[0.04] text-[10px] font-semibold text-navy max-w-[300px]">
      {project ? (
        <Link
          to={`/projects/${project.id}`}
          className="flex items-center gap-1 pl-1.5 pr-1 py-px truncate hover:underline"
          title={`Open ${project.name}`}
        >
          <FolderOpen size={11} className="flex-shrink-0" />
          <span className="truncate">{label}</span>
        </Link>
      ) : (
        <span className="flex items-center gap-1 pl-1.5 pr-1 py-px"><FolderOpen size={11} /> {label}</span>
      )}
      {onUnlink && (
        <button
          type="button"
          onClick={onUnlink}
          className="px-1 py-px border-l border-navy/15 text-fg-3 hover:text-status-danger-fg"
          title="Unlink from this project"
          aria-label="Unlink from this project"
        >
          <X size={10} />
        </button>
      )}
    </span>
  );
}

// ── The run's suggestion, waiting for a yes or no ─────────────────────────────
export function SuggestionLine({
  project, onConfirm, onDismiss,
}: { project: Project; onConfirm: () => void; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2 mt-1.5 text-xs">
      <span className="flex items-center gap-1 text-fg-2 min-w-0">
        <FolderOpen size={12} className="text-fg-3 flex-shrink-0" />
        <span className="truncate">
          Link to <span className="font-semibold text-navy">{projectCode(project)} · {shortName(project.name, 40)}</span>?
        </span>
      </span>
      <button
        type="button"
        onClick={onConfirm}
        className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-navy/25 text-navy font-medium hover:bg-surface"
      >
        <Check size={11} /> Link
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="px-2 py-0.5 rounded-md text-fg-3 hover:text-fg hover:bg-surface"
        title="Not this project. The run won't suggest it again for this task."
      >
        No
      </button>
    </div>
  );
}

// ── The picker ────────────────────────────────────────────────────────────────
interface ModalProps {
  /** What's being connected: a task title, a read-me line or a note. */
  title: string;
  /** Heading; "Connect project" by default. */
  heading?: string;
  /** One line under the title, e.g. who will see it once shared. */
  hint?: string;
  projects: Project[];
  /** Projects linked on other tasks, most recent first: offered before typing. */
  recent: Project[];
  onPick: (projectId: string) => void;
  onClose: () => void;
}

export function ConnectProjectModal({ title, heading = 'Connect project', hint, projects, recent, onPick, onClose }: ModalProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const results = useMemo(() => (query.trim() ? searchProjects(projects, query) : recent.slice(0, 6)), [projects, recent, query]);
  const pick = (p: Project | undefined) => { if (p) onPick(p.id); };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={heading} className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-navy">{heading}</h2>
            <p className="text-xs text-fg-2 truncate" title={title}>{title}</p>
            {hint && <p className="text-[11px] text-fg-3 mt-0.5">{hint}</p>}
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface text-fg-3" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="px-5 pt-3">
          <label className="flex items-center gap-2 border border-border rounded-lg px-3 py-2 focus-within:border-navy">
            <Search size={14} className="text-fg-3" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                if (e.key === 'Enter') { e.preventDefault(); pick(results[active]); }
              }}
              placeholder="Name, number, client or code"
              aria-label="Search projects"
              className="flex-1 text-sm outline-none bg-transparent"
            />
          </label>
        </div>

        <div className="px-2 py-2 min-h-[120px]">
          {!query.trim() && results.length > 0 && (
            <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-3">Linked recently</div>
          )}
          {results.map((p, idx) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pick(p)}
              onMouseEnter={() => setActive(idx)}
              className={[
                'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left',
                idx === active ? 'bg-surface' : '',
              ].join(' ')}
            >
              <span className="text-[11px] font-semibold text-navy tabular-nums w-[104px] flex-shrink-0 truncate">{projectCode(p)}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-fg truncate">{p.name}</span>
                <span className="block text-xs text-fg-3 truncate">{[p.client, p.status].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
          ))}
          {query.trim() && results.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-fg-2">No project matches "{query.trim()}".</p>
          )}
          {!query.trim() && results.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-fg-3">Type to search {projects.length.toLocaleString()} projects.</p>
          )}
        </div>
      </div>
    </div>
  );
}
