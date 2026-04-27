import { useEffect, useMemo, useState } from 'react';
import { Search, Loader2, Building2, Hash, MapPin, ChevronRight, AlertCircle } from 'lucide-react';
import { Modal } from './Modal';
import { supabase } from '../lib/supabase';

export interface DToolsListedProject {
  dtoolsId: string;
  name: string;
  number: string;
  client: string;
  businessUnit: string;
  siteAddress: string;
  projectTotal: number;
  status?: string;
}

interface DToolsImportPickerProps {
  open: boolean;
  onClose: () => void;
  /** Called when the user picks a DTools project. Should resolve once the
   *  caller's flow (import / link) is finished. The picker stays open and
   *  shows a spinner on the chosen row until the promise settles. */
  onSelect: (project: DToolsListedProject) => Promise<void>;
  title?: string;
  description?: string;
  errorLabel?: string;
}

export function DToolsImportPicker({
  open,
  onClose,
  onSelect,
  title = 'Import from DTools',
  description = "Selecting a project pulls its name, number, client, business unit, site address, and total value from DTools, then syncs the full Bill of Materials with locations.",
  errorLabel = 'Import failed',
}: DToolsImportPickerProps) {
  const [projects, setProjects] = useState<DToolsListedProject[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setProjects(null);
      setError(null);
      setSearch('');
      setActionError(null);
      setBusyId(null);
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

  const handleClick = async (p: DToolsListedProject) => {
    setBusyId(p.dtoolsId);
    setActionError(null);
    try {
      await onSelect(p);
    } catch (err) {
      console.error('[DToolsImportPicker] action failed:', err);
      setActionError(err instanceof Error ? err.message : 'Action failed');
      setBusyId(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      <div className="space-y-4">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-2 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, number, or client…"
            className="input"
            style={{ paddingLeft: '2.5rem' }}
            autoFocus
          />
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span><strong className="font-semibold">Couldn't load projects:</strong> {error}</span>
          </div>
        )}

        {actionError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span><strong className="font-semibold">{errorLabel}:</strong> {actionError}</span>
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
                const isBusy = busyId === p.dtoolsId;
                const otherBusy = busyId !== null && !isBusy;
                return (
                  <button
                    key={p.dtoolsId}
                    type="button"
                    disabled={isBusy || otherBusy}
                    onClick={() => handleClick(p)}
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
                    {isBusy ? (
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

        <div className="text-xs text-fg-2">{description}</div>
      </div>
    </Modal>
  );
}
