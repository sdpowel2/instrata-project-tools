import { NavLink, Outlet, useParams } from 'react-router-dom';
import {
  LayoutDashboard, FolderOpen, FileText, MessageSquareWarning,
  ClipboardCheck, BookOpen, Settings, ChevronRight, LogOut,
} from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../contexts/AuthContext';
import instrataLogo from '../assets/instrata-logo-white.png';

const mainNav = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/projects', icon: FolderOpen, label: 'Projects' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

const moduleNav = [
  { to: 'submittals', icon: FileText, label: 'Submittals' },
  { to: 'rfis', icon: MessageSquareWarning, label: 'RFIs' },
  { to: 'closeout', icon: ClipboardCheck, label: 'Closeout' },
  { to: 'manual', icon: BookOpen, label: 'Owner Manual' },
];

export function Layout() {
  const { projectId } = useParams();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const { user, signOut } = useAuth();

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="w-64 min-w-[256px] bg-navy flex flex-col h-full">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-white/10">
          <img src={instrataLogo} alt="Instrata" className="h-8 w-auto object-contain" />
          <div className="text-orange text-[10px] font-bold tracking-[0.15em] uppercase mt-1">Project Tools</div>
        </div>

        {/* Main nav */}
        <nav className="flex-1 py-3 px-3 space-y-0.5 overflow-y-auto">
          {mainNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-white/10 text-white border-l-2 border-orange'
                    : 'text-white/60 hover:text-white hover:bg-white/5'
                }`
              }
            >
              <item.icon size={18} />
              {item.label}
            </NavLink>
          ))}

          {/* Project module nav */}
          {project && (
            <div className="mt-6 pt-4 border-t border-white/10">
              <div className="px-3 mb-3">
                <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-orange mb-1">Current Project</div>
                <div className="text-white text-sm font-medium truncate">{project.name}</div>
                <div className="text-white/40 text-xs font-mono">{project.number}</div>
              </div>
              {moduleNav.map((item) => (
                <NavLink
                  key={item.to}
                  to={`/projects/${projectId}/${item.to}`}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-white/10 text-white border-l-2 border-orange'
                        : 'text-white/60 hover:text-white hover:bg-white/5'
                    }`
                  }
                >
                  <item.icon size={18} />
                  {item.label}
                  <ChevronRight size={14} className="ml-auto opacity-40" />
                </NavLink>
              ))}
            </div>
          )}
        </nav>

        {/* User section */}
        {user && (
          <div className="px-4 py-3 border-t border-white/10">
            <div className="flex items-center justify-between mb-2">
              <div className="min-w-0">
                <div className="text-white text-sm font-medium truncate">
                  {user.fullName || user.email}
                </div>
                <span className="inline-block mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-orange/80">
                  {user.role}
                </span>
              </div>
            </div>
            <button
              onClick={() => { signOut(); }}
              className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-white/60 hover:text-white hover:bg-white/10 transition-colors text-xs"
            >
              <LogOut size={14} />
              Sign Out
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-4 border-t border-white/10">
          <div className="text-white/30 text-xs">v1.0 — Instrata / Premiere</div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
