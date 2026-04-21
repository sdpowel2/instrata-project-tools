// Breadcrumb + title block shown at the top of every project page.
// Pulls Settings / Team modal openers from the ProjectHome outlet context so
// tool pages don't need to manage those modals themselves.
import { Link, useOutletContext } from 'react-router-dom';
import { ChevronRight, Settings as SettingsIcon, Users } from 'lucide-react';
import type { Project } from '../types';
import { StatusBadge } from './StatusBadge';
import { isSupabaseConfigured } from '../lib/supabase';
import type { ProjectOutletContext } from '../pages/ProjectHome';

interface ProjectHeaderProps {
  project: Project;
  /** Extra action node rendered left of the Settings / Team buttons. */
  rightSlot?: React.ReactNode;
}

export function ProjectHeader({ project, rightSlot }: ProjectHeaderProps) {
  // Cast is safe at runtime — ProjectHome always provides this context for its
  // child routes. Tool pages that render outside ProjectHome (none today) would
  // get undefined and we'd no-op the handlers.
  const ctx = useOutletContext<ProjectOutletContext | undefined>();

  return (
    <div>
      <div className="text-[13px] text-fg-2 mb-2 flex items-center gap-1.5">
        <Link to="/projects" className="text-fg-2 hover:text-navy no-underline">Projects</Link>
        <ChevronRight size={12} className="text-fg-2" />
        <span className="text-navy font-medium truncate">{project.name}</span>
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[26px] font-bold text-navy tracking-[-0.01em] m-0 leading-tight">
            {project.name}
          </h1>
          <div className="text-[13px] text-fg-2 mt-1.5 flex items-center gap-2.5 flex-wrap">
            <span className="font-mono text-fg">{project.number}</span>
            <span className="opacity-40">·</span>
            <span>{project.client}</span>
            {project.businessUnit && (
              <>
                <span className="opacity-40">·</span>
                <span>{project.businessUnit}</span>
              </>
            )}
            {project.value && (
              <>
                <span className="opacity-40">·</span>
                <span className="font-mono font-semibold text-fg">{project.value}</span>
              </>
            )}
            <StatusBadge status={project.status} dot />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {rightSlot}
          <button
            onClick={() => ctx?.openSettings()}
            className="btn-secondary text-sm"
            title="Project settings"
          >
            <SettingsIcon size={14} /> Settings
          </button>
          {isSupabaseConfigured() && (
            <button
              onClick={() => ctx?.openTeam()}
              className="btn-secondary text-sm"
              title="Project team"
            >
              <Users size={14} /> Team
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
