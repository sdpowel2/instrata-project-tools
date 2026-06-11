import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  FileText, MessageSquareWarning, ClipboardCheck, BookOpen,
  Upload, Plus, Package, RefreshCw, Loader2, Check,
  ScanLine, Scale, ChevronRight, Users, ChevronDown,
  Calendar, Truck, ShieldCheck,
} from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from '../components/Modal';
import { JoinProjectModal } from '../components/JoinProjectModal';
import { CSVImportModal, type ImportedItem } from '../components/CSVImportModal';
import { ProjectHeader } from '../components/ProjectHeader';
import { Eyebrow } from '../components/ui';
import { DToolsImportPicker, type DToolsListedProject } from '../components/DToolsImportPicker';
import { EffortSurveyPrompt, EffortSurveyFooter } from './EffortSurvey';
import { ProjectLog } from '../components/ProjectLog';
import { isSupabaseConfigured } from '../lib/supabase';
import { uploadFile } from '../lib/storage';
import type {
  ItemCategory, SubmittalItemLocation, ProjectPhase, ProjectStatus,
  ProjectChangeOrder, ChangeOrderStatus, ChangeOrderItem, BomItemType, DToolsSyncDelta,
} from '../types';
import { PRE_SALES_STATUSES, POST_SALES_STATUSES, computeMilestoneStatus } from '../types';

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
  const allMilestones = useStore((s) => s.milestones);
  const allPurchasingModules = useStore((s) => s.purchasingModules);
  const allPurchasingItems = useStore((s) => s.purchasingItems);
  const allChangeOrders = useStore((s) => s.changeOrders);
  const projectBoM = useStore((s) => s.projectBoM);
  const addBoMItem = useStore((s) => s.addBoMItem);
  const importBoMItems = useStore((s) => s.importBoMItems);
  const syncDToolsBoM = useStore((s) => s.syncDToolsBoM);
  const linkDToolsAndSyncBoM = useStore((s) => s.linkDToolsAndSyncBoM);
  const myProjectIds = useStore((s) => s.myProjectIds);
  const addSelfToProject = useStore((s) => s.addSelfToProject);
  const { isAdmin } = useAuth();

  const submittals = useMemo(() => allSubmittals.filter((x) => x.projectId === projectId), [allSubmittals, projectId]);
  const rfis = useMemo(() => allRfis.filter((x) => x.projectId === projectId), [allRfis, projectId]);
  const closeout = useMemo(() => allCloseouts.find((x) => x.projectId === projectId), [allCloseouts, projectId]);
  const manuals = useMemo(() => allManuals.filter((x) => x.projectId === projectId), [allManuals, projectId]);
  const reviewRuns = useMemo(() => allReviewRuns.filter((x) => x.projectId === projectId), [allReviewRuns, projectId]);
  const milestones = useMemo(() => allMilestones.filter((x) => x.projectId === projectId), [allMilestones, projectId]);
  const bomItems = useMemo(() => projectBoM.filter((x) => x.projectId === projectId), [projectBoM, projectId]);
  const changeOrders = useMemo(
    () => allChangeOrders.filter((x) => x.projectId === projectId),
    [allChangeOrders, projectId],
  );

  const [showCSVImport, setShowCSVImport] = useState(false);
  const [showAddItem, setShowAddItem] = useState(false);
  const [showDToolsPicker, setShowDToolsPicker] = useState(false);
  // Action a non-member is trying to take — drives the "join or view-only"
  // modal. `allowViewOnly` is true for read-only destinations (opening a tool),
  // false for edits (which can't proceed without joining). null = no prompt.
  const [pendingAction, setPendingAction] = useState<{ run: () => void; allowViewOnly: boolean } | null>(null);
  const [itemForm, setItemForm] = useState({
    manufacturer: '', model: '', description: '',
    category: 'Display' as ItemCategory,
    qty: 1, room: '', notes: '',
  });

  if (!project) return null;

  // Editing project-scoped data is RLS-gated to team members (admins bypass).
  // A non-member opening a tool can view it, but their edits won't persist —
  // so prompt them to join first, unless they've already chosen view-only for
  // this project this session.
  const canEdit = isAdmin || myProjectIds.has(project.id);
  const viewOnlyKey = `viewOnly:${project.id}`;
  const dismissedViewOnly = () => sessionStorage.getItem(viewOnlyKey) === '1';

  // Gate any membership-requiring action behind the join prompt. Editors run
  // it immediately. Non-members get the modal — except read-only actions
  // (allowViewOnly) are let through once they've opted into view-only this
  // session, so browsing isn't nagged on every click.
  const requireMembership = (run: () => void, opts?: { allowViewOnly?: boolean }) => {
    const allowViewOnly = opts?.allowViewOnly ?? false;
    if (canEdit || (allowViewOnly && dismissedViewOnly())) {
      run();
      return;
    }
    setPendingAction({ run, allowViewOnly });
  };

  const handleOpenTool = (tool: string) =>
    requireMembership(() => navigate(`/projects/${projectId}/${tool}`), { allowViewOnly: true });

  const handleJoinFromPrompt = async () => {
    const action = pendingAction;
    await addSelfToProject(project.id);
    setPendingAction(null);
    action?.run();
  };

  const handleViewOnly = () => {
    const action = pendingAction;
    sessionStorage.setItem(viewOnlyKey, '1');
    setPendingAction(null);
    // Edits can't proceed view-only — just dismiss. Read-only destinations
    // continue through.
    if (action?.allowViewOnly) action.run();
  };

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
      laborType: '', laborBreakdown: [], includedInPhase: false,
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
  // Operations is a parallel section. Schedule & Milestones and Purchasing
  // are live; Inventory is still scaffolded.
  const milestoneOverdue = milestones.filter((m) => computeMilestoneStatus(m) === 'overdue').length;
  const milestoneAtRisk  = milestones.filter((m) => computeMilestoneStatus(m) === 'at_risk').length;
  const milestoneOpen    = milestones.filter((m) => !m.completedDate).length;
  const scheduleSub = milestones.length === 0
    ? 'Not yet scheduled'
    : milestoneOverdue > 0
      ? `${milestoneOverdue} overdue · ${milestoneOpen} open`
      : milestoneAtRisk > 0
        ? `${milestoneAtRisk} at risk · ${milestoneOpen} open`
        : `${milestoneOpen} open · ${milestones.length - milestoneOpen} complete`;

  const purchasingModules = allPurchasingModules.filter((m) => m.projectId === projectId);
  const purchModuleIds = new Set(purchasingModules.map((m) => m.id));
  const purchItemsForProject = allPurchasingItems.filter((p) => purchModuleIds.has(p.purchasingModuleId));
  const purchOrdered  = purchItemsForProject.filter((p) => p.purchaseStatus === 'ordered').length;
  const purchReceived = purchItemsForProject.filter((p) => p.purchaseStatus === 'received').length;
  const purchasingSub = purchasingModules.length === 0
    ? 'No purchasing modules yet'
    : `${purchOrdered} ordered · ${purchReceived} received`;

  const opsItems: ToolItem[] = [
    { tool: 'schedule',   icon: Calendar, label: 'Schedule & Milestones', value: milestones.length || '—', sub: scheduleSub, enabled: true },
    { tool: 'purchasing', icon: Truck,    label: 'Purchasing',            value: purchasingModules.length || '—', sub: purchasingSub, enabled: true },
    { tool: 'inventory',  icon: Package,  label: 'Inventory',             value: '—', sub: 'Nothing received' },
  ];

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1400px]">
      <ProjectHeader project={project} />

      <EffortSurveyPrompt project={project} onNavigate={(p) => navigate(p)} />

      {/* Timeline + Team — share the same 3-col grid as the tool cards below
          so the Timeline aligns with Pre-Sales+Post-Sales and Team aligns
          with Operations. Without col-span-2, a 2fr/1fr grid leaves the
          right edge of Timeline G/3 short of Post-Sales. */}
      <div className="mt-5.5 grid grid-cols-3 gap-5" style={{ marginTop: 22 }}>
        <div className="col-span-2 bg-white border border-border rounded-xl shadow-sm">
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
            <PhaseTimeline status={project.status} phase={project.phase} />
          </div>
        </div>

        <TeamCard ownerId={project.ownerId} />
      </div>

      {/* Tool group cards — Pre-Sales / Post-Sales / Operations */}
      <div className="mt-5 grid grid-cols-3 gap-5">
        <ToolGroupCard
          phase="Pre-Sales"
          items={preItems}
          description="Winning the work. Review specs, compare vendor bids, manage RFIs."
          onOpen={handleOpenTool}
        />
        <ToolGroupCard
          phase="Post-Sales"
          items={postItems}
          description="Delivering the work. Submittals, closeout, and owner handoff."
          onOpen={handleOpenTool}
        />
        <ToolGroupCard
          phase="Operations"
          items={opsItems}
          description="Running the work day-to-day. Schedule, purchasing, and inventory."
          // Schedule & Milestones is live; Purchasing / Inventory are flagged
          // disabled per-item so they still render dimmed.
          onOpen={handleOpenTool}
        />
      </div>

      {/* Milestone summary — next 3 upcoming/at-risk milestones per spec §6.
          Hidden until at least one milestone exists. */}
      {milestones.length > 0 && (
        <div className="mt-5">
          <MilestoneSummaryCard
            milestones={milestones}
            onOpen={() => navigate(`/projects/${projectId}/schedule`)}
          />
        </div>
      )}

      {/* Project Log — comments, files, client/GC log (scaffolded) */}
      <div className="mt-5">
        <ProjectLog project={project} />
      </div>

      {/* Project Quote — DTools BoM */}
      <div className="mt-5">
        <ProjectQuoteSection
          project={project}
          bomItems={bomItems}
          changeOrders={changeOrders}
          onSync={() => requireMembership(() => {
            if (!projectId) return;
            // Linked already → re-sync against the same DTools project.
            // Not linked yet → open the picker so the user can choose which
            // DTools project this Monday-imported row should pull from.
            if (project.dtoolsProjectId) {
              syncDToolsBoM(projectId);
            } else {
              setShowDToolsPicker(true);
            }
          })}
          onCsvImport={() => requireMembership(() => setShowCSVImport(true))}
          onAddItem={() => requireMembership(() => setShowAddItem(true))}
        />
      </div>

      <EffortSurveyFooter project={project} onNavigate={(p) => navigate(p)} />

      <JoinProjectModal
        open={pendingAction !== null}
        projectName={project.name}
        onJoin={handleJoinFromPrompt}
        onViewOnly={handleViewOnly}
        onClose={() => setPendingAction(null)}
      />

      <CSVImportModal open={showCSVImport} onClose={() => setShowCSVImport(false)} onImport={handleCSVImport} />

      <DToolsImportPicker
        open={showDToolsPicker}
        onClose={() => setShowDToolsPicker(false)}
        onSelect={async (p: DToolsListedProject) => {
          if (!projectId) return;
          await linkDToolsAndSyncBoM(projectId, {
            dtoolsId: p.dtoolsId,
            number: p.number,
            projectTotal: p.projectTotal,
          });
          setShowDToolsPicker(false);
        }}
        title="Link this project to DTools"
        description="Pick the DTools project this should sync with. The selected project's number, value, and Bill of Materials will be pulled in. You can re-sync anytime after linking."
        errorLabel="Link failed"
      />

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

