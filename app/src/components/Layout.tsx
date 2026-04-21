import { NavLink, Outlet, useParams, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, FolderOpen, FileText, MessageSquareWarning,
  ClipboardCheck, BookOpen, Settings, LogOut, ShieldCheck, Scale, Mail,
  Home, ScanLine,
} from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from './StatusBadge';
import instrataLogo from '../assets/instrata-logo-white.png';

const mainNav = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/projects', icon: FolderOpen, label: 'Projects' },
  { to: '/review-queue', icon: ShieldCheck, label: 'Review Queue' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

const presalesTools = [
  { to: 'review', icon: ScanLine, label: 'Auto-Review' },
  { to: 'bid-leveling', icon: Scale, label: 'Bid Leveling' },
  { to: 'rfis', icon: MessageSquareWarning, label: 'RFIs' },
];
const postsalesTools = [
  { to: 'submittals', icon: FileText, label: 'Submittals' },
  // RFIs persist into Post-Sales — answered RFIs from pre-sales remain visible
  { to: 'rfis', icon: MessageSquareWarning, label: 'RFIs' },
  { to: 'closeout', icon: ClipboardCheck, label: 'Closeout' },
  { to: 'manual', icon: BookOpen, label: 'Owner Manual' },
];

export function Layout() {
  const { projectId } = useParams();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const { user, signOut, isAdmin } = useAuth();

  return (
    <div className="flex h-full">
      <aside className="w-64 min-w-[256px] bg-navy flex flex-col h-full">
        {/* Wordmark */}
        <div className="px-5 py-4 border-b border-white/10">
          <img src={instrataLogo} alt="Instrata" className="h-6 w-auto object-contain object-left" />
          <div className="text-orange text-[10px] font-bold tracking-[0.15em] uppercase mt-1">Project Tools</div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2.5 py-3.5 overflow-y-auto flex flex-col gap-0.5">
          <SidebarEyebrow color="rgba(255,255,255,0.35)">Workspace</SidebarEyebrow>
          {mainNav.map((item) => (
            <SidebarLink key={item.to} to={item.to} icon={item.icon} label={item.label} end={item.to === '/'} />
          ))}
          {isAdmin && (
            <SidebarLink to="/personal-ops" icon={Mail} label="Personal Ops" />
          )}

          {project && (
            <>
              {/* Current project card */}
              <div className="mt-4 mb-2.5 mx-1 px-3.5 py-3 bg-white/[0.04] border border-white/[0.08] rounded-[10px]">
                <div className="text-[10px] font-bold text-orange tracking-[0.15em] uppercase mb-1">
                  Current Project
                </div>
                <div className="text-white text-[13px] font-semibold leading-[1.3] break-words">
                  {project.name}
                </div>
                <div className="text-white/45 text-[11px] font-mono mt-0.5 truncate">
                  {project.number}
                </div>
                <div className="mt-2"><StatusBadge status={project.status} dot /></div>
              </div>

              {/* Overview — persistent */}
              <div className="mb-3.5">
                <SidebarLink to={`/projects/${project.id}`} icon={Home} label="Overview" end />
              </div>

              {/* Pre-Sales group */}
              <PhaseGroup label="Pre-Sales" accent="#6FB6FF">
                {presalesTools.map((item) => (
                  <SidebarLink
                    key={`pre-${item.to}`}
                    to={`/projects/${project.id}/${item.to}`}
                    icon={item.icon}
                    label={item.label}
                    indent
                  />
                ))}
              </PhaseGroup>

              {/* Post-Sales group */}
              <PhaseGroup label="Post-Sales" accent="var(--color-orange)">
                {postsalesTools.map((item) => (
                  <SidebarLink
                    key={`post-${item.to}`}
                    to={`/projects/${project.id}/${item.to}`}
                    icon={item.icon}
                    label={item.label}
                    indent
                  />
                ))}
              </PhaseGroup>
            </>
          )}
        </nav>

        {/* User */}
        {user && (
          <div className="px-4 py-3 border-t border-white/10 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-orange text-white text-[12px] font-bold flex items-center justify-center flex-shrink-0">
              {initialsOf(user.fullName || user.email || 'U')}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-white text-[13px] font-semibold truncate">{user.fullName || user.email}</div>
              <div className="text-white/50 text-[11px] truncate">{user.role}</div>
            </div>
            <button
              onClick={() => signOut()}
              title="Sign out"
              className="p-1.5 rounded-md text-white/50 hover:text-white hover:bg-white/10 transition-colors"
            >
              <LogOut size={15} />
            </button>
          </div>
        )}

        <div className="px-5 py-2.5 border-t border-white/[0.08] text-white/30 text-[11px]">
          v2.0 — Instrata Project Tools
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

function SidebarEyebrow({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <div
      className="px-3 mb-2 text-[10px] font-bold tracking-[0.15em] uppercase"
      style={{ color }}
    >
      {children}
    </div>
  );
}

interface SidebarLinkProps {
  to: string;
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  end?: boolean;
  indent?: boolean;
}

function SidebarLink({ to, icon: Icon, label, end, indent }: SidebarLinkProps) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          'flex items-center gap-3 py-2.5 rounded-lg text-[14px] font-medium transition-colors',
          'border-l-2',
          indent ? 'pl-3.5' : 'pl-2.5',
          'pr-3',
          isActive
            ? 'bg-white/10 text-white border-orange'
            : 'text-white/65 hover:text-white hover:bg-white/5 border-transparent',
        ].join(' ')
      }
    >
      <Icon size={17} />
      <span className="flex-1">{label}</span>
    </NavLink>
  );
}

function PhaseGroup({ label, accent, children }: { label: string; accent: string; children: React.ReactNode }) {
  // Active path drives whether the group is highlighted; using location lets us
  // tint the group rail subtly when a tool inside it is open.
  const { pathname } = useLocation();
  // Pre-Sales rail uses light blue; Post-Sales uses orange.
  return (
    <div className="mb-3 last:mb-2">
      <div className="px-3.5 mb-1.5">
        <div
          className="text-[10px] font-bold tracking-[0.15em] uppercase"
          style={{ color: accent }}
        >
          {label}
        </div>
      </div>
      <div
        className="ml-3.5 pl-0.5 border-l"
        style={{ borderColor: accent.startsWith('var') ? 'rgba(246,141,46,0.28)' : 'rgba(111,182,255,0.25)' }}
        data-pathname={pathname}
      >
        {children}
      </div>
    </div>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
