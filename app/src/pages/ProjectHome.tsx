import { useParams, useNavigate, NavLink, Outlet } from 'react-router-dom';
import { FileText, MessageSquareWarning, ClipboardCheck, BookOpen, ArrowLeft } from 'lucide-react';
import { useStore } from '../store';
import { StatusBadge } from '../components/StatusBadge';

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
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));

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
          <StatusBadge status={project.status} />
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
    </div>
  );
}
