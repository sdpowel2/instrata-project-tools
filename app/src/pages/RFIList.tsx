import { useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, MessageSquareWarning, Download, Search, FileText } from 'lucide-react';
import { useStore } from '../store';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { LocationProductPicker } from '../components/LocationProductPicker';
import { ProjectHeader } from '../components/ProjectHeader';
import { PhaseRibbon } from '../components/PhaseRibbon';
import { exportRFIPDF, exportRFILogPDF } from '../utils/exportRFIPDF';
import type { RFIStatus } from '../types';

export function RFIList() {
  const { projectId } = useParams();
  const allRfis = useStore((s) => s.rfis);
  const rfis = useMemo(() => allRfis.filter((x) => x.projectId === projectId), [allRfis, projectId]);
  const addRFI = useStore((s) => s.addRFI);
  const updateRFI = useStore((s) => s.updateRFI);
  const projectBoM = useStore((s) => s.projectBoM);
  const [showNew, setShowNew] = useState(false);
  const [showDetail, setShowDetail] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({
    subject: '', specSection: '', description: '', status: 'Open' as RFIStatus,
    responseDue: '', responseSummary: '', answeredBy: '',
    locationRef: undefined as string | undefined, productRef: undefined as string | undefined,
  });

  const filtered = rfis.filter((r) => {
    const matchStatus = statusFilter === 'All' || r.status === statusFilter;
    const matchSearch = !search || r.subject.toLowerCase().includes(search.toLowerCase()) || r.number.toLowerCase().includes(search.toLowerCase());
    return matchStatus && matchSearch;
  }).sort((a, b) => a.number.localeCompare(b.number));

  const isOverdue = (r: typeof rfis[0]) => r.status === 'Open' && new Date(r.responseDue) < new Date();

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    addRFI({ ...form, projectId: projectId! });
    setShowNew(false);
    setForm({ subject: '', specSection: '', description: '', status: 'Open', responseDue: '', responseSummary: '', answeredBy: '', locationRef: undefined, productRef: undefined });
  };

  const projects = useStore((s) => s.projects);
  const project = projects.find((p) => p.id === projectId);
  const selectedRFI = rfis.find((r) => r.id === showDetail);

  // ── CSV Export ──
  const handleExportCSV = () => {
    const headers = ['RFI #', 'Subject', 'Spec Section', 'Status', 'Response Due', 'Answered By', 'Answered At', 'Description', 'Response Summary'];
    const rows = rfis.map((r) => [
      r.number, r.subject, r.specSection, r.status, r.responseDue,
      r.answeredBy || '', r.answeredAt || '', r.description, r.responseSummary || '',
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RFI-Log-${project?.number || projectId}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  // Open + Answered RFIs are client-facing; Closed/Void stay internal-only.
  const openRFIs = rfis.filter((r) => r.status !== 'Closed' && r.status !== 'Void');

  const handleExportPDF = async () => {
    if (!project) return;
    try {
      await exportRFILogPDF(rfis, project);
    } catch (err) {
      console.error('RFI log PDF export failed:', err);
      alert(`PDF export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleExportRFI = async () => {
    if (!project || !selectedRFI) return;
    try {
      await exportRFIPDF(selectedRFI, project);
    } catch (err) {
      console.error('RFI PDF export failed:', err);
      alert(`PDF export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleAnswer = () => {
    if (!selectedRFI) return;
    updateRFI(selectedRFI.id, {
      status: 'Answered',
      answeredAt: new Date().toISOString().split('T')[0],
      answeredBy: selectedRFI.answeredBy || 'TBD',
      responseSummary: selectedRFI.responseSummary || '',
    });
  };

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      {project && <ProjectHeader project={project} />}
      {project && (
        <div className="mt-5">
          {/* RFIs straddle both phases — show the project's current phase. */}
          <PhaseRibbon phase={project.phase} toolLabel="RFIs" toolIcon={MessageSquareWarning} />
        </div>
      )}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-[22px] font-bold text-navy m-0">RFI Log</h2>
          <p className="text-[13px] text-fg-2 mt-1 m-0">Requests for information across this project.</p>
        </div>
        <div className="flex gap-3">
          <button onClick={handleExportCSV} className="btn-secondary text-sm"><Download size={14} /> Export CSV</button>
          <button
            onClick={handleExportPDF}
            disabled={openRFIs.length === 0}
            title={openRFIs.length === 0 ? 'No open RFIs to export' : `Export ${openRFIs.length} open RFI${openRFIs.length === 1 ? '' : 's'} as a client-facing PDF`}
            className="btn-secondary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FileText size={14} /> Export PDF
          </button>
          <button onClick={() => setShowNew(true)} className="btn-orange text-sm"><Plus size={16} /> New RFI</button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search RFIs..." className="w-full pl-10 pr-4 py-2 border border-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-navy/20" />
        </div>
        <div className="flex gap-2">
          {['All', 'Open', 'Answered', 'Closed', 'Void'].map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)} className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${statusFilter === s ? 'bg-navy text-white' : 'bg-white text-text-secondary border border-border hover:bg-surface'}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {rfis.length === 0 ? (
        <EmptyState
          icon={<MessageSquareWarning size={48} />}
          title="No RFIs yet"
          description="Create your first Request for Information to start tracking questions and responses."
          action={<button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={16} /> Create RFI</button>}
        />
      ) : (
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-navy text-white text-left">
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">RFI #</th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Subject</th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Spec Section</th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Related To</th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Status</th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Response Due</th>
                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Days Open</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((rfi, i) => {
                const daysOpen = Math.floor((Date.now() - new Date(rfi.createdAt).getTime()) / 86400000);
                const overdue = isOverdue(rfi);
                return (
                  <tr
                    key={rfi.id}
                    onClick={() => setShowDetail(rfi.id)}
                    className={`cursor-pointer hover:bg-surface/50 transition-colors ${i % 2 === 1 ? 'bg-surface/30' : ''} ${overdue ? 'border-l-4 border-l-red-500' : ''}`}
                  >
                    <td className="px-5 py-3 text-sm font-mono font-medium text-navy">{rfi.number}</td>
                    <td className="px-5 py-3 text-sm text-text-primary">{rfi.subject}</td>
                    <td className="px-5 py-3 text-sm text-text-secondary">{rfi.specSection || '—'}</td>
                    <td className="px-5 py-3 text-sm text-text-secondary">{(() => { const prod = rfi.productRef ? projectBoM.find(b => b.id === rfi.productRef) : undefined; return prod ? `${prod.manufacturer} ${prod.model}` : rfi.locationRef || '—'; })()}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={overdue ? 'Overdue' : rfi.status} />
                    </td>
                    <td className="px-5 py-3 text-sm text-text-secondary">{rfi.responseDue}</td>
                    <td className="px-5 py-3 text-sm text-text-secondary">{rfi.status === 'Open' || rfi.status === 'Answered' ? `${daysOpen}d` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-5 py-3 bg-surface/50 border-t border-border text-sm text-text-secondary">
            {filtered.length} RFIs &middot; {filtered.filter((r) => r.status === 'Open').length} open &middot; {filtered.filter((r) => isOverdue(r)).length} overdue
          </div>
        </div>
      )}

      {/* New RFI Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New RFI" wide>
        <form onSubmit={handleCreate} className="space-y-4">
          <LocationProductPicker
            projectId={projectId!}
            selectedLocation={form.locationRef}
            selectedProduct={form.productRef}
            onLocationChange={(loc) => setForm({ ...form, locationRef: loc })}
            onProductChange={(pid) => setForm({ ...form, productRef: pid })}
          />
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Subject <span className="text-red-500">*</span></span>
            <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required className="input mt-1.5" />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm font-medium text-text-primary">Spec Section / Drawing Ref</span>
              <input value={form.specSection} onChange={(e) => setForm({ ...form, specSection: e.target.value })} className="input mt-1.5" />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-text-primary">Requested Response Date <span className="text-red-500">*</span></span>
              <input type="date" value={form.responseDue} onChange={(e) => setForm({ ...form, responseDue: e.target.value })} required className="input mt-1.5" />
            </label>
          </div>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Question / Description <span className="text-red-500">*</span></span>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required rows={4} className="input mt-1.5" />
          </label>
          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <button type="button" onClick={() => setShowNew(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary">Create RFI</button>
          </div>
        </form>
      </Modal>

      {/* RFI Detail Modal */}
      <Modal open={!!showDetail} onClose={() => setShowDetail(null)} title={selectedRFI ? `${selectedRFI.number}: ${selectedRFI.subject}` : ''} wide>
        {selectedRFI && (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <StatusBadge status={isOverdue(selectedRFI) ? 'Overdue' : selectedRFI.status} />
              <span className="text-sm text-text-secondary">Created {selectedRFI.createdAt}</span>
              {selectedRFI.specSection && <span className="text-sm text-text-secondary">&middot; {selectedRFI.specSection}</span>}
            </div>

            {(selectedRFI.locationRef || selectedRFI.productRef) && (
              <div className="flex items-center gap-2">
                {selectedRFI.locationRef && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-50 text-blue-700 text-xs font-medium rounded-full">
                    📍 {selectedRFI.locationRef}
                  </span>
                )}
                {selectedRFI.productRef && (() => {
                  const prod = projectBoM.find(b => b.id === selectedRFI.productRef);
                  return prod ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-50 text-amber-700 text-xs font-medium rounded-full">
                      📦 {prod.manufacturer} {prod.model}
                    </span>
                  ) : null;
                })()}
              </div>
            )}

            <div>
              <div className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1">Question</div>
              <p className="text-sm text-text-primary leading-relaxed bg-surface rounded-lg p-4">{selectedRFI.description}</p>
            </div>

            <div className="text-sm text-text-secondary">Response due: <span className={`font-medium ${isOverdue(selectedRFI) ? 'text-red-600' : 'text-text-primary'}`}>{selectedRFI.responseDue}</span></div>

            {selectedRFI.status === 'Answered' && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="text-xs font-semibold text-green-700 uppercase tracking-wider mb-1">Response</div>
                <p className="text-sm text-text-primary">{selectedRFI.responseSummary}</p>
                <div className="text-xs text-text-secondary mt-2">Answered by {selectedRFI.answeredBy} on {selectedRFI.answeredAt}</div>
              </div>
            )}

            {selectedRFI.status === 'Open' && (
              <div className="border-t border-border pt-4">
                <div className="text-sm font-semibold text-navy mb-3">Record Response</div>
                <label className="block mb-3">
                  <span className="text-sm font-medium text-text-primary">Response Summary</span>
                  <textarea
                    value={selectedRFI.responseSummary || ''}
                    onChange={(e) => updateRFI(selectedRFI.id, { responseSummary: e.target.value })}
                    rows={3} className="input mt-1.5"
                  />
                </label>
                <label className="block mb-3">
                  <span className="text-sm font-medium text-text-primary">Answered By</span>
                  <input
                    value={selectedRFI.answeredBy || ''}
                    onChange={(e) => updateRFI(selectedRFI.id, { answeredBy: e.target.value })}
                    className="input mt-1.5"
                  />
                </label>
                <button onClick={handleAnswer} className="btn-primary text-sm">Mark as Answered</button>
              </div>
            )}

            <div className="flex justify-between pt-4 border-t border-border">
              <button onClick={handleExportRFI} className="btn-secondary text-sm"><Download size={14} /> Export PDF</button>
              <div className="flex gap-2">
                {selectedRFI.status !== 'Closed' && selectedRFI.status !== 'Void' && (
                  <>
                    <button onClick={() => { updateRFI(selectedRFI.id, { status: 'Closed' }); setShowDetail(null); }} className="btn-secondary text-sm">Close</button>
                    <button onClick={() => { updateRFI(selectedRFI.id, { status: 'Void' }); setShowDetail(null); }} className="btn-secondary text-sm text-gray-400">Void</button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
