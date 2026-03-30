import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FileText, MessageSquareWarning, ClipboardCheck, BookOpen, Upload, Plus, Package } from 'lucide-react';
import { useStore } from '../store';
import { Modal } from '../components/Modal';
import { CSVImportModal, type ImportedItem } from '../components/CSVImportModal';
import { BoMLocationView } from '../components/BoMLocationView';
import { isSupabaseConfigured } from '../lib/supabase';
import { uploadFile } from '../lib/storage';
import type { ItemCategory, SubmittalItemLocation } from '../types';

const categories: ItemCategory[] = ['Display', 'Audio', 'Control', 'Networking', 'Cabling', 'Other'];

export function ProjectOverview() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const allSubmittals = useStore((s) => s.submittals);
  const allRfis = useStore((s) => s.rfis);
  const allCloseouts = useStore((s) => s.closeouts);
  const allManuals = useStore((s) => s.manuals);
  const projectBoM = useStore((s) => s.projectBoM);
  const addBoMItem = useStore((s) => s.addBoMItem);
  const deleteBoMItem = useStore((s) => s.deleteBoMItem);
  const importBoMItems = useStore((s) => s.importBoMItems);

  const submittals = useMemo(() => allSubmittals.filter((x) => x.projectId === projectId), [allSubmittals, projectId]);
  const rfis = useMemo(() => allRfis.filter((x) => x.projectId === projectId), [allRfis, projectId]);
  const closeout = useMemo(() => allCloseouts.find((x) => x.projectId === projectId), [allCloseouts, projectId]);
  const manuals = useMemo(() => allManuals.filter((x) => x.projectId === projectId), [allManuals, projectId]);
  const bomItems = useMemo(() => projectBoM.filter((x) => x.projectId === projectId), [projectBoM, projectId]);

  const [showCSVImport, setShowCSVImport] = useState(false);
  const [showAddItem, setShowAddItem] = useState(false);
  const [itemForm, setItemForm] = useState({
    manufacturer: '',
    model: '',
    description: '',
    category: 'Display' as ItemCategory,
    qty: 1,
    room: '',
    notes: '',
  });

  const cards = [
    {
      title: 'Submittals',
      icon: FileText,
      count: submittals.length,
      detail: `${submittals.filter((s) => s.status === 'Approved').length} approved`,
      to: 'submittals',
      color: 'bg-blue/10 text-blue',
    },
    {
      title: 'RFIs',
      icon: MessageSquareWarning,
      count: rfis.length,
      detail: `${rfis.filter((r) => r.status === 'Open').length} open`,
      to: 'rfis',
      color: 'bg-orange/10 text-orange',
    },
    {
      title: 'Closeout',
      icon: ClipboardCheck,
      count: closeout ? closeout.punchItems.length + closeout.warranties.length : 0,
      detail: closeout ? `${closeout.punchItems.filter((p) => p.status !== 'Complete').length} open items` : 'Not started',
      to: 'closeout',
      color: 'bg-green-50 text-green-600',
    },
    {
      title: 'Owner Manuals',
      icon: BookOpen,
      count: manuals.length,
      detail: manuals.length > 0 ? `${manuals[0].sections.length} sections` : 'Not started',
      to: 'manual',
      color: 'bg-navy/5 text-navy',
    },
  ];

  const handleAddItem = (e: React.FormEvent) => {
    e.preventDefault();
    const locations: SubmittalItemLocation[] = itemForm.room.trim()
      ? [{ room: itemForm.room.trim(), qty: itemForm.qty }]
      : [];
    addBoMItem(projectId!, {
      manufacturer: itemForm.manufacturer,
      model: itemForm.model,
      description: itemForm.description,
      category: itemForm.category,
      qty: itemForm.qty,
      notes: itemForm.notes,
      locations,
      sortOrder: bomItems.length,
    });
    setShowAddItem(false);
    setItemForm({ manufacturer: '', model: '', description: '', category: 'Display', qty: 1, room: '', notes: '' });
  };

  const handleCSVImport = (imported: ImportedItem[]) => {
    // Separate items with and without cutsheet files
    const withoutFiles: typeof imported = [];
    const withFiles: typeof imported = [];
    for (const item of imported) {
      if (item.cutSheetFile) {
        withFiles.push(item);
      } else {
        withoutFiles.push(item);
      }
    }

    // Import items without cutsheets immediately
    if (withoutFiles.length > 0) {
      importBoMItems(
        projectId!,
        withoutFiles.map((item) => ({
          manufacturer: item.manufacturer,
          model: item.model,
          description: item.description,
          category: item.category,
          qty: item.qty,
          notes: item.notes,
          locations: item.locations || [],
          cutSheetName: item.cutSheetName,
        })),
      );
    }

    // For items with cutsheet files, upload to storage or convert to base64
    if (withFiles.length > 0) {
      const promises = withFiles.map(
        (item) =>
          new Promise<{
            manufacturer: string;
            model: string;
            description: string;
            category: ItemCategory;
            qty: number;
            notes: string;
            locations: SubmittalItemLocation[];
            cutSheetData?: string;
            cutSheetName?: string;
          }>((resolve) => {
            if (isSupabaseConfigured()) {
              // Upload to Supabase Storage
              uploadFile('cutsheets', projectId!, item.cutSheetFile!).then((url) => {
                resolve({
                  manufacturer: item.manufacturer,
                  model: item.model,
                  description: item.description,
                  category: item.category,
                  qty: item.qty,
                  notes: item.notes,
                  locations: item.locations || [],
                  cutSheetData: url,
                  cutSheetName: item.cutSheetName,
                });
              }).catch((err) => {
                console.error('Cutsheet upload failed:', err);
                // Import without cutsheet on failure
                resolve({
                  manufacturer: item.manufacturer,
                  model: item.model,
                  description: item.description,
                  category: item.category,
                  qty: item.qty,
                  notes: item.notes,
                  locations: item.locations || [],
                  cutSheetName: item.cutSheetName,
                });
              });
            } else {
              // Fallback: base64 for demo mode
              const reader = new FileReader();
              reader.onload = (e) => {
                const base64 = (e.target?.result as string).split(',')[1];
                resolve({
                  manufacturer: item.manufacturer,
                  model: item.model,
                  description: item.description,
                  category: item.category,
                  qty: item.qty,
                  notes: item.notes,
                  locations: item.locations || [],
                  cutSheetData: base64,
                  cutSheetName: item.cutSheetName,
                });
              };
              reader.readAsDataURL(item.cutSheetFile!);
            }
          }),
      );
      Promise.all(promises).then((resolved) => {
        importBoMItems(projectId!, resolved);
      });
    }
  };

  return (
    <div className="p-8">
      <h2 className="text-lg font-semibold text-navy mb-5">Project Modules</h2>
      <div className="grid grid-cols-2 gap-5">
        {cards.map((card) => (
          <button
            key={card.title}
            onClick={() => navigate(card.to)}
            className="bg-white rounded-xl border border-border shadow-sm p-6 text-left hover:shadow-md transition-shadow"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-10 h-10 ${card.color} rounded-lg flex items-center justify-center`}>
                <card.icon size={20} />
              </div>
              <div>
                <div className="text-sm font-semibold text-text-primary">{card.title}</div>
                <div className="text-xs text-text-secondary">{card.detail}</div>
              </div>
            </div>
            <div className="text-3xl font-bold text-text-primary">{card.count}</div>
          </button>
        ))}
      </div>

      {/* Project Bill of Materials */}
      <div className="mt-8 bg-white rounded-xl border border-border shadow-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-orange/10 rounded-lg flex items-center justify-center">
              <Package size={20} className="text-orange" />
            </div>
            <h3 className="text-lg font-semibold text-navy">Bill of Materials</h3>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowCSVImport(true)} className="btn-secondary text-sm">
              <Upload size={14} /> Import CSV
            </button>
            <button onClick={() => setShowAddItem(true)} className="btn-primary text-sm">
              <Plus size={14} /> Add Item
            </button>
          </div>
        </div>
        <div className="p-6">
          <BoMLocationView items={bomItems} onRemove={(itemId) => deleteBoMItem(itemId)} />
        </div>
      </div>

      {/* CSV Import Modal */}
      <CSVImportModal open={showCSVImport} onClose={() => setShowCSVImport(false)} onImport={handleCSVImport} />

      {/* Add Item Modal */}
      <Modal open={showAddItem} onClose={() => setShowAddItem(false)} title="Add BoM Item">
        <form onSubmit={handleAddItem} className="space-y-4">
          <div>
            <label className="text-sm font-medium text-text-primary">
              Manufacturer <span className="text-red-500">*</span>
            </label>
            <input
              className="input mt-1.5"
              required
              value={itemForm.manufacturer}
              onChange={(e) => setItemForm((f) => ({ ...f, manufacturer: e.target.value }))}
              placeholder="e.g. Crestron"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">
              Model <span className="text-red-500">*</span>
            </label>
            <input
              className="input mt-1.5"
              required
              value={itemForm.model}
              onChange={(e) => setItemForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="e.g. DM-NVX-363"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">Description</label>
            <input
              className="input mt-1.5"
              value={itemForm.description}
              onChange={(e) => setItemForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Optional description"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-text-primary">Category</label>
              <select
                className="input mt-1.5"
                value={itemForm.category}
                onChange={(e) => setItemForm((f) => ({ ...f, category: e.target.value as ItemCategory }))}
              >
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">
                Quantity <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                className="input mt-1.5"
                required
                min={1}
                value={itemForm.qty}
                onChange={(e) => setItemForm((f) => ({ ...f, qty: Math.max(1, parseInt(e.target.value) || 1) }))}
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">Room / Location</label>
            <input
              className="input mt-1.5"
              value={itemForm.room}
              onChange={(e) => setItemForm((f) => ({ ...f, room: e.target.value }))}
              placeholder="e.g. Conference Room A"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">Notes</label>
            <textarea
              className="input mt-1.5"
              rows={2}
              value={itemForm.notes}
              onChange={(e) => setItemForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Optional notes"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <button type="button" onClick={() => setShowAddItem(false)} className="btn-secondary text-sm">
              Cancel
            </button>
            <button type="submit" className="btn-primary text-sm">
              <Plus size={14} /> Add Item
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
