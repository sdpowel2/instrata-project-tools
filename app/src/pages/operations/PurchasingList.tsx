// Purchasing — module list page. One project can have many purchasing
// modules (one per submittal, or aggregated). Click into a module → detail.
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Truck, Plus, FileText, Trash2, ChevronRight } from 'lucide-react';
import { useStore } from '../../store';
import { ProjectHeader } from '../../components/ProjectHeader';
import { PhaseRibbon } from '../../components/PhaseRibbon';
import { Modal } from '../../components/Modal';
import { computePurchaseSummary } from '../../utils/purchasing';

export function PurchasingListPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const allModules = useStore((s) => s.purchasingModules);
  const allSubmittals = useStore((s) => s.submittals);
  const purchasingItems = useStore((s) => s.purchasingItems);
  const addModule = useStore((s) => s.addPurchasingModule);
  const deleteModule = useStore((s) => s.deletePurchasingModule);

  const modules = useMemo(
    () => allModules.filter((m) => m.projectId === projectId)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    [allModules, projectId],
  );
  const submittals = useMemo(
    () => allSubmittals.filter((s) => s.projectId === projectId),
    [allSubmittals, projectId],
  );

  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<{ title: string; submittalId: string }>({
    title: '', submittalId: '',
  });

  if (!project) return null;

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.submittalId) return;
    const sub = submittals.find((s) => s.id === form.submittalId);
    const title = form.title.trim() || (sub ? `Purchasing — ${sub.title}` : 'Purchasing');
    const id = addModule({
      projectId: projectId!,
      title,
      submittalIds: [form.submittalId],
    });
    setShowNew(false);
    setForm({ title: '', submittalId: '' });
    navigate(`/projects/${projectId}/purchasing/${id}`);
  };

  const handleDelete = (id: string, title: string) => {
    if (window.confirm(`Delete "${title || 'purchasing module'}"? This won't undo any orders already placed externally.`)) {
      deleteModule(id);
    }
  };

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <ProjectHeader project={project} />
      <div className="mt-5.5" style={{ marginTop: 22 }}>
        <PhaseRibbon phase="Operations" toolLabel="Purchasing" toolIcon={Truck} />
      </div>

      <div className="flex items-end justify-between mb-5">
        <div>
          <h2 className="text-2xl font-bold text-navy m-0">Purchasing</h2>
          <p className="text-sm text-fg-2 mt-1 m-0">
            Convert approved submittal items into purchase orders, tracked through receipt at the warehouse.
          </p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          disabled={submittals.length === 0}
          className="btn-orange text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          title={submittals.length === 0 ? 'Create a submittal first to start a purchasing module' : ''}
        >
          <Plus size={16} /> New Purchasing Module
        </button>
      </div>

      {modules.length === 0 ? (
        <div className="bg-white border border-border rounded-xl px-6 py-14 text-center shadow-sm">
          <div className="text-border mb-3.5 flex justify-center">
            <Truck size={44} />
          </div>
          <div className="text-base font-semibold text-navy">No purchasing modules yet</div>
          <div className="text-[13px] text-fg-2 mt-1.5 max-w-[460px] mx-auto">
            {submittals.length === 0
              ? 'Create a submittal first — purchasing modules link to one or more submittals to pull in their items.'
              : 'Start a purchasing module by linking it to one of this project\u2019s submittals.'}
          </div>
          {submittals.length > 0 && (
            <button onClick={() => setShowNew(true)} className="btn-primary text-sm mt-5">
              <Plus size={14} /> Start a Purchasing Module
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
          {modules.map((m, i) => {
            const linkedSubs = m.submittalIds
              .map((sid) => allSubmittals.find((s) => s.id === sid))
              .filter(Boolean) as typeof allSubmittals;
            const summary = computePurchaseSummary(m.id, linkedSubs, purchasingItems);
            return (
              <button
                key={m.id}
                onClick={() => navigate(`/projects/${projectId}/purchasing/${m.id}`)}
                className={`w-full flex items-center gap-3.5 px-5 py-4 text-left transition-colors hover:bg-surface/60 ${i === 0 ? '' : 'border-t border-border'}`}
              >
                <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#22C55E14', color: '#22C55E' }}>
                  <Truck size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-fg truncate">{m.title || 'Untitled module'}</div>
                  <div className="text-xs text-fg-2 mt-0.5 truncate">
                    {linkedSubs.length === 0
                      ? 'No submittals linked'
                      : linkedSubs.map((s) => s.title).join(' · ')}
                  </div>
                </div>
                <div className="flex items-center gap-5 text-[12px] text-fg-2">
                  <span>{summary.totalItems} items</span>
                  <span><strong className="text-navy">{summary.notOrdered}</strong> to order</span>
                  <span><strong className="text-blue-700">{summary.ordered}</strong> ordered</span>
                  <span><strong className="text-green-700">{summary.received}</strong> received</span>
                  {summary.warningCount > 0 && (
                    <span className="inline-flex items-center gap-1 text-red-700 font-semibold">
                      ⚠ {summary.warningCount}
                    </span>
                  )}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(m.id, m.title); }}
                  title="Delete"
                  className="p-1.5 rounded-md text-fg-2 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 size={13} />
                </button>
                <ChevronRight size={14} className="text-fg-2" />
              </button>
            );
          })}
        </div>
      )}

      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Purchasing Module">
        <form onSubmit={create} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Link to Submittal <span className="text-red-500">*</span></span>
            <select
              required value={form.submittalId}
              onChange={(e) => setForm({ ...form, submittalId: e.target.value })}
              className="input mt-1.5"
            >
              <option value="">Choose a submittal…</option>
              {submittals.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} {s.revision ? `(${s.revision})` : ''} — {s.status}
                </option>
              ))}
            </select>
            <span className="text-xs text-fg-2 mt-1.5 inline-flex items-center gap-1">
              <FileText size={11} />
              You can link more submittals after the module is created.
            </span>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-text-primary">Module Title</span>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="input mt-1.5"
              placeholder="Defaults to the submittal title"
            />
          </label>
          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <button type="button" onClick={() => setShowNew(false)} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" className="btn-primary text-sm">Create Module</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
