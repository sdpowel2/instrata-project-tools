import { useNavigate } from 'react-router-dom';
import { FolderOpen, FileText, MessageSquareWarning, AlertTriangle, Plus, ArrowRight } from 'lucide-react';
import { useStore } from '../store';
import { StatusBadge } from '../components/StatusBadge';

export function Dashboard() {
  const navigate = useNavigate();
  const projects = useStore((s) => s.projects);
  const submittals = useStore((s) => s.submittals);
  const rfis = useStore((s) => s.rfis);
  const closeouts = useStore((s) => s.closeouts);

  const recentProjects = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  const openRFIs = rfis.filter((r) => r.status === 'Open');
  const overdueRFIs = openRFIs.filter((r) => new Date(r.responseDue) < new Date());
  const pendingSubmittals = submittals.filter((s) => s.status === 'Submitted' || s.status === 'Revise & Resubmit');
  const allPunchItems = closeouts.flatMap((c) => c.punchItems);
  const openPunch = allPunchItems.filter((p) => p.status === 'Open' || p.status === 'In Progress');

  const stats = [
    { label: 'Active Projects', value: projects.filter((p) => p.status === 'Active').length, icon: FolderOpen, color: 'bg-navy' },
    { label: 'Open RFIs', value: openRFIs.length, icon: MessageSquareWarning, color: 'bg-blue' },
    { label: 'Pending Submittals', value: pendingSubmittals.length, icon: FileText, color: 'bg-orange' },
    { label: 'Open Punch Items', value: openPunch.length, icon: AlertTriangle, color: 'bg-yellow' },
  ];

  return (
    <div className="p-8 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-navy">Dashboard</h1>
          <p className="text-sm text-text-secondary mt-1">Welcome back. Here's your project overview.</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => navigate('/projects/new')}
            className="flex items-center gap-2 px-4 py-2.5 bg-navy text-white text-sm font-medium rounded-lg hover:bg-navy-light transition-colors"
          >
            <Plus size={16} />
            New Project
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-5 mb-8">
        {stats.map((stat) => (
          <div key={stat.label} className="bg-white rounded-xl border border-border p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div className={`w-10 h-10 ${stat.color} rounded-lg flex items-center justify-center`}>
                <stat.icon size={20} className="text-white" />
              </div>
              <span className="text-3xl font-bold text-text-primary">{stat.value}</span>
            </div>
            <div className="text-sm text-text-secondary font-medium">{stat.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Recent Projects */}
        <div className="col-span-2 bg-white rounded-xl border border-border shadow-sm">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <h2 className="text-base font-semibold text-navy">Recent Projects</h2>
            <button onClick={() => navigate('/projects')} className="text-sm text-blue font-medium hover:underline flex items-center gap-1">
              View all <ArrowRight size={14} />
            </button>
          </div>
          <div className="divide-y divide-border">
            {recentProjects.map((project) => (
              <button
                key={project.id}
                onClick={() => navigate(`/projects/${project.id}`)}
                className="w-full flex items-center justify-between px-6 py-4 hover:bg-surface/50 transition-colors text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text-primary truncate">{project.name}</div>
                  <div className="text-xs text-text-secondary mt-0.5">
                    <span className="font-mono">{project.number}</span> &middot; {project.client}
                  </div>
                </div>
                <div className="flex items-center gap-3 ml-4">
                  <StatusBadge status={project.status} />
                  <ChevronIcon />
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Alerts */}
        <div className="space-y-6">
          {/* Overdue RFIs */}
          <div className="bg-white rounded-xl border border-border shadow-sm">
            <div className="px-5 py-4 border-b border-border">
              <h2 className="text-base font-semibold text-navy">Overdue RFIs</h2>
            </div>
            {overdueRFIs.length === 0 ? (
              <div className="px-5 py-6 text-sm text-text-secondary text-center">No overdue RFIs</div>
            ) : (
              <div className="divide-y divide-border">
                {overdueRFIs.slice(0, 5).map((rfi) => {
                  const proj = projects.find((p) => p.id === rfi.projectId);
                  return (
                    <div key={rfi.id} className="px-5 py-3">
                      <div className="text-sm font-medium text-red-600">{rfi.number}: {rfi.subject}</div>
                      <div className="text-xs text-text-secondary mt-0.5">{proj?.name} &middot; Due {rfi.responseDue}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="bg-white rounded-xl border border-border shadow-sm">
            <div className="px-5 py-4 border-b border-border">
              <h2 className="text-base font-semibold text-navy">Quick Actions</h2>
            </div>
            <div className="p-4 space-y-2">
              {[
                { label: 'New Project', action: () => navigate('/projects/new') },
                { label: 'New Submittal', action: () => navigate('/projects') },
                { label: 'New RFI', action: () => navigate('/projects') },
              ].map((item) => (
                <button
                  key={item.label}
                  onClick={item.action}
                  className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-text-primary hover:bg-surface transition-colors"
                >
                  <Plus size={16} className="text-orange" />
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChevronIcon() {
  return <ArrowRight size={14} className="text-text-secondary" />;
}
