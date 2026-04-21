import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  FileText, MessageSquareWarning, ClipboardCheck, BookOpen,
  Upload, Plus, Package, RefreshCw, Loader2, Check,
  ScanLine, Scale, ChevronRight, Users,
} from 'lucide-react';
import { useStore } from '../store';
import { Modal } from '../components/Modal';
import { CSVImportModal, type ImportedItem } from '../components/CSVImportModal';
import { ProjectHeader } from '../components/ProjectHeader';
import { Eyebrow } from '../components/ui';
import { EffortSurveyPrompt, EffortSurveyFooter } from './EffortSurvey';
import { isSupabaseConfigured } from '../lib/supabase';
import { uploadFile } from '../lib/storage';
import type {
  ItemCategory, SubmittalItemLocation, ProjectPhase,
  MondayProjectStatus,
} from '../types';

const categories: ItemCategory[] = ['Display', 'Audio', 'Control', 'Networking', 'Cabling', 'Other'];

export function ProjectOverview() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const allSubmittals = useStore((s) => s.submittals);
  const allRfis = useStore((s) => s.rfis);
  const allCloseouts = useStore((s) => s.closeouts);
  const allManuals = useStore((s) => s.manuals);
  const allReviewRuns = useStore((s) => s.reviewRuns);
  const projectBoM = useStore((s) => s.projectBoM);
  const addBoMItem = useStore((s) => s.addBoMItem);
  const importBoMItems = useStore((s) => s.importBoMItems);
  const syncDToolsBoM = useStore((s) => s.syncDToolsBoM);

  const submittals = useMemo(() => allSubmittals.filter((x) => x.projectId === projectId), [allSubmittals, projectId]);
  const rfis = useMemo(() => allRfis.filter((x) => x.projectId === projectId), [allRfis, projectId]);
  const closeout = useMemo(() => allCloseouts.find((x) => x.projectId === projectId), [allCloseouts, projectId]);
  const manuals = useMemo(() => allManuals.filter((x) => x.projectId === projectId), [allManuals, projectId]);
  const reviewRuns = useMemo(() => allReviewRuns.filter((x) => x.projectId === projectId), [allReviewRuns, projectId]);
  const bomItems = useMemo(() => projectBoM.filter((x) => x.projectId === projectId), [projectBoM, projectId]);

  const [showCSVImport, setShowCSVImport] = useState(false);
  const [showAddItem, setShowAddItem] = useState(false);
  const [itemForm, setItemForm] = useState({
    manufacturer: '', model: '', description: '',
    category: 'Display' as ItemCategory,
    qty: 1, room: '', notes: '',
  });

  if (!project) return null;

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
      itemType: 'Product',
      unitCost: 0, unitPrice: 0,
      laborHours: 0, laborUnitCost: 0, laborUnitPrice: 0,
      fixedLaborCost: 0, fixedLaborPrice: 0,
      marginPct: 0, ownerFurnished: false, optional: false,
    });
    setShowAddItem(false);
    setItemForm({ manufacturer: '', model: '', description: '', category: 'Display', qty: 1, room: '', notes: '' });
  };

  const handleCSVImport = (imported: ImportedItem[]) => {
    const withoutFiles = imported.filter((i) => !i.cutSheetFile);
    const withFiles = imported.filter((i) => i.cutSheetFile);

    if (withoutFiles.length > 0) {
      importBoMItems(projectId!, withoutFiles.map((item) => ({
        manufacturer: item.manufacturer,
        model: item.model,
        description: item.description,
        category: item.category,
        qty: item.qty,
        notes: item.notes,
        locations: item.locations || [],
        cutSheetName: item.cutSheetName,
      })));
    }

    if (withFiles.length > 0) {
      const promises = withFiles.map((item) => new Promise<{
        manufacturer: string; model: string; description: string;
        category: ItemCategory; qty: number; notes: string;
        locations: SubmittalItemLocation[];
        cutSheetData?: string; cutSheetName?: string;
      }>((resolve) => {
        if (isSupabaseConfigured()) {
          uploadFile('cutsheets', projectId!, item.cutSheetFile!).then((url) => {
            resolve({
              manufacturer: item.manufacturer, model: item.model, description: item.description,
              category: item.category, qty: item.qty, notes: item.notes,
              locations: item.locations || [],
              cutSheetData: url, cutSheetName: item.cutSheetName,
            });
          }).catch(() => {
            resolve({
              manufacturer: item.manufacturer, model: item.model, description: item.description,
              category: item.category, qty: item.qty, notes: item.notes,
              locations: item.locations || [],
              cutSheetName: item.cutSheetName,
            });
          });
        } else {
          const reader = new FileReader();
          reader.onload = (e) => {
            const base64 = (e.target?.result as string).split(',')[1];
            resolve({
              manufacturer: item.manufacturer, model: item.model, description: item.description,
              category: item.category, qty: item.qty, notes: item.notes,
              locations: item.locations || [],
              cutSheetData: base64, cutSheetName: item.cutSheetName,
            });
          };
          reader.readAsDataURL(item.cutSheetFile!);
        }
      }));
      Promise.all(promises).then((resolved) => importBoMItems(projectId!, resolved));
    }
  };

  // Tool quick-link items, derived from real store data
  const reviewsOpen = reviewRuns.filter((r) => r.status === 'pending_review' || r.status === 'in_review' || r.status === 'changes_requested').length;
  const subsApproved = submittals.filter((s) => s.status === 'Approved').length;
  const subsPending = submittals.length - subsApproved;
  const punchOpen = closeout?.punchItems.filter((p) => p.status !== 'Complete' && p.status !== 'N/A').length ?? 0;
  const rfisOpen = rfis.filter((r) => r.status === 'Open').length;

  const preItems: ToolItem[] = [
    { tool: 'review',       icon: ScanLine,             label: 'Auto-Review',  value: reviewsOpen,    sub: reviewsOpen ? `${reviewsOpen} run${reviewsOpen === 1 ? '' : 's'} awaiting review` : 'Nothing in queue' },
    { tool: 'bid-leveling', icon: Scale,                label: 'Bid Leveling', value: 0,              sub: 'Compare vendor bids' },
    { tool: 'rfis',         icon: MessageSquareWarning, label: 'RFIs',         value: rfisOpen,       sub: `${rfis.length} total · ${rfisOpen} open` },
  ];
  const postItems: ToolItem[] = [
    { tool: 'submittals',   icon: FileText,             label: 'Submittals',   value: submittals.length, sub: `${subsApproved} approved · ${subsPending} pending` },
    { tool: 'closeout',     icon: ClipboardCheck,       label: 'Closeout',     value: closeout?.punchItems.length ?? 0, sub: closeout ? `${punchOpen} open punch items` : 'Not yet started' },
    { tool: 'manual',       icon: BookOpen,             label: 'Owner Manual', value: manuals.length,    sub: manuals.length > 0 ? `${manuals[0].sections.length} sections` : 'Generated after closeout' },
  ];

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <ProjectHeader project={project} />

      <EffortSurveyPrompt project={project} onNavigate={(p) => navigate(p)} />

      {/* Timeline + Team */}
      <div className="mt-5.5 grid grid-cols-[2fr_1fr] gap-5" style={{ marginTop: 22 }}>
        <div className="bg-white border border-border rounded-xl shadow-sm">
          <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
            <div>
              <Eyebrow>Monday.com</Eyebrow>
              <h2 className="text-base font-semibold text-navy m-0 mt-0.5">Project Timeline</h2>
            </div>
            <span className="text-xs text-fg-2">
              Currently <strong style={{ color: phaseAccent(project.phase) }}>{project.phase}</strong>
            </span>
          </div>
          <div className="p-6">
            <PhaseTimeline status={project.status as MondayProjectStatus} />
          </div>
        </div>

        <TeamCard ownerId={project.ownerId} />
      </div>

      {/* Tool group cards */}
      <div className="mt-5 grid grid-cols-2 gap-5">
        <ToolGroupCard
          phase="Pre-Sales"
          items={preItems}
          description="Winning the work. Review specs, compare vendor bids, manage RFIs."
          onOpen={(tool) => navigate(`/projects/${projectId}/${tool}`)}
        />
        <ToolGroupCard
          phase="Post-Sales"
          items={postItems}
          description="Delivering the work. Submittals, closeout, and owner handoff."
          onOpen={(tool) => navigate(`/projects/${projectId}/${tool}`)}
        />
      </div>

      {/* Project Quote — DTools BoM */}
      <div className="mt-5">
        <ProjectQuoteSection
          project={project}
          bomItems={bomItems}
          onSync={() => projectId && syncDToolsBoM(projectId)}
          onCsvImport={() => setShowCSVImport(true)}
          onAddItem={() => setShowAddItem(true)}
        />
      </div>

      <EffortSurveyFooter project={project} onNavigate={(p) => navigate(p)} />

      <CSVImportModal open={showCSVImport} onClose={() => setShowCSVImport(false)} onImport={handleCSVImport} />

      <Modal open={showAddItem} onClose={() => setShowAddItem(false)} title="Add Line Item">
        <form onSubmit={handleAddItem} className="space-y-4">
          <Field label="Manufacturer" required>
            <input className="input" required value={itemForm.manufacturer}
              onChange={(e) => setItemForm((f) => ({ ...f, manufacturer: e.target.value }))}
              placeholder="e.g. Crestron" />
          </Field>
          <Field label="Model" required>
            <input className="input" required value={itemForm.model}
              onChange={(e) => setItemForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="e.g. DM-NVX-363" />
          </Field>
          <Field label="Description">
            <input className="input" value={itemForm.description}
              onChange={(e) => setItemForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Optional description" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Category">
              <select className="input" value={itemForm.category}
                onChange={(e) => setItemForm((f) => ({ ...f, category: e.target.value as ItemCategory }))}>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Quantity" required>
              <input type="number" className="input" required min={1} value={itemForm.qty}
                onChange={(e) => setItemForm((f) => ({ ...f, qty: Math.max(1, parseInt(e.target.value) || 1) }))} />
            </Field>
          </div>
          <Field label="Room / Location">
            <input className="input" value={itemForm.room}
              onChange={(e) => setItemForm((f) => ({ ...f, room: e.target.value }))}
              placeholder="e.g. Conference Room A" />
          </Field>
          <Field label="Notes">
            <textarea className="input" rows={2} value={itemForm.notes}
              onChange={(e) => setItemForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Optional notes" />
          </Field>
          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <button type="button" onClick={() => setShowAddItem(false)} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" className="btn-primary text-sm"><Plus size={14} /> Add Item</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// =============================================================================
// PhaseTimeline — Monday status pipeline as a stepper
// =============================================================================

const TIMELINE_PHASES: MondayProjectStatus[] = ['Not Started', 'In Progress', 'In Review', 'Follow Up', 'Won'];

function PhaseTimeline({ status }: { status: MondayProjectStatus }) {
  // Legacy statuses ('Active', 'Pending Closeout', 'Closed') aren't on the
  // Monday timeline — fall back to the closest position.
  const legacyMap: Record<string, number> = { Active: 1, 'Pending Closeout': 3, Closed: 4 };
  const idx = TIMELINE_PHASES.indexOf(status) >= 0
    ? TIMELINE_PHASES.indexOf(status)
    : (legacyMap[status as string] ?? 0);

  return (
    <div className="flex items-center">
      {TIMELINE_PHASES.map((p, i) => {
        const done = i < idx;
        const here = i === idx;
        const color = done ? '#15803D' : here ? '#F68D2E' : '#CBD5E1';
        return (
          <Fragment key={p}>
            <div className="flex-none text-center min-w-[100px]">
              <div
                className="w-[30px] h-[30px] rounded-full mx-auto flex items-center justify-center"
                style={{
                  background: here ? '#F68D2E' : done ? '#15803D' : '#fff',
                  border: `2px solid ${color}`,
                  color: here || done ? '#fff' : '#CBD5E1',
                }}
              >
                {done ? <Check size={14} /> : <span className="text-xs font-bold">{i + 1}</span>}
              </div>
              <div
                className="text-[11px] mt-1.5"
                style={{ fontWeight: here ? 700 : 500, color: here ? 'var(--color-navy)' : 'var(--color-fg-2)' }}
              >
                {p}
              </div>
            </div>
            {i < TIMELINE_PHASES.length - 1 && (
              <div
                className="flex-1 h-0.5"
                style={{ background: i < idx ? '#15803D' : '#E2E4E9', margin: '0 -4px 22px' }}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// React Fragment shortcut for the loop above
import { Fragment } from 'react';

// =============================================================================
// Team — placeholder until project_members lands in the central store
// =============================================================================

function TeamCard({ ownerId }: { ownerId?: string }) {
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
        <div>
          <Eyebrow>Assigned</Eyebrow>
          <h2 className="text-base font-semibold text-navy m-0 mt-0.5">Team</h2>
        </div>
        <Users size={16} className="text-fg-2" />
      </div>
      <div className="px-5 py-4">
        {ownerId ? (
          <div className="text-sm text-fg-2">
            Owner assignment recorded.
            <div className="text-xs text-fg-2 mt-2">
              Open the project settings to manage team members.
            </div>
          </div>
        ) : (
          <div className="text-sm text-fg-2">
            No owner assigned yet.
            <div className="text-xs text-fg-2 mt-2">
              Assign an engineer in project settings.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// ToolGroupCard — Pre-Sales / Post-Sales section with quick links
// =============================================================================

interface ToolItem {
  tool: string;
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  value: number | string;
  sub: string;
}

function ToolGroupCard({ phase, description, items, onOpen }: {
  phase: ProjectPhase;
  description: string;
  items: ToolItem[];
  onOpen: (tool: string) => void;
}) {
  const accent = phaseAccent(phase);
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div
        className="px-5 py-3.5 border-b border-border flex items-center gap-3"
        style={{ background: `${accent}08` }}
      >
        <div className="w-2 h-[30px] rounded" style={{ background: accent }} />
        <div className="flex-1">
          <div className="text-[10px] font-bold tracking-[0.15em] uppercase" style={{ color: accent }}>
            {phase}
          </div>
          <div className="text-[13px] text-fg-2 mt-0.5">{description}</div>
        </div>
      </div>
      <div>
        {items.map((it, i) => {
          const Icon = it.icon;
          return (
            <button
              key={it.tool}
              onClick={() => onOpen(it.tool)}
              className={`w-full flex items-center gap-3.5 px-5 py-3.5 text-left hover:bg-surface/60 transition-colors ${i === 0 ? '' : 'border-t border-border'}`}
            >
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: `${accent}14`, color: accent }}
              >
                <Icon size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-fg">{it.label}</div>
                <div className="text-xs text-fg-2 mt-0.5">{it.sub}</div>
              </div>
              <div className="text-lg font-bold text-navy font-mono">{it.value}</div>
              <ChevronRight size={14} className="text-fg-2" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// ProjectQuoteSection — DTools BoM (simple flat table per redesign)
// =============================================================================

interface ProjectQuoteSectionProps {
  project: { id: string; dtoolsBomStatus: string; dtoolsProjectId?: string; updatedAt: string };
  bomItems: { id: string; qty: number; manufacturer: string; model: string; description: string; unitPrice: number }[];
  onSync: () => void;
  onCsvImport: () => void;
  onAddItem: () => void;
}

function ProjectQuoteSection({ project, bomItems, onSync, onCsvImport, onAddItem }: ProjectQuoteSectionProps) {
  const syncing = project.dtoolsBomStatus === 'loading';
  const synced = project.dtoolsBomStatus === 'found';
  const total = bomItems.reduce((s, r) => s + (r.qty * (r.unitPrice || 0)), 0);
  const fmt = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-5.5 py-4 border-b border-border flex items-center justify-between gap-4 flex-wrap" style={{ paddingLeft: 22, paddingRight: 22 }}>
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-[10px] bg-navy/[0.06] text-navy flex items-center justify-center">
            <Package size={22} />
          </div>
          <div>
            <Eyebrow>Bill of Materials</Eyebrow>
            <h2 className="text-lg font-bold text-navy m-0 mt-0.5">Project Quote</h2>
            <div className="text-xs text-fg-2 mt-0.5">
              {synced ? (
                <>Synced from <strong className="text-fg">DTools</strong>
                {project.dtoolsProjectId && <> · <span className="font-mono">{project.dtoolsProjectId}</span></>}
                {' '}· Last sync {project.updatedAt}</>
              ) : (
                <>Not synced yet. Import the bill of materials from DTools to populate this project.</>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {bomItems.length > 0 && (
            <div className="text-right pr-1.5">
              <div className="text-[10px] font-bold text-fg-2 tracking-[0.1em] uppercase">Quote Total</div>
              <div className="text-xl font-bold text-navy font-mono">{fmt(total)}</div>
            </div>
          )}
          <button onClick={onCsvImport} className="btn-secondary text-sm">
            <Upload size={14} /> Import CSV
          </button>
          <button onClick={onAddItem} className="btn-secondary text-sm">
            <Plus size={14} /> Add Item
          </button>
          {isSupabaseConfigured() && (
            <button onClick={onSync} disabled={syncing} className="btn-orange text-sm disabled:opacity-60">
              {syncing
                ? <><Loader2 size={14} className="animate-spin" /> Syncing…</>
                : <><RefreshCw size={14} /> {synced ? 'Re-sync from DTools' : 'Sync from DTools'}</>}
            </button>
          )}
        </div>
      </div>

      {bomItems.length === 0 ? (
        <div className="px-6 py-14 text-center">
          <div className="w-14 h-14 rounded-xl bg-navy/[0.06] text-navy flex items-center justify-center mx-auto mb-3.5">
            <Package size={26} />
          </div>
          <div className="text-base font-semibold text-navy">No bill of materials yet</div>
          <div className="text-[13px] text-fg-2 max-w-[440px] mx-auto mt-1.5 mb-4">
            Pull line items directly from this project's DTools quote, or import a CSV. You can re-sync at any time to pick up changes.
          </div>
          {isSupabaseConfigured() && (
            <button onClick={onSync} disabled={syncing} className="btn-orange text-sm disabled:opacity-60">
              {syncing
                ? <><Loader2 size={14} className="animate-spin" /> Syncing…</>
                : <><RefreshCw size={14} /> Sync from DTools</>}
            </button>
          )}
        </div>
      ) : (
        <div>
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-navy text-white text-left">
                <th className="px-5.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em]" style={{ paddingLeft: 22, paddingRight: 22, width: 60 }}>Qty</th>
                <th className="px-5.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em]" style={{ paddingLeft: 22, paddingRight: 22, width: 170 }}>Part #</th>
                <th className="px-5.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em]" style={{ paddingLeft: 22, paddingRight: 22, width: 140 }}>Manufacturer</th>
                <th className="px-5.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em]" style={{ paddingLeft: 22, paddingRight: 22 }}>Description</th>
                <th className="px-5.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-right" style={{ paddingLeft: 22, paddingRight: 22, width: 110 }}>Unit</th>
                <th className="px-5.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-right" style={{ paddingLeft: 22, paddingRight: 22, width: 120 }}>Extended</th>
              </tr>
            </thead>
            <tbody>
              {bomItems.map((r, i) => (
                <tr key={r.id} style={{ background: i % 2 === 1 ? 'rgba(245,246,248,0.3)' : '#fff' }}>
                  <td className="px-5.5 py-3 text-[13px] font-semibold font-mono border-t border-border" style={{ paddingLeft: 22, paddingRight: 22 }}>{r.qty}</td>
                  <td className="px-5.5 py-3 text-[13px] font-mono border-t border-border" style={{ paddingLeft: 22, paddingRight: 22 }}>{r.model}</td>
                  <td className="px-5.5 py-3 text-[13px] text-fg-2 border-t border-border" style={{ paddingLeft: 22, paddingRight: 22 }}>{r.manufacturer}</td>
                  <td className="px-5.5 py-3 text-[13px] border-t border-border" style={{ paddingLeft: 22, paddingRight: 22 }}>{r.description}</td>
                  <td className="px-5.5 py-3 text-[13px] font-mono text-fg-2 text-right border-t border-border" style={{ paddingLeft: 22, paddingRight: 22 }}>{fmt(r.unitPrice || 0)}</td>
                  <td className="px-5.5 py-3 text-[13px] font-mono font-semibold text-right border-t border-border" style={{ paddingLeft: 22, paddingRight: 22 }}>{fmt(r.qty * (r.unitPrice || 0))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: 'rgba(34,50,110,0.03)' }}>
                <td colSpan={5} className="px-5.5 py-3 text-right text-[13px] font-semibold border-t-2 border-border" style={{ paddingLeft: 22, paddingRight: 22 }}>Total</td>
                <td className="px-5.5 py-3 text-right font-mono font-bold text-base text-navy border-t-2 border-border" style={{ paddingLeft: 22, paddingRight: 22 }}>{fmt(total)}</td>
              </tr>
            </tfoot>
          </table>
          <div className="px-5.5 py-2.5 border-t border-border text-xs text-fg-2" style={{ paddingLeft: 22, paddingRight: 22 }}>
            {bomItems.length} line items{synced ? ' · pulled from DTools' : ''}
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function phaseAccent(phase: ProjectPhase): string {
  return phase === 'Pre-Sales' ? '#0072CE' : '#F68D2E';
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-fg">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
