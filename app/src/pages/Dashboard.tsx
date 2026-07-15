import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, ChevronRight, FolderPlus,
  MessageSquareWarning, ScanLine, FileText, ClipboardCheck,
} from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../components/StatusBadge';
import { DToolsSyncDot } from '../components/DToolsSyncDot';
import { Eyebrow, PageHeader } from '../components/ui';
import { PipelineBar, tilesForPhase, buildPipelineCounts } from '../components/PipelineBar';
import { AdminDashboardSection } from '../components/AdminDashboardSection';
import { FEATURES } from '../config/featureFlags';
import type { Project, ProjectStatus, ProjectPhase } from '../types';

export function Dashboard() {
  const navigate = useNavigate();
  const { user, isAdmin } = useAuth();
  const projects = useStore((s) => s.projects);
  const myProjectIds = useStore((s) => s.myProjectIds);
  const submittals = useStore((s) => s.submittals);
  const rfis = useStore((s) => s.rfis);
  const closeouts = useStore((s) => s.closeouts);
  const reviewRuns = useStore((s) => s.reviewRuns);

  // Phase toggle: which board's pipeline are we looking at? Defaults to
  // Pre-Sales since that's where the active sales work lives.
  const [phaseView, setPhaseView] = useState<ProjectPhase>('Pre-Sales');
  const [statusFilter, setStatusFilter] = useState<'All' | ProjectStatus>('All');

  // Reset status filter when phase flips so a Pre-Sales-only status doesn't
  // stick around after switching to Post-Sales (and vice versa).
  const tiles = tilesForPhase(phaseView);

  // Scope: every card on this page operates on projects the user is a member
  // of. The global registry lives on /projects; Dashboard is "your day."
  const myProjects = useMemo(
    () => projects.filter((p) => myProjectIds.has(p.id)),
    [projects, myProjectIds],
  );

  // "My Projects" list reflects the active phase view + status filter.
  const filteredMine = useMemo(() => {
    let out = myProjects.filter((p) => p.phase === phaseView);
    if (statusFilter !== 'All') out = out.filter((p) => p.status === statusFilter);
    return out;
  }, [myProjects, phaseView, statusFilter]);

  // Pipeline counts reflect *your* projects only — the tiles answer "of the
  // projects I'm on, how many are in each status." Org-wide counts live on
  // the Projects page.
  const { counts: pipelineCounts, total: phaseProjectTotal } = useMemo(
    () => buildPipelineCounts(myProjects, phaseView, tiles),
    [myProjects, phaseView, tiles],
  );

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <PageHeader
        eyebrow={`Welcome, ${(user?.fullName || 'there').split(' ')[0]}`}
        title="Dashboard"
        subtitle={
          <>
            {myProjects.length} project{myProjects.length === 1 ? '' : 's'} assigned to you
            {' · '}
            Live from Monday.com
          </>
        }
        actions={
          <button onClick={() => navigate('/projects/new')} className="btn-orange">
            <Plus size={16} /> New Project
          </button>
        }
      />

      {myProjects.length === 0 ? (
        <EmptyMembershipsState onBrowse={() => navigate('/projects')} />
      ) : (
        <>
          <PipelineBar
            tiles={tiles}
            counts={pipelineCounts}
            total={phaseProjectTotal}
            selected={statusFilter}
            onSelect={setStatusFilter}
            phaseView={phaseView}
            onPhaseChange={(p) => { setPhaseView(p); setStatusFilter('All'); }}
            footer={<>Showing <strong className="text-fg">your</strong> {phaseView.toLowerCase()} projects · click a status to filter</>}
          />

          <div className="grid grid-cols-[1fr_340px] gap-6 mt-7">
            <MyProjectsCard
              projects={filteredMine}
              totalMine={myProjects.filter((p) => p.phase === phaseView).length}
              filter={statusFilter}
              onClear={() => setStatusFilter('All')}
              onOpen={(p) => navigate(`/projects/${p.id}`)}
            />

            <div className="flex flex-col gap-5">
              <MyWorkCard
                myProjectIds={myProjectIds}
                allRfis={rfis}
                allSubmittals={submittals}
                allReviewRuns={reviewRuns}
                allCloseouts={closeouts}
              />
              <ActivityCard projects={myProjects} onNavigate={(id) => navigate(`/projects/${id}`)} />
            </div>
          </div>
        </>
      )}

      {isAdmin && <AdminDashboardSection />}
    </div>
  );
}

