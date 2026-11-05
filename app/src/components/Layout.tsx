import { NavLink, Outlet, useParams, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, FolderOpen, FileText, MessageSquareWarning,
  ClipboardCheck, BookOpen, Settings, LogOut, Scale,
  Home, ScanLine, Package, Calendar, Truck, Library, Bug, BookUser, NotebookPen, ListChecks, Sun,
} from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../contexts/AuthContext';
import { useDocNav } from '../store/docNavStore';
import { StatusBadge } from './StatusBadge';
import { BugReportModal } from './BugReportModal';
import { NotificationBell } from './NotificationBell';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { FEATURES } from '../config/featureFlags';
import instrataLogo from '../assets/instrata-logo-white.png';

// Cutsheet count is rendered as a badge on Dashboard for admins only — the
// admin section on Dashboard hosts the Cutsheet Review card now that the
// standalone Manager Dashboard page is gone.
const PROJECTS_NAV = { to: '/projects', icon: FolderOpen, label: 'Projects' };
const PRODUCTS_NAV = { to: '/products', icon: Package, label: 'Products' };

const presalesTools = [
  { to: 'review', icon: ScanLine, label: 'Auto-Review', enabled: FEATURES.autoReview },
  { to: 'bid-leveling', icon: Scale, label: 'Bid Leveling', enabled: FEATURES.bidLeveling },
  { to: 'rfis', icon: MessageSquareWarning, label: 'RFIs', enabled: true },
];
const postsalesTools = [
  { to: 'submittals', icon: FileText, label: 'Submittals', enabled: true },
  // RFIs persist into Post-Sales — answered RFIs from pre-sales remain visible
  { to: 'rfis', icon: MessageSquareWarning, label: 'RFIs', enabled: true },
  { to: 'closeout', icon: ClipboardCheck, label: 'Closeout', enabled: true },
  { to: 'manual', icon: BookOpen, label: 'Owner Manual', enabled: FEATURES.ownerManual },
];
// Operations is a parallel section to Pre/Post-Sales. The whole section is
// feature-flagged off for the v1 rollout; Inventory stays scaffolded-only
// even once the flag flips.
const operationsTools = [
  { to: 'schedule',   icon: Calendar, label: 'Schedule & Milestones', enabled: FEATURES.operations },
  { to: 'purchasing', icon: Truck,    label: 'Purchasing',             enabled: FEATURES.operations },
  { to: 'inventory',  icon: Package,  label: 'Inventory',              enabled: false },
];

