import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Trash2, GripVertical, ArrowLeft, Download, Upload, FileText, X as XIcon, Check, Loader2 } from 'lucide-react';
import { useStore } from '../store';
import { StatusBadge } from '../components/StatusBadge';
import { Modal } from '../components/Modal';
import { CSVImportModal, type ImportedItem } from '../components/CSVImportModal';
import { exportSubmittalPDF } from '../utils/exportSubmittalPDF';
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
  const [editing, setEditing] = useState(false);
  const [itemForm, setItemForm] = useState({
    manufacturer: '', model: '', description: '', category: 'Display' as ItemCategory,
    qty: 1, notes: '', sortOrder: 0,
  });

  if (!submittal) return <div className="p-8 text-text-secondary">Submittal not found.</div>;

  const handleAddItem = (e: React.FormEvent) => {
    e.preventDefault();
    addItem(submittalId!, { ...itemForm, locations: [], sortOrder: submittal.items.length });
    setShowAddItem(false);
    setItemForm({ manufacturer: '', model: '', description: '', category: 'Display', qty: 1, notes: '', sortOrder: 0 });
  };

  const handleCSVImport = (items: ImportedItem[]) => {
    items.forEach((item, i) => {
      // Convert cutsheet file to base64 if present
      if (item.cutSheetFile) {
        const reader = new FileReader();
        const idx = submittal.items.length + i;
        reader.onload = (e) => {
          const base64 = (e.target?.result as string).split(',')[1];
          // We need to find the item by sortOrder since we don't have the id yet
          const sub = useStore.getState().submittals.find((s) => s.id === submittalId);
          const addedItem = sub?.items.find((it) => it.sortOrder === idx);
          if (addedItem) {
            updateItem(submittalId!, addedItem.id, { cutSheetData: base64, cutSheetPath: item.cutSheetName });
          }
        };
        reader.readAsDataURL(item.cutSheetFile);
      }
      addItem(submittalId!, {
        manufacturer: item.manufacturer,
        model: item.model,
        description: item.description,
        category: item.category,
        qty: item.qty,
        notes: item.notes,
        locations: item.locations || [],
        sortOrder: submittal.items.length + i,
        cutSheetPath: item.cutSheetName || undefined,
      });
    });
  };

  const handleCutSheetUpload = (itemId: string, file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = (e.target?.result as string).split(',')[1];
      updateItem(submittalId!, itemId, { cutSheetPath: file.name, cutSheetData: base64 });
    };
    reader.readAsDataURL(file);
  };

  const sortedItems = [...submittal.items].sort((a, b) => a.sortOrder - b.sortOrder);
  const grouped = categories.reduce((acc, cat) => {
    const items = sortedItems.filter((i) => i.category === cat);
    if (items.length > 0) acc.push({ category: cat, items });
    return acc;
  }, [] as { category: string; items: typeof sortedItems }[]);

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
                    {item.cutSheetPath ? (
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
                  <td className="px-4 py-3 text-sm text-text-secondary max-w-[150px] truncate">{item.notes || '—'}</td>
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
