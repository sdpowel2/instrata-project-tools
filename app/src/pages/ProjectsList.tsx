import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, Plus, Search } from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../contexts/AuthContext';
import { StatusBadge } from '../components/StatusBadge';

export function ProjectsList() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  // In Supabase mode, RLS policies ensure members only see their own projects.
  // In demo mode, all projects are shown regardless of role.
  const projects = useStore((s) => s.projects);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [buFilter, setBuFilter] = useState<string>('All');

  const filtered = projects.filter((p) => {
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.number.toLowerCase().includes(search.toLowerCase()) ||
      p.client.toLowerCase().includes(search.toLowerCase()) ||
      (p.businessUnit && p.businessUnit.toLowerCase().includes(search.toLowerCase()));
    const matchStatus = statusFilter === 'All' || p.status === statusFilter;
    const matchBU = buFilter === 'All' || p.businessUnit === buFilter;
    return matchSearch && matchStatus && matchBU;
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="p-8 max-w-[1400px]">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-navy">Projects</h1>
        <button
          onClick={() => navigate('/projects/new')}
          className="flex items-center gap-2 px-4 py-2.5 bg-navy text-white text-sm font-medium rounded-lg hover:bg-navy-light transition-colors"
        >
          <Plus size={16} />
          New Project
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects..."
            className="w-full pl-10 pr-4 py-2.5 border border-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy"
          />
        </div>
        <div className="flex gap-2">
          {['All', 'Active', 'Pending Closeout', 'Closed'].map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                statusFilter === status
                  ? 'bg-navy text-white'
                  : 'bg-white text-text-secondary border border-border hover:bg-surface'
              }`}
            >
              {status}
            </button>
          ))}
        </div>
        <select
          value={buFilter}
          onChange={(e) => setBuFilter(e.target.value)}
          className="px-3 py-2 text-sm font-medium rounded-lg border border-border bg-white text-text-secondary focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy"
        >
          <option value="All">All Business Units</option>
          <option value="Instrata SE">Instrata SE</option>
          <option value="Instrata SW">Instrata SW</option>
          <option value="Instrata NE">Instrata NE</option>
          <option value="Instrata MA">Instrata MA</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-navy text-white text-left">
              <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider">Project</th>
              <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider">Number</th>
              <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider">Client</th>
              <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider">Business Unit</th>
              <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider">Status</th>
              <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider">Last Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.map((project, i) => (
              <tr
                key={project.id}
                onClick={() => navigate(`/projects/${project.id}`)}
                className={`cursor-pointer hover:bg-surface/50 transition-colors ${i % 2 === 1 ? 'bg-surface/30' : ''}`}
              >
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-navy/5 rounded-lg flex items-center justify-center">
                      <FolderOpen size={16} className="text-navy" />
                    </div>
                    <span className="text-sm font-medium text-text-primary">{project.name}</span>
                  </div>
                </td>
                <td className="px-6 py-4 text-sm font-mono text-text-secondary">{project.number}</td>
                <td className="px-6 py-4 text-sm text-text-secondary">{project.client}</td>
                <td className="px-6 py-4 text-sm text-text-secondary">{project.businessUnit || '—'}</td>
                <td className="px-6 py-4"><StatusBadge status={project.status} /></td>
                <td className="px-6 py-4 text-sm text-text-secondary">{project.updatedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="px-6 py-12 text-center text-sm text-text-secondary">No projects found</div>
        )}
      </div>
    </div>
  );
}
