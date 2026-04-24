// Admin triage page for the SharePoint cutsheet repository.
//
// Lists all pending staging items in the left rail; clicking one opens a
// detail panel on the right with an inline PDF preview (via Graph
// downloadUrl), a metadata correction form, and approve / reject actions.
//
// Approval moves the SharePoint file from /Staging/ to
// /Repository/{Manufacturer}/{Model}.pdf, writes the canonical
// cutsheet_repository row, and promotes any submittal items that linked
// to the staging record so they pick up the approved cutsheet.
//
// Reject deletes the file and marks the staging row rejected with an
// optional reason.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Check, X as XIcon, AlertCircle, FileText, FolderCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { Eyebrow, PageHeader } from '../components/ui';

interface StagingRow {
  id: string;
  manufacturer: string | null;
  model_number: string | null;
  display_name: string | null;
  category: string | null;
  sharepoint_item_id: string;
  sharepoint_path: string;
  file_size_bytes: number | null;
  original_filename: string | null;
  uploaded_by_user_id: string | null;
  source_project_id: string | null;
  source_context: string | null;
  status: string;
  created_at: string;
  downloadUrl?: string | null;
}

export function CutsheetReviewPage() {
  const { isAdmin, user } = useAuth();
  const [items, setItems] = useState<StagingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // When approve hits a repo duplicate, we capture the existing repo row so
  // the admin can convert with a single "Mark as duplicate" click instead of
  // having to navigate elsewhere to figure out the linkage.
  const [duplicateOf, setDuplicateOf] = useState<{ id: string; sharepoint_path: string } | null>(null);

  // Per-row metadata edits before approval. Keyed by staging row id so the
  // form state doesn't get clobbered when the user navigates between items.
  const [edits, setEdits] = useState<Record<string, { manufacturer: string; model: string; category: string }>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke<{ items: StagingRow[] }>(
        'sharepoint-cutsheet',
        { body: { op: 'listStaging', status: 'pending', withDownloadUrls: true } },
      );
      if (fnError) throw fnError;
      setItems(data?.items ?? []);
      // Drop selection if it's no longer in the list.
      if (selectedId && !data?.items?.some((i) => i.id === selectedId)) {
        setSelectedId(data?.items?.[0]?.id ?? null);
      } else if (!selectedId && data?.items?.length) {
        setSelectedId(data.items[0].id);
      }
    } catch (err) {
      console.error('[CutsheetReview] list failed:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { if (isAdmin) refresh(); /* eslint-disable-next-line */ }, [isAdmin]);

  // Reset duplicate-detection state whenever the admin moves to a different item.
  useEffect(() => { setDuplicateOf(null); setActionError(null); }, [selectedId]);

  const handleMarkDuplicate = async () => {
    if (!selected || !duplicateOf) return;
    const reason = window.prompt('Optional note about this duplicate (visible to the uploader):') ?? undefined;
    setActing(true);
    setActionError(null);
    try {
      const { error: fnError } = await supabase.functions.invoke('sharepoint-cutsheet', {
        body: {
          op: 'markStagingDuplicate',
          stagingId: selected.id,
          existingRepositoryId: duplicateOf.id,
          reason,
          reviewedByUserId: user?.id ?? null,
        },
      });
      if (fnError) throw fnError;
      // Drop from list, advance.
      setItems((prev) => {
        const next = prev.filter((i) => i.id !== selected.id);
        const idx = prev.findIndex((i) => i.id === selected.id);
        setSelectedId(next[idx] ? next[idx].id : (next[idx - 1]?.id ?? null));
        return next;
      });
      setDuplicateOf(null);
    } catch (err) {
      console.error('[CutsheetReview] mark duplicate failed:', err);
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  const selected = useMemo(() => items.find((i) => i.id === selectedId) ?? null, [items, selectedId]);

  // Pull initial edit values from the staging row whenever selection changes.
  useEffect(() => {
    if (!selected) return;
    setEdits((prev) => {
      if (prev[selected.id]) return prev;
      return {
        ...prev,
        [selected.id]: {
          manufacturer: selected.manufacturer ?? '',
          model: selected.model_number ?? '',
          category: selected.category ?? '',
        },
      };
    });
  }, [selected]);

  const editFor = (id: string) =>
    edits[id] ?? { manufacturer: '', model: '', category: '' };

  const setEdit = (id: string, patch: Partial<{ manufacturer: string; model: string; category: string }>) =>
    setEdits((prev) => ({ ...prev, [id]: { ...editFor(id), ...patch } }));

  const handleApprove = async () => {
    if (!selected) return;
    const e = editFor(selected.id);
    if (!e.manufacturer.trim() || !e.model.trim()) {
      setActionError('Manufacturer and model are required to approve.');
      return;
    }
    setActing(true);
    setActionError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke<{ repository?: { id: string }; error?: string; existing?: { id: string; sharepoint_path: string } }>(
        'sharepoint-cutsheet',
        { body: {
          op: 'approveStaging',
          stagingId: selected.id,
          manufacturer: e.manufacturer.trim(),
          model: e.model.trim(),
          category: e.category.trim() || null,
          reviewedByUserId: user?.id ?? null,
        } },
      );
      if (fnError) throw fnError;
      if (data?.error === 'duplicate' && data.existing) {
        setActionError(`Repository already has a cutsheet for that manufacturer + model.`);
        setDuplicateOf(data.existing);
        return;
      }
      // Drop from list, advance selection.
      setItems((prev) => {
        const next = prev.filter((i) => i.id !== selected.id);
        const idx = prev.findIndex((i) => i.id === selected.id);
        setSelectedId(next[idx] ? next[idx].id : (next[idx - 1]?.id ?? null));
        return next;
      });
    } catch (err) {
      console.error('[CutsheetReview] approve failed:', err);
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  const handleReject = async () => {
    if (!selected) return;
    const reason = window.prompt('Optional rejection reason (visible to the uploader):') ?? undefined;
    setActing(true);
    setActionError(null);
    try {
      const { error: fnError } = await supabase.functions.invoke('sharepoint-cutsheet', {
        body: {
          op: 'rejectStaging',
          stagingId: selected.id,
          reason,
          reviewedByUserId: user?.id ?? null,
        },
      });
      if (fnError) throw fnError;
      setItems((prev) => {
        const next = prev.filter((i) => i.id !== selected.id);
        const idx = prev.findIndex((i) => i.id === selected.id);
        setSelectedId(next[idx] ? next[idx].id : (next[idx - 1]?.id ?? null));
        return next;
      });
    } catch (err) {
      console.error('[CutsheetReview] reject failed:', err);
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="px-8 pt-7 pb-10">
        <div className="text-fg-2 text-sm">Admin access required.</div>
      </div>
    );
  }

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <PageHeader
        eyebrow="SharePoint · Cutsheet Repository"
        title="Cutsheet Review"
        subtitle={
          <>
            Approve or reject cutsheets uploaded from submittal builds.
            {' '}Approved files move to <strong>/Repository/{'{'}Manufacturer{'}'}/</strong> and become available across all projects.
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
          <strong className="font-semibold">Couldn't load queue:</strong> {error}
        </div>
      )}

      <div className="grid grid-cols-[360px_1fr] gap-5 min-h-[600px]">
        {/* Left rail — pending list */}
        <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <Eyebrow>Pending Queue</Eyebrow>
            <span className="text-xs text-fg-2">{items.length}</span>
          </div>
          {loading && items.length === 0 ? (
            <div className="flex-1 flex items-center justify-center gap-2 text-fg-2 text-sm py-12">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12 text-fg-2 text-sm gap-2">
              <FolderCheck size={32} className="text-green-600" />
              <div>Nothing pending review.</div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {items.map((item) => {
                const active = item.id === selectedId;
                return (
                  <button
                    key={item.id}
                    onClick={() => { setSelectedId(item.id); setActionError(null); }}
                    className={`w-full text-left px-4 py-3 border-b border-border-soft transition-colors ${
                      active ? 'bg-navy/[0.06]' : 'hover:bg-surface/60'
                    }`}
                  >
                    <div className="text-sm font-semibold text-fg truncate">
                      {item.manufacturer || <span className="italic text-fg-2">(no manufacturer)</span>}
                      {' '}
                      <span className="font-mono text-fg-2">{item.model_number || '—'}</span>
                    </div>
                    <div className="text-xs text-fg-2 mt-0.5 truncate" title={item.original_filename ?? ''}>
                      <FileText size={10} className="inline mr-1" />
                      {item.original_filename ?? item.sharepoint_path.split('/').pop()}
                    </div>
                    <div className="text-[11px] text-fg-3 mt-1">
                      {new Date(item.created_at).toLocaleString()}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right pane — preview + actions */}
        <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden flex flex-col">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-fg-2 text-sm">
              Select a pending cutsheet to review.
            </div>
          ) : (
            <>
              <div className="px-5 py-4 border-b border-border">
                <Eyebrow>Reviewing</Eyebrow>
                <div className="text-base font-semibold text-navy mt-0.5 truncate">
                  {selected.original_filename ?? selected.sharepoint_path.split('/').pop()}
                </div>
                <div className="text-xs text-fg-2 mt-1">
                  Uploaded {new Date(selected.created_at).toLocaleString()}
                  {selected.file_size_bytes ? ` · ${Math.round(selected.file_size_bytes / 1024)} KB` : ''}
                </div>
              </div>

              <div className="grid grid-cols-[1fr_320px] gap-5 p-5 flex-1 min-h-0">
                {/* PDF preview */}
                <div className="bg-surface/50 border border-border rounded-lg overflow-hidden">
                  {selected.downloadUrl ? (
                    <iframe
                      src={selected.downloadUrl}
                      title="Cutsheet preview"
                      className="w-full h-full min-h-[500px]"
                    />
                  ) : (
                    <div className="h-full flex items-center justify-center text-fg-2 text-sm">
                      Preview URL unavailable.
                    </div>
                  )}
                </div>

                {/* Metadata + actions */}
                <div className="flex flex-col gap-4">
                  <Field label="Manufacturer" required>
                    <input
                      className="input"
                      value={editFor(selected.id).manufacturer}
                      onChange={(e) => setEdit(selected.id, { manufacturer: e.target.value })}
                      placeholder="e.g. Biamp"
                    />
                  </Field>
                  <Field label="Model Number" required>
                    <input
                      className="input"
                      value={editFor(selected.id).model}
                      onChange={(e) => setEdit(selected.id, { model: e.target.value })}
                      placeholder="e.g. TesiraFORTE-AI"
                    />
                  </Field>
                  <Field label="Category">
                    <input
                      className="input"
                      value={editFor(selected.id).category}
                      onChange={(e) => setEdit(selected.id, { category: e.target.value })}
                      placeholder="e.g. DSP, Display, Camera"
                    />
                  </Field>

                  {actionError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex gap-2 items-start">
                      <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <div>{actionError}</div>
                        {duplicateOf && (
                          <div className="mt-1 text-fg-2 font-mono text-[11px] break-all">
                            Existing: {duplicateOf.sharepoint_path}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="flex flex-col gap-2 mt-auto">
                    {duplicateOf ? (
                      <button
                        onClick={handleMarkDuplicate}
                        disabled={acting}
                        className="btn-primary justify-center disabled:opacity-60"
                      >
                        {acting ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                        Mark as duplicate &amp; promote
                      </button>
                    ) : (
                      <button
                        onClick={handleApprove}
                        disabled={acting}
                        className="btn-primary justify-center disabled:opacity-60"
                      >
                        {acting ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                        Approve & Move to Repository
                      </button>
                    )}
                    <button
                      onClick={handleReject}
                      disabled={acting}
                      className="btn-secondary justify-center disabled:opacity-60"
                    >
                      <XIcon size={16} />
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-fg-2 uppercase tracking-wider">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
