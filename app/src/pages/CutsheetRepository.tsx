// Read-only browser for the approved cutsheet repository.
//
// Lets any signed-in user verify what's already in the catalog before
// hunting down a new file. Shows usage counts (how many projects have
// used each cutsheet) so admins can identify dead weight at cleanup time.
// Clicking a row opens an inline PDF preview using the SharePoint
// downloadUrl — no proxy through our server.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Search, FolderCheck, ExternalLink, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Eyebrow, PageHeader } from '../components/ui';

interface RepositoryRow {
  id: string;
  manufacturer: string;
  model_number: string;
  display_name: string | null;
  category: string | null;
  sharepoint_item_id: string;
  sharepoint_path: string;
  file_size_bytes: number | null;
  approved_at: string | null;
  created_at: string;
}

interface UsageCount {
  cutsheet_id: string;
  count: number;
}

export function CutsheetRepositoryPage() {
  const [items, setItems] = useState<RepositoryRow[]>([]);
  const [usageByCutsheet, setUsageByCutsheet] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [repoRes, usageRes] = await Promise.all([
        supabase.from('cutsheet_repository')
          .select('id, manufacturer, model_number, display_name, category, sharepoint_item_id, sharepoint_path, file_size_bytes, approved_at, created_at')
          .order('manufacturer', { ascending: true })
          .order('model_number', { ascending: true }),
        // Aggregate usage counts client-side (small dataset for now). When
        // the table grows, push this into a SQL view.
        supabase.from('cutsheet_project_usage').select('cutsheet_id'),
      ]);
      if (repoRes.error) throw repoRes.error;
      if (usageRes.error) console.warn('[CutsheetRepository] usage fetch failed:', usageRes.error.message);

      setItems(repoRes.data ?? []);
      const counts = new Map<string, number>();
      for (const row of usageRes.data ?? []) {
        counts.set(row.cutsheet_id, (counts.get(row.cutsheet_id) ?? 0) + 1);
      }
      setUsageByCutsheet(counts);
    } catch (err) {
      console.error('[CutsheetRepository] load failed:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((r) =>
      r.manufacturer.toLowerCase().includes(q) ||
      r.model_number.toLowerCase().includes(q) ||
      (r.display_name?.toLowerCase().includes(q) ?? false) ||
      (r.category?.toLowerCase().includes(q) ?? false),
    );
  }, [items, search]);

  // Fetch a fresh preview URL whenever the selection changes.
  useEffect(() => {
    if (!selectedId) { setPreviewUrl(null); setPreviewError(null); return; }
    const row = items.find((i) => i.id === selectedId);
    if (!row) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewUrl(null);
    supabase.functions.invoke<{ downloadUrl: string }>('sharepoint-cutsheet', {
      body: { op: 'getDownloadUrl', sharepointItemId: row.sharepoint_item_id },
    }).then(({ data, error: fnErr }) => {
      if (cancelled) return;
      if (fnErr) throw fnErr;
      if (!data?.downloadUrl) throw new Error('No download URL returned');
      setPreviewUrl(data.downloadUrl);
    }).catch((err) => {
      if (cancelled) return;
      console.error('[CutsheetRepository] preview URL fetch failed:', err);
      setPreviewError(err instanceof Error ? err.message : String(err));
    }).finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, items]);

  const selected = useMemo(() => items.find((i) => i.id === selectedId) ?? null, [items, selectedId]);

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <PageHeader
        eyebrow="SharePoint · Cutsheet Repository"
        title="Cutsheet Repository"
        subtitle={
          <>
            {items.length} approved cutsheet{items.length === 1 ? '' : 's'} in the catalog.
            {' '}Auto-attached to submittal items when manufacturer + model match.
          </>
        }
        actions={
          <button onClick={refresh} disabled={loading} className="btn-secondary disabled:opacity-60">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Refresh
          </button>
        }
      />

      {error && (
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <strong className="font-semibold">Couldn't load repository:</strong> {error}
        </div>
      )}

      <div className="grid grid-cols-[1fr_420px] gap-5 min-h-[600px]">
        {/* Left: catalog list */}
        <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-border flex items-center gap-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-2 pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by manufacturer, model, or category"
                className="input"
                style={{ paddingLeft: '2.5rem' }}
              />
            </div>
            <span className="text-xs text-fg-2 whitespace-nowrap">
              {filtered.length} of {items.length}
            </span>
          </div>

          {loading && items.length === 0 ? (
            <div className="flex-1 flex items-center justify-center gap-2 text-fg-2 text-sm py-12">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12 text-fg-2 text-sm gap-2">
              <FolderCheck size={32} className="text-fg-3" />
              {items.length === 0
                ? 'Repository is empty. Approve a cutsheet from the review queue to get started.'
                : `No cutsheets match "${search}".`}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <table className="w-full">
                <thead className="bg-navy text-white text-left text-[11px] sticky top-0">
                  <tr>
                    <th className="px-4 py-2 font-semibold uppercase tracking-[0.05em]">Manufacturer</th>
                    <th className="px-4 py-2 font-semibold uppercase tracking-[0.05em]">Model</th>
                    <th className="px-4 py-2 font-semibold uppercase tracking-[0.05em]">Category</th>
                    <th className="px-4 py-2 font-semibold uppercase tracking-[0.05em] text-right">Used</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row, i) => {
                    const active = row.id === selectedId;
                    const usage = usageByCutsheet.get(row.id) ?? 0;
                    return (
                      <tr
                        key={row.id}
                        onClick={() => setSelectedId(row.id)}
                        className={`cursor-pointer border-t border-border-soft transition-colors ${
                          active ? 'bg-navy/[0.06]' : i % 2 === 1 ? 'bg-surface/30 hover:bg-surface/60' : 'hover:bg-surface/60'
                        }`}
                      >
                        <td className="px-4 py-2.5 text-[13px] text-fg-2">{row.manufacturer}</td>
                        <td className="px-4 py-2.5 text-[13px] font-mono text-fg">{row.model_number}</td>
                        <td className="px-4 py-2.5 text-[12px] text-fg-2">{row.category ?? '—'}</td>
                        <td className="px-4 py-2.5 text-[13px] font-mono text-right">
                          <span className={usage === 0 ? 'text-fg-3' : 'text-fg'}>{usage}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right: preview pane */}
        <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden flex flex-col">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-fg-2 text-sm">
              Select a cutsheet to preview.
            </div>
          ) : (
            <>
              <div className="px-5 py-4 border-b border-border">
                <Eyebrow>Cutsheet</Eyebrow>
                <div className="text-base font-semibold text-navy mt-0.5 truncate">
                  {selected.manufacturer} {selected.model_number}
                </div>
                {selected.display_name && (
                  <div className="text-sm text-fg-2 mt-1 truncate">{selected.display_name}</div>
                )}
                <div className="text-xs text-fg-2 mt-2 flex items-center gap-3 flex-wrap">
                  {selected.category && <span>{selected.category}</span>}
                  {selected.file_size_bytes && (
                    <span>· {Math.round(selected.file_size_bytes / 1024)} KB</span>
                  )}
                  {selected.approved_at && (
                    <span>· Approved {new Date(selected.approved_at).toLocaleDateString()}</span>
                  )}
                  <span>· Used {usageByCutsheet.get(selected.id) ?? 0}×</span>
                </div>
                <div className="text-[11px] font-mono text-fg-3 mt-2 truncate" title={selected.sharepoint_path}>
                  {selected.sharepoint_path}
                </div>
                {previewUrl && (
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-navy hover:text-orange font-medium mt-3"
                  >
                    <ExternalLink size={12} /> Open in new tab
                  </a>
                )}
              </div>

              <div className="flex-1 bg-surface/40 min-h-[500px]">
                {previewLoading ? (
                  <div className="h-full flex items-center justify-center text-fg-2 text-sm gap-2">
                    <Loader2 size={16} className="animate-spin" /> Loading preview…
                  </div>
                ) : previewError ? (
                  <div className="h-full flex items-center justify-center text-red-700 text-sm px-6 text-center gap-2">
                    <AlertCircle size={16} className="flex-shrink-0" />
                    Couldn't load preview: {previewError}
                  </div>
                ) : previewUrl ? (
                  <iframe src={previewUrl} title="Cutsheet preview" className="w-full h-full min-h-[500px]" />
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
