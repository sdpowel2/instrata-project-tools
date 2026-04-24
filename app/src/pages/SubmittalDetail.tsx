import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Trash2, GripVertical, ArrowLeft, Download, Upload, FileText, X as XIcon, Check, Loader2, Filter, ChevronDown, ChevronRight, FolderCheck, Clock } from 'lucide-react';
import { useStore } from '../store';
import { StatusBadge } from '../components/StatusBadge';
import { Modal } from '../components/Modal';
import { CSVImportModal, type ImportedItem } from '../components/CSVImportModal';
import { exportSubmittalPDF } from '../utils/exportSubmittalPDF';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { uploadFile } from '../lib/storage';
import { listExcludedForSubmittal } from '../utils/submittalExclusions';
import type { ItemCategory, SubmittalStatus } from '../types';

const categories: ItemCategory[] = ['Display', 'Audio', 'Control', 'Networking', 'Cabling', 'Other'];

export function SubmittalDetail() {
  const { projectId, submittalId } = useParams();
  const navigate = useNavigate();
  const submittal = useStore((s) => s.submittals.find((x) => x.id === submittalId));
  const project = useStore((s) => s.projects.find((x) => x.id === projectId));
  const updateSubmittal = useStore((s) => s.updateSubmittal);
  const addItem = useStore((s) => s.addSubmittalItem);
  const updateItem = useStore((s) => s.updateSubmittalItem);
  const deleteItem = useStore((s) => s.deleteSubmittalItem);
  const populateFromBoM = useStore((s) => s.populateSubmittalFromBoM);
  const allBoM = useStore((s) => s.projectBoM);
  const bomItems = allBoM.filter((b) => b.projectId === projectId);
  const [showAddItem, setShowAddItem] = useState(false);
  const [showCSVImport, setShowCSVImport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [itemForm, setItemForm] = useState({
    manufacturer: '', model: '', description: '', category: 'Display' as ItemCategory,
    qty: 1, notes: '', sortOrder: 0,
  });
  const [excludedExpanded, setExcludedExpanded] = useState(false);
  const [uploadingItemId, setUploadingItemId] = useState<string | null>(null);

  if (!submittal) return <div className="p-8 text-text-secondary">Submittal not found.</div>;

  const handleAddItem = (e: React.FormEvent) => {
    e.preventDefault();
    addItem(submittalId!, { ...itemForm, locations: [], sortOrder: submittal.items.length });
    setShowAddItem(false);
    setItemForm({ manufacturer: '', model: '', description: '', category: 'Display', qty: 1, notes: '', sortOrder: 0 });
  };

  const handleCSVImport = (items: ImportedItem[]) => {
    items.forEach((item, i) => {
      const idx = submittal.items.length + i;

      if (item.cutSheetFile) {
        if (isSupabaseConfigured()) {
          // Upload to Supabase Storage
          const file = item.cutSheetFile;
          uploadFile('cutsheets', projectId!, file).then((url) => {
            const sub = useStore.getState().submittals.find((s) => s.id === submittalId);
            const addedItem = sub?.items.find((it) => it.sortOrder === idx);
            if (addedItem) {
              updateItem(submittalId!, addedItem.id, { cutSheetData: url, cutSheetPath: item.cutSheetName });
            }
          }).catch((err) => console.error('Cutsheet upload failed:', err));
        } else {
          // Fallback: convert to base64 for demo mode
          const reader = new FileReader();
          reader.onload = (e) => {
            const base64 = (e.target?.result as string).split(',')[1];
            const sub = useStore.getState().submittals.find((s) => s.id === submittalId);
            const addedItem = sub?.items.find((it) => it.sortOrder === idx);
            if (addedItem) {
              updateItem(submittalId!, addedItem.id, { cutSheetData: base64, cutSheetPath: item.cutSheetName });
            }
          };
          reader.readAsDataURL(item.cutSheetFile);
        }
      }

      addItem(submittalId!, {
        manufacturer: item.manufacturer,
        model: item.model,
        description: item.description,
        category: item.category,
        qty: item.qty,
        notes: item.notes,
        locations: item.locations || [],
        sortOrder: idx,
        cutSheetPath: item.cutSheetName || undefined,
      });
    });
  };

  const handleCutSheetUpload = async (itemId: string, file: File) => {
    const item = submittal.items.find((i) => i.id === itemId);
    if (!item) return;
    setUploadingItemId(itemId);
    try {
      // Read the file as base64 (no data: prefix) for the edge function body.
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const result = (e.target?.result as string) ?? '';
          const stripped = result.split(',')[1] ?? '';
          resolve(stripped);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });

      if (isSupabaseConfigured()) {
        // Route through SharePoint staging. The edge function dedupes
        // against the approved repository first — if a match exists,
        // we attach that instead of staging a duplicate.
        const { data: { user } } = await supabase.auth.getUser();
        const { data, error } = await supabase.functions.invoke<{
          matched?: { repositoryId: string; sharepointPath: string };
          staged?: { stagingId: string; sharepointPath: string };
        }>('sharepoint-cutsheet', {
          body: {
            op: 'uploadStaging',
            fileBase64: base64,
            filename: file.name,
            manufacturer: item.manufacturer,
            model: item.model,
            projectId: projectId,
            sourceContext: 'submittal_builder',
            uploadedByUserId: user?.id ?? null,
          },
        });
        if (error) throw error;

        if (data?.matched) {
          // Already in the approved repo — attach as a repository cutsheet.
          const path = data.matched.sharepointPath.split('/').pop() ?? data.matched.sharepointPath;
          updateItem(submittalId!, itemId, {
            cutsheetRepositoryId: data.matched.repositoryId,
            cutSheetName: path,
          });
        } else if (data?.staged) {
          updateItem(submittalId!, itemId, {
            cutsheetStagingId: data.staged.stagingId,
            cutSheetName: file.name,
          });
        } else {
          throw new Error('SharePoint upload returned no result');
        }
      } else {
        // Demo mode: in-memory base64 (legacy path).
        updateItem(submittalId!, itemId, { cutSheetPath: file.name, cutSheetData: base64 });
      }
    } catch (err) {
      console.error('Cutsheet upload failed:', err);
      alert(`Cutsheet upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploadingItemId(null);
    }
  };

  const sortedItems = [...submittal.items].sort((a, b) => a.sortOrder - b.sortOrder);
  // BoM rows the auto-populate filtered out (labor + house manufacturers)
  // that aren't already in the submittal. Recomputes whenever items change,
  // so adding one back removes it from this list automatically.
  const excludedRows = listExcludedForSubmittal(bomItems, submittal.items);

  const handleAddExcluded = (row: typeof excludedRows[number]) => {
    addItem(submittalId!, {
      manufacturer: row.manufacturer,
      model: row.model,
      description: row.description,
      category: 'Other',
      qty: row.qty,
      notes: '',
      locations: [],
      sortOrder: submittal.items.length,
    });
  };

  return (
    <div className="p-8 max-w-[1200px]">
      <button onClick={() => navigate(`/projects/${projectId}/submittals`)} className="flex items-center gap-1 text-sm text-text-secondary hover:text-navy mb-4 transition-colors">
        <ArrowLeft size={14} /> Back to Submittals
      </button>

      {/* Header */}
      <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-navy">{submittal.title}</h2>
            <div className="flex items-center gap-3 mt-1 text-sm text-text-secondary">
              <span className="font-mono">{submittal.revision}</span>
              <span>&middot;</span>
              <span>Prepared by {submittal.preparedBy}</span>
              <span>&middot;</span>
              <span>For {submittal.submittedTo}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={submittal.status} />
            <select
              value={submittal.status}
              onChange={(e) => updateSubmittal(submittalId!, { status: e.target.value as SubmittalStatus })}
              className="input text-sm py-1.5"
            >
              <option>Draft</option>
              <option>Submitted</option>
              <option>Approved</option>
              <option>Revise & Resubmit</option>
            </select>
          </div>
        </div>
        {submittal.notes && <p className="text-sm text-text-secondary">{submittal.notes}</p>}
        <div className="flex gap-3 mt-4 pt-4 border-t border-border">
          <button
            disabled={exporting}
            onClick={async () => {
              if (!project) return;
              setExporting(true);
              try {
                await exportSubmittalPDF(submittal, project);
              } catch (err) {
                console.error('PDF export failed:', err);
              } finally {
                setExporting(false);
              }
            }}
            className="btn-primary text-sm"
          >
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {exporting ? 'Generating...' : 'Export PDF'}
          </button>
          <button onClick={() => setShowCSVImport(true)} className="btn-secondary text-sm"><Upload size={14} /> Import CSV</button>
          <button onClick={() => setShowAddItem(true)} className="btn-secondary text-sm"><Plus size={14} /> Add Line Item</button>
        </div>
      </div>

      {/* Excluded-from-import banner */}
      {excludedRows.length > 0 && (
        <div className="bg-white rounded-xl border border-border shadow-sm mb-6 overflow-hidden">
          <button
            onClick={() => setExcludedExpanded((v) => !v)}
            className="w-full flex items-center gap-3 px-5 py-3 hover:bg-surface/50 transition-colors text-left"
          >
            <Filter size={16} className="text-orange flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-navy">
                {excludedRows.length} item{excludedRows.length === 1 ? '' : 's'} excluded from import
              </div>
              <div className="text-xs text-fg-2 mt-0.5">
                Labor entries and house manufacturers (Instrata, Premiere, Cable Solutions, Net100, Kane) are excluded by default.
              </div>
            </div>
            {excludedExpanded ? <ChevronDown size={16} className="text-fg-2" /> : <ChevronRight size={16} className="text-fg-2" />}
          </button>
          {excludedExpanded && (
            <div className="border-t border-border">
              <table className="w-full">
                <thead>
                  <tr className="bg-surface/60 text-fg-2 text-left text-[11px]">
                    <th className="px-5 py-2 font-semibold uppercase tracking-[0.05em]">Manufacturer</th>
                    <th className="px-5 py-2 font-semibold uppercase tracking-[0.05em]">Model</th>
                    <th className="px-5 py-2 font-semibold uppercase tracking-[0.05em]">Description</th>
                    <th className="px-5 py-2 font-semibold uppercase tracking-[0.05em] text-center" style={{ width: 60 }}>Qty</th>
                    <th className="px-5 py-2 font-semibold uppercase tracking-[0.05em]" style={{ width: 200 }}>Reason</th>
                    <th className="px-5 py-2" style={{ width: 130 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {excludedRows.map((row) => (
                    <tr key={row.bomItemId} className="border-t border-border-soft">
                      <td className="px-5 py-2.5 text-[13px] text-fg-2">{row.manufacturer}</td>
                      <td className="px-5 py-2.5 text-[13px] font-mono">{row.model}</td>
                      <td className="px-5 py-2.5 text-[13px]">{row.description}</td>
                      <td className="px-5 py-2.5 text-[13px] font-mono font-semibold text-center">{row.qty}</td>
                      <td className="px-5 py-2.5 text-[12px] text-fg-2 italic">{row.reason}</td>
                      <td className="px-5 py-2.5">
                        <button
                          onClick={() => handleAddExcluded(row)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border text-navy hover:bg-surface transition-colors"
                          title="Add this item to the submittal anyway"
                        >
                          <Plus size={12} /> Add to submittal
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Line items table */}
      {sortedItems.length === 0 ? (
        <div className="bg-white rounded-xl border border-border shadow-sm p-12 text-center">
          <p className="text-text-secondary mb-4">No line items yet. Add equipment to this submittal.</p>
          <div className="flex items-center justify-center gap-3">
            <button onClick={() => setShowAddItem(true)} className="btn-primary"><Plus size={16} /> Add First Item</button>
            {bomItems.length > 0 && (
              <button
                onClick={() => populateFromBoM(submittalId!, projectId!)}
                className="btn-secondary"
              >
                <Upload size={16} /> Populate from Project BoM
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-navy text-white text-left">
                <th className="w-8 px-3 py-3"></th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">Manufacturer</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">Model</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">Description</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">Category</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-center">Qty</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">Cutsheet</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">Notes</th>
                <th className="w-12 px-3 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedItems.map((item, i) => (
                <tr key={item.id} className={`hover:bg-surface/50 ${i % 2 === 1 ? 'bg-surface/30' : ''}`}>
                  <td className="px-3 py-3 text-text-secondary"><GripVertical size={14} className="cursor-grab" /></td>
                  <td className="px-4 py-3 text-sm font-medium text-text-primary">{item.manufacturer}</td>
                  <td className="px-4 py-3 text-sm font-mono text-text-secondary">{item.model}</td>
                  <td className="px-4 py-3 text-sm text-text-secondary max-w-[200px] truncate">{item.description}</td>
                  <td className="px-4 py-3"><span className="text-xs font-medium px-2 py-0.5 rounded bg-surface text-text-secondary">{item.category}</span></td>
                  <td className="px-4 py-3 text-sm text-text-primary text-center font-medium">{item.qty}</td>
                  <td className="px-4 py-3">
                    {uploadingItemId === item.id ? (
                      <span className="text-xs text-text-secondary inline-flex items-center gap-1.5">
                        <Loader2 size={12} className="animate-spin" />
                        Uploading…
                      </span>
                    ) : item.cutsheetRepositoryId ? (
                      <div className="flex items-center gap-1.5">
                        <span
                          className="text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full flex items-center gap-1 max-w-[140px]"
                          title="Attached from SharePoint cutsheet repository"
                        >
                          <FolderCheck size={10} className="shrink-0" />
                          <span className="truncate">{item.cutSheetName || 'Repository'}</span>
                        </span>
                        <button
                          onClick={() => updateItem(submittalId!, item.id, { cutsheetRepositoryId: undefined, cutSheetName: undefined })}
                          className="p-0.5 rounded hover:bg-red-50 text-text-secondary hover:text-red-500 transition-colors"
                          title="Detach repository cutsheet"
                        >
                          <XIcon size={12} />
                        </button>
                      </div>
                    ) : item.cutsheetStagingId ? (
                      <div className="flex items-center gap-1.5">
                        <span
                          className="text-xs text-orange-dark bg-orange/10 px-2 py-0.5 rounded-full flex items-center gap-1 max-w-[140px]"
                          title="Uploaded to SharePoint staging — pending admin review"
                        >
                          <Clock size={10} className="shrink-0" />
                          <span className="truncate">{item.cutSheetName || 'Pending review'}</span>
                        </span>
                        <button
                          onClick={() => updateItem(submittalId!, item.id, { cutsheetStagingId: undefined, cutSheetName: undefined })}
                          className="p-0.5 rounded hover:bg-red-50 text-text-secondary hover:text-red-500 transition-colors"
                          title="Detach staged cutsheet (file remains in /Staging/ for admin to clean up)"
                        >
                          <XIcon size={12} />
                        </button>
                      </div>
                    ) : item.cutSheetPath ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-green-700 bg-green-50 px-2 py-0.5 rounded-full flex items-center gap-1 max-w-[120px]">
                          <Check size={10} className="shrink-0" />
                          <span className="truncate">{item.cutSheetPath}</span>
                        </span>
                        <button
                          onClick={() => updateItem(submittalId!, item.id, { cutSheetPath: undefined })}
                          className="p-0.5 rounded hover:bg-red-50 text-text-secondary hover:text-red-500 transition-colors"
                        >
                          <XIcon size={12} />
                        </button>
                      </div>
                    ) : (
                      <label className="text-xs text-navy hover:text-orange cursor-pointer font-medium transition-colors flex items-center gap-1">
                        <FileText size={12} />
                        Upload PDF
                        <input
                          type="file"
                          accept=".pdf"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleCutSheetUpload(item.id, file);
                          }}
                        />
                      </label>
                    )}
                  </td>
                  <td className="px-4 py-3 max-w-[200px]">
                    <InlineNotesField
                      value={item.notes}
                      onSave={(next) => updateItem(submittalId!, item.id, { notes: next })}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <button onClick={() => deleteItem(submittalId!, item.id)} className="p-1 rounded hover:bg-red-50 text-text-secondary hover:text-red-500 transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-6 py-3 bg-surface/50 border-t border-border text-sm text-text-secondary">
            {sortedItems.length} items &middot; {sortedItems.reduce((a, b) => a + b.qty, 0)} total qty
          </div>
        </div>
      )}

      {/* Add item modal */}
      <Modal open={showAddItem} onClose={() => setShowAddItem(false)} title="Add Line Item" wide>
        <form onSubmit={handleAddItem} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm font-medium text-text-primary">Manufacturer <span className="text-red-500">*</span></span>
              <input value={itemForm.manufacturer} onChange={(e) => setItemForm({ ...itemForm, manufacturer: e.target.value })} required className="input mt-1.5" placeholder="e.g. Samsung" />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-text-primary">Model Number <span className="text-red-500">*</span></span>
              <input value={itemForm.model} onChange={(e) => setItemForm({ ...itemForm, model: e.target.value })} required className="input mt-1.5" placeholder="e.g. QM85C" />
            </label>
          </div>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Description</span>
            <input value={itemForm.description} onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })} className="input mt-1.5" placeholder="Brief description" />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm font-medium text-text-primary">Category</span>
              <select value={itemForm.category} onChange={(e) => setItemForm({ ...itemForm, category: e.target.value as ItemCategory })} className="input mt-1.5">
                {categories.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium text-text-primary">Quantity</span>
              <input type="number" min={1} value={itemForm.qty} onChange={(e) => setItemForm({ ...itemForm, qty: Number(e.target.value) })} className="input mt-1.5" />
            </label>
          </div>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Notes</span>
            <textarea value={itemForm.notes} onChange={(e) => setItemForm({ ...itemForm, notes: e.target.value })} rows={2} className="input mt-1.5" />
          </label>
          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <button type="button" onClick={() => setShowAddItem(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary">Add Item</button>
          </div>
        </form>
      </Modal>

      {/* CSV Import modal */}
      <CSVImportModal
        open={showCSVImport}
        onClose={() => setShowCSVImport(false)}
        onImport={handleCSVImport}
      />
    </div>
  );
}

// Notes are edited in place inside the line items table. The field looks
// like static text until you click into it; saves on blur or Enter, reverts
// on Escape. Updating the persisted value from props (e.g. someone else
// edits the same row) keeps the local draft in sync when not focused.
function InlineNotesField({ value, onSave }: { value: string; onSave: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);

  // Re-sync when the canonical value changes and we're not actively editing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value.trim()) onSave(trimmed);
  };

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setEditing(true)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); }
        else if (e.key === 'Escape') { setDraft(value); setEditing(false); (e.currentTarget as HTMLInputElement).blur(); }
      }}
      placeholder="—"
      className="w-full bg-transparent text-sm text-text-secondary placeholder:text-text-secondary/50 px-2 py-1 -mx-2 -my-1 rounded border border-transparent hover:border-border focus:border-navy focus:bg-white focus:text-text-primary focus:outline-none focus:ring-2 focus:ring-navy/20 transition-colors"
    />
  );
}