function EmptyMembershipsState({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm px-8 py-14 text-center">
      <div className="w-14 h-14 rounded-full bg-navy/[0.06] text-navy inline-flex items-center justify-center mb-4">
        <FolderPlus size={26} />
      </div>
      <h2 className="text-lg font-semibold text-navy m-0">You're not on any projects yet</h2>
      <p className="text-sm text-fg-2 mt-1.5 max-w-md mx-auto">
        New work assigned in Monday will land here automatically once project sync is enabled.
        In the meantime, browse the workspace and add yourself to anything you're already supporting.
      </p>
      <button onClick={onBrowse} className="btn-secondary mt-5">
        Browse all projects
      </button>
    </div>
  );
}

interface MyProjectsCardProps {
  projects: Project[];
  totalMine: number;
  filter: 'All' | ProjectStatus;
  onClear: () => void;
  onOpen: (p: Project) => void;
}

function MyProjectsCard({ projects, totalMine, filter, onClear, onOpen }: MyProjectsCardProps) {
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
        <div>
          <Eyebrow>Assigned to you</Eyebrow>
          <h2 className="text-base font-semibold text-navy m-0 mt-0.5">
            My Projects
            <span className="ml-2.5 text-[13px] font-medium text-fg-2">
              {projects.length}{filter !== 'All' && ` of ${totalMine}`}
            </span>
          </h2>
        </div>
        {filter !== 'All' && (
          <button
            onClick={onClear}
            className="inline-flex items-center gap-1.5 bg-navy/[0.06] text-navy text-xs font-semibold px-2.5 py-1.5 rounded-md hover:bg-navy/10 transition-colors"
          >
            Filtered: {filter}
            <span aria-hidden>×</span>
          </button>
        )}
      </div>
      {projects.length === 0 ? (
        <div className="px-4 py-12 text-center text-fg-2 text-sm">
          No projects match this filter.
        </div>
      ) : (
        <div>
          {projects.map((p, i) => (
            <ProjectRow key={p.id} project={p} onOpen={onOpen} first={i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectRow({ project, onOpen, first }: { project: Project; onOpen: (p: Project) => void; first: boolean }) {
  const accent = phaseAccent(project.phase);
  return (
    <button
      onClick={() => onOpen(project)}
      className={`w-full grid grid-cols-[3px_1fr_auto_auto] gap-4 px-5 py-4 items-center text-left transition-colors hover:bg-surface/60 ${first ? '' : 'border-t border-border'}`}
    >
      <div className="w-[3px] h-9 rounded-sm" style={{ background: accent }} />
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <DToolsSyncDot project={project} />
          <div className="text-sm font-semibold text-fg truncate">{project.name}</div>
          <span
            className="text-[10px] font-bold tracking-[0.1em] uppercase px-1.5 py-0.5 rounded"
            style={{ color: accent, background: `${accent}14` }}
          >
            {project.phase}
          </span>
        </div>
        <div className="text-xs text-fg-2 mt-0.5">
          <span className="font-mono">{project.number}</span>
          {project.client && <> · {project.client}</>}
          {project.businessUnit && <> · {project.businessUnit}</>}
        </div>
      </div>
      <div className="text-right">
        {project.value && (
          <div className="text-[13px] font-semibold text-fg font-mono">{project.value}</div>
        )}
        <div className="text-[11px] text-fg-2 mt-0.5">{project.updatedAt}</div>
      </div>
      <div className="flex items-center gap-2.5">
        <StatusBadge status={project.status} dot />
        <ChevronRight size={14} className="text-fg-2" />
      </div>
    </button>
  );
}

function phaseAccent(phase: ProjectPhase): string {
  return phase === 'Pre-Sales' ? '#0072CE' : '#F68D2E';
}

interface MyWorkCardProps {
  myProjectIds: Set<string>;
  allRfis: ReturnType<typeof useStore.getState>['rfis'];
  allSubmittals: ReturnType<typeof useStore.getState>['submittals'];
  allReviewRuns: ReturnType<typeof useStore.getState>['reviewRuns'];
  allCloseouts: ReturnType<typeof useStore.getState>['closeouts'];
}

function MyWorkCard({ myProjectIds, allRfis, allSubmittals, allReviewRuns, allCloseouts }: MyWorkCardProps) {
  const inMine = (id: string) => myProjectIds.has(id);
  const rfis = allRfis.filter((r) => inMine(r.projectId) && r.status === 'Open').length;
  const subs = allSubmittals.filter((s) => inMine(s.projectId) && (s.status === 'Submitted' || s.status === 'Revise & Resubmit')).length;
  // Engineer-side "waiting on you" reviews: pre-review they haven't escalated
  // yet, or runs the manager sent back. submitted_for_review / in_review are
  // on the manager's plate and surface in the admin Needs Review card instead.
  const reviews = allReviewRuns.filter((r) => inMine(r.projectId) && (r.status === 'pending_review' || r.status === 'changes_requested')).length;
  const punch = allCloseouts
    .filter((c) => inMine(c.projectId))
    .flatMap((c) => c.punchItems)
    .filter((p) => p.status !== 'Complete' && p.status !== 'N/A').length;

  const items: { label: string; value: number; icon: React.ComponentType<{ size?: number }>; phase: ProjectPhase }[] = [
    { label: 'Open RFIs',          value: rfis,    icon: MessageSquareWarning, phase: 'Pre-Sales' },
    // Auto-Review is feature-flagged off for the v1 rollout.
    ...(FEATURES.autoReview
      ? [{ label: 'Auto-Review items', value: reviews, icon: ScanLine, phase: 'Pre-Sales' as ProjectPhase }]
      : []),
    { label: 'Pending Submittals', value: subs,    icon: FileText,             phase: 'Post-Sales' },
    { label: 'Open Punch Items',   value: punch,   icon: ClipboardCheck,       phase: 'Post-Sales' },
  ];

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-4.5 py-3.5 border-b border-border" style={{ paddingLeft: 18, paddingRight: 18 }}>
        <Eyebrow>My Queue</Eyebrow>
        <h2 className="text-base font-semibold text-navy m-0 mt-0.5">Waiting on you</h2>
      </div>
      {items.map((it, i) => {
        const accent = phaseAccent(it.phase);
        const Icon = it.icon;
        return (
          <div
            key={it.label}
            className={`flex items-center gap-3 px-4.5 py-3 ${i === 0 ? '' : 'border-t border-border'}`}
            style={{ paddingLeft: 18, paddingRight: 18 }}
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: `${accent}14`, color: accent }}
            >
              <Icon size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-fg">{it.label}</div>
              <div className="text-[10px] font-bold tracking-[0.1em] uppercase mt-0.5" style={{ color: accent }}>
                {it.phase}
              </div>
            </div>
            <div
              className="text-xl font-bold font-mono"
              style={{ color: it.value > 0 ? 'var(--color-navy)' : 'var(--color-fg-3)' }}
            >
              {it.value}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActivityCard({ projects, onNavigate }: { projects: Project[]; onNavigate: (id: string) => void }) {
  // Until we have a real activity log, surface the 5 most-recently-updated projects.
  const recent = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-4.5 py-3.5 border-b border-border" style={{ paddingLeft: 18, paddingRight: 18 }}>
        <Eyebrow>Recent</Eyebrow>
        <h2 className="text-base font-semibold text-navy m-0 mt-0.5">Activity</h2>
      </div>
      {recent.length === 0 ? (
        <div className="px-4 py-10 text-center text-fg-2 text-sm">No recent activity</div>
      ) : (
        <div className="py-1">
          {recent.map((p) => (
            <button
              key={p.id}
              onClick={() => onNavigate(p.id)}
              className="w-full flex gap-2.5 px-4.5 py-2.5 text-left hover:bg-surface/50 transition-colors"
              style={{ paddingLeft: 18, paddingRight: 18 }}
            >
              <div className="w-1.5 h-1.5 rounded-full bg-orange mt-[7px] flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-fg">
                  <strong className="font-semibold">{p.name}</strong> updated
                </div>
                <div className="text-[11px] text-fg-2 mt-0.5">{p.client} · {p.updatedAt}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
