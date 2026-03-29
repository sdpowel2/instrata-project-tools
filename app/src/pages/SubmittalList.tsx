import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, FileText } from 'lucide-react';
import { useStore } from '../store';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import type { SubmittalStatus } from '../types';

export function SubmittalList() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const allSubmittals = useStore((s) => s.submittals);
  const submittals = useMemo(() => allSubmittals.filter((x) => x.projectId === projectId), [allSubmittals, projectId]);
  const addSubmittal = useStore((s) => s.addSubmittal);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ title: '', revision: 'Rev 0', preparedBy: '', submittedTo: '', status: 'Draft' as SubmittalStatus, notes: '' });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const id = addSubmittal({ ...form, projectId: projectId! });
    setShowNew(false);
    setForm({ title: '', revision: 'Rev 0', preparedBy: '', submittedTo: '', status: 'Draft', notes: '' });
    navigate(`/projects/${projectId}/submittals/${id}`);
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-navy">Submittals</h2>
        <button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={16} /> New Submittal</button>
      </div>

      {submittals.length === 0 ? (
        <EmptyState
          icon={<FileText size={48} />}
          title="No submittals yet"
          description="Create your first submittal package to get started with equipment documentation."
          action={<button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={16} /> Create Submittal</button>}
        />
      ) : (
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-navy text-white text-left">
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider">Title</th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider">Revision</th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider">Items</th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wider">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {submittals.map((sub, i) => (
                <tr
                  key={sub.id}
                  onClick={() => navigate(`/projects/${projectId}/submittals/${sub.id}`)}
                  className={`cursor-pointer hover:bg-surface/50 transition-colors ${i % 2 === 1 ? 'bg-surface/30' : ''}`}
                >
                  <td className="px-6 py-4 text-sm font-medium text-text-primary">{sub.title}</td>
                  <td className="px-6 py-4 text-sm font-mono text-text-secondary">{sub.revision}</td>
                  <td className="px-6 py-4 text-sm text-text-secondary">{sub.items.length} items</td>
                  <td className="px-6 py-4"><StatusBadge status={sub.status} /></td>
                  <td className="px-6 py-4 text-sm text-text-secondary">{sub.createdAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Submittal">
        <form onSubmit={handleCreate} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Submittal Title <span className="text-red-500">*</span></span>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required className="input mt-1.5" />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm font-medium text-text-primary">Revision</span>
              <input value={form.revision} onChange={(e) => setForm({ ...form, revision: e.target.value })} className="input mt-1.5" />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-text-primary">Status</span>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as SubmittalStatus })} className="input mt-1.5">
                <option>Draft</option>
                <option>Submitted</option>
                <option>Approved</option>
                <option>Revise & Resubmit</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Prepared By <span className="text-red-500">*</span></span>
            <input value={form.preparedBy} onChange={(e) => setForm({ ...form, preparedBy: e.target.value })} required className="input mt-1.5" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Submitted To <span className="text-red-500">*</span></span>
            <input value={form.submittedTo} onChange={(e) => setForm({ ...form, submittedTo: e.target.value })} required className="input mt-1.5" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Notes</span>
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} className="input mt-1.5" />
          </label>
          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <button type="button" onClick={() => setShowNew(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary">Create Submittal</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