export function Layout() {
  const { projectId } = useParams();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const { user, signOut, isAdmin, isSyncViewer } = useAuth();
  const pendingCutsheets = usePendingCutsheetCount(isAdmin);
  const { pathname } = useLocation();
  const docCrumbs = useDocNav((s) => s.crumbs);
  const docNavigate = useDocNav((s) => s.navigate);
  const onDocPage = pathname === '/documentation';
  const [showBugModal, setShowBugModal] = useState(false);

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
          <SidebarLink
            to="/"
            icon={LayoutDashboard}
            label="Dashboard"
            end
            badge={isAdmin && pendingCutsheets > 0 ? pendingCutsheets : undefined}
          />
          {isAdmin && <SidebarLink to="/my-day" icon={Sun} label="My Day" />}
          <SidebarLink to={PROJECTS_NAV.to} icon={PROJECTS_NAV.icon} label={PROJECTS_NAV.label} />
          <SidebarLink to={PRODUCTS_NAV.to} icon={PRODUCTS_NAV.icon} label={PRODUCTS_NAV.label} />
          <SidebarLink to="/directory" icon={BookUser} label="Directory" />
          {isSyncViewer && <SidebarLink to="/ops-queue" icon={ListChecks} label="Coordinator" />}
          <SidebarLink
            to="/documentation"
            icon={Library}
            label="Documentation"
            onClick={onDocPage ? () => docNavigate?.('#/') : undefined}
          />
          {onDocPage && docCrumbs.length > 0 && (
            <div className="mx-2.5 mb-1 pl-3 border-l border-white/10">
              {docCrumbs.map((crumb, i) => {
                const isLast = i === docCrumbs.length - 1;
                const clickable = !isLast && !!crumb.href;
                return (
                  <div
                    key={i}
                    onClick={clickable ? () => docNavigate?.(crumb.href!) : undefined}
                    className={[
                      'text-[11px] leading-[1.35] py-0.5',
                      isLast ? 'text-white font-medium' : 'text-white/45',
                      clickable ? 'cursor-pointer hover:text-white transition-colors' : '',
                    ].join(' ')}
                    style={{ paddingLeft: `${i * 8}px` }}
                  >
                    {i > 0 && <span className="mr-1 text-white/25">›</span>}
                    {crumb.label}
                  </div>
                );
              })}
            </div>
          )}
          <SidebarLink to="/settings" icon={Settings} label="Settings" />

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

              {/* Overview + Wiki — persistent; the wiki straddles both phases */}
              <div className="mb-3.5">
                <SidebarLink to={`/projects/${project.id}`} icon={Home} label="Overview" end />
                <SidebarLink to={`/projects/${project.id}/wiki`} icon={NotebookPen} label="Project Wiki" />
              </div>

              {/* Pre-Sales group */}
              <PhaseGroup label="Pre-Sales" accent="#6FB6FF">
                {presalesTools.map((item) => (
                  item.enabled ? (
                    <SidebarLink
                      key={`pre-${item.to}`}
                      to={`/projects/${project.id}/${item.to}`}
                      icon={item.icon}
                      label={item.label}
                      indent
                    />
                  ) : (
                    <SidebarDisabledLink
                      key={`pre-${item.to}`}
                      icon={item.icon}
                      label={item.label}
                      indent
                    />
                  )
                ))}
              </PhaseGroup>

              {/* Post-Sales group */}
              <PhaseGroup label="Post-Sales" accent="var(--color-orange)">
                {postsalesTools.map((item) => (
                  item.enabled ? (
                    <SidebarLink
                      key={`post-${item.to}`}
                      to={`/projects/${project.id}/${item.to}`}
                      icon={item.icon}
                      label={item.label}
                      indent
                    />
                  ) : (
                    <SidebarDisabledLink
                      key={`post-${item.to}`}
                      icon={item.icon}
                      label={item.label}
                      indent
                    />
                  )
                ))}
              </PhaseGroup>

              {/* Operations group — entire section is feature-flagged off
                  for the v1 rollout. */}
              <PhaseGroup label="Operations" accent="#22C55E">
                {operationsTools.map((item) => (
                  item.enabled ? (
                    <SidebarLink
                      key={`ops-${item.to}`}
                      to={`/projects/${project.id}/${item.to}`}
                      icon={item.icon}
                      label={item.label}
                      indent
                    />
                  ) : (
                    <SidebarDisabledLink
                      key={`ops-${item.to}`}
                      icon={item.icon}
                      label={item.label}
                      indent
                    />
                  )
                ))}
              </PhaseGroup>
            </>
          )}
        </nav>

        {/* Report a Bug */}
        <div className="px-2.5 py-2 border-t border-white/10">
          <button
            onClick={() => setShowBugModal(true)}
            className="flex items-center gap-3 w-full py-2 px-2.5 rounded-lg text-[13px] font-medium text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors"
          >
            <Bug size={15} />
            <span>Report a Bug</span>
          </button>
        </div>

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
            <NotificationBell />
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

      <BugReportModal open={showBugModal} onClose={() => setShowBugModal(false)} />
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
  /** Optional count badge rendered on the right side. Hidden when undefined or 0. */
  badge?: number;
  onClick?: () => void;
}

function SidebarLink({ to, icon: Icon, label, end, indent, badge, onClick }: SidebarLinkProps) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
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
      {badge !== undefined && badge > 0 && (
        <span className="bg-orange text-white text-[11px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center leading-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </NavLink>
  );
}

// Inert sidebar entry that mirrors SidebarLink styling but does not
// navigate. Used for feature-flagged-off tools, which surface in the sidebar
// but won't be functional until a future feature push.
function SidebarDisabledLink({
  icon: Icon,
  label,
  indent,
}: Omit<SidebarLinkProps, 'to' | 'badge'>) {
  return (
    <div
      title="Coming soon"
      aria-disabled="true"
      className={[
        'flex items-center gap-3 py-2.5 rounded-lg text-[14px] font-medium',
        'border-l-2 border-transparent',
        indent ? 'pl-3.5' : 'pl-2.5',
        'pr-3',
        'text-white/40 cursor-not-allowed select-none',
      ].join(' ')}
    >
      <Icon size={17} />
      <span className="flex-1">{label}</span>
    </div>
  );
}

// Polls the cutsheet_staging table for pending count so admins see the
// queue depth in the sidebar at a glance. Polls every 60s — Phase 3 doesn't
// warrant a realtime subscription.
function usePendingCutsheetCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled || !isSupabaseConfigured()) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { count: c, error } = await supabase
          .from('cutsheet_staging')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'pending');
        if (cancelled) return;
        if (!error) setCount(c ?? 0);
      } catch { /* swallow — sidebar badge is best-effort */ }
    };
    tick();
    const interval = setInterval(tick, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [enabled]);
  return count;
}

function PhaseGroup({ label, accent, children }: { label: string; accent: string; children: React.ReactNode }) {
  // Active path drives whether the group is highlighted; using location lets us
  // tint the group rail subtly when a tool inside it is open.
  const { pathname } = useLocation();
  // Rail color matches the eyebrow accent at low opacity. Pre-Sales uses
  // light blue; Post-Sales uses orange (var); Operations uses green.
  const railColor =
    accent.startsWith('var') ? 'rgba(246,141,46,0.28)'
    : accent === '#22C55E'   ? 'rgba(34,197,94,0.28)'
    :                          'rgba(111,182,255,0.25)';
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
        style={{ borderColor: railColor }}
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
