import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FolderOpen, Plus, Sparkles, ChevronRight,
  MessageSquareWarning, ScanLine, FileText, ClipboardCheck,
} from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../components/StatusBadge';
import { Eyebrow, PageHeader } from '../components/ui';
import type { Project, MondayProjectStatus, ProjectPhase } from '../types';

const PIPELINE_STATUSES: { key: MondayProjectStatus; color: string; bg: string }[] = [
  { key: 'Not Started', color: '#9CA3AF', bg: '#F3F4F6' },
  { key: 'In Progress', color: '#E07A1A', bg: 'rgba(246,141,46,0.12)' },
  { key: 'In Review',   color: '#1D4ED8', bg: '#DBEAFE' },
  { key: 'Follow Up',   color: '#A16207', bg: '#FEF9C3' },
  { key: 'Won',         color: '#15803D', bg: '#DCFCE7' },
];

export function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const projects = useStore((s) => s.projects);
  const submittals = useStore((s) => s.submittals);
  const rfis = useStore((s) => s.rfis);
  const closeouts = useStore((s) => s.closeouts);
  const reviewRuns = useStore((s) => s.reviewRuns);

  const [statusFilter, setStatusFilter] = useState<'All' | MondayProjectStatus>('All');

  // Owner filter: if any project is assigned to the current user, scope to those.
  // Otherwise show everything (most useful default until ownership is populated).
  const myProjects = useMemo(() => {
    if (!user) return projects;
    const mine = projects.filter((p) => p.ownerId === user.id);
    return mine.length > 0 ? mine : projects;
  }, [projects, user]);

  const ownershipPopulated = !!user && projects.some((p) => p.ownerId === user.id);

  const filteredMine = statusFilter === 'All'
    ? myProjects
    : myProjects.filter((p) => p.status === statusFilter);

  // Pipeline counts come from ALL projects, not just mine — these tiles represent
  // org-wide pipeline state.
  const pipelineCounts = useMemo(() => {
    const counts = new Map<MondayProjectStatus, number>();
    for (const s of PIPELINE_STATUSES) counts.set(s.key, 0);
    for (const p of projects) {
      if (counts.has(p.status as MondayProjectStatus)) {
        counts.set(p.status as MondayProjectStatus, counts.get(p.status as MondayProjectStatus)! + 1);
      }
    }
    return counts;
  }, [projects]);

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <PageHeader
        eyebrow={`Welcome, ${(user?.fullName || 'there').split(' ')[0]}`}
        title="Dashboard"
        subtitle={
          <>
            {myProjects.length} {ownershipPopulated ? 'projects assigned to you' : 'projects in workspace'}
            {' · '}
            Live from Monday.com
          </>
        }
        actions={
          <>
            <button onClick={() => navigate('/projects')} className="btn-secondary">
              <FolderOpen size={16} /> All Projects
            </button>
            <button onClick={() => navigate('/projects/new')} className="btn-orange">
              <Plus size={16} /> New Project
            </button>
          </>
        }
      />

      <PipelineBar
        counts={pipelineCounts}
        total={projects.length}
        selected={statusFilter}
        onSelect={setStatusFilter}
      />

      <div className="grid grid-cols-[1fr_340px] gap-6 mt-7">
        <MyProjectsCard
          projects={filteredMine}
          totalMine={myProjects.length}
          filter={statusFilter}
          ownershipPopulated={ownershipPopulated}
          onClear={() => setStatusFilter('All')}
          onOpen={(p) => navigate(`/projects/${p.id}`)}
        />

        <div className="flex flex-col gap-5">
          <MyWorkCard
            myProjectIds={new Set(myProjects.map((p) => p.id))}
            allRfis={rfis}
            allSubmittals={submittals}
            allReviewRuns={reviewRuns}
            allCloseouts={closeouts}
          />
          <ActivityCard projects={myProjects} onNavigate={(id) => navigate(`/projects/${id}`)} />
        </div>
      </div>
    </div>
  );
}

interface PipelineBarProps {
  counts: Map<MondayProjectStatus, number>;
  total: number;
  selected: 'All' | MondayProjectStatus;
  onSelect: (s: 'All' | MondayProjectStatus) => void;
}

