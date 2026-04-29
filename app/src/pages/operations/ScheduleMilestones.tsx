// Schedule & Milestones — primary post-sales PM tool. Surfaces project-level
// (contractual) and phase-level (operational) checkpoints in a unified list,
// with a read-only timeline toggle for awareness. Phase 1 scope per the
// milestone-tracking spec — Gantt editing belongs in the Gantt module
// (Phase 2), CO-linked milestones land with change orders later.
import { useMemo, useState } from 'react';
import {
  Calendar, Plus, Check, Pencil, Trash2, AlertTriangle, Clock,
  CheckCircle2, CircleDashed, LayoutList, GanttChart, Sparkles,
} from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useStore } from '../../store';
import { ProjectHeader } from '../../components/ProjectHeader';
import { PhaseRibbon } from '../../components/PhaseRibbon';
import { Modal } from '../../components/Modal';
import {
  MILESTONE_TYPES, computeMilestoneStatus,
  type ProjectMilestone, type MilestoneStatus, type MilestoneType, type MilestoneTier,
} from '../../types';
import { generateFromTemplate } from '../../utils/milestoneTemplates';

type ViewMode = 'list' | 'timeline';

interface FormState {
  id?: string;
  title: string;
  milestoneType: MilestoneType;
  tier: MilestoneTier;
  phase: string;
  dueDate: string;
  notes: string;
}

const blankForm = (): FormState => ({
  title: '',
  milestoneType: 'submittal_due',
  tier: 'project',
  phase: '',
  dueDate: new Date().toISOString().slice(0, 10),
  notes: '',
});

