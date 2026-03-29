import { useState } from 'react';
import { useParams, useNavigate, NavLink, Outlet } from 'react-router-dom';
import { FileText, MessageSquareWarning, ClipboardCheck, BookOpen, ArrowLeft, Users } from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../components/StatusBadge';
import { ProjectMembersModal } from '../components/ProjectMembersModal';
import { isSupabaseConfigured } from '../lib/supabase';

const tabs = [
  { to: '', label: 'Overview', end: true },
  { to: 'submittals', label: 'Submittals', icon: FileText },
  { to: 'rfis', label: 'RFIs', icon: MessageSquareWarning },
  { to: 'closeout', label: 'Closeout', icon: ClipboardCheck },
  { to: 'manual', label: 'Owner Manual', icon: BookOpen },
];

export function ProjectHome() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const [teamModalOpen, setTeamModalOpen] = useState(false);

  if (!project) {
    return <div className="p-8 text-text-secondary">Project not found.</div>;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Project header */}
      <div className="bg-white border-b border-border px-8 pt-6 pb-0">
        <button onClick={() => navigate('/projects')} className="flex items-center gap-1 text-sm text-text-secondary hover:text-navy mb-3 transition-colors">
          <ArrowLeft size={14} /> All Projects
        </button>
        <div className="flex items-start justify-between mb-5">
          <div>
            <h1 className="text-xl font-bold text-navy">{project.name}</h1>
            <div className="flex items-center gap-3 mt-1.5 text-sm text-text-secondary">
              <span className="font-mono">{project.number}</span>
              <span>&middot;</span>
              <span>{project.client}</span>
              {project.address && <><span>&middot;</span><span>{project.address}</span></>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {isSupabaseConfigured() && (
              <button
                onClick={() => setTeamModalOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-navy border border-border rounded-lg hover:bg-surface transition-colors"
              >
                <Users size={14} />
                Team
              </button>
            )}
            <StatusBadge status={project.status} />
          </div>
        </div>

        {/* Tab nav */}
        <nav className="flex gap-1 -mb-px">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                `flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  isActive
                    ? 'border-orange text-navy'
                    : 'border-transparent text-text-secondary hover:text-navy hover:border-border'
                }`
              }
            >
              {tab.icon && <tab.icon size={16} />}
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        <Outlet />
      </div>

      {/* Project members modal */}
      <ProjectMembersModal
        open={teamModalOpen}
        onClose={() => setTeamModalOpen(false)}
        projectId={project.id}
        projectName={project.name}
      />
    </div>
  );
}
