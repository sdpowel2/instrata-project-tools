import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, BookOpen, Trash2, Download, ChevronDown, ChevronRight, Cpu } from 'lucide-react';
import { useStore } from '../store';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import type { ManualSectionType } from '../types';

const sectionTypes: ManualSectionType[] = ['System Overview', 'System Section', 'Device Registry', 'Support Contacts', 'Emergency Procedures'];

export function OwnerManualPage() {
  const { projectId } = useParams();
  const allManuals = useStore((s) => s.manuals);
  const manuals = useMemo(() => allManuals.filter((x) => x.projectId === projectId), [allManuals, projectId]);
  const addManual = useStore((s) => s.addManual);
  const updateManual = useStore((s) => s.updateManual);
  const addSection = useStore((s) => s.addManualSection);
  const deleteSection = useStore((s) => s.deleteManualSection);
  const addDevice = useStore((s) => s.addManualDevice);
  const updateDevice = useStore((s) => s.updateManualDevice);
  const deleteDevice = useStore((s) => s.deleteManualDevice);

  const [showNewManual, setShowNewManual] = useState(false);
  const [showAddSection, setShowAddSection] = useState(false);
  const [showAddDevice, setShowAddDevice] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [manualForm, setManualForm] = useState({ title: '', revision: 'Rev 0', overviewText: '' });
  const [sectionForm, setSectionForm] = useState({ title: '', type: 'System Section' as ManualSectionType, sortOrder: 0 });
  const [deviceForm, setDeviceForm] = useState({
    manufacturer: '', model: '', serialNumber: '', location: '', purpose: '',
    operationNotes: '', ipAddress: '', controlId: '', sortOrder: 0,
  });

  const manual = manuals[0];

  const handleCreateManual = (e: React.FormEvent) => {
    e.preventDefault();
    addManual({ ...manualForm, projectId: projectId! });
    setShowNewManual(false);
    setManualForm({ title: '', revision: 'Rev 0', overviewText: '' });
  };

  const handleAddSection = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manual) return;
    addSection(manual.id, { ...sectionForm, sortOrder: manual.sections.length });
    setShowAddSection(false);
    setSectionForm({ title: '', type: 'System Section', sortOrder: 0 });
  };

  const handleAddDevice = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manual || !showAddDevice) return;
    const section = manual.sections.find((s) => s.id === showAddDevice);
    addDevice(manual.id, showAddDevice, { ...deviceForm, sortOrder: section?.devices.length ?? 0 });
    setShowAddDevice(null);
    setDeviceForm({ manufacturer: '', model: '', serialNumber: '', location: '', purpose: '', operationNotes: '', ipAddress: '', controlId: '', sortOrder: 0 });
  };

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  if (!manual) {
    return (
      <div className="p-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-navy">Owner Manual</h2>
        </div>
        <EmptyState
          icon={<BookOpen size={48} />}
          title="No owner manual yet"
          description="Create a structured, branded operations manual for the building owner."
          action={<button onClick={() => setShowNewManual(true)} className="btn-primary"><Plus size={16} /> Create Manual</button>}
        />
        <Modal open={showNewManual} onClose={() => setShowNewManual(false)} title="Create Owner Manual" wide>
          <form onSubmit={handleCreateManual} className="space-y-4">
            <label className="block"><span className="text-sm font-medium">Manual Title <span className="text-red-500">*</span></span><input value={manualForm.title} onChange={(e) => setManualForm({ ...manualForm, title: e.target.value })} required className="input mt-1.5" /></label>
            <label className="block"><span className="text-sm font-medium">Revision</span><input value={manualForm.revision} onChange={(e) => setManualForm({ ...manualForm, revision: e.target.value })} className="input mt-1.5" /></label>
            <label className="block"><span className="text-sm font-medium">System Overview</span><textarea value={manualForm.overviewText} onChange={(e) => setManualForm({ ...manualForm, overviewText: e.target.value })} rows={4} className="input mt-1.5" placeholder="Describe the installed AV systems..." /></label>
            <div className="flex justify-end gap-3 pt-4 border-t border-border">
              <button type="button" onClick={() => setShowNewManual(false)} className="btn-secondary">Cancel</button>
              <button type="submit" className="btn-primary">Create Manual</button>
            </div>
          </form>
        </Modal>
      </div>
    );
  }

  const sortedSections = [...manual.sections].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="p-8 max-w-[1200px]">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-navy">Owner Manual</h2>
        <div className="flex gap-3">
          <button className="btn-primary text-sm"><Download size={14} /> Export PDF</button>
        </div>
      </div>

      {/* Manual header */}
      <div className="bg-white rounded-xl border border-border shadow-sm p-6 mb-6">
        <h3 className="text-lg font-bold text-navy">{manual.title}</h3>
        <div className="flex items-center gap-3 mt-1 text-sm text-text-secondary">
          <span className="font-mono">{manual.revision}</span>
          <span>&middot;</span>
          <span>Created {manual.createdAt}</span>
        </div>
        {manual.overviewText && (
          <div className="mt-4 p-4 bg-surface rounded-lg">
            <div className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1">System Overview</div>
            <p className="text-sm text-text-primary leading-relaxed">{manual.overviewText}</p>
          </div>
        )}
      </div>

      {/* Sections */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-navy">Manual Sections</h3>
        <button onClick={() => setShowAddSection(true)} className="btn-secondary text-sm"><Plus size={14} /> Add Section</button>
      </div>

      {sortedSections.length === 0 ? (
        <div className="bg-white rounded-xl border border-border shadow-sm p-8 text-center">
          <p className="text-text-secondary mb-4">No sections yet. Add a section to start building the manual.</p>
          <button onClick={() => setShowAddSection(true)} className="btn-primary text-sm"><Plus size={16} /> Add Section</button>
        </div>
      ) : (
        <div className="space-y-3">
          {sortedSections.map((section) => {
            const expanded = expandedSections.has(section.id);
            return (
              <div key={section.id} className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
                <button
                  onClick={() => toggleSection(section.id)}
                  className="w-full flex items-center justify-between px-6 py-4 hover:bg-surface/50 transition-colors text-left"
                >
                  <div className="flex items-center gap-3">
                    {expanded ? <ChevronDown size={16} className="text-navy" /> : <ChevronRight size={16} className="text-text-secondary" />}
                    <div>
                      <div className="text-sm font-semibold text-text-primary">{section.title}</div>
                      <div className="text-xs text-text-secondary">{section.type} &middot; {section.devices.length} devices</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={(e) => { e.stopPropagation(); setShowAddDevice(section.id); }} className="p-1.5 rounded-lg hover:bg-surface text-text-secondary hover:text-navy"><Plus size={14} /></button>
                    <button onClick={(e) => { e.stopPropagation(); deleteSection(manual.id, section.id); }} className="p-1.5 rounded-lg hover:bg-red-50 text-text-secondary hover:text-red-500"><Trash2 size={14} /></button>
                  </div>
                </button>

                {expanded && (
                  <div className="border-t border-border">
                    {section.devices.length === 0 ? (
                      <div className="px-6 py-6 text-center text-sm text-text-secondary">
                        No devices in this section. <button onClick={() => setShowAddDevice(section.id)} className="text-blue underline">Add a device</button>
                      </div>
                    ) : (
                      <div className="divide-y divide-border">
                        {[...section.devices].sort((a, b) => a.sortOrder - b.sortOrder).map((device) => (
                          <div key={device.id} className="px-6 py-4 hover:bg-surface/30">
                            <div className="flex items-start justify-between">
                              <div className="flex items-start gap-3">
                                <div className="w-8 h-8 bg-navy/5 rounded-lg flex items-center justify-center mt-0.5">
                                  <Cpu size={14} className="text-navy" />
                                </div>
                                <div>
                                  <div className="text-sm font-medium text-text-primary">{device.manufacturer} {device.model}</div>
                                  <div className="text-xs text-text-secondary mt-0.5">{device.location} &middot; {device.purpose}</div>
                                  {device.operationNotes && <p className="text-xs text-text-secondary mt-2 leading-relaxed max-w-xl">{device.operationNotes}</p>}
                                  <div className="flex gap-3 mt-1.5">
                                    {device.ipAddress && <span className="text-xs font-mono text-text-secondary">IP: {device.ipAddress}</span>}
                                    {device.controlId && <span className="text-xs font-mono text-text-secondary">ID: {device.controlId}</span>}
                                    {device.serialNumber && <span className="text-xs font-mono text-text-secondary">S/N: {device.serialNumber}</span>}
                                  </div>
                                </div>
                              </div>
                              <button onClick={() => deleteDevice(manual.id, section.id, device.id)} className="p-1 rounded hover:bg-red-50 text-text-secondary hover:text-red-500"><Trash2 size={14} /></button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Section Modal */}
      <Modal open={showAddSection} onClose={() => setShowAddSection(false)} title="Add Manual Section">
        <form onSubmit={handleAddSection} className="space-y-4">
          <label className="block"><span className="text-sm font-medium">Section Title <span className="text-red-500">*</span></span><input value={sectionForm.title} onChange={(e) => setSectionForm({ ...sectionForm, title: e.target.value })} required className="input mt-1.5" /></label>
          <label className="block">
            <span className="text-sm font-medium">Section Type</span>
            <select value={sectionForm.type} onChange={(e) => setSectionForm({ ...sectionForm, type: e.target.value as ManualSectionType })} className="input mt-1.5">
              {sectionTypes.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <button type="button" onClick={() => setShowAddSection(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary">Add Section</button>
          </div>
        </form>
      </Modal>

      {/* Add Device Modal */}
      <Modal open={!!showAddDevice} onClose={() => setShowAddDevice(null)} title="Add Device" wide>
        <form onSubmit={handleAddDevice} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <label className="block"><span className="text-sm font-medium">Manufacturer <span className="text-red-500">*</span></span><input value={deviceForm.manufacturer} onChange={(e) => setDeviceForm({ ...deviceForm, manufacturer: e.target.value })} required className="input mt-1.5" /></label>
            <label className="block"><span className="text-sm font-medium">Model <span className="text-red-500">*</span></span><input value={deviceForm.model} onChange={(e) => setDeviceForm({ ...deviceForm, model: e.target.value })} required className="input mt-1.5" /></label>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <label className="block"><span className="text-sm font-medium">Location</span><input value={deviceForm.location} onChange={(e) => setDeviceForm({ ...deviceForm, location: e.target.value })} className="input mt-1.5" placeholder="Room / zone" /></label>
            <label className="block"><span className="text-sm font-medium">Serial Number</span><input value={deviceForm.serialNumber} onChange={(e) => setDeviceForm({ ...deviceForm, serialNumber: e.target.value })} className="input mt-1.5" /></label>
          </div>
          <label className="block"><span className="text-sm font-medium">System Role / Purpose</span><input value={deviceForm.purpose} onChange={(e) => setDeviceForm({ ...deviceForm, purpose: e.target.value })} className="input mt-1.5" placeholder='e.g. "Primary display processor — Conference Room B"' /></label>
          <label className="block"><span className="text-sm font-medium">Operation Notes</span><textarea value={deviceForm.operationNotes} onChange={(e) => setDeviceForm({ ...deviceForm, operationNotes: e.target.value })} rows={3} className="input mt-1.5" /></label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block"><span className="text-sm font-medium">IP Address</span><input value={deviceForm.ipAddress} onChange={(e) => setDeviceForm({ ...deviceForm, ipAddress: e.target.value })} className="input mt-1.5 font-mono" /></label>
            <label className="block"><span className="text-sm font-medium">Control ID</span><input value={deviceForm.controlId} onChange={(e) => setDeviceForm({ ...deviceForm, controlId: e.target.value })} className="input mt-1.5 font-mono" /></label>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <button type="button" onClick={() => setShowAddDevice(null)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary">Add Device</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
