import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, ChevronRight } from 'lucide-react';
import { useStore } from '../store';
import { StatusBadge } from '../components/StatusBadge';
import { PageHeader } from '../components/ui';
import type { ProjectPhase } from '../types';

const PHASE_PILLS = ['All', 'Pre-Sales', 'Post-Sales'] as const;

export function ProjectsList() {
  const navigate = useNavigate();
  // In Supabase mode, RLS policies ensure members only see their own projects.
  // In demo mode, all projects are shown regardless of role.
  const projects = useStore((s) => s.projects);
  const [search, setSearch] = useState('');
  const [phaseFilter, setPhaseFilter] = useState<string>('All');
  const [buFilter, setBuFilter] = useState<string>('All');

  const businessUnits = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects) if (p.businessUnit) set.add(p.businessUnit);
    return Array.from(set).sort();
  }, [projects]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects
      .filter((p) => {
        const matchSearch = !q
          || p.name.toLowerCase().includes(q)
          || p.number.toLowerCase().includes(q)
          || p.client.toLowerCase().includes(q)
          || (p.businessUnit?.toLowerCase().includes(q) ?? false);
        const matchPhase = phaseFilter === 'All' || p.phase === phaseFilter;
        const matchBU = buFilter === 'All' || p.businessUnit === buFilter;
        return matchSearch && matchPhase && matchBU;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [projects, search, phaseFilter, buFilter]);

  const filtersActive = search.trim() !== '' || phaseFilter !== 'All' || buFilter !== 'All';

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <PageHeader
        eyebrow="Workspace"
        title="Projects"
        subtitle={
          <>
            {filtered.length}
            {filtersActive && <> of {projects.length}</>}
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

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
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

        <div className="flex items-center gap-1 p-1 bg-white border border-border rounded-lg">
          {PHASE_PILLS.map((phase) => {
            const active = phaseFilter === phase;
            return (
              <button
                key={phase}
                onClick={() => setPhaseFilter(phase)}
                className={[
                  'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap',
                  active
                    ? 'bg-navy text-white'
                    : 'text-fg-2 hover:text-navy hover:bg-surface',
                ].join(' ')}
              >
                {phase}
              </button>
            );
          })}
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
      </div>

      {/* Table in card */}
      <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
        {filtered.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-fg-2">
            No projects match these filters.
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-navy text-white text-left text-[11px]">
              <tr>
                <th className="px-5 py-2.5 font-semibold uppercase tracking-[0.05em]">Project</th>
                <th className="px-5 py-2.5 font-semibold uppercase tracking-[0.05em]">Number</th>
                <th className="px-5 py-2.5 font-semibold uppercase tracking-[0.05em]">Client</th>
                <th className="px-5 py-2.5 font-semibold uppercase tracking-[0.05em]">Business Unit</th>
                <th className="px-5 py-2.5 font-semibold uppercase tracking-[0.05em]">Status</th>
                <th className="px-5 py-2.5 font-semibold uppercase tracking-[0.05em]">Updated</th>
                <th className="px-2 py-2.5" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((project, i) => {
                const accent = phaseAccent(project.phase);
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
