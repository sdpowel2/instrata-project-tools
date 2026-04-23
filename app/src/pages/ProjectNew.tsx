import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Search, Loader2, Building2, Hash, MapPin, ChevronRight, AlertCircle } from 'lucide-react';
import { useStore } from '../store';
import { Modal } from '../components/Modal';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { ProjectStatus, ProjectBusinessUnit, ProjectPhase } from '../types';

interface DToolsListedProject {
  dtoolsId: string;
  name: string;
  number: string;
  client: string;
  businessUnit: string;
  siteAddress: string;
  projectTotal: number;
  status?: string;
}

export function ProjectNew() {
  const navigate = useNavigate();
  const addProject = useStore((s) => s.addProject);
  const fetchAllData = useStore((s) => s.fetchAllData);
  const [form, setForm] = useState({
    name: '',
    number: '',
    client: '',
    address: '',
    businessUnit: '' as ProjectBusinessUnit | '',
    status: 'Not Started' as ProjectStatus,
    phase: 'Pre-Sales' as ProjectPhase,
    value: '',
    dtoolsBomStatus: '' as const,
  });
  const [showDToolsPicker, setShowDToolsPicker] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = addProject(form);
    navigate(`/projects/${id}`);
  };

  const handleImported = (newProjectId: string) => {
    setShowDToolsPicker(false);
    // Re-pull the store so the freshly-inserted project is in memory before
    // the overview tries to render. Cheap relative to the round trip the
    // import already did.
    void fetchAllData().finally(() => navigate(`/projects/${newProjectId}`));
  };

  return (
    <div className="p-8 max-w-2xl">
      <div className="flex items-start justify-between mb-6 gap-4">
        <h1 className="text-2xl font-bold text-navy">New Project</h1>
        {isSupabaseConfigured() && (
          <button
            type="button"
            onClick={() => setShowDToolsPicker(true)}
            className="btn-orange whitespace-nowrap"
          >
            <Download size={16} /> Import from DTools
          </button>
        )}
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-border shadow-sm p-6 space-y-5">
        <Field label="Project Name" required>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className="input" placeholder="e.g. One Vanderbilt - Level 60 AV Buildout" />
        </Field>
        <Field label="Project Number" required>
          <input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} required className="input" placeholder="e.g. INS-2026-005" />
        </Field>
        <Field label="Client" required>
          <input value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} required className="input" placeholder="Client name" />
        </Field>
        <Field label="Business Unit" required>
          <select value={form.businessUnit} onChange={(e) => setForm({ ...form, businessUnit: e.target.value as ProjectBusinessUnit })} required className="input">
            <option value="" disabled>Select a business unit</option>
            <option value="Instrata SE">Instrata SE</option>
            <option value="Instrata SW">Instrata SW</option>
            <option value="Instrata NE">Instrata NE</option>
            <option value="Instrata MA">Instrata MA</option>
          </select>
        </Field>
        <Field label="Address">
          <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="input" placeholder="Project address" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Phase" required>
            <select value={form.phase} onChange={(e) => setForm({ ...form, phase: e.target.value as ProjectPhase })} className="input">
              <option value="Pre-Sales">Pre-Sales</option>
              <option value="Post-Sales">Post-Sales</option>
            </select>
          </Field>
          <Field label="Contracted Value">
            <input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} className="input" placeholder="e.g. $482K" />
          </Field>
        </div>
        <div className="flex justify-end gap-3 pt-4 border-t border-border">
          <button type="button" onClick={() => navigate('/projects')} className="btn-secondary">Cancel</button>
          <button type="submit" className="btn-primary">Create Project</button>
        </div>
      </form>

      <DToolsImportPicker
        open={showDToolsPicker}
        onClose={() => setShowDToolsPicker(false)}
        onImported={handleImported}
      />
    </div>
  );
}

// ─── DTools picker modal ─────────────────────────────────────────────────────

interface DToolsImportPickerProps {
  open: boolean;
  onClose: () => void;
  onImported: (newProjectId: string) => void;
}