export function ScheduleMilestonesPage() {
  const { projectId } = useParams();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const allMilestones = useStore((s) => s.milestones);
  const addMilestone = useStore((s) => s.addMilestone);
  const updateMilestone = useStore((s) => s.updateMilestone);
  const deleteMilestone = useStore((s) => s.deleteMilestone);
  const markMilestoneComplete = useStore((s) => s.markMilestoneComplete);
  const addMilestonesBatch = useStore((s) => s.addMilestonesBatch);

  const milestones = useMemo(
    () => allMilestones.filter((m) => m.projectId === projectId)
      .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || '')),
    [allMilestones, projectId],
  );

  const [view, setView] = useState<ViewMode>('list');
  const [showForm, setShowForm] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm());
  const [completePrompt, setCompletePrompt] = useState<{ id: string; title: string } | null>(null);
  const [completeNote, setCompleteNote] = useState('');
  const [templateStart, setTemplateStart] = useState(() => new Date().toISOString().slice(0, 10));

  if (!project) return null;

  const projectTier = milestones.filter((m) => m.tier === 'project');
  const phaseTier   = milestones.filter((m) => m.tier === 'phase');

  const completed = milestones.filter((m) => m.completedDate).length;
  const total = milestones.length;
  const pct = total ? Math.round((completed / total) * 100) : 0;
  const overdue = milestones.filter((m) => computeMilestoneStatus(m) === 'overdue').length;
  const atRisk  = milestones.filter((m) => computeMilestoneStatus(m) === 'at_risk').length;

  const openNew = (tier: MilestoneTier = 'project') => {
    const seed = blankForm();
    seed.tier = tier;
    seed.milestoneType = tier === 'phase' ? 'rough_in_complete' : 'submittal_due';
    seed.title = MILESTONE_TYPES.find((t) => t.value === seed.milestoneType)?.label ?? '';
    setForm(seed);
    setShowForm(true);
  };

  const openEdit = (m: ProjectMilestone) => {
    setForm({
      id: m.id,
      title: m.title,
      milestoneType: m.milestoneType,
      tier: m.tier,
      phase: m.phase ?? '',
      dueDate: m.dueDate,
      notes: m.notes,
    });
    setShowForm(true);
  };

  const onTypeChange = (t: MilestoneType) => {
    const def = MILESTONE_TYPES.find((x) => x.value === t);
    setForm((f) => ({
      ...f,
      milestoneType: t,
      tier: def?.tier ?? f.tier,
      title: f.title.trim() === '' || isAnyTypeLabel(f.title) ? def?.label ?? f.title : f.title,
    }));
  };

  const submitForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.id) {
      updateMilestone(form.id, {
        title: form.title.trim() || (MILESTONE_TYPES.find((t) => t.value === form.milestoneType)?.label ?? ''),
        milestoneType: form.milestoneType,
        tier: form.tier,
        phase: form.tier === 'phase' ? (form.phase || 'all') : undefined,
        dueDate: form.dueDate,
        notes: form.notes,
      });
    } else {
      addMilestone({
        projectId: projectId!,
        title: form.title.trim() || (MILESTONE_TYPES.find((t) => t.value === form.milestoneType)?.label ?? ''),
        description: '',
        milestoneType: form.milestoneType,
        tier: form.tier,
        phase: form.tier === 'phase' ? (form.phase || 'all') : undefined,
        dueDate: form.dueDate,
        notes: form.notes,
      });
    }
    setShowForm(false);
    setForm(blankForm());
  };

  const submitComplete = () => {
    if (!completePrompt) return;
    markMilestoneComplete(completePrompt.id, completeNote.trim() || undefined);
    setCompletePrompt(null);
    setCompleteNote('');
  };

  const applyTemplate = () => {
    const items = generateFromTemplate(projectId!, templateStart);
    addMilestonesBatch(items);
    setShowTemplate(false);
  };

  const handleDelete = (m: ProjectMilestone) => {
    if (window.confirm(`Delete "${m.title}"? This can't be undone.`)) {
      deleteMilestone(m.id);
    }
  };

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <ProjectHeader project={project} />

      <div className="mt-5.5" style={{ marginTop: 22 }}>
        <PhaseRibbon phase="Operations" toolLabel="Schedule & Milestones" toolIcon={Calendar} />
      </div>

      <div className="flex items-end justify-between mb-5 gap-4">
        <div>
          <h2 className="text-2xl font-bold text-navy m-0">Schedule &amp; Milestones</h2>
          <p className="text-sm text-fg-2 mt-1 m-0">
            Project dates that drive purchasing, field deployment, and closeout.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle view={view} onChange={setView} />
          {milestones.length > 0 && (
            <button
              onClick={() => setShowTemplate(true)}
              className="btn-secondary text-sm"
              title="Generate the default Commercial AV milestone set"
            >
              <Sparkles size={14} /> Apply Template
            </button>
          )}
          <button onClick={() => openNew('project')} className="btn-orange text-sm">
            <Plus size={16} /> Add Milestone
          </button>
        </div>
      </div>

      {milestones.length === 0 ? (
        <EmptyMilestoneState
          onAdd={() => openNew('project')}
          onTemplate={() => setShowTemplate(true)}
        />
      ) : (
        <>
          {/* Progress strip */}
          <div
            className="bg-white border border-border rounded-xl px-5.5 py-4.5 shadow-sm mb-5"
            style={{ paddingLeft: 22, paddingRight: 22 }}
          >
            <div className="flex items-center justify-between mb-2.5">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-2">
                  Project Schedule
                </div>
                <div className="text-sm text-fg mt-1">
                  <strong style={{ color: '#15803D' }}>{completed}</strong> of {total} milestones complete
                  {overdue > 0 && (
                    <span className="ml-3 inline-flex items-center gap-1 text-red-700 font-semibold">
                      <AlertTriangle size={12} /> {overdue} overdue
                    </span>
                  )}
                  {atRisk > 0 && (
                    <span className="ml-3 inline-flex items-center gap-1 text-amber-700 font-semibold">
                      <Clock size={12} /> {atRisk} at risk
                    </span>
                  )}
                </div>
              </div>
              <div className="text-2xl font-bold text-navy font-mono">{pct}%</div>
            </div>
            <div className="h-2 bg-gray-100 rounded overflow-hidden">
              <div
                className="h-full transition-[width]"
                style={{
                  width: `${pct}%`,
                  background: 'linear-gradient(90deg, #15803D 0%, #22C55E 100%)',
                }}
              />
            </div>
          </div>

          {view === 'list' ? (
            <div className="flex flex-col gap-5">
              <MilestoneSection
                title="Project Milestones"
                subtitle="Contractual dates and major handoffs."
                tier="project"
                milestones={projectTier}
                onEdit={openEdit}
                onComplete={(m) => setCompletePrompt({ id: m.id, title: m.title })}
                onDelete={handleDelete}
                onAdd={() => openNew('project')}
              />
              <MilestoneSection
                title="Phase Milestones"
                subtitle="Operational checkpoints tied to installation phases."
                tier="phase"
                milestones={phaseTier}
                onEdit={openEdit}
                onComplete={(m) => setCompletePrompt({ id: m.id, title: m.title })}
                onDelete={handleDelete}
                onAdd={() => openNew('phase')}
              />
            </div>
          ) : (
            <TimelineView milestones={milestones} onSelect={openEdit} />
          )}
        </>
      )}

      {/* Add / Edit modal */}
      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={form.id ? 'Edit Milestone' : 'Add Milestone'}
      >
        <form onSubmit={submitForm} className="space-y-4">
          <Field label="Milestone Type" required>
            <select
              className="input"
              value={form.milestoneType}
              onChange={(e) => onTypeChange(e.target.value as MilestoneType)}
            >
              <optgroup label="Contractual / Project">
                {MILESTONE_TYPES.filter((t) => t.tier === 'project').map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </optgroup>
              <optgroup label="Operational / Phase">
                {MILESTONE_TYPES.filter((t) => t.tier === 'phase').map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field label="Title" required>
            <input
              className="input" required
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="What this milestone tracks"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Tier">
              <select
                className="input"
                value={form.tier}
                onChange={(e) => setForm((f) => ({ ...f, tier: e.target.value as MilestoneTier }))}
              >
                <option value="project">Project</option>
                <option value="phase">Phase</option>
              </select>
            </Field>
            <Field label="Due Date" required>
              <input
                type="date" className="input" required
                value={form.dueDate}
                onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
              />
            </Field>
          </div>
          {form.tier === 'phase' && (
            <Field label="Phase">
              <input
                className="input"
                value={form.phase}
                onChange={(e) => setForm((f) => ({ ...f, phase: e.target.value }))}
                placeholder="e.g. Floor 2, Wing A, all"
              />
            </Field>
          )}
          <Field label="Notes">
            <textarea
              className="input" rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Optional context"
            />
          </Field>
          <div className="flex justify-between pt-3 border-t border-border">
            <div>
              {form.id && (
                <button
                  type="button"
                  onClick={() => {
                    const m = milestones.find((x) => x.id === form.id);
                    if (m) {
                      setShowForm(false);
                      handleDelete(m);
                    }
                  }}
                  className="btn-secondary text-sm text-red-600"
                >
                  <Trash2 size={14} /> Delete
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowForm(false)} className="btn-secondary text-sm">
                Cancel
              </button>
              <button type="submit" className="btn-primary text-sm">
                {form.id ? 'Save Changes' : 'Add Milestone'}
              </button>
            </div>
          </div>
        </form>
      </Modal>

      {/* Mark complete modal */}
      <Modal
        open={completePrompt !== null}
        onClose={() => { setCompletePrompt(null); setCompleteNote(''); }}
        title="Mark Milestone Complete"
      >
        <div className="space-y-4">
          <div className="text-sm text-fg">
            Mark <strong>{completePrompt?.title}</strong> as complete? Today's date will be recorded
            as the completion date.
          </div>
          <Field label="Completion Note (optional)">
            <textarea
              className="input" rows={3}
              value={completeNote}
              onChange={(e) => setCompleteNote(e.target.value)}
              placeholder="Any context to log alongside the completion"
            />
          </Field>
          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <button
              onClick={() => { setCompletePrompt(null); setCompleteNote(''); }}
              className="btn-secondary text-sm"
            >Cancel</button>
            <button onClick={submitComplete} className="btn-primary text-sm">
              <Check size={14} /> Mark Complete
            </button>
          </div>
        </div>
      </Modal>

      {/* Apply template modal */}
      <Modal
        open={showTemplate}
        onClose={() => setShowTemplate(false)}
        title="Apply Default Commercial AV Template"
      >
        <div className="space-y-4">
          <div className="text-sm text-fg-2">
            Generates 12 milestones spanning submittal, install, and closeout — all anchored
            off the project start date below. Every date is editable after generation.
          </div>
          <Field label="Project Start Date" required>
            <input
              type="date" className="input"
              value={templateStart}
              onChange={(e) => setTemplateStart(e.target.value)}
            />
          </Field>
          {milestones.length > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              This project already has {milestones.length} milestone{milestones.length === 1 ? '' : 's'} —
              applying the template will add 12 more. Existing milestones won't be touched.
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <button onClick={() => setShowTemplate(false)} className="btn-secondary text-sm">
              Cancel
            </button>
            <button onClick={applyTemplate} className="btn-primary text-sm">
              <Sparkles size={14} /> Generate
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// =============================================================================
// View toggle
// =============================================================================

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="inline-flex border border-border rounded-lg overflow-hidden bg-white text-xs">
      <button
        onClick={() => onChange('list')}
        className={`px-3 py-2 inline-flex items-center gap-1.5 transition-colors ${
          view === 'list' ? 'bg-navy text-white' : 'text-fg-2 hover:bg-surface'
        }`}
      >
        <LayoutList size={13} /> List
      </button>
      <button
        onClick={() => onChange('timeline')}
        className={`px-3 py-2 inline-flex items-center gap-1.5 transition-colors border-l border-border ${
          view === 'timeline' ? 'bg-navy text-white' : 'text-fg-2 hover:bg-surface'
        }`}
      >
        <GanttChart size={13} /> Timeline
      </button>
    </div>
  );
}

// =============================================================================
// Sectioned list — Project / Phase
// =============================================================================

interface SectionProps {
  title: string;
  subtitle: string;
  tier: MilestoneTier;
  milestones: ProjectMilestone[];
  onEdit: (m: ProjectMilestone) => void;
  onComplete: (m: ProjectMilestone) => void;
  onDelete: (m: ProjectMilestone) => void;
  onAdd: () => void;
}

function MilestoneSection({ title, subtitle, tier, milestones, onEdit, onComplete, onDelete, onAdd }: SectionProps) {
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div
        className="px-5.5 py-3.5 border-b border-border flex items-center justify-between"
        style={{ paddingLeft: 22, paddingRight: 22 }}
      >
        <div>
          <div className="text-[13px] font-semibold text-navy">{title}</div>
          <div className="text-xs text-fg-2 mt-0.5">{subtitle}</div>
        </div>
        <button onClick={onAdd} className="btn-secondary text-xs">
          <Plus size={12} /> Add
        </button>
      </div>

      {milestones.length === 0 ? (
        <div className="px-6 py-10 text-center text-sm text-fg-2">
          No {tier === 'project' ? 'contractual' : 'operational'} milestones yet.
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-fg-2 bg-surface/40">
              <th className="px-5 py-2.5 font-semibold w-[110px]">Status</th>
              <th className="px-3 py-2.5 font-semibold">Milestone</th>
              {tier === 'phase' && <th className="px-3 py-2.5 font-semibold w-[110px]">Phase</th>}
              <th className="px-3 py-2.5 font-semibold w-[120px]">Due</th>
              <th className="px-3 py-2.5 font-semibold w-[120px]">Completed</th>
              <th className="px-5 py-2.5 font-semibold w-[150px] text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {milestones.map((m) => {
              const status = computeMilestoneStatus(m);
              const overdue = status === 'overdue';
              return (
                <tr
                  key={m.id}
                  className={`hover:bg-surface/40 transition-colors ${overdue ? 'border-l-4 border-l-red-500' : ''}`}
                >
                  <td className="px-5 py-3"><MilestoneStatusBadge status={status} /></td>
                  <td className="px-3 py-3">
                    <div className="text-sm font-semibold text-fg">{m.title}</div>
                    {m.description && (
                      <div className="text-xs text-fg-2 mt-0.5">{m.description}</div>
                    )}
                  </td>
                  {tier === 'phase' && (
                    <td className="px-3 py-3 text-xs text-fg-2">{m.phase || 'all'}</td>
                  )}
                  <td className="px-3 py-3 font-mono text-[13px] text-fg-2">{m.dueDate || '—'}</td>
                  <td className="px-3 py-3 font-mono text-[13px] text-fg-2">{m.completedDate || '—'}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      {!m.completedDate && (
                        <button
                          onClick={() => onComplete(m)}
                          className="px-2 py-1 text-xs font-medium rounded-md text-green-700 hover:bg-green-50"
                          title="Mark complete"
                        >
                          <Check size={13} />
                        </button>
                      )}
                      <button
                        onClick={() => onEdit(m)}
                        className="px-2 py-1 text-xs font-medium rounded-md text-fg-2 hover:bg-surface"
                        title="Edit"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => onDelete(m)}
                        className="px-2 py-1 text-xs font-medium rounded-md text-fg-2 hover:bg-red-50 hover:text-red-600"
                        title="Delete"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// =============================================================================
// Status badge
// =============================================================================

const STATUS_STYLE: Record<MilestoneStatus, { bg: string; fg: string; label: string; Icon: typeof Check }> = {
  upcoming: { bg: '#F3F4F6',                       fg: '#4B5563', label: 'Upcoming', Icon: CircleDashed },
  at_risk:  { bg: '#FEF3C7',                       fg: '#A16207', label: 'At Risk',  Icon: Clock },
  overdue:  { bg: '#FEE2E2',                       fg: '#B91C1C', label: 'Overdue',  Icon: AlertTriangle },
  complete: { bg: '#DCFCE7',                       fg: '#15803D', label: 'Complete', Icon: CheckCircle2 },
};

function MilestoneStatusBadge({ status }: { status: MilestoneStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.fg }}
    >
      <s.Icon size={11} /> {s.label}
    </span>
  );
}

// =============================================================================
// Timeline view — read-only diamonds on a horizontal axis
// =============================================================================

function TimelineView({ milestones, onSelect }: { milestones: ProjectMilestone[]; onSelect: (m: ProjectMilestone) => void }) {
  // Earliest milestone date → latest + 14d buffer
  const dated = milestones.filter((m) => m.dueDate);
  if (dated.length === 0) {
    return (
      <div className="bg-white border border-border rounded-xl px-6 py-14 text-center shadow-sm text-sm text-fg-2">
        No dated milestones yet.
      </div>
    );
  }
  const dates = dated.map((m) => new Date(m.dueDate + 'T00:00:00').getTime());
  const min = Math.min(...dates);
  const max = Math.max(...dates) + 14 * 86400000;
  const today = Date.now();
  const span = Math.max(max - min, 86400000); // avoid divide-by-zero

  const pos = (t: number) => `${((t - min) / span) * 100}%`;

  const groups: { label: string; items: ProjectMilestone[] }[] = [
    { label: 'Project',   items: milestones.filter((m) => m.tier === 'project') },
    { label: 'Phase',     items: milestones.filter((m) => m.tier === 'phase') },
  ];

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-5.5 py-3.5 border-b border-border" style={{ paddingLeft: 22, paddingRight: 22 }}>
        <div className="text-[13px] font-semibold text-navy">Timeline</div>
        <div className="text-xs text-fg-2 mt-0.5">
          Read-only awareness view. Click a milestone to open it.
        </div>
      </div>
      <div className="p-6">
        {/* Today marker + axis */}
        <div className="relative h-3 mb-1">
          {today >= min && today <= max && (
            <div
              className="absolute top-0 bottom-0 border-l-2 border-orange"
              style={{ left: pos(today) }}
              title="Today"
            >
              <span className="absolute -top-5 left-1 text-[10px] font-bold uppercase tracking-wider text-orange">Today</span>
            </div>
          )}
        </div>
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="text-[10px] font-bold tracking-[0.15em] uppercase text-fg-2 mb-2">
                {g.label}
              </div>
              <div className="relative h-12 bg-surface/50 border border-border rounded-md">
                {today >= min && today <= max && (
                  <div className="absolute top-0 bottom-0 border-l-2 border-orange/60" style={{ left: pos(today) }} />
                )}
                {g.items.map((m) => {
                  if (!m.dueDate) return null;
                  const t = new Date(m.dueDate + 'T00:00:00').getTime();
                  const status = computeMilestoneStatus(m);
                  const color = STATUS_STYLE[status].fg;
                  return (
                    <button
                      key={m.id}
                      onClick={() => onSelect(m)}
                      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 group"
                      style={{ left: pos(t) }}
                      title={`${m.title} · ${m.dueDate}${m.completedDate ? ` · completed ${m.completedDate}` : ''}`}
                    >
                      <span
                        className="block w-3 h-3 rotate-45 border-2 bg-white"
                        style={{
                          borderColor: color,
                          background: status === 'complete' ? color : '#fff',
                        }}
                      />
                      <span
                        className="absolute left-1/2 -translate-x-1/2 top-5 whitespace-nowrap text-[10px] text-fg-2 group-hover:text-navy transition-colors"
                      >
                        {m.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Empty state
// =============================================================================

function EmptyMilestoneState({ onAdd, onTemplate }: { onAdd: () => void; onTemplate: () => void }) {
  return (
    <div className="bg-white border border-border rounded-xl px-6 py-14 text-center shadow-sm">
      <div className="text-border mb-3.5 flex justify-center">
        <Calendar size={44} />
      </div>
      <div className="text-base font-semibold text-navy">No milestones yet</div>
      <div className="text-[13px] text-fg-2 mt-1.5 max-w-[460px] mx-auto">
        Add milestones to anchor purchasing and field deployment dates, or apply the default
        Commercial AV template to spin up a full set in one click.
      </div>
      <div className="mt-5 inline-flex items-center gap-2.5">
        <button onClick={onTemplate} className="btn-primary text-sm">
          <Sparkles size={14} /> Apply Template
        </button>
        <button onClick={onAdd} className="btn-secondary text-sm">
          <Plus size={14} /> Add One Manually
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Local helpers
// =============================================================================

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-fg">
        {label}{required && <span className="text-red-500"> *</span>}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

/** True when the title currently matches one of the canonical type labels — so
 *  we can safely auto-replace it when the user changes the type. Custom titles
 *  (anything the user typed) are preserved. */
function isAnyTypeLabel(title: string): boolean {
  const t = title.trim();
  return MILESTONE_TYPES.some((d) => d.label === t);
}
