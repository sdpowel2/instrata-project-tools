import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, Shield, AlertTriangle, Trash2, Download, CheckCircle2, ClipboardCheck, ChevronDown, ChevronRight, X, Eye, FileText, Upload, BookOpen, Rocket, MapPin, GripVertical } from 'lucide-react';
import { useStore } from '../store';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { LocationProductPicker } from '../components/LocationProductPicker';
import { ProjectHeader } from '../components/ProjectHeader';
import { PhaseRibbon } from '../components/PhaseRibbon';
import type { PunchStatus, PunchPriority, SignOffStatus, Warranty, ManualBookmark, QuickStartRoom } from '../types';
import { exportSignOffPDF } from '../utils/exportSignOffPDF';
import { exportCloseoutPDF } from '../utils/exportCloseoutPDF';
import { exportPunchListPDF } from '../utils/exportPunchListPDF';
import { exportWarrantyPDF } from '../utils/exportWarrantyPDF';
import { exportManualsPDF } from '../utils/exportManualsPDF';
import { extractBookmarks } from '../utils/extractBookmarks';
import { isSupabaseConfigured } from '../lib/supabase';
import { uploadFile, fetchFileBytes } from '../lib/storage';

/* ─── Warranty Edit Modal (sub-component) ─── */
function WarrantyEditModal({
  warranty,
  open,
  onClose,
}: {
  warranty: Warranty | null;
  open: boolean;
  onClose: (updated: Partial<Warranty> | null) => void;
}) {
  const [form, setForm] = useState<Partial<Warranty>>({});

  useEffect(() => {
    if (warranty) {
      setForm({ ...warranty });
    }
  }, [warranty]);

  if (!warranty) return null;

  const set = (key: keyof Warranty, value: string | number) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <Modal
      open={open}
      onClose={() => onClose(form)}
      title="Edit Warranty"
      wide
    >
      <div className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">System</span>
          <input
            value={form.system ?? ''}
            onChange={(e) => set('system', e.target.value)}
            className="input mt-1.5"
          />
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium text-fg-2">Manufacturer (from BoM)</span>
            <input value={form.manufacturer ?? ''} readOnly className="input mt-1.5 bg-surface cursor-not-allowed" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-fg-2">Model (from BoM)</span>
            <input value={form.model ?? ''} readOnly className="input mt-1.5 bg-surface cursor-not-allowed" />
          </label>
        </div>
        <label className="block">
          <span className="text-sm font-medium">Vendor / Distributor</span>
          <input
            value={form.vendor ?? ''}
            onChange={(e) => set('vendor', e.target.value)}
            className="input mt-1.5"
          />
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium">Start Date</span>
            <input
              type="date"
              value={form.startDate ?? ''}
              onChange={(e) => set('startDate', e.target.value)}
              className="input mt-1.5"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Duration (months)</span>
            <input
              type="number"
              min={1}
              value={form.durationMonths ?? 12}
              onChange={(e) => set('durationMonths', Number(e.target.value))}
              className="input mt-1.5"
            />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <label className="block">
            <span className="text-sm font-medium">Contact Name</span>
            <input
              value={form.contactName ?? ''}
              onChange={(e) => set('contactName', e.target.value)}
              className="input mt-1.5"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Contact Email</span>
            <input
              type="email"
              value={form.contactEmail ?? ''}
              onChange={(e) => set('contactEmail', e.target.value)}
              className="input mt-1.5"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Contact Phone</span>
            <input
              value={form.contactPhone ?? ''}
              onChange={(e) => set('contactPhone', e.target.value)}
              className="input mt-1.5"
            />
          </label>
        </div>
        <label className="block">
          <span className="text-sm font-medium">Coverage Notes</span>
          <textarea
            value={form.coverageNotes ?? ''}
            onChange={(e) => set('coverageNotes', e.target.value)}
            rows={3}
            className="input mt-1.5"
          />
        </label>
        <div className="flex justify-end gap-3 pt-4 border-t border-border">
          <button
            type="button"
            onClick={() => onClose(form)}
            className="btn-primary"
          >
            Save &amp; Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Main Component ─── */
export function CloseoutDashboard() {
  const { projectId } = useParams();
  const getOrCreate = useStore((s) => s.getOrCreateCloseout);
  const closeout = useStore((s) => s.closeouts.find((c) => c.projectId === projectId));
  const addWarranty = useStore((s) => s.addWarranty);
  const updateWarranty = useStore((s) => s.updateWarranty);
  const deleteWarranty = useStore((s) => s.deleteWarranty);
  const populateWarranties = useStore((s) => s.populateWarrantiesFromBoM);
  const addPunchItem = useStore((s) => s.addPunchItem);
  const updatePunchItem = useStore((s) => s.updatePunchItem);
  const deletePunchItem = useStore((s) => s.deletePunchItem);
  const addSignOffSheet = useStore((s) => s.addSignOffSheet);
  const addSignOffCustomItem = useStore((s) => s.addSignOffCustomItem);
  const deleteSignOffCustomItem = useStore((s) => s.deleteSignOffCustomItem);
  const addAsBuiltDrawing = useStore((s) => s.addAsBuiltDrawing);
  const deleteAsBuiltDrawing = useStore((s) => s.deleteAsBuiltDrawing);
  const addQuickStartRoom = useStore((s) => s.addQuickStartRoom);
  const deleteQuickStartRoom = useStore((s) => s.deleteQuickStartRoom);
  const addQuickStartStep = useStore((s) => s.addQuickStartStep);
  const updateQuickStartStep = useStore((s) => s.updateQuickStartStep);
  const deleteQuickStartStep = useStore((s) => s.deleteQuickStartStep);
  const allBoM = useStore((s) => s.projectBoM);
  const projects = useStore((s) => s.projects);
  const projectBoM = useMemo(() => allBoM.filter((b) => b.projectId === projectId), [allBoM, projectId]);
  const project = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);

  // ── All useState hooks ABOVE the early return ──
  const [activeTab, setActiveTab] = useState<'warranties' | 'punch' | 'signoff' | 'drawings' | 'manuals' | 'quickstart'>('warranties');
  const [showAddRoom, setShowAddRoom] = useState(false);
  const [showAddWarranty, setShowAddWarranty] = useState(false);
  const [showAddPunch, setShowAddPunch] = useState(false);
  const [editingWarranty, setEditingWarranty] = useState<Warranty | null>(null);

  const [wForm, setWForm] = useState({
    system: '', manufacturer: '', model: '', vendor: '', startDate: '',
    durationMonths: 12, contactName: '', contactEmail: '', contactPhone: '', coverageNotes: '',
  });

  const [pForm, setPForm] = useState({
    description: '', location: '', assignedTo: '', status: 'Open' as PunchStatus, priority: 'Standard' as PunchPriority, productRef: undefined as string | undefined,
  });

  // As-Built Drawings state
  const [showAddDrawing, setShowAddDrawing] = useState(false);
  const [drawingForm, setDrawingForm] = useState({ title: '', revision: '', fileName: '', fileData: '' });
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Sign-Off accordion state
  const [expandedRooms, setExpandedRooms] = useState<Set<string>>(new Set());
  const [customItemInputs, setCustomItemInputs] = useState<Record<string, string>>({});
  const [signOffPreparedBy, setSignOffPreparedBy] = useState('');

  // Manuals tab state
  const setProductManual   = useStore((s) => s.setProductManual);
  const clearProductManual = useStore((s) => s.clearProductManual);
  const [manualBookmarks, setManualBookmarks] = useState<ManualBookmark[]>([]);
  const [manualUploading, setManualUploading] = useState(false);
  const [manualExporting, setManualExporting] = useState(false);
  const manualInputRef = useRef<HTMLInputElement>(null);

  // ── Sign-Off: BoM items grouped by room (must be above early return) ──
  const roomGroups = useMemo(() => {
    const map = new Map<string, typeof projectBoM>();
    for (const item of projectBoM) {
      for (const loc of item.locations) {
        const room = loc.room || 'Unassigned';
        if (!map.has(room)) map.set(room, []);
        map.get(room)!.push(item);
      }
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [projectBoM]);

  useEffect(() => {
    if (!closeout && projectId) {
      getOrCreate(projectId);
    }
  }, [closeout, projectId, getOrCreate]);

  if (!closeout) return <div className="p-8 text-fg-2">Loading closeout package...</div>;

  const closeoutId = closeout.id;

  // ── Warranty inline editing helpers ──
  const handleInlineWarrantyChange = (wId: string, field: string, value: string | number) => {
    updateWarranty(closeoutId, wId, { [field]: value });
  };

  const handleAddWarranty = (e: React.FormEvent) => {
    e.preventDefault();
    addWarranty(closeoutId, wForm);
    setShowAddWarranty(false);
    setWForm({ system: '', manufacturer: '', model: '', vendor: '', startDate: '', durationMonths: 12, contactName: '', contactEmail: '', contactPhone: '', coverageNotes: '' });
  };

  const handleWarrantyModalClose = (updated: Partial<Warranty> | null) => {
    if (updated && editingWarranty) {
      updateWarranty(closeoutId, editingWarranty.id, updated);
    }
    setEditingWarranty(null);
  };

  // ── Punch ──
  const handleAddPunch = (e: React.FormEvent) => {
    e.preventDefault();
    addPunchItem(closeoutId, { ...pForm, productRef: pForm.productRef });
    setShowAddPunch(false);
    setPForm({ description: '', location: '', assignedTo: '', status: 'Open', priority: 'Standard', productRef: undefined });
  };

  // ── As-Built Drawings ──
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (isSupabaseConfigured()) {
      // Store the File object for upload on submit
      setPendingFile(file);
      setDrawingForm((prev) => ({ ...prev, fileName: file.name, fileData: '__pending_upload__' }));
    } else {
      // Fallback: base64 for demo mode
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        setDrawingForm((prev) => ({ ...prev, fileName: file.name, fileData: base64 }));
      };
      reader.readAsDataURL(file);
    }
  };

  const handleAddDrawing = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!drawingForm.title || !drawingForm.fileData) return;

    let fileData = drawingForm.fileData;

    if (isSupabaseConfigured() && pendingFile) {
      try {
        fileData = await uploadFile('as-builts', projectId!, pendingFile);
      } catch (err) {
        console.error('As-built drawing upload failed:', err);
        return;
      }
    }

    addAsBuiltDrawing(closeoutId, {
      title: drawingForm.title,
      revision: drawingForm.revision,
      fileName: drawingForm.fileName,
      fileData,
    });
    setShowAddDrawing(false);
    setDrawingForm({ title: '', revision: '', fileName: '', fileData: '' });
    setPendingFile(null);
  };

  const handleViewDrawing = async (d: { fileName: string; fileData: string }) => {
    try {
      // Use authenticated fetch for both private Storage URLs and legacy base64
      const bytes = await fetchFileBytes(d.fileData);
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = d.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err: any) {
      console.error('[Download Drawing]', err);
      alert('Download failed: ' + err.message);
    }
  };

  const toggleRoom = (room: string) => {
    setExpandedRooms((prev) => {
      const next = new Set(prev);
      if (next.has(room)) next.delete(room); else next.add(room);
      return next;
    });
  };

  // Helper to find product name by ref
  const getProductName = (ref?: string) => {
    if (!ref) return '';
    const item = projectBoM.find((b) => b.id === ref);
    return item ? `${item.manufacturer} ${item.model}` : '';
  };

  // Find existing sign-off sheet for a room, or return undefined
  const getSheetForRoom = (room: string) =>
    (closeout.signOffSheets || []).find((s) => s.zone === room);

  const tabs = [
    { key: 'warranties', label: 'Warranties', icon: Shield, count: closeout.warranties.length },
    { key: 'punch', label: 'Punch List', icon: AlertTriangle, count: closeout.punchItems.length },
    { key: 'signoff', label: 'Test & Sign-Off', icon: CheckCircle2, count: (closeout.signOffSheets || []).length },
    { key: 'drawings', label: 'As-Built Drawings', icon: ClipboardCheck, count: (closeout.asBuiltDrawings || []).length },
    { key: 'manuals', label: 'Manuals', icon: BookOpen, count: closeout.productManualUrl ? 1 : 0 },
    { key: 'quickstart', label: 'Quick Start Guide', icon: Rocket, count: (closeout.quickStartRooms ?? []).length },
  ] as const;

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      {project && <ProjectHeader project={project} />}
      <div className="mt-5">
        <PhaseRibbon phase="Post-Sales" toolLabel="Closeout" toolIcon={ClipboardCheck} />
      </div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-[22px] font-bold text-navy m-0">Closeout Package</h2>
          <p className="text-[13px] text-fg-2 mt-1 m-0">Punch list, warranties, sign-off sheets, and as-built drawings.</p>
        </div>
        <button
          className="btn-orange text-sm"
          onClick={() => {
            if (project && closeout) {
              exportCloseoutPDF(project, closeout, projectBoM, project.client, project.client)
                .catch((err) => { console.error('[Closeout PDF]', err); alert('PDF export failed: ' + err.message); });
            }
          }}
        >
          <Download size={14} /> Export Closeout PDF
        </button>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-2 mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activeTab === tab.key ? 'bg-navy text-white' : 'bg-white text-fg-2 border border-border hover:bg-surface'
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
            {tab.count > 0 && <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === tab.key ? 'bg-white/20' : 'bg-surface'}`}>{tab.count}</span>}
          </button>
        ))}
      </div>

      {/* ═══════════════════ Warranty Tab ═══════════════════ */}
      {activeTab === 'warranties' && (
        <>
          <div className="flex justify-end gap-3 mb-4">
            <button
              onClick={() => {
                if (project) {
                  exportWarrantyPDF(project, closeout.warranties)
                    .catch((err) => { console.error('[Warranty PDF]', err); alert('PDF export failed: ' + err.message); });
                }
              }}
              disabled={closeout.warranties.length === 0}
              className="btn-secondary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download size={14} /> Export Warranty PDF
            </button>
            <button
              onClick={() => populateWarranties(closeoutId, projectId!)}
              className="btn-secondary text-sm"
            >
              <Upload size={14} /> Populate from BoM
            </button>
            <button onClick={() => setShowAddWarranty(true)} className="btn-secondary text-sm">
              <Plus size={14} /> Add Warranty
            </button>
          </div>
          {closeout.warranties.length === 0 ? (
            <EmptyState
              icon={<Shield size={48} />}
              title="No warranties"
              description="Populate from the project BoM or add warranties manually."
              action={
                <button
                  onClick={() => populateWarranties(closeoutId, projectId!)}
                  className="btn-primary"
                >
                  <Upload size={16} /> Populate from BoM
                </button>
              }
            />
          ) : (
            <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-navy text-white text-left">
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">System</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Manufacturer + Model</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Vendor</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Start Date</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Duration</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Contact</th>
                    <th className="w-12"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {closeout.warranties.map((w, i) => (
                    <tr
                      key={w.id}
                      className={`cursor-pointer hover:bg-surface/50 ${i % 2 === 1 ? 'bg-surface/30' : ''}`}
                      onClick={() => setEditingWarranty(w)}
                    >
                      <td className="px-5 py-2">
                        <input
                          value={w.system}
                          onChange={(e) => handleInlineWarrantyChange(w.id, 'system', e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full text-sm font-medium text-fg bg-transparent border-b border-transparent hover:border-border focus:border-navy focus:outline-none px-0 py-1"
                        />
                      </td>
                      <td className="px-5 py-3 text-sm text-fg-2">
                        {w.manufacturer} {w.model}
                      </td>
                      <td className="px-5 py-2">
                        <input
                          value={w.vendor}
                          onChange={(e) => handleInlineWarrantyChange(w.id, 'vendor', e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full text-sm text-fg-2 bg-transparent border-b border-transparent hover:border-border focus:border-navy focus:outline-none px-0 py-1"
                          placeholder="Enter vendor"
                        />
                      </td>
                      <td className="px-5 py-2">
                        <input
                          type="date"
                          value={w.startDate}
                          onChange={(e) => handleInlineWarrantyChange(w.id, 'startDate', e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="text-sm text-fg-2 bg-transparent border-b border-transparent hover:border-border focus:border-navy focus:outline-none px-0 py-1"
                        />
                      </td>
                      <td className="px-5 py-2">
                        <input
                          type="number"
                          min={1}
                          value={w.durationMonths}
                          onChange={(e) => handleInlineWarrantyChange(w.id, 'durationMonths', Number(e.target.value))}
                          onClick={(e) => e.stopPropagation()}
                          className="w-20 text-sm text-fg-2 bg-transparent border-b border-transparent hover:border-border focus:border-navy focus:outline-none px-0 py-1"
                        />
                        <span className="text-xs text-fg-2 ml-1">mo</span>
                      </td>
                      <td className="px-5 py-2">
                        <input
                          value={w.contactName}
                          onChange={(e) => handleInlineWarrantyChange(w.id, 'contactName', e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full text-sm text-fg-2 bg-transparent border-b border-transparent hover:border-border focus:border-navy focus:outline-none px-0 py-1"
                          placeholder="Contact name"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteWarranty(closeoutId, w.id); }}
                          className="p-1 rounded hover:bg-red-50 text-fg-2 hover:text-red-500"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ═══════════════════ Punch List Tab ═══════════════════ */}
      {activeTab === 'punch' && (
        <>
          <div className="flex justify-end gap-3 mb-4">
            <button
              onClick={() => {
                if (project) {
                  exportPunchListPDF(project, closeout.punchItems, projectBoM)
                    .catch((err) => { console.error('[Punch List PDF]', err); alert('PDF export failed: ' + err.message); });
                }
              }}
              disabled={closeout.punchItems.length === 0}
              className="btn-secondary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download size={14} /> Export Punch List PDF
            </button>
            <button onClick={() => setShowAddPunch(true)} className="btn-secondary text-sm"><Plus size={14} /> Add Punch Item</button>
          </div>
          {closeout.punchItems.length === 0 ? (
            <EmptyState icon={<AlertTriangle size={48} />} title="No punch items" description="Track outstanding items to resolution." action={<button onClick={() => setShowAddPunch(true)} className="btn-primary"><Plus size={16} /> Add Punch Item</button>} />
          ) : (
            <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-navy text-white text-left">
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">#</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Description</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Location</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Product</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Assigned To</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Priority</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Status</th>
                    <th className="w-24"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {closeout.punchItems.map((p, i) => (
                    <tr key={p.id} className={i % 2 === 1 ? 'bg-surface/30' : ''}>
                      <td className="px-5 py-3 text-sm font-mono text-fg-2">{i + 1}</td>
                      <td className="px-5 py-3 text-sm text-fg">{p.description}</td>
                      <td className="px-5 py-3 text-sm text-fg-2">{p.location}</td>
                      <td className="px-5 py-3 text-sm text-fg-2">{getProductName(p.productRef) || <span className="text-fg-2/50">&mdash;</span>}</td>
                      <td className="px-5 py-3 text-sm text-fg-2">{p.assignedTo}</td>
                      <td className="px-5 py-3"><StatusBadge status={p.priority} /></td>
                      <td className="px-5 py-3">
                        <select
                          value={p.status}
                          onChange={(e) => {
                            const newStatus = e.target.value as PunchStatus;
                            updatePunchItem(closeoutId, p.id, {
                              status: newStatus,
                              resolvedAt: newStatus === 'Complete' ? new Date().toISOString().split('T')[0] : undefined,
                            });
                          }}
                          className="text-xs border border-border rounded-lg px-2 py-1 bg-white"
                        >
                          <option>Open</option>
                          <option>In Progress</option>
                          <option>Complete</option>
                          <option>N/A</option>
                        </select>
                      </td>
                      <td className="px-3 py-3">
                        <button onClick={() => deletePunchItem(closeoutId, p.id)} className="p-1 rounded hover:bg-red-50 text-fg-2 hover:text-red-500"><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-5 py-3 bg-surface/50 border-t border-border text-sm text-fg-2">
                {closeout.punchItems.filter((p) => p.status !== 'Complete' && p.status !== 'N/A').length} open &middot; {closeout.punchItems.filter((p) => p.status === 'Complete').length} complete
              </div>
            </div>
          )}
        </>
      )}

      {/* ═══════════════════ Sign-Off Tab ═══════════════════ */}
      {activeTab === 'signoff' && (
        <>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-fg whitespace-nowrap">Prepared By</label>
              <input
                value={signOffPreparedBy}
                onChange={(e) => setSignOffPreparedBy(e.target.value)}
                placeholder="Instrata"
                className="input text-sm w-56"
              />
            </div>
            <button
              onClick={() => {
                if (project) {
                  const preparedBy = signOffPreparedBy.trim() || 'Instrata';
                  exportSignOffPDF(project, projectBoM, closeout.signOffSheets || [], preparedBy, project.client)
                    .catch((err) => { console.error('[Sign-Off PDF]', err); alert('PDF export failed: ' + err.message); });
                }
              }}
              className="btn-secondary text-sm"
            >
              <FileText size={14} /> Generate Sign-Off PDF
            </button>
          </div>
          {roomGroups.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 size={48} />}
              title="No BoM items"
              description="Add products to the project BoM with room locations to generate sign-off sheets."
            />
          ) : (
            <div className="space-y-3">
              {roomGroups.map(([room, items]) => {
                const isExpanded = expandedRooms.has(room);
                const sheet = getSheetForRoom(room);
                return (
                  <div key={room} className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
                    {/* Room header */}
                    <button
                      onClick={() => toggleRoom(room)}
                      className="w-full flex items-center justify-between px-5 py-4 hover:bg-surface/50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        {isExpanded ? <ChevronDown size={18} className="text-navy" /> : <ChevronRight size={18} className="text-fg-2" />}
                        <span className="text-sm font-semibold text-navy">{room}</span>
                        <span className="text-xs text-fg-2 bg-surface px-2 py-0.5 rounded-full">
                          {items.length} product{items.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      {sheet && (
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          sheet.status === 'Passed' ? 'bg-emerald-100 text-emerald-700' :
                          sheet.status === 'Failed' ? 'bg-red-100 text-red-700' :
                          'bg-amber-100 text-amber-700'
                        }`}>
                          {sheet.status}
                        </span>
                      )}
                    </button>

                    {/* Expanded content */}
                    {isExpanded && (
                      <div className="border-t border-border">
                        {/* BoM products */}
                        <table className="w-full">
                          <thead>
                            <tr className="bg-surface/50">
                              <th className="px-5 py-2 text-xs font-semibold text-fg-2 text-left uppercase tracking-wider">Manufacturer</th>
                              <th className="px-5 py-2 text-xs font-semibold text-fg-2 text-left uppercase tracking-wider">Model</th>
                              <th className="px-5 py-2 text-xs font-semibold text-fg-2 text-left uppercase tracking-wider">Description</th>
                              <th className="px-5 py-2 text-xs font-semibold text-fg-2 text-left uppercase tracking-wider">Qty</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {items.map((item) => {
                              const locQty = item.locations.find((l) => l.room === room)?.qty ?? item.qty;
                              return (
                                <tr key={item.id}>
                                  <td className="px-5 py-2.5 text-sm text-fg">{item.manufacturer}</td>
                                  <td className="px-5 py-2.5 text-sm text-fg-2">{item.model}</td>
                                  <td className="px-5 py-2.5 text-sm text-fg-2">{item.description}</td>
                                  <td className="px-5 py-2.5 text-sm text-fg-2">{locQty}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>

                        {/* Custom items */}
                        {sheet && (sheet.customItems || []).length > 0 && (
                          <div className="px-5 py-3 border-t border-border">
                            <p className="text-xs font-semibold text-fg-2 uppercase tracking-wider mb-2">Custom Items</p>
                            <div className="space-y-1.5">
                              {(sheet.customItems || []).map((ci) => (
                                <div key={ci.id} className="flex items-center justify-between bg-surface/50 rounded-lg px-3 py-2">
                                  <span className="text-sm text-fg">{ci.text}</span>
                                  <button
                                    onClick={() => deleteSignOffCustomItem(closeoutId, sheet.id, ci.id)}
                                    className="p-0.5 rounded hover:bg-red-50 text-fg-2 hover:text-red-500"
                                  >
                                    <X size={14} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Add custom item */}
                        <div className="px-5 py-3 border-t border-border">
                          <div className="flex gap-2">
                            <input
                              value={customItemInputs[room] || ''}
                              onChange={(e) => setCustomItemInputs((prev) => ({ ...prev, [room]: e.target.value }))}
                              placeholder="Add custom item..."
                              className="input flex-1 text-sm"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && customItemInputs[room]?.trim()) {
                                  let targetSheet = sheet;
                                  if (!targetSheet) {
                                    addSignOffSheet(closeoutId, { zone: room, system: '', testedBy: '', testedDate: '', witnessedBy: '', status: 'Pending' as SignOffStatus, notes: '', customItems: [] });
                                    // Zustand set() is synchronous — read the new sheet immediately
                                    targetSheet = useStore.getState().closeouts
                                      .find((c) => c.id === closeoutId)?.signOffSheets
                                      .find((s) => s.zone === room);
                                  }
                                  if (targetSheet) {
                                    addSignOffCustomItem(closeoutId, targetSheet.id, customItemInputs[room].trim());
                                  }
                                  setCustomItemInputs((prev) => ({ ...prev, [room]: '' }));
                                }
                              }}
                            />
                            <button
                              onClick={() => {
                                if (!customItemInputs[room]?.trim()) return;
                                let targetSheet = sheet;
                                if (!targetSheet) {
                                  addSignOffSheet(closeoutId, { zone: room, system: '', testedBy: '', testedDate: '', witnessedBy: '', status: 'Pending' as SignOffStatus, notes: '', customItems: [] });
                                  // Zustand set() is synchronous — read the new sheet immediately
                                  targetSheet = useStore.getState().closeouts
                                    .find((c) => c.id === closeoutId)?.signOffSheets
                                    .find((s) => s.zone === room);
                                }
                                if (targetSheet) {
                                  addSignOffCustomItem(closeoutId, targetSheet.id, customItemInputs[room].trim());
                                }
                                setCustomItemInputs((prev) => ({ ...prev, [room]: '' }));
                              }}
                              className="btn-secondary text-sm"
                            >
                              <Plus size={14} /> Add
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ═══════════════════ As-Built Drawings Tab ═══════════════════ */}
      {activeTab === 'drawings' && (
        <>
          <div className="flex justify-end mb-4">
            <button onClick={() => setShowAddDrawing(true)} className="btn-secondary text-sm">
              <Plus size={14} /> Add Drawing
            </button>
          </div>
          {(closeout.asBuiltDrawings || []).length === 0 ? (
            <EmptyState
              icon={<ClipboardCheck size={48} />}
              title="As-Built Drawing Log"
              description="Upload final drawing PDFs with revision numbers and dates."
              action={
                <button onClick={() => setShowAddDrawing(true)} className="btn-primary">
                  <Plus size={16} /> Add Drawing
                </button>
              }
            />
          ) : (
            <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-navy text-white text-left">
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Title</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">File Name</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Revision</th>
                    <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Uploaded</th>
                    <th className="w-28"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(closeout.asBuiltDrawings || []).map((d, i) => (
                    <tr key={d.id} className={i % 2 === 1 ? 'bg-surface/30' : ''}>
                      <td className="px-5 py-3 text-sm font-medium text-fg">{d.title}</td>
                      <td className="px-5 py-3 text-sm text-fg-2">{d.fileName}</td>
                      <td className="px-5 py-3 text-sm text-fg-2">{d.revision || '\u2014'}</td>
                      <td className="px-5 py-3 text-sm text-fg-2">{d.uploadedAt}</td>
                      <td className="px-3 py-3 flex gap-1">
                        <button
                          onClick={() => handleViewDrawing(d)}
                          className="p-1 rounded hover:bg-blue-50 text-fg-2 hover:text-navy"
                          title="Download / View"
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          onClick={() => deleteAsBuiltDrawing(closeoutId, d.id)}
                          className="p-1 rounded hover:bg-red-50 text-fg-2 hover:text-red-500"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ═══════════════════ Manuals Tab ═══════════════════ */}
      {activeTab === 'manuals' && (
        <>
          {/* Hidden file input */}
          <input
            ref={manualInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file || !projectId) return;
              setManualUploading(true);
              try {
                const url = await uploadFile('manuals', projectId, file);
                setProductManual(closeoutId, url, file.name);
                // Parse bookmarks from the uploaded file
                const bytes = new Uint8Array(await file.arrayBuffer());
                const bms = await extractBookmarks(bytes);
                setManualBookmarks(bms);
              } catch (err: any) {
                alert('Upload failed: ' + err.message);
              }
              setManualUploading(false);
              e.target.value = '';
            }}
          />

          {!closeout.productManualUrl ? (
            <EmptyState
              icon={<BookOpen size={48} />}
              title="No product manuals uploaded"
              description="Staple all product manuals into a single PDF in Bluebeam, then upload it here. Bookmarks will be parsed automatically for the table of contents."
              action={
                <button
                  onClick={() => manualInputRef.current?.click()}
                  disabled={manualUploading}
                  className="btn-primary disabled:opacity-50"
                >
                  <Upload size={16} /> {manualUploading ? 'Uploading...' : 'Upload Manual PDF'}
                </button>
              }
            />
          ) : (
            <div className="space-y-4">
              {/* File info card */}
              <div className="bg-white rounded-xl border border-border shadow-sm p-5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-navy/10 flex items-center justify-center">
                    <BookOpen size={20} className="text-navy" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-fg">{closeout.productManualName}</p>
                    <p className="text-xs text-fg-2 mt-0.5">{manualBookmarks.length > 0 ? `${manualBookmarks.filter(b => b.depth === 0).length} sections detected` : 'No bookmarks detected'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      setManualExporting(true);
                      try {
                        const bytes = await fetchFileBytes(closeout.productManualUrl!);
                        const bms   = manualBookmarks.length > 0 ? manualBookmarks : await extractBookmarks(bytes);
                        if (project) await exportManualsPDF(project, bytes, bms);
                      } catch (err: any) {
                        alert('Export failed: ' + err.message);
                      }
                      setManualExporting(false);
                    }}
                    disabled={manualExporting}
                    className="btn-secondary text-sm disabled:opacity-50"
                  >
                    <Download size={14} /> {manualExporting ? 'Exporting...' : 'Export PDF'}
                  </button>
                  <button
                    onClick={() => manualInputRef.current?.click()}
                    disabled={manualUploading}
                    className="btn-secondary text-sm disabled:opacity-50"
                  >
                    <Upload size={14} /> {manualUploading ? 'Uploading...' : 'Replace'}
                  </button>
                  <button
                    onClick={() => { clearProductManual(closeoutId); setManualBookmarks([]); }}
                    className="p-2 rounded-lg hover:bg-red-50 text-fg-2 hover:text-red-500 transition-colors"
                    title="Remove manual"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              {/* Bookmark preview */}
              {manualBookmarks.length > 0 && (
                <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
                  <div className="px-5 py-3 bg-navy">
                    <p className="text-sm font-semibold text-white">Detected Table of Contents</p>
                    <p className="text-xs text-white/60 mt-0.5">Parsed from PDF bookmarks — will appear in exported document</p>
                  </div>
                  <div className="divide-y divide-border">
                    {manualBookmarks.map((bm, i) => (
                      <div key={i} className="flex items-center justify-between px-5 py-2.5" style={{ paddingLeft: `${20 + bm.depth * 16}px` }}>
                        <span className={`text-sm ${bm.depth === 0 ? 'font-semibold text-navy' : 'text-fg-2'}`}>{bm.title}</span>
                        {bm.page > 0 && <span className="text-xs font-mono text-fg-2 ml-4 shrink-0">p. {bm.page}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ═══════════════════ Quick Start Guide Tab ═══════════════════ */}
      {activeTab === 'quickstart' && (
        <>
          <div className="flex justify-end mb-4">
            <button onClick={() => setShowAddRoom(true)} className="btn-secondary text-sm">
              <Plus size={14} /> Add a Room
            </button>
          </div>
          {(closeout.quickStartRooms ?? []).length === 0 ? (
            <EmptyState
              icon={<Rocket size={48} />}
              title="No quick start rooms yet"
              description="Add a room to walk the client through how to operate it."
              action={
                <button onClick={() => setShowAddRoom(true)} className="btn-primary">
                  <Plus size={16} /> Add a Room
                </button>
              }
            />
          ) : (
            <div className="space-y-4">
              {(closeout.quickStartRooms ?? []).map((room) => (
                <QuickStartRoomCard
                  key={room.id}
                  room={room}
                  onDelete={() => {
                    if (confirm(`Delete the "${room.name}" quick start room? All steps will be removed.`)) {
                      deleteQuickStartRoom(closeoutId, room.id);
                    }
                  }}
                  onAddStep={() => addQuickStartStep(closeoutId, room.id, { text: '', note: '' })}
                  onUpdateStep={(stepId, updates) => updateQuickStartStep(closeoutId, room.id, stepId, updates)}
                  onDeleteStep={(stepId) => deleteQuickStartStep(closeoutId, room.id, stepId)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ─── Add Room Modal ─── */}
      <AddQuickStartRoomModal
        open={showAddRoom}
        onClose={() => setShowAddRoom(false)}
        availableRooms={roomGroups.map(([room]) => room)}
        existingRoomNames={new Set((closeout.quickStartRooms ?? []).map((r) => r.name))}
        onAdd={(name) => {
          addQuickStartRoom(closeoutId, name);
          setShowAddRoom(false);
        }}
      />

      {/* ─── Warranty Edit Modal ─── */}
      <WarrantyEditModal
        warranty={editingWarranty}
        open={editingWarranty !== null}
        onClose={handleWarrantyModalClose}
      />

      {/* ─── Add Warranty Modal ─── */}
      <Modal open={showAddWarranty} onClose={() => setShowAddWarranty(false)} title="Add Warranty" wide>
        <form onSubmit={handleAddWarranty} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium">System <span className="text-red-500">*</span></span>
            <input value={wForm.system} onChange={(e) => setWForm({ ...wForm, system: e.target.value })} required className="input mt-1.5" placeholder='e.g. "Conference Room A Display System"' />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block"><span className="text-sm font-medium">Manufacturer</span><input value={wForm.manufacturer} onChange={(e) => setWForm({ ...wForm, manufacturer: e.target.value })} className="input mt-1.5" /></label>
            <label className="block"><span className="text-sm font-medium">Model</span><input value={wForm.model} onChange={(e) => setWForm({ ...wForm, model: e.target.value })} className="input mt-1.5" /></label>
          </div>
          <label className="block"><span className="text-sm font-medium">Vendor / Distributor</span><input value={wForm.vendor} onChange={(e) => setWForm({ ...wForm, vendor: e.target.value })} className="input mt-1.5" /></label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block"><span className="text-sm font-medium">Start Date</span><input type="date" value={wForm.startDate} onChange={(e) => setWForm({ ...wForm, startDate: e.target.value })} className="input mt-1.5" /></label>
            <label className="block"><span className="text-sm font-medium">Duration (months)</span><input type="number" min={1} value={wForm.durationMonths} onChange={(e) => setWForm({ ...wForm, durationMonths: Number(e.target.value) })} className="input mt-1.5" /></label>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <label className="block"><span className="text-sm font-medium">Contact Name</span><input value={wForm.contactName} onChange={(e) => setWForm({ ...wForm, contactName: e.target.value })} className="input mt-1.5" /></label>
            <label className="block"><span className="text-sm font-medium">Contact Email</span><input type="email" value={wForm.contactEmail} onChange={(e) => setWForm({ ...wForm, contactEmail: e.target.value })} className="input mt-1.5" /></label>
            <label className="block"><span className="text-sm font-medium">Contact Phone</span><input value={wForm.contactPhone} onChange={(e) => setWForm({ ...wForm, contactPhone: e.target.value })} className="input mt-1.5" /></label>
          </div>
          <label className="block"><span className="text-sm font-medium">Coverage Notes</span><textarea value={wForm.coverageNotes} onChange={(e) => setWForm({ ...wForm, coverageNotes: e.target.value })} rows={2} className="input mt-1.5" /></label>
          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <button type="button" onClick={() => setShowAddWarranty(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary">Add Warranty</button>
          </div>
        </form>
      </Modal>

      {/* ─── Add Punch Item Modal ─── */}
      <Modal open={showAddPunch} onClose={() => setShowAddPunch(false)} title="Add Punch Item">
        <form onSubmit={handleAddPunch} className="space-y-4">
          <label className="block"><span className="text-sm font-medium">Description <span className="text-red-500">*</span></span><textarea value={pForm.description} onChange={(e) => setPForm({ ...pForm, description: e.target.value })} required rows={2} className="input mt-1.5" /></label>
          {projectId && (
            <LocationProductPicker
              projectId={projectId}
              selectedLocation={pForm.location || undefined}
              selectedProduct={pForm.productRef}
              onLocationChange={(loc) => setPForm({ ...pForm, location: loc || '' })}
              onProductChange={(ref) => setPForm({ ...pForm, productRef: ref })}
            />
          )}
          {!projectId && (
            <label className="block"><span className="text-sm font-medium">Location</span><input value={pForm.location} onChange={(e) => setPForm({ ...pForm, location: e.target.value })} className="input mt-1.5" /></label>
          )}
          <label className="block"><span className="text-sm font-medium">Assigned To</span><input value={pForm.assignedTo} onChange={(e) => setPForm({ ...pForm, assignedTo: e.target.value })} className="input mt-1.5" /></label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm font-medium">Priority</span>
              <select value={pForm.priority} onChange={(e) => setPForm({ ...pForm, priority: e.target.value as PunchPriority })} className="input mt-1.5">
                <option>Standard</option>
                <option>Critical</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Status</span>
              <select value={pForm.status} onChange={(e) => setPForm({ ...pForm, status: e.target.value as PunchStatus })} className="input mt-1.5">
                <option>Open</option>
                <option>In Progress</option>
                <option>Complete</option>
                <option>N/A</option>
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <button type="button" onClick={() => setShowAddPunch(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary">Add Punch Item</button>
          </div>
        </form>
      </Modal>

      {/* ─── Add Drawing Modal ─── */}
      <Modal open={showAddDrawing} onClose={() => setShowAddDrawing(false)} title="Add As-Built Drawing">
        <form onSubmit={handleAddDrawing} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Title <span className="text-red-500">*</span></span>
            <input
              value={drawingForm.title}
              onChange={(e) => setDrawingForm({ ...drawingForm, title: e.target.value })}
              required
              className="input mt-1.5"
              placeholder="e.g. Floor Plan - Level 3"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Revision</span>
            <input
              value={drawingForm.revision}
              onChange={(e) => setDrawingForm({ ...drawingForm, revision: e.target.value })}
              className="input mt-1.5"
              placeholder="e.g. Rev A"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">PDF File <span className="text-red-500">*</span></span>
            <input
              type="file"
              accept="application/pdf"
              onChange={handleFileChange}
              className="mt-1.5 block w-full text-sm text-fg-2 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-navy file:text-white hover:file:bg-navy/90 file:cursor-pointer"
            />
            {drawingForm.fileName && (
              <p className="text-xs text-fg-2 mt-1">Selected: {drawingForm.fileName}</p>
            )}
          </label>
          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <button type="button" onClick={() => setShowAddDrawing(false)} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={!drawingForm.title || !drawingForm.fileData} className="btn-primary disabled:opacity-50">Add Drawing</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ─── Quick Start Guide: Room card with editable steps ─── */
function QuickStartRoomCard({
  room,
  onDelete,
  onAddStep,
  onUpdateStep,
  onDeleteStep,
}: {
  room: QuickStartRoom;
  onDelete: () => void;
  onAddStep: () => void;
  onUpdateStep: (stepId: string, updates: { text?: string; note?: string }) => void;
  onDeleteStep: (stepId: string) => void;
}) {
  return (
    <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 bg-navy/5 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-2 h-7 rounded" style={{ background: '#F68D2E' }} />
          <h3 className="text-base font-semibold text-navy m-0 truncate">{room.name}</h3>
          <span className="text-xs text-fg-2 whitespace-nowrap">
            {room.steps.length} step{room.steps.length === 1 ? '' : 's'}
          </span>
        </div>
        <button
          onClick={onDelete}
          className="p-1.5 rounded hover:bg-red-50 text-fg-2 hover:text-red-500 transition-colors"
          title="Delete room"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {room.steps.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-fg-2">
          No steps yet. Add the first step below.
        </div>
      ) : (
        <ol className="divide-y divide-border-soft">
          {room.steps.map((step, i) => (
            <li key={step.id} className="px-5 py-4 flex items-start gap-3">
              <GripVertical size={14} className="text-fg-3 mt-2.5 flex-shrink-0" />
              <div className="flex items-center justify-center w-7 h-7 rounded-full bg-navy text-white text-xs font-bold font-mono flex-shrink-0 mt-1">
                {i + 1}
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <input
                  value={step.text}
                  onChange={(e) => onUpdateStep(step.id, { text: e.target.value })}
                  placeholder="Step (e.g. Press the Start button)"
                  className="input text-sm"
                />
                <textarea
                  value={step.note}
                  onChange={(e) => onUpdateStep(step.id, { note: e.target.value })}
                  placeholder="Note (optional — extra context shown below the step)"
                  rows={2}
                  className="input text-xs"
                />
              </div>
              <button
                onClick={() => onDeleteStep(step.id)}
                className="p-1.5 rounded hover:bg-red-50 text-fg-2 hover:text-red-500 transition-colors flex-shrink-0 mt-1"
                title="Delete step"
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className="px-5 py-3 border-t border-border bg-surface/40">
        <button onClick={onAddStep} className="btn-secondary text-sm">
          <Plus size={14} /> Add Step
        </button>
      </div>
    </div>
  );
}

/* ─── Quick Start Guide: Add Room modal ─── */
function AddQuickStartRoomModal({
  open,
  onClose,
  availableRooms,
  existingRoomNames,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  availableRooms: string[];
  existingRoomNames: Set<string>;
  onAdd: (name: string) => void;
}) {
  const [customName, setCustomName] = useState('');
  const [search, setSearch] = useState('');

  // Reset on open/close
  useEffect(() => {
    if (!open) {
      setCustomName('');
      setSearch('');
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = availableRooms.filter((r) => r && r !== 'Unassigned');
    if (!q) return list;
    return list.filter((r) => r.toLowerCase().includes(q));
  }, [availableRooms, search]);

  const handleAddCustom = (e: React.FormEvent) => {
    e.preventDefault();
    const name = customName.trim();
    if (!name) return;
    onAdd(name);
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a Room" wide>
      <div className="space-y-5">
        {/* Custom name */}
        <div>
          <label className="block text-sm font-medium text-fg mb-1.5">Custom room name</label>
          <form onSubmit={handleAddCustom} className="flex gap-2">
            <input
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder='e.g. "Conference Room 145"'
              className="input flex-1"
              autoFocus
            />
            <button
              type="submit"
              disabled={!customName.trim()}
              className="btn-primary text-sm whitespace-nowrap disabled:opacity-50"
            >
              <Plus size={14} /> Add
            </button>
          </form>
          <p className="text-xs text-fg-2 mt-1.5">
            Type a name if your BoM doesn't have rooms broken out (e.g. quotes built by equipment type).
          </p>
        </div>

        {/* Or pick from BoM */}
        {availableRooms.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs uppercase tracking-wider text-fg-2 font-semibold">Or pick from project locations</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            {availableRooms.length > 6 && (
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter locations…"
                className="input text-sm mb-2"
              />
            )}

            <div className="border border-border rounded-lg overflow-hidden bg-white" style={{ maxHeight: 320, overflowY: 'auto' }}>
              {filtered.length === 0 ? (
                <div className="py-8 text-center text-sm text-fg-2">
                  No matching locations.
                </div>
              ) : (
                <ul className="divide-y divide-border-soft">
                  {filtered.map((room) => {
                    const alreadyAdded = existingRoomNames.has(room);
                    return (
                      <li key={room}>
                        <button
                          type="button"
                          onClick={() => onAdd(room)}
                          disabled={alreadyAdded}
                          className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-surface/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title={alreadyAdded ? 'Already added' : undefined}
                        >
                          <MapPin size={13} className="text-fg-2 flex-shrink-0" />
                          <span className="flex-1 min-w-0 truncate">{room}</span>
                          {alreadyAdded && <span className="text-[10px] text-fg-3 uppercase tracking-wider">Added</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