// Stepper sequences are pulled from types.ts so they stay in sync with the
// authoritative status enum. Off-pipeline statuses (On Hold / Lost / Declined
// to Bid / Rebid) don't render on the timeline — those are surface-only states.
function PhaseTimeline({ status, phase }: { status: ProjectStatus; phase: ProjectPhase }) {
  const phases = phase === 'Pre-Sales' ? PRE_SALES_STATUSES : POST_SALES_STATUSES;
  const rawIdx = phases.indexOf(status);
  const idx = rawIdx >= 0 ? rawIdx : 0;

  return (
    <div className="flex items-center">
      {phases.map((p, i) => {
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
            {i < phases.length - 1 && (
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
  /** Per-item override — used when the section's onOpen is set but a single
   *  row should still render as disabled (e.g. Operations: Schedule is live,
   *  Purchasing / Inventory aren't). Defaults to true. */
  enabled?: boolean;
}

function ToolGroupCard({ phase, description, items, onOpen }: {
  // Operations is a UI-only section that lives parallel to Pre/Post-Sales.
  phase: ProjectPhase | 'Operations';
  description: string;
  items: ToolItem[];
  /** Optional. When omitted, items render but don't navigate (used for the
   *  Operations card while those tools are still being built out). */
  onOpen?: (tool: string) => void;
}) {
  const accent = sectionAccent(phase);
  const disabled = !onOpen;
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      {/* Header — items-start + a 2-line min-height on the description keeps
          the eyebrow at the same y across all three cards even when the
          description is short enough to fit on one line. */}
      <div
        className="px-5 py-3.5 border-b border-border flex items-start gap-3"
        style={{ background: `${accent}08` }}
      >
        <div className="w-2 h-[30px] rounded flex-shrink-0" style={{ background: accent }} />
        <div className="flex-1">
          <div className="text-[10px] font-bold tracking-[0.15em] uppercase" style={{ color: accent }}>
            {phase}
          </div>
          <div
            className="text-[13px] text-fg-2 mt-0.5"
            // Explicit line-height + 2× min-height so single-line copy
            // (Post-Sales) takes the same vertical space as 2-line copy
            // (Pre-Sales / Operations). Without pinning line-height, the
            // browser default of ~1.5 makes 2.6em fall short of two lines.
            style={{ lineHeight: 1.45, minHeight: 'calc(2 * 1.45 * 13px)' }}
          >
            {description}
          </div>
        </div>
      </div>
      <div>
        {items.map((it, i) => {
          const Icon = it.icon;
          const rowClass = `w-full flex items-center gap-3.5 px-5 py-3.5 text-left transition-colors ${i === 0 ? '' : 'border-t border-border'}`;
          const content = (
            <>
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
            </>
          );
          const itemEnabled = it.enabled !== false;
          if (disabled || !itemEnabled || !onOpen) {
            return (
              <div
                key={it.tool}
                title="Coming soon"
                aria-disabled="true"
                className={`${rowClass} cursor-not-allowed opacity-70 select-none`}
              >
                {content}
              </div>
            );
          }
          return (
            <button
              key={it.tool}
              onClick={() => onOpen(it.tool)}
              className={`${rowClass} hover:bg-surface/60`}
            >
              {content}
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
  project: {
    id: string; dtoolsBomStatus: string; dtoolsProjectId?: string; updatedAt: string; value?: string;
    dtoolsCost?: number; dtoolsPriceWithoutTax?: number; dtoolsTax?: number;
    dtoolsPrice?: number; dtoolsHours?: number; dtoolsSyncDelta?: DToolsSyncDelta;
  };
  bomItems: BoMRow[];
  changeOrders: ProjectChangeOrder[];
  onSync: () => void;
  onCsvImport: () => void;
  onAddItem: () => void;
}

// Hierarchical DTools locations look like "1st Floor\(Typical of 1) Council Chamber - (1607)".
// We split on backslash to get the path segments, in order from root → leaf.
function locationPath(room: string): string[] {
  return room.split('\\').map((s) => s.trim()).filter(Boolean);
}

// Build a nested tree of locations → items, used by the BoM section to render
// a collapsible "Floor > Room > …" view. Items without a location land under
// a synthetic "Unassigned" branch so labor/misc lines aren't dropped.
interface LocationNode {
  name: string;
  fullPath: string; // unique key for expand/collapse state
  children: Map<string, LocationNode>;
  // Items physically present at THIS node (qty for this location).
  items: { item: BoMRow; qty: number }[];
}

interface BoMRow {
  id: string; qty: number; manufacturer: string; model: string;
  description: string; locations: SubmittalItemLocation[];
  itemType: BomItemType; laborType: string;
  unitCost: number; unitPrice: number;
  laborHours: number; laborUnitCost: number; laborUnitPrice: number;
  fixedLaborCost: number; fixedLaborPrice: number;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const fmtMoney = (n: number) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Full-line equipment + labor dollars for a BoM row. Products carry labor as
// line-total hours × blended rate; companion labor lines are fixed dollars;
// phase-residual labor lines are hour-based.
function lineTotals(item: BoMRow): { equip: number; labor: number; equipCost: number; laborCost: number } {
  if (item.itemType === 'Labor') {
    return {
      equip: 0,
      equipCost: 0,
      labor: r2(item.laborHours * item.laborUnitPrice) + item.fixedLaborPrice,
      laborCost: r2(item.laborHours * item.laborUnitCost) + item.fixedLaborCost,
    };
  }
  return {
    equip: r2(item.qty * item.unitPrice),
    equipCost: r2(item.qty * item.unitCost),
    labor: r2(item.laborHours * item.laborUnitPrice),
    laborCost: r2(item.laborHours * item.laborUnitCost),
  };
}

// Proportional share of a line's dollars for one location's quantity.
function shareTotals(item: BoMRow, locQty: number): { equip: number; labor: number } {
  const t = lineTotals(item);
  const frac = item.qty > 0 ? locQty / item.qty : 1;
  return { equip: r2(t.equip * frac), labor: r2(t.labor * frac) };
}

// Subtotal for a location node including its sub-locations.
function nodeSubtotal(node: LocationNode): { equip: number; labor: number } {
  let equip = 0, labor = 0;
  for (const { item, qty } of node.items) {
    const s = shareTotals(item, qty);
    equip += s.equip;
    labor += s.labor;
  }
  for (const child of node.children.values()) {
    const s = nodeSubtotal(child);
    equip += s.equip;
    labor += s.labor;
  }
  return { equip: r2(equip), labor: r2(labor) };
}

function buildLocationTree(bomItems: BoMRow[]): LocationNode {
  const root: LocationNode = { name: '', fullPath: '', children: new Map(), items: [] };

  const ensureNode = (path: string[]): LocationNode => {
    let node = root;
    let cumulative = '';
    for (const seg of path) {
      cumulative = cumulative ? `${cumulative} / ${seg}` : seg;
      if (!node.children.has(seg)) {
        node.children.set(seg, { name: seg, fullPath: cumulative, children: new Map(), items: [] });
      }
      node = node.children.get(seg)!;
    }
    return node;
  };

  for (const item of bomItems) {
    // Locationless labor (phase rollup residuals — project-wide hours) gets
    // its own bucket so it reads as labor, not as a data problem.
    const fallback = item.itemType === 'Labor' ? 'Project Labor' : 'Unassigned';
    if (item.locations.length === 0) {
      ensureNode([fallback]).items.push({ item, qty: item.qty });
      continue;
    }
    for (const loc of item.locations) {
      const segs = locationPath(loc.room);
      if (segs.length === 0) {
        ensureNode([fallback]).items.push({ item, qty: loc.qty });
      } else {
        ensureNode(segs).items.push({ item, qty: loc.qty });
      }
    }
  }

  return root;
}

// Total qty of items under a node (recursive). Used in branch headers so
// users can see how much sits in each location at a glance.
function countNode(node: LocationNode): number {
  let count = node.items.reduce((s, x) => s + x.qty, 0);
  for (const child of node.children.values()) count += countNode(child);
  return count;
}

function ProjectQuoteSection({ project, bomItems, changeOrders, onSync, onCsvImport, onAddItem }: ProjectQuoteSectionProps) {
  const syncing = project.dtoolsBomStatus === 'loading';
  const synced = project.dtoolsBomStatus === 'found';
  // Header badge shows the canonical DTools value only — equipment-level
  // pricing is intentionally hidden in this view (the user manages pricing
  // in DTools, not here).
  const totalDisplay = project.value && project.value.trim() ? project.value : null;

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
          {bomItems.length > 0 && totalDisplay && (
            <div className="text-right pr-1.5">
              <div className="text-[10px] font-bold text-fg-2 tracking-[0.1em] uppercase">DTools Project Total</div>
              <div className="text-xl font-bold text-navy font-mono">{totalDisplay}</div>
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
          <BoMLocationTree bomItems={bomItems} />
          <QuoteTotalsFooter project={project} bomItems={bomItems} />
          <div className="px-5.5 py-2.5 border-t border-border text-xs text-fg-2" style={{ paddingLeft: 22, paddingRight: 22 }}>
            {bomItems.length} line items{synced ? ' · pulled from DTools' : ''}
          </div>

          {/* Change Orders — pulled from DTools alongside the BoM. All groups
              collapsed by default so the BoM stays the focal point until a
              user drills in. */}
          <div className="border-t border-border">
            <div className="flex items-center justify-between gap-3" style={{ padding: '14px 22px 4px' }}>
              <div className="text-[10px] font-bold text-fg-2 tracking-[0.15em] uppercase">
                Change Orders
              </div>
              <span className="text-[11px] text-fg-2 inline-flex items-center gap-1.5">
                <ShieldCheck size={11} /> Read-only · DTools is authoritative
              </span>
            </div>
            <ChangeOrderGroups changeOrders={changeOrders} />
          </div>

          {/* Contract Value summary — Original + Approved = Current, with
              pending exposure surfaced separately so it can never be
              confused with the contracted total. */}
          <ContractValueSummary projectValue={project.value} changeOrders={changeOrders} />
        </div>
      )}
    </div>
  );
}

// =============================================================================
// QuoteTotalsFooter — Equipment / Labor / Total rollup at the bottom of the
// BoM. Prefers the sync's reconciled split (computed with DTools' own row
// convention, so it matches the DTools quote to the penny); falls back to
// summing the visible lines for CSV-imported projects.
// =============================================================================

function QuoteTotalsFooter({ project, bomItems }: {
  project: ProjectQuoteSectionProps['project'];
  bomItems: BoMRow[];
}) {
  const delta = project.dtoolsSyncDelta;

  const computed = useMemo(() => {
    let equip = 0, equipCost = 0, labor = 0, laborCost = 0;
    for (const item of bomItems) {
      const t = lineTotals(item);
      equip += t.equip; equipCost += t.equipCost;
      labor += t.labor; laborCost += t.laborCost;
    }
    return { equip: r2(equip), equipCost: r2(equipCost), labor: r2(labor), laborCost: r2(laborCost) };
  }, [bomItems]);

  const equipPrice = delta?.equipmentPrice ?? computed.equip;
  const equipCost = delta?.equipmentCost ?? computed.equipCost;
  const laborPrice = delta?.laborPrice ?? computed.labor;
  const laborCost = delta?.laborCost ?? computed.laborCost;
  const subtotalPrice = r2(equipPrice + laborPrice);
  const subtotalCost = r2(equipCost + laborCost);
  const tax = project.dtoolsTax ?? 0;
  const grandTotal = project.dtoolsPrice ?? r2(subtotalPrice + tax);
  const gp = (cost: number, price: number) =>
    price > 0 ? `${(((price - cost) / price) * 100).toFixed(1)}%` : '—';

  const hasCost = equipCost > 0 || laborCost > 0;

  return (
    <div className="border-t-2 border-border bg-navy/[0.03]" style={{ paddingLeft: 22, paddingRight: 22 }}>
      <table className="border-collapse ml-auto my-3" style={{ minWidth: 420 }}>
        <thead>
          <tr className="text-fg-2 text-[10px] font-semibold uppercase tracking-[0.05em]">
            <th className="text-left py-1 pr-6"></th>
            {hasCost && <th className="text-right py-1 pr-6">Cost</th>}
            <th className="text-right py-1 pr-6">Price</th>
            {hasCost && <th className="text-right py-1">GP%</th>}
          </tr>
        </thead>
        <tbody className="text-[13px]">
          <tr>
            <td className="py-1 pr-6 font-semibold text-fg-2">Equipment</td>
            {hasCost && <td className="py-1 pr-6 text-right font-mono">{fmtMoney(equipCost)}</td>}
            <td className="py-1 pr-6 text-right font-mono">{fmtMoney(equipPrice)}</td>
            {hasCost && <td className="py-1 text-right font-mono text-fg-2">{gp(equipCost, equipPrice)}</td>}
          </tr>
          <tr>
            <td className="py-1 pr-6 font-semibold text-fg-2">Labor</td>
            {hasCost && <td className="py-1 pr-6 text-right font-mono">{fmtMoney(laborCost)}</td>}
            <td className="py-1 pr-6 text-right font-mono">{fmtMoney(laborPrice)}</td>
            {hasCost && <td className="py-1 text-right font-mono text-fg-2">{gp(laborCost, laborPrice)}</td>}
          </tr>
          {tax > 0 && (
            <tr>
              <td className="py-1 pr-6 font-semibold text-fg-2">Tax</td>
              {hasCost && <td className="py-1 pr-6" />}
              <td className="py-1 pr-6 text-right font-mono">{fmtMoney(tax)}</td>
              {hasCost && <td className="py-1" />}
            </tr>
          )}
          <tr className="border-t border-border">
            <td className="py-1.5 pr-6 font-bold text-navy">DTools Project Total</td>
            {hasCost && <td className="py-1.5 pr-6 text-right font-mono font-bold text-navy">{fmtMoney(subtotalCost)}</td>}
            <td className="py-1.5 pr-6 text-right font-mono font-bold text-navy text-base">{fmtMoney(grandTotal)}</td>
            {hasCost && <td className="py-1.5 text-right font-mono font-bold text-navy">{gp(subtotalCost, subtotalPrice)}</td>}
          </tr>
        </tbody>
      </table>
      {delta && (
        <div className="pb-2.5 text-right text-[11px]">
          {delta.verified ? (
            <span className="text-green-700 inline-flex items-center gap-1">
              <ShieldCheck size={11} /> Reconciled with DTools quote (drift ≤ $1)
            </span>
          ) : (
            <span className="text-orange-600">
              ⚠ Does not reconcile with DTools (Δ cost {fmtMoney(delta.costDelta)}, Δ price {fmtMoney(delta.priceDelta)}) — check the sync log
            </span>
          )}
          {delta.echoModels.length > 0 && (
            <span className="text-fg-2"> · DTools rolls {delta.echoModels.join(', ')} into phase labor; shown here as its own line</span>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Change Orders — read-only blocks rendered inside the Project Quote card.
// =============================================================================

function parseProjectValue(s: string | undefined): number {
  if (!s) return 0;
  const m = s.match(/\$?\s*([\d,.]+)\s*([KM])?/i);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return 0;
  const suffix = (m[2] || '').toUpperCase();
  return n * (suffix === 'M' ? 1_000_000 : suffix === 'K' ? 1_000 : 1);
}

const fmtUSD = (n: number) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US');
const fmtSigned = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US');
const fmtSignedCents = (n: number) =>
  (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface ChangeOrderGroupsProps {
  changeOrders: ProjectChangeOrder[];
}

function ChangeOrderGroups({ changeOrders }: ChangeOrderGroupsProps) {
  if (changeOrders.length === 0) {
    return (
      <div className="text-center text-fg-2 text-[13px] border-t border-border" style={{ padding: '28px 22px' }}>
        No change orders for this project yet.
      </div>
    );
  }

  const approved = changeOrders.filter((c) => c.status === 'Approved');
  const pending = changeOrders.filter((c) => c.status === 'Pending');
  const rejected = changeOrders.filter((c) => c.status === 'Rejected');

  return (
    <div>
      <COGroup label="Approved" status="Approved" accent="#15803D" items={approved} />
      <COGroup label="Pending"  status="Pending"  accent="var(--color-orange)" items={pending} />
      <COGroup label="Rejected" status="Rejected" accent="#9CA3AF" items={rejected} isLast />
    </div>
  );
}

interface COGroupProps {
  label: string;
  status: ChangeOrderStatus;
  accent: string;
  items: ProjectChangeOrder[];
  isLast?: boolean;
}

function COGroup({ label, status, accent, items, isLast }: COGroupProps) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  const total = items.reduce((s, c) => s + c.amount, 0);
  const muted = status === 'Rejected';

  return (
    <div style={{ borderBottom: isLast ? 'none' : '1px solid var(--color-border)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 text-left transition-colors hover:bg-surface/50"
        style={{ padding: '14px 22px' }}
      >
        <ChevronRight
          size={12}
          className="text-fg-2 transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)' }}
        />
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: accent }} />
        <span className="text-[11px] font-bold tracking-[0.12em] uppercase" style={{ color: accent }}>
          {label}
        </span>
        <span className="text-xs text-fg-2">
          · {items.length} change order{items.length === 1 ? '' : 's'}
        </span>
        <span className="flex-1" />
        <span
          className="font-mono text-[13px] font-semibold"
          style={{
            color: muted ? 'var(--color-fg-2)' : accent,
            textDecoration: muted ? 'line-through' : 'none',
          }}
        >
          {fmtSigned(total)}
        </span>
      </button>
      {open && (
        <div style={{ paddingBottom: 6 }}>
          {items.map((co) => (
            <CORow key={co.id} co={co} status={status} />
          ))}
        </div>
      )}
    </div>
  );
}

interface CORowProps {
  co: ProjectChangeOrder;
  status: ChangeOrderStatus;
}

function CORow({ co, status }: CORowProps) {
  const muted = status === 'Rejected';
  const [showItems, setShowItems] = useState(false);
  const amountColor =
    status === 'Approved' ? '#15803D' : status === 'Pending' ? 'var(--color-orange)' : 'var(--color-fg-2)';

  // Internal vs External chip — both sides modify the bottom line, so we
  // colour by category just for at-a-glance attribution: navy = Internal
  // (Instrata absorbed), orange = External (client/contract-facing).
  const isInternal = co.category === 'Internal';
  const chipBg = isInternal ? 'rgba(34,50,110,0.08)' : 'rgba(246,141,46,0.10)';
  const chipBorder = isInternal ? 'rgba(34,50,110,0.25)' : 'rgba(246,141,46,0.30)';
  const chipColor = isInternal ? 'var(--color-navy)' : 'var(--color-orange-dark)';

  return (
    <div
      className="flex items-start gap-3.5 border-t border-border"
      style={{ padding: '12px 22px 12px 50px', opacity: muted ? 0.7 : 1 }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2.5 flex-wrap">
          <span className="text-[13px] font-bold font-mono text-fg">{co.number}</span>
          <span
            className="text-[13.5px] font-semibold text-fg"
            style={{ textDecoration: muted ? 'line-through' : 'none' }}
          >
            {co.title}
          </span>
          <span
            className="text-[10px] font-bold tracking-[0.1em] uppercase"
            style={{
              padding: '2px 7px',
              borderRadius: 4,
              background: chipBg,
              color: chipColor,
              border: `1px solid ${chipBorder}`,
            }}
          >
            {co.category}
          </span>
          {status === 'Pending' && (
            <span
              className="text-[10px] font-bold tracking-[0.1em] uppercase"
              style={{
                padding: '2px 7px',
                borderRadius: 4,
                background: 'rgba(246,141,46,0.12)',
                color: 'var(--color-orange)',
                border: '1px solid rgba(246,141,46,0.3)',
              }}
            >
              Not in contract
            </span>
          )}
        </div>
        <div className="mt-1 text-[12.5px] text-fg-2 leading-relaxed">{co.description}</div>
        <div className="mt-1.5 flex items-center gap-3.5 text-[11px] text-fg-2 flex-wrap">
          <span className="inline-flex items-center gap-1">
            <Calendar size={11} /> Requested {co.requestedAt}
          </span>
          {co.resolvedAt && (
            <span>· {status === 'Rejected' ? 'Rejected' : 'Approved'} {co.resolvedAt}</span>
          )}
          <span className="font-mono">· {co.dToolsId}</span>
          {co.items && co.items.length > 0 && (
            <button
              onClick={() => setShowItems((v) => !v)}
              className="text-navy font-semibold hover:underline"
            >
              {showItems ? 'Hide' : 'Show'} {co.items.length} line item{co.items.length === 1 ? '' : 's'}
            </button>
          )}
          {co.dtoolsVerified === false && (
            <span className="text-orange-600 font-semibold">⚠ lines don't reconcile with CO total</span>
          )}
        </div>
        {showItems && co.items && <COItemsTable items={co.items} />}
      </div>
      <div
        className="flex-shrink-0 text-right font-mono text-[15px] font-bold"
        style={{
          color: amountColor,
          textDecoration: muted ? 'line-through' : 'none',
        }}
      >
        {fmtSigned(co.amount)}
      </div>
    </div>
  );
}

// Signed delta lines inside a published CO. Removals arrive from DTools with
// negated unit prices/hours, so the line totals are already signed — we just
// color-code by change type.
function COItemsTable({ items }: { items: ChangeOrderItem[] }) {
  const typeStyle = (t: ChangeOrderItem['changeType']) => {
    if (t === 'Added') return { color: '#15803D', bg: 'rgba(21,128,61,0.08)', label: 'Added' };
    if (t === 'Removed') return { color: '#B91C1C', bg: 'rgba(185,28,28,0.08)', label: 'Removed' };
    if (t === 'Adjusted') return { color: '#B45309', bg: 'rgba(180,83,9,0.08)', label: 'Adjusted' };
    return { color: 'var(--color-fg-2)', bg: 'rgba(0,0,0,0.04)', label: t };
  };

  return (
    <div className="mt-2.5 border border-border rounded-lg overflow-hidden">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="bg-navy/[0.04] text-fg-2 text-left">
            <th className="py-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.05em]" style={{ width: 80 }}></th>
            <th className="py-1.5 pr-3 text-[10px] font-semibold uppercase tracking-[0.05em]" style={{ width: 40 }}>Qty</th>
            <th className="py-1.5 pr-3 text-[10px] font-semibold uppercase tracking-[0.05em]">Item</th>
            <th className="py-1.5 pr-3 text-[10px] font-semibold uppercase tracking-[0.05em] text-right" style={{ width: 95 }}>Equipment</th>
            <th className="py-1.5 pr-3 text-[10px] font-semibold uppercase tracking-[0.05em] text-right" style={{ width: 85 }}>Labor</th>
            <th className="py-1.5 pr-3 text-[10px] font-semibold uppercase tracking-[0.05em] text-right" style={{ width: 95 }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const s = typeStyle(it.changeType);
            const equip = r2(it.qty * it.unitPrice);
            const total = r2(equip + it.laborPrice);
            return (
              <tr key={it.id} className="border-t border-border-soft">
                <td className="py-1.5 px-3">
                  <span
                    className="text-[10px] font-bold tracking-[0.08em] uppercase"
                    style={{ padding: '1px 6px', borderRadius: 4, color: s.color, background: s.bg }}
                  >
                    {s.label}
                  </span>
                </td>
                <td className="py-1.5 pr-3 font-mono">{it.qty}</td>
                <td className="py-1.5 pr-3">
                  <span className="font-mono font-semibold">{it.model}</span>
                  {it.manufacturer && <span className="text-fg-2"> · {it.manufacturer}</span>}
                  {it.description && <span className="text-fg-2"> — {it.description}</span>}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono" style={{ color: s.color }}>{fmtSignedCents(equip)}</td>
                <td className="py-1.5 pr-3 text-right font-mono" style={{ color: s.color }}>
                  {it.laborPrice !== 0 ? fmtSignedCents(it.laborPrice) : '—'}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono font-bold" style={{ color: s.color }}>{fmtSignedCents(total)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface ContractValueSummaryProps {
  projectValue?: string;
  changeOrders: ProjectChangeOrder[];
}

function ContractValueSummary({ projectValue, changeOrders }: ContractValueSummaryProps) {
  const approved = changeOrders.filter((c) => c.status === 'Approved');
  const pending = changeOrders.filter((c) => c.status === 'Pending');

  // Nothing to summarize if the project has no anchor value AND no COs —
  // the existing footer "DTools Project Total" already covers that case.
  if (!projectValue && approved.length === 0 && pending.length === 0) return null;

  const original = parseProjectValue(projectValue);
  const approvedDelta = approved.reduce((s, c) => s + c.amount, 0);
  const pendingExposure = pending.reduce((s, c) => s + c.amount, 0);
  const current = original + approvedDelta;

  return (
    <div
      className="border-t border-border"
      style={{ padding: '22px 22px 24px', background: 'rgba(34,50,110,0.03)' }}
    >
      <div className="text-[10px] font-bold text-fg-2 tracking-[0.15em] uppercase mb-4">
        Contract Value
      </div>
      <div
        className="grid items-center gap-4"
        style={{ gridTemplateColumns: '1fr auto 1fr auto 1.25fr' }}
      >
        <SummaryCol eyebrow="Original Contract" value={fmtUSD(original)} tone="neutral" />
        <SummaryOp symbol="+" />
        <SummaryCol
          eyebrow={`Approved CO${approved.length === 1 ? '' : 's'} · ${approved.length}`}
          value={fmtSigned(approvedDelta)}
          tone="approved"
        />
        <SummaryOp symbol="=" />
        <SummaryCol eyebrow="Current Contract Value" value={fmtUSD(current)} tone="hero" />
      </div>

      {pending.length > 0 && (
        <div
          className="mt-4 flex items-center justify-between gap-3.5 flex-wrap"
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            background: 'rgba(246,141,46,0.08)',
            border: '1px solid rgba(246,141,46,0.28)',
          }}
        >
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-bold tracking-[0.12em] uppercase text-orange">
              <span className="inline-block w-[7px] h-[7px] rounded-full bg-orange" />
              Pending Exposure
            </span>
            <span className="text-[13px] text-fg">
              <strong className="font-mono">{fmtSigned(pendingExposure)}</strong>
              <span className="text-fg-2">
                {' '}across {pending.length} pending CO{pending.length === 1 ? '' : 's'}
              </span>
            </span>
          </div>
          <span className="text-xs text-fg-2 italic">Not yet part of the contract</span>
        </div>
      )}
    </div>
  );
}

interface SummaryColProps {
  eyebrow: string;
  value: string;
  tone: 'neutral' | 'approved' | 'hero';
}

function SummaryCol({ eyebrow, value, tone }: SummaryColProps) {
  const isHero = tone === 'hero';
  const isApproved = tone === 'approved';
  const color = isHero ? 'var(--color-navy)' : isApproved ? '#15803D' : 'var(--color-fg)';
  return (
    <div>
      <div className="text-[10px] font-bold text-fg-2 tracking-[0.12em] uppercase">{eyebrow}</div>
      <div
        className="font-mono font-bold"
        style={{
          marginTop: 6,
          fontSize: isHero ? 30 : 22,
          color,
          letterSpacing: isHero ? '-0.01em' : 0,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SummaryOp({ symbol }: { symbol: string }) {
  return (
    <div
      className="font-mono text-fg-2 text-center select-none"
      style={{ fontSize: 22, fontWeight: 300 }}
    >
      {symbol}
    </div>
  );
}

// =============================================================================
// BoMLocationTree — collapsible Floor → Room → … hierarchy of BoM items
// =============================================================================

function BoMLocationTree({ bomItems }: { bomItems: BoMRow[] }) {
  const tree = useMemo(() => buildLocationTree(bomItems), [bomItems]);

  // Default state: only the top-level branches are expanded. Big projects
  // collapse rooms by default so the page is scannable.
  const initialExpanded = useMemo(() => {
    const set = new Set<string>();
    for (const top of tree.children.values()) set.add(top.fullPath);
    return set;
  }, [tree]);
  const [expanded, setExpanded] = useState<Set<string>>(initialExpanded);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const allPaths = useMemo(() => {
    const out: string[] = [];
    const walk = (n: LocationNode) => {
      if (n.fullPath) out.push(n.fullPath);
      for (const c of n.children.values()) walk(c);
    };
    walk(tree);
    return out;
  }, [tree]);

  const allExpanded = expanded.size === allPaths.length;

  return (
    <div>
      <div className="px-5.5 py-2.5 border-b border-border bg-surface/40 flex items-center justify-between text-xs" style={{ paddingLeft: 22, paddingRight: 22 }}>
        <div className="text-fg-2">
          {bomItems.length} line item{bomItems.length === 1 ? '' : 's'} across {tree.children.size} location{tree.children.size === 1 ? '' : 's'}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setExpanded(new Set(allPaths))}
            disabled={allExpanded}
            className="text-navy font-medium hover:underline disabled:opacity-40 disabled:no-underline"
          >
            Expand all
          </button>
          <span className="text-fg-3">·</span>
          <button
            onClick={() => setExpanded(new Set())}
            disabled={expanded.size === 0}
            className="text-navy font-medium hover:underline disabled:opacity-40 disabled:no-underline"
          >
            Collapse all
          </button>
        </div>
      </div>
      <div>
        {Array.from(tree.children.values())
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((node) => (
            <LocationBranch
              key={node.fullPath}
              node={node}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
            />
          ))}
      </div>
    </div>
  );
}

interface LocationBranchProps {
  node: LocationNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}

function LocationBranch({ node, depth, expanded, onToggle }: LocationBranchProps) {
  const isOpen = expanded.has(node.fullPath);
  const childCount = node.children.size;
  const itemCount = countNode(node);
  const subtotal = useMemo(() => nodeSubtotal(node), [node]);
  const hasMoney = subtotal.equip > 0 || subtotal.labor > 0;
  // Indent each level by ~20px so deep hierarchies stay scannable.
  const indent = 22 + depth * 20;

  return (
    <div className="border-t border-border first:border-t-0">
      <button
        onClick={() => onToggle(node.fullPath)}
        className="w-full flex items-center gap-2.5 py-2.5 text-left hover:bg-surface/50 transition-colors"
        style={{ paddingLeft: indent, paddingRight: 22 }}
      >
        <span className="text-fg-2 flex-shrink-0">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="text-[13px] font-semibold text-navy flex-1 min-w-0 truncate">
          {node.name}
        </span>
        <span className="text-[11px] text-fg-2 flex items-center gap-3 flex-shrink-0">
          {childCount > 0 && <span>{childCount} sub-location{childCount === 1 ? '' : 's'}</span>}
          <span>{itemCount} item{itemCount === 1 ? '' : 's'}</span>
          {hasMoney && (
            <span className="font-mono font-semibold text-navy">
              {fmtMoney(subtotal.equip + subtotal.labor)}
            </span>
          )}
        </span>
      </button>

      {isOpen && (
        <>
          {/* Items physically present at THIS node (not in deeper sub-locations) */}
          {node.items.length > 0 && (
            <div className="bg-white">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-navy/[0.04] text-fg-2 text-left">
                    <th className="py-1.5 text-[10px] font-semibold uppercase tracking-[0.05em]" style={{ paddingLeft: indent + 24, paddingRight: 22, width: 50 }}>Qty</th>
                    <th className="py-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] pr-5" style={{ width: 170 }}>Part #</th>
                    <th className="py-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] pr-5" style={{ width: 140 }}>Manufacturer</th>
                    <th className="py-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] pr-5">Description</th>
                    <th className="py-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] pr-5 text-right" style={{ width: 95 }}>Unit Price</th>
                    <th className="py-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] pr-5 text-right" style={{ width: 100 }}>Ext. Price</th>
                    <th className="py-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-right" style={{ width: 100, paddingRight: 22 }}>Labor</th>
                  </tr>
                </thead>
                <tbody>
                  {node.items.map(({ item, qty }, i) => {
                    const share = shareTotals(item, qty);
                    const isLabor = item.itemType === 'Labor';
                    const isHourly = isLabor && item.laborHours > 0;
                    return (
                      <tr key={`${item.id}-${i}`} className="border-t border-border-soft">
                        <td className="py-2 text-[13px] font-semibold font-mono align-top" style={{ paddingLeft: indent + 24, paddingRight: 22 }}>
                          {isHourly ? `${Number(qty.toFixed(2))} hr` : qty}
                        </td>
                        <td className="py-2 text-[13px] font-mono align-top pr-5">{item.model}</td>
                        <td className="py-2 text-[13px] text-fg-2 align-top pr-5">{item.manufacturer || (isLabor ? item.laborType : '')}</td>
                        <td className="py-2 text-[13px] align-top pr-5">{item.description}</td>
                        <td className="py-2 text-[13px] font-mono align-top pr-5 text-right">
                          {isLabor
                            ? (isHourly ? `${fmtMoney(item.laborUnitPrice)}/hr` : fmtMoney(item.unitPrice))
                            : fmtMoney(item.unitPrice)}
                        </td>
                        <td className="py-2 text-[13px] font-mono align-top pr-5 text-right">
                          {isLabor ? '—' : fmtMoney(share.equip)}
                        </td>
                        <td className="py-2 text-[13px] font-mono align-top text-right" style={{ paddingRight: 22 }}>
                          {share.labor > 0 ? fmtMoney(share.labor) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {/* Sub-locations below */}
          {Array.from(node.children.values())
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((child) => (
              <LocationBranch
                key={child.fullPath}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
              />
            ))}
        </>
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

// Section accent extends phase accent to include the Operations section,
// which is parallel to Pre/Post-Sales in the UI but technically lives
// under Post-Sales in the data model.
function sectionAccent(section: ProjectPhase | 'Operations'): string {
  if (section === 'Operations') return '#22C55E';
  return phaseAccent(section);
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

// =============================================================================
// MilestoneSummaryCard — next 3 upcoming/at-risk + overdue + completion %
// (Surfaces here per milestone-tracking spec §6.)
// =============================================================================

interface MilestoneRow {
  id: string;
  title: string;
  dueDate: string;
  completedDate?: string;
  ownerId?: string;
}

function MilestoneSummaryCard({ milestones, onOpen }: { milestones: MilestoneRow[]; onOpen: () => void }) {
  const total = milestones.length;
  const complete = milestones.filter((m) => !!m.completedDate).length;
  const overdue = milestones.filter((m) => computeMilestoneStatus(m) === 'overdue').length;
  const pct = total ? Math.round((complete / total) * 100) : 0;

  // Next 3 upcoming/at-risk/overdue, soonest first.
  const upcoming = milestones
    .filter((m) => !m.completedDate)
    .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''))
    .slice(0, 3);

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div
        className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3"
        style={{ background: '#22C55E08' }}
      >
        <div className="flex items-center gap-3">
          <div className="w-2 h-[30px] rounded" style={{ background: '#22C55E' }} />
          <div>
            <div className="text-[10px] font-bold tracking-[0.15em] uppercase" style={{ color: '#22C55E' }}>
              Milestones
            </div>
            <div className="text-sm font-semibold text-navy mt-0.5">
              <strong style={{ color: '#15803D' }}>{complete}</strong> of {total} complete
              {overdue > 0 && (
                <span className="ml-2.5 inline-flex items-center gap-1 text-red-700 text-xs font-bold align-middle">
                  <Calendar size={11} /> {overdue} overdue
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xl font-bold text-navy font-mono">{pct}%</div>
          <button onClick={onOpen} className="btn-secondary text-xs">Open Schedule</button>
        </div>
      </div>
      {upcoming.length === 0 ? (
        <div className="px-5 py-6 text-center text-sm text-fg-2">
          All milestones complete. 🎉
        </div>
      ) : (
        <div>
          {upcoming.map((m, i) => {
            const status = computeMilestoneStatus(m);
            const color = status === 'overdue' ? '#B91C1C' : status === 'at_risk' ? '#A16207' : '#4B5563';
            return (
              <div
                key={m.id}
                className={`flex items-center gap-3.5 px-5 py-3 ${i === 0 ? '' : 'border-t border-border'}`}
              >
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: `${color}14`, color }}
                >
                  <Calendar size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-fg truncate">{m.title}</div>
                  <div className="text-xs text-fg-2 mt-0.5 capitalize">{status.replace('_', ' ')}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[13px]" style={{ color }}>{m.dueDate || '—'}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