function DToolsImportPicker({ open, onClose, onImported }: DToolsImportPickerProps) {
  const [projects, setProjects] = useState<DToolsListedProject[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [importingId, setImportingId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Fetch the project list when the modal opens. Cache for the lifetime of
  // the modal — closing and reopening will refresh.
  useEffect(() => {
    if (!open) {
      setProjects(null);
      setError(null);
      setSearch('');
      setImportError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    supabase.functions.invoke<{ projects: DToolsListedProject[] }>('dtools-list-projects', { body: {} })
      .then(({ data, error: fnError }) => {
        if (cancelled) return;
        if (fnError) throw fnError;
        if (!data) throw new Error('Empty response');
        setProjects(data.projects ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[DToolsImportPicker] list failed:', err);
        setError(err instanceof Error ? err.message : 'Failed to load DTools projects');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const filtered = useMemo(() => {
    if (!projects) return [];
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.number.toLowerCase().includes(q) ||
      p.client.toLowerCase().includes(q),
    );
  }, [projects, search]);

  const handleImport = async (p: DToolsListedProject) => {
    setImportingId(p.dtoolsId);
    setImportError(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error: fnError } = await supabase.functions.invoke<{ projectId: string; alreadyExisted?: boolean }>(
        'dtools-import-project',
        { body: { dtoolsProjectId: p.dtoolsId, createdBy: user?.id ?? null } },
      );
      if (fnError) throw fnError;
      if (!data?.projectId) throw new Error('Import response missing projectId');
      onImported(data.projectId);
    } catch (err) {
      console.error('[DToolsImportPicker] import failed:', err);
      setImportError(err instanceof Error ? err.message : 'Import failed');
      setImportingId(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Import from DTools" wide>
      <div className="space-y-4">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-2 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, number, or client…"
            className="input pl-10"
            autoFocus
          />
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span><strong className="font-semibold">Couldn't load projects:</strong> {error}</span>
          </div>
        )}

        {importError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span><strong className="font-semibold">Import failed:</strong> {importError}</span>
          </div>
        )}

        <div className="border border-border rounded-lg overflow-hidden bg-white" style={{ minHeight: 320, maxHeight: 480 }}>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-fg-2 text-sm">
              <Loader2 size={16} className="animate-spin" />
              Loading projects from DTools…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-sm text-fg-2">
              {projects && projects.length > 0
                ? `No projects match "${search}".`
                : 'No DTools projects available.'}
            </div>
          ) : (
            <div className="divide-y divide-border overflow-y-auto" style={{ maxHeight: 480 }}>
              {filtered.map((p) => {
                const isImporting = importingId === p.dtoolsId;
                const otherImporting = importingId !== null && !isImporting;
                return (
                  <button
                    key={p.dtoolsId}
                    type="button"
                    disabled={isImporting || otherImporting}
                    onClick={() => handleImport(p)}
                    className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-surface/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-fg truncate">{p.name || '(unnamed project)'}</div>
                      <div className="text-xs text-fg-2 mt-0.5 flex items-center gap-3 flex-wrap">
                        {p.number && (
                          <span className="inline-flex items-center gap-1 font-mono">
                            <Hash size={11} />{p.number}
                          </span>
                        )}
                        {p.client && <span>{p.client}</span>}
                        {p.businessUnit && (
                          <span className="inline-flex items-center gap-1">
                            <Building2 size={11} />{p.businessUnit}
                          </span>
                        )}
                        {p.siteAddress && (
                          <span className="inline-flex items-center gap-1 truncate max-w-[260px]">
                            <MapPin size={11} />{p.siteAddress}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      {p.projectTotal > 0 && (
                        <div className="text-sm font-semibold text-navy font-mono">
                          ${Math.round(p.projectTotal).toLocaleString('en-US')}
                        </div>
                      )}
                    </div>
                    {isImporting ? (
                      <Loader2 size={16} className="text-fg-2 animate-spin flex-shrink-0" />
                    ) : (
                      <ChevronRight size={16} className="text-fg-2 flex-shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="text-xs text-fg-2">
          Selecting a project pulls its name, number, client, business unit, site address, and total value from DTools, then syncs the full Bill of Materials with locations.
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-text-primary">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
