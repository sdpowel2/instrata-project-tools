import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, Shield, AlertTriangle, Trash2, Download, CheckCircle2, ClipboardCheck, ChevronDown, ChevronRight, X, Eye, FileText, Upload } from 'lucide-react';
import { useStore } from '../store';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { LocationProductPicker } from '../components/LocationProductPicker';
import type { PunchStatus, PunchPriority, SignOffStatus, Warranty } from '../types';
import { exportSignOffPDF } from '../utils/exportSignOffPDF';
import { exportCloseoutPDF } from '../utils/exportCloseoutPDF';
import { isSupabaseConfigured } from '../lib/supabase';
import { uploadFile, isUrl, fetchFileBytes } from '../lib/storage';

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
            <span className="text-sm font-medium text-text-secondary">Manufacturer (from BoM)</span>
            <input value={form.manufacturer ?? ''} readOnly className="input mt-1.5 bg-surface cursor-not-allowed" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-text-secondary">Model (from BoM)</span>
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
  const updateSignOffSheet = useStore((s) => s.updateSignOffSheet);
  const deleteSignOffSheet = useStore((s) => s.deleteSignOffSheet);
  const addSignOffCustomItem = useStore((s) => s.addSignOffCustomItem);
  const deleteSignOffCustomItem = useStore((s) => s.deleteSignOffCustomItem);
  const addAsBuiltDrawing = useStore((s) => s.addAsBuiltDrawing);
  const deleteAsBuiltDrawing = useStore((s) => s.deleteAsBuiltDrawing);
  const allBoM = useStore((s) => s.projectBoM);
  const projects = useStore((s) => s.projects);
  const projectBoM = useMemo(() => allBoM.filter((b) => b.projectId === projectId), [allBoM, projectId]);
  const project = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);

  // ── All useState hooks ABOVE the early return ──
  const [activeTab, setActiveTab] = useState<'warranties' | 'punch' | 'signoff' | 'drawings'>('warranties');
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

  // Sign-Off accordion state
  const [expandedRooms, setExpandedRooms] = useState<Set<string>>(new Set());
  const [customItemInputs, setCustomItemInputs] = useState<Record<string, string>>({});
  const [signOffPreparedBy, setSignOffPreparedBy] = useState('');

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

  if (!closeout) return <div className="p-8 text-text-secondary">Loading closeout package...</div>;

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
  const [pendingFile, setPendingFile] = useState<File | null>(null);

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
      const blob = new Blob([bytes], { type: 'application/pdf' });
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
  ] as const;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-navy">Closeout Package</h2>
        <button
          className="btn-primary text-sm"
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
              activeTab === tab.key ? 'bg-navy text-white' : 'bg-white text-text-secondary border border-border hover:bg-surface'
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
                      className={`cursor-pointer hover:bg-blue-50/50 ${i % 2 === 1 ? 'bg-surface/30' : ''}`}
                      onClick={() => setEditingWarranty(w)}
                    >
                      <td className="px-5 py-2">
                        <input
                          value={w.system}
                          onChange={(e) => handleInlineWarrantyChange(w.id, 'system', e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full text-sm font-medium text-text-primary bg-transparent border-b border-transparent hover:border-border focus:border-navy focus:outline-none px-0 py-1"
                        />
                      </td>
                      <td className="px-5 py-3 text-sm text-text-secondary">
                        {w.manufacturer} {w.model}
                      </td>
                      <td className="px-5 py-2">
                        <input
                          value={w.vendor}
                          onChange={(e) => handleInlineWarrantyChange(w.id, 'vendor', e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full text-sm text-text-secondary bg-transparent border-b border-transparent hover:border-border focus:border-navy focus:outline-none px-0 py-1"
                          placeholder="Enter vendor"
                        />
                      </td>
                      <td className="px-5 py-2">
                        <input
                          type="date"
                          value={w.startDate}
                          onChange={(e) => handleInlineWarrantyChange(w.id, 'startDate', e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="text-sm text-text-secondary bg-transparent border-b border-transparent hover:border-border focus:border-navy focus:outline-none px-0 py-1"
                        />
                      </td>
                      <td className="px-5 py-2">
                        <input
                          type="number"
                          min={1}
                          value={w.durationMonths}
                          onChange={(e) => handleInlineWarrantyChange(w.id, 'durationMonths', Number(e.target.value))}
                          onClick={(e) => e.stopPropagation()}
                          className="w-20 text-sm text-text-secondary bg-transparent border-b border-transparent hover:border-border focus:border-navy focus:outline-none px-0 py-1"
                        />
                        <span className="text-xs text-text-secondary ml-1">mo</span>
                      </td>
                      <td className="px-5 py-2">
                        <input
                          value={w.contactName}
                          onChange={(e) => handleInlineWarrantyChange(w.id, 'contactName', e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full text-sm text-text-secondary bg-transparent border-b border-transparent hover:border-border focus:border-navy focus:outline-none px-0 py-1"
                          placeholder="Contact name"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteWarranty(closeoutId, w.id); }}
                          className="p-1 rounded hover:bg-red-50 text-text-secondary hover:text-red-500"
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
          <div className="flex justify-end mb-4">
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
                      <td className="px-5 py-3 text-sm font-mono text-text-secondary">{i + 1}</td>
                      <td className="px-5 py-3 text-sm text-text-primary">{p.description}</td>
                      <td className="px-5 py-3 text-sm text-text-secondary">{p.location}</td>
                      <td className="px-5 py-3 text-sm text-text-secondary">{getProductName(p.productRef) || <span className="text-text-secondary/50">&mdash;</span>}</td>
                      <td className="px-5 py-3 text-sm text-text-secondary">{p.assignedTo}</td>
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
                        <button onClick={() => deletePunchItem(closeoutId, p.id)} className="p-1 rounded hover:bg-red-50 text-text-secondary hover:text-red-500"><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-5 py-3 bg-surface/50 border-t border-border text-sm text-text-secondary">
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
              <label className="text-sm font-medium text-text-primary whitespace-nowrap">Prepared By</label>
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
                        {isExpanded ? <ChevronDown size={18} className="text-navy" /> : <ChevronRight size={18} className="text-text-secondary" />}
                        <span className="text-sm font-semibold text-navy">{room}</span>
                        <span className="text-xs text-text-secondary bg-surface px-2 py-0.5 rounded-full">
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
                              <th className="px-5 py-2 text-xs font-semibold text-text-secondary text-left uppercase tracking-wider">Manufacturer</th>
                              <th className="px-5 py-2 text-xs font-semibold text-text-secondary text-left uppercase tracking-wider">Model</th>
                              <th className="px-5 py-2 text-xs font-semibold text-text-secondary text-left uppercase tracking-wider">Description</th>
                              <th className="px-5 py-2 text-xs font-semibold text-text-secondary text-left uppercase tracking-wider">Qty</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {items.map((item) => {
                              const locQty = item.locations.find((l) => l.room === room)?.qty ?? item.qty;
                              return (
                                <tr key={item.id}>
                                  <td className="px-5 py-2.5 text-sm text-text-primary">{item.manufacturer}</td>
                                  <td className="px-5 py-2.5 text-sm text-text-secondary">{item.model}</td>
                                  <td className="px-5 py-2.5 text-sm text-text-secondary">{item.description}</td>
                                  <td className="px-5 py-2.5 text-sm text-text-secondary">{locQty}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>

                        {/* Custom items */}
                        {sheet && (sheet.customItems || []).length > 0 && (
                          <div className="px-5 py-3 border-t border-border">
                            <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">Custom Items</p>
                            <div className="space-y-1.5">
                              {(sheet.customItems || []).map((ci) => (
                                <div key={ci.id} className="flex items-center justify-between bg-surface/50 rounded-lg px-3 py-2">
                                  <span className="text-sm text-text-primary">{ci.text}</span>
                                  <button
                                    onClick={() => deleteSignOffCustomItem(closeoutId, sheet.id, ci.id)}
                                    className="p-0.5 rounded hover:bg-red-50 text-text-secondary hover:text-red-500"
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
                      <td className="px-5 py-3 text-sm font-medium text-text-primary">{d.title}</td>
                      <td className="px-5 py-3 text-sm text-text-secondary">{d.fileName}</td>
                      <td className="px-5 py-3 text-sm text-text-secondary">{d.revision || '\u2014'}</td>
                      <td className="px-5 py-3 text-sm text-text-secondary">{d.uploadedAt}</td>
                      <td className="px-3 py-3 flex gap-1">
                        <button
                          onClick={() => handleViewDrawing(d)}
                          className="p-1 rounded hover:bg-blue-50 text-text-secondary hover:text-navy"
                          title="Download / View"
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          onClick={() => deleteAsBuiltDrawing(closeoutId, d.id)}
                          className="p-1 rounded hover:bg-red-50 text-text-secondary hover:text-red-500"
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
              className="mt-1.5 block w-full text-sm text-text-secondary file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-navy file:text-white hover:file:bg-navy/90 file:cursor-pointer"
            />
            {drawingForm.fileName && (
              <p className="text-xs text-text-secondary mt-1">Selected: {drawingForm.fileName}</p>
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