function PipelineBar({ counts, total, selected, onSelect }: PipelineBarProps) {
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm p-1">
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `minmax(140px,180px) repeat(${PIPELINE_STATUSES.length}, 1fr)` }}
      >
        <PipelineTile
          active={selected === 'All'}
          onClick={() => onSelect('All')}
          accent="var(--color-navy)"
          accentBg="rgba(34,50,110,0.06)"
          label="All"
          value={total}
          tagline="total projects"
          dotColor="var(--color-navy)"
        />
        {PIPELINE_STATUSES.map((s) => {
          const count = counts.get(s.key) ?? 0;
          const pct = total ? Math.round((count / total) * 100) : 0;
          const active = selected === s.key;
          return (
            <PipelineTile
              key={s.key}
              active={active}
              onClick={() => onSelect(s.key)}
              accent={s.color}
              accentBg={s.bg}
              label={s.key}
              value={count}
              tagline={`${pct}% of pipeline`}
              dotColor={s.color}
              showBar
              barPct={pct}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-2 px-3.5 pt-2 pb-1.5 mt-1 border-t border-border text-fg-2 text-[11px]">
        <Sparkles size={12} className="text-orange" />
        <span>
          Live from <strong className="text-fg">Monday.com</strong> · click a status to filter your projects below
        </span>
      </div>
    </div>
  );
}

interface PipelineTileProps {
  active: boolean;
  onClick: () => void;
  accent: string;
  accentBg: string;
  label: string;
  value: number;
  tagline: string;
  dotColor: string;
  showBar?: boolean;
  barPct?: number;
}

function PipelineTile({ active, onClick, accent, accentBg, label, value, tagline, dotColor, showBar, barPct = 0 }: PipelineTileProps) {
  return (
    <button
      onClick={onClick}
      className="text-left rounded-[9px] px-3.5 pt-3.5 pb-3 transition-all"
      style={{
        background: active ? accentBg : 'transparent',
        border: active ? `1px solid ${accent}` : '1px solid transparent',
        boxShadow: active ? `inset 0 -2px 0 ${accent}` : undefined,
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-2 h-2 rounded-full" style={{ background: dotColor }} />
        <div
          className="text-[11px] font-bold tracking-[0.08em] uppercase whitespace-nowrap"
          style={{ color: accent }}
        >
          {label}
        </div>
      </div>
      <div
        className="text-[26px] font-bold leading-none font-mono"
        style={{ color: active && label !== 'All' ? 'var(--color-fg)' : (label === 'All' ? 'var(--color-navy)' : 'var(--color-fg)') }}
      >
        {value}
      </div>
      {showBar ? (
        <>
          <div className="mt-2.5 h-[3px] rounded-sm overflow-hidden bg-black/[0.06]">
            <div className="h-full transition-[width]" style={{ width: `${barPct}%`, background: accent }} />
          </div>
          <div className="text-[11px] text-fg-2 mt-1.5">{tagline}</div>
        </>
      ) : (
        <div className="text-[11px] text-fg-2 mt-1">{tagline}</div>
      )}
    </button>
  );
}

interface MyProjectsCardProps {
  projects: Project[];
  totalMine: number;
  filter: 'All' | MondayProjectStatus;
  ownershipPopulated: boolean;
  onClear: () => void;
  onOpen: (p: Project) => void;
}

function MyProjectsCard({ projects, totalMine, filter, ownershipPopulated, onClear, onOpen }: MyProjectsCardProps) {
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
        <div>
          <Eyebrow>{ownershipPopulated ? 'Assigned to you' : 'Workspace'}</Eyebrow>
          <h2 className="text-base font-semibold text-navy m-0 mt-0.5">
            {ownershipPopulated ? 'My Projects' : 'All Projects'}
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
  const reviews = allReviewRuns.filter((r) => inMine(r.projectId) && (r.status === 'pending_review' || r.status === 'in_review' || r.status === 'changes_requested')).length;
  const punch = allCloseouts
    .filter((c) => inMine(c.projectId))
    .flatMap((c) => c.punchItems)
    .filter((p) => p.status !== 'Complete' && p.status !== 'N/A').length;

  const items: { label: string; value: number; icon: React.ComponentType<{ size?: number }>; phase: ProjectPhase }[] = [
    { label: 'Open RFIs',          value: rfis,    icon: MessageSquareWarning, phase: 'Pre-Sales' },
    { label: 'Auto-Review items',  value: reviews, icon: ScanLine,             phase: 'Pre-Sales' },
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
