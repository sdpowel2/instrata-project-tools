import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, ChevronRight, UserPlus, Check, Loader2 } from 'lucide-react';
import { useStore } from '../store';
import { StatusBadge } from '../components/StatusBadge';
import { DToolsSyncDot } from '../components/DToolsSyncDot';
import { PageHeader } from '../components/ui';
import { PipelineBar, tilesForPhase, buildPipelineCounts } from '../components/PipelineBar';
import type { ProjectPhase, ProjectStatus } from '../types';

export function ProjectsList() {
  const navigate = useNavigate();
  // Global registry: every authenticated user sees every project. RLS on the
  // server enforces the same thing — this page deliberately does not scope
  // to membership. The Dashboard is the user-scoped view.
  const projects = useStore((s) => s.projects);
  const myProjectIds = useStore((s) => s.myProjectIds);
  const addSelfToProject = useStore((s) => s.addSelfToProject);

  const [search, setSearch] = useState('');
  const [phaseView, setPhaseView] = useState<ProjectPhase>('Pre-Sales');
  const [statusFilter, setStatusFilter] = useState<'All' | ProjectStatus>('All');
  const [buFilter, setBuFilter] = useState<string>('All');

  // Local UX state for the "Add me" affordance — keeps the row in a loading
  // state until the optimistic write resolves so a fast double-click can't
  // fire two inserts.
  const [pendingAddIds, setPendingAddIds] = useState<Set<string>>(() => new Set());

  const tiles = tilesForPhase(phaseView);

  // Pipeline counts reflect EVERY project in the active phase — this is the
  // org-wide registry view, so tiles answer "how many projects are in each
  // status across the company."
  const { counts: pipelineCounts, total: phaseProjectTotal } = useMemo(
    () => buildPipelineCounts(projects, phaseView, tiles),
    [projects, phaseView, tiles],
  );

  const businessUnits = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects) if (p.businessUnit) set.add(p.businessUnit);
    return Array.from(set).sort();
  }, [projects]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects
      .filter((p) => {
        if (p.phase !== phaseView) return false;
        if (statusFilter !== 'All' && p.status !== statusFilter) return false;
        if (buFilter !== 'All' && p.businessUnit !== buFilter) return false;
        if (!q) return true;
        return (
          p.name.toLowerCase().includes(q)
          || p.number.toLowerCase().includes(q)
          || p.client.toLowerCase().includes(q)
          || (p.businessUnit?.toLowerCase().includes(q) ?? false)
        );
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [projects, search, phaseView, statusFilter, buFilter]);

  const filtersActive = search.trim() !== '' || statusFilter !== 'All' || buFilter !== 'All';
  const totalInPhase = projects.filter((p) => p.phase === phaseView).length;

  const handleAddMe = async (projectId: string) => {
    if (pendingAddIds.has(projectId) || myProjectIds.has(projectId)) return;
    setPendingAddIds((s) => new Set(s).add(projectId));
    try {
      await addSelfToProject(projectId);
    } finally {
      setPendingAddIds((s) => {
        const next = new Set(s);
        next.delete(projectId);
        return next;
      });
    }
  };

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <PageHeader
        eyebrow="Workspace"
        title="Projects"
        subtitle={
          <>
            {filtered.length}
            {filtersActive && <> of {totalInPhase}</>}
            {' '}project{filtered.length === 1 ? '' : 's'}
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

      {/* Pipeline tiles + phase toggle — drives status filter for the list below */}
      <PipelineBar
        tiles={tiles}
        counts={pipelineCounts}
        total={phaseProjectTotal}
        selected={statusFilter}
        onSelect={setStatusFilter}
        phaseView={phaseView}
        onPhaseChange={(p) => { setPhaseView(p); setStatusFilter('All'); }}
      />

      {/* Filter bar */}
      <div className="flex items-center gap-3 mt-5 mb-5 flex-wrap">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-2 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, number, client, or BU"
            className="input"
            style={{ paddingLeft: '2.5rem' }}
          />
        </div>

        <select
          value={buFilter}
          onChange={(e) => setBuFilter(e.target.value)}
          className="input"
          style={{ width: 'auto', minWidth: 180, paddingTop: '0.5rem', paddingBottom: '0.5rem' }}
        >
          <option value="All">All Business Units</option>
          {businessUnits.map((bu) => (
            <option key={bu} value={bu}>{bu}</option>
          ))}
        </select>

        {statusFilter !== 'All' && (
          <button
            onClick={() => setStatusFilter('All')}
            className="inline-flex items-center gap-1.5 bg-navy/[0.06] text-navy text-xs font-semibold px-2.5 py-1.5 rounded-md hover:bg-navy/10 transition-colors"
          >
            Status: {statusFilter}
            <span aria-hidden>×</span>
          </button>
        )}
      </div>

      {/* Table in card — horizontal scroll if the columns can't all fit
          (whitespace-nowrap cells + long project names push the table wider
          than the card on dense filter slices like All/Follow Up). */}
      <div className="bg-white border border-border rounded-xl shadow-sm overflow-x-auto">
        {filtered.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-fg-2">
            No projects match these filters.
          </div>
        ) : (
          <table className="w-full min-w-[960px]">
            <thead className="bg-navy text-white text-left text-[11px]">
              <tr>
                <th className="px-5 py-2.5 font-semibold uppercase tracking-[0.05em]">Project</th>
                <th className="px-5 py-2.5 font-semibold uppercase tracking-[0.05em]">Number</th>
                <th className="px-5 py-2.5 font-semibold uppercase tracking-[0.05em]">Client</th>
                <th className="px-5 py-2.5 font-semibold uppercase tracking-[0.05em]">Business Unit</th>
                <th className="px-5 py-2.5 font-semibold uppercase tracking-[0.05em]">Status</th>
                <th className="px-5 py-2.5 font-semibold uppercase tracking-[0.05em]">Updated</th>
                <th className="px-2 py-2.5" aria-label="Membership" />
                <th className="px-2 py-2.5" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((project, i) => {
                const accent = phaseAccent(project.phase);
                const isMember = myProjectIds.has(project.id);
                const isPending = pendingAddIds.has(project.id);
                return (
                  <tr
                    key={project.id}
                    onClick={() => navigate(`/projects/${project.id}`)}
                    className={`cursor-pointer transition-colors border-t border-border-soft ${
                      i % 2 === 1 ? 'bg-surface/30 hover:bg-surface/60' : 'hover:bg-surface/60'
                    }`}
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-[3px] h-9 rounded-sm flex-shrink-0" style={{ background: accent }} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <DToolsSyncDot project={project} />
                            <span className="text-sm font-semibold text-fg truncate">{project.name}</span>
                            <span
                              className="text-[10px] font-bold tracking-[0.1em] uppercase px-1.5 py-0.5 rounded whitespace-nowrap"
                              style={{ color: accent, background: `${accent}14` }}
                            >
                              {project.phase}
                            </span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-[13px] font-mono text-fg-2 whitespace-nowrap">{project.number}</td>
                    <td className="px-5 py-3 text-[13px] text-fg-2">{project.client || '—'}</td>
                    <td className="px-5 py-3 text-[13px] text-fg-2 whitespace-nowrap">{project.businessUnit || '—'}</td>
                    <td className="px-5 py-3 whitespace-nowrap"><StatusBadge status={project.status} dot /></td>
                    <td className="px-5 py-3 text-[12px] text-fg-2 whitespace-nowrap">{project.updatedAt}</td>
                    <td className="px-2 py-3 whitespace-nowrap">
                      {isMember ? (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full"
                          title="You're on this project"
                        >
                          <Check size={11} /> On
                        </span>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleAddMe(project.id); }}
                          disabled={isPending}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-navy bg-navy/[0.06] hover:bg-navy/10 disabled:opacity-60 disabled:cursor-not-allowed px-2 py-1 rounded-md transition-colors"
                          title="Add yourself to this project"
                        >
                          {isPending
                            ? <Loader2 size={11} className="animate-spin" />
                            : <UserPlus size={11} />}
                          Add me
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-3 text-right pr-4">
                      <ChevronRight size={14} className="text-fg-2 inline" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function phaseAccent(phase: ProjectPhase): string {
  return phase === 'Pre-Sales' ? '#0072CE' : '#F68D2E';
}
