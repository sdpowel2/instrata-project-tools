import { useEffect, useMemo, useState } from 'react';
import { FileSpreadsheet, FileText, Pencil, Printer, RotateCcw, Check, X, AlertTriangle, Loader2, Lock } from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../contexts/AuthContext';
import { Modal } from './Modal';
import { Eyebrow } from './ui';
import type { Project, ProjectBoMItem, GrossMarginForm } from '../types';
import {
  computeGrossMarginForm, mergeOverrides, recomputeForm, getFormValue,
  DEFAULT_SPECIAL_MODELS, type SpecialModels,
} from '../utils/grossMargin';
import { loadSpecialModels } from '../lib/gmSettings';
import { exportGrossMarginPDF } from '../utils/exportGrossMarginPDF';

const usd = (n: number) => '$' + (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hrsFmt = (n: number | undefined) => (n != null && n !== 0 ? `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} hrs` : '—');

// =============================================================================
// Project Documentation card — sits below the Project Quote on the overview.
// Lists the auto-generated reports built from a synced BoM. Phase 1: the
// Gross Margin Form.
// =============================================================================
export function ProjectDocumentationSection({ project }: { project: Project }) {
  const allBoM = useStore((s) => s.projectBoM);
  const myProjectIds = useStore((s) => s.myProjectIds);
  const fetchProjectDocuments = useStore((s) => s.fetchProjectDocuments);
  const documentsLoadedFor = useStore((s) => s.documentsLoadedFor);
  const { isAdmin } = useAuth();

  const bomItems = useMemo(() => allBoM.filter((i) => i.projectId === project.id), [allBoM, project.id]);
  const synced = project.dtoolsBomStatus === 'found';
  const canEdit = isAdmin || myProjectIds.has(project.id);

  const [gmOpen, setGmOpen] = useState(false);

  useEffect(() => {
    if (synced && !documentsLoadedFor.has(project.id)) fetchProjectDocuments(project.id);
  }, [synced, project.id, documentsLoadedFor, fetchProjectDocuments]);

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-5.5 py-4 border-b border-border flex items-center gap-3.5" style={{ paddingLeft: 22, paddingRight: 22 }}>
        <div className="w-11 h-11 rounded-[10px] bg-navy/[0.06] text-navy flex items-center justify-center">
          <FileText size={22} />
        </div>
        <div>
          <Eyebrow>Documentation</Eyebrow>
          <h2 className="text-lg font-bold text-navy m-0 mt-0.5">Project Documentation</h2>
          <div className="text-xs text-fg-2 mt-0.5">
            Reports generated from the synced bill of materials.
          </div>
        </div>
      </div>

      {!synced ? (
        <div className="px-6 py-10 text-center">
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-3">
            <AlertTriangle size={22} />
          </div>
          <div className="text-sm font-semibold text-navy">Sync with DTools first</div>
          <div className="text-[13px] text-fg-2 max-w-[460px] mx-auto mt-1.5">
            This project must be synced with DTools before project documentation can be generated.
            Sync the bill of materials from the Project Quote above, then come back here.
          </div>
        </div>
      ) : (
        <div className="divide-y divide-border">
          <DocumentRow
            icon={<FileSpreadsheet size={18} />}
            title="Gross Margin Form"
            description="Project labor, equipment and tax totals for accounting to open the project. Auto-filled from DTools; editable to match the quote."
            onOpen={() => setGmOpen(true)}
          />
        </div>
      )}

      <GrossMarginFormModal
        project={project}
        bomItems={bomItems}
        canEdit={canEdit}
        open={gmOpen}
        onClose={() => setGmOpen(false)}
      />
    </div>
  );
}

function DocumentRow({ icon, title, description, onOpen }: {
  icon: React.ReactNode; title: string; description: string; onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-4 px-5.5 py-4 hover:bg-surface/60 transition-colors" style={{ paddingLeft: 22, paddingRight: 22 }}>
      <div className="w-9 h-9 rounded-lg bg-navy/[0.06] text-navy flex items-center justify-center shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-navy">{title}</div>
        <div className="text-xs text-fg-2 mt-0.5">{description}</div>
      </div>
      <button onClick={onOpen} className="btn-secondary text-sm shrink-0">Open</button>
    </div>
  );
}

// =============================================================================
// Gross Margin Form — view / edit / print.
// =============================================================================
type Edits = Record<string, number | string>;

function GrossMarginFormModal({ project, bomItems, canEdit, open, onClose }: {
  project: Project; bomItems: ProjectBoMItem[]; canEdit: boolean; open: boolean; onClose: () => void;
}) {
  const projectDocuments = useStore((s) => s.projectDocuments);
  const saveProjectDocument = useStore((s) => s.saveProjectDocument);

  const [special, setSpecial] = useState<SpecialModels>(DEFAULT_SPECIAL_MODELS);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Edits>({});
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);

  const doc = useMemo(
    () => projectDocuments.find((d) => d.projectId === project.id && d.docType === 'gross_margin'),
    [projectDocuments, project.id],
  );

  // Load the org-wide special-line model strings once when opened.
  useEffect(() => { if (open) loadSpecialModels().then(setSpecial); }, [open]);

  // Seed the editable draft from the saved overrides whenever we (re)open.
  useEffect(() => {
    if (open) { setEdits({ ...(doc?.overrides ?? {}) }); setEditing(false); }
  }, [open, doc]);

  const base = useMemo(() => computeGrossMarginForm(project, bomItems, special), [project, bomItems, special]);
  const form = useMemo(() => recomputeForm(mergeOverrides(base, edits), project), [base, edits, project]);

  const isOverridden = (path: string) => path in edits && edits[path] !== getFormValue(base, path);
  const dirty = useMemo(
    () => JSON.stringify(diffFromBase(base, edits)) !== JSON.stringify(doc?.overrides ?? {}),
    [base, edits, doc],
  );

  const setField = (path: string, value: number | string) =>
    setEdits((e) => ({ ...e, [path]: value }));
  const resetField = (path: string) =>
    setEdits((e) => { const n = { ...e }; delete n[path]; return n; });

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveProjectDocument({
        projectId: project.id,
        docType: 'gross_margin',
        overrides: diffFromBase(base, edits),
      });
      setEditing(false);
    } finally { setSaving(false); }
  };

  const handlePrint = async () => {
    setPrinting(true);
    try { await exportGrossMarginPDF(project, form); }
    finally { setPrinting(false); }
  };

  const handleResetAll = () => setEdits({});

  return (
    <Modal open={open} onClose={onClose} title="Gross Margin Form" wide>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2 text-xs">
          {form.verified ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-600 font-medium">
              <Check size={14} /> Reconciles to DTools total
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-amber-600 font-medium" title={`Δ cost ${usd(form.drift.cost)} · Δ price ${usd(form.drift.price)}`}>
              <AlertTriangle size={14} /> Off DTools by {usd(form.drift.price)} (price) — review
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handlePrint} disabled={printing} className="btn-secondary text-sm disabled:opacity-60">
            {printing ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />} Print PDF
          </button>
          {!editing ? (
            canEdit ? (
              <button onClick={() => setEditing(true)} className="btn-orange text-sm"><Pencil size={14} /> Edit</button>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-fg-2"><Lock size={13} /> Join project to edit</span>
            )
          ) : (
            <>
              <button onClick={handleResetAll} className="btn-secondary text-sm" title="Reset every field to the synced value">
                <RotateCcw size={14} /> Reset all
              </button>
              <button onClick={() => { setEdits({ ...(doc?.overrides ?? {}) }); setEditing(false); }} className="btn-secondary text-sm">
                <X size={14} /> Cancel
              </button>
              <button onClick={handleSave} disabled={saving || !dirty} className="btn-orange text-sm disabled:opacity-60">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
              </button>
            </>
          )}
        </div>
      </div>

      {/* Job Specific Information */}
      <Section title="Job Specific Information">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
          <TextField label="Project Name" path="header.projectName" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="Quote Number" path="header.quoteNumber" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="Client Name" path="header.clientName" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="PO Number" path="header.poNumber" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="Site Address" path="header.siteAddress" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="Sales Rep" path="header.salesRep" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="Billing Address" path="header.billingAddress" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="Engineer" path="header.engineer" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="Client Email" path="header.clientEmail" {...{ form, base, editing, isOverridden, setField, resetField }} />
        </div>
      </Section>

      {/* Quote Specific Information */}
      <Section title="Quote Specific Information">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-fg-2">
                <th className="text-left font-bold py-1.5"></th>
                <th className="text-right font-bold py-1.5 w-28">Hours</th>
                <th className="text-right font-bold py-1.5 w-36">Cost</th>
                <th className="text-right font-bold py-1.5 w-36">Price</th>
              </tr>
            </thead>
            <tbody>
              <AmountRow label="Install Hours" form={form} editing={editing} isOverridden={isOverridden} setField={setField} resetField={resetField} hoursPath="installHours.hours" costPath="installHours.cost" pricePath="installHours.price" />
              <AmountRow label="Programming Hours" form={form} editing={editing} isOverridden={isOverridden} setField={setField} resetField={resetField} hoursPath="programmingHours.hours" costPath="programmingHours.cost" pricePath="programmingHours.price" />
              <AmountRow label="Travel" form={form} editing={editing} isOverridden={isOverridden} setField={setField} resetField={resetField} hoursPath="travel.hours" costPath="travel.cost" pricePath="travel.price" />
              <DerivedRow label="Labor Totals" hours={form.laborTotals.hours} cost={form.laborTotals.cost} price={form.laborTotals.price} />
              <SpacerRow />
              <AmountRow label="Equipment" form={form} editing={editing} isOverridden={isOverridden} setField={setField} resetField={resetField} costPath="equipment.cost" pricePath="equipment.price" />
              <AmountRow label="Subcontractor" form={form} editing={editing} isOverridden={isOverridden} setField={setField} resetField={resetField} costPath="subcontractor.cost" pricePath="subcontractor.price" />
              <AmountRow label="Equipment Rental" form={form} editing={editing} isOverridden={isOverridden} setField={setField} resetField={resetField} costPath="equipmentRental.cost" pricePath="equipmentRental.price" />
              <AmountRow label="Permits" form={form} editing={editing} isOverridden={isOverridden} setField={setField} resetField={resetField} costPath="permits.cost" pricePath="permits.price" />
              <DerivedRow label="Equipment Totals" cost={form.equipmentTotals.cost} price={form.equipmentTotals.price} />
              <SpacerRow />
              <DerivedRow label="PROJECT TOTALS" cost={form.projectTotals.cost} price={form.projectTotals.price} strong />
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-fg-2 mt-2">
          Project totals exclude Premiere Protect (shown below) and reconcile to the DTools project total.
          Subcontractor, Equipment Rental and Permits are reported here as equipment even though DTools carries them as fixed labor.
        </p>
      </Section>

      {/* Tax Information */}
      <Section title="Tax Information">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-2.5">
          <PctField label="Tax Rate" path="tax.rate" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <UsdField label="Materials Tax" path="tax.materialsTax" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <UsdField label="Labor Tax" path="tax.laborTax" {...{ form, base, editing, isOverridden, setField, resetField }} />
        </div>
      </Section>

      {/* Custom Job Information */}
      <Section title="Custom Job Information">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
          <TextField label="Subsidiary" path="custom.subsidiary" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="Branch" path="custom.branch" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="Project Type" path="custom.projectType" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="AIA Invoicing Required" path="custom.aiaInvoicing" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="Prevailing Wage" path="custom.prevailingWage" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="T&M?" path="custom.timeAndMaterials" {...{ form, base, editing, isOverridden, setField, resetField }} />
          <TextField label="Material Only?" path="custom.materialOnly" {...{ form, base, editing, isOverridden, setField, resetField }} />
        </div>
        <div className="mt-4 pt-3 border-t border-border">
          <div className="text-[10px] uppercase tracking-wider text-fg-2 font-bold mb-2">Premiere Protect</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
            <UsdField label="Cost" path="premiereProtect.cost" {...{ form, base, editing, isOverridden, setField, resetField }} />
            <UsdField label="Price" path="premiereProtect.price" {...{ form, base, editing, isOverridden, setField, resetField }} />
          </div>
        </div>
      </Section>
    </Modal>
  );
}

// ── Shared field props ───────────────────────────────────────────────────────
interface FieldProps {
  label: string;
  path: string;
  form: GrossMarginForm;
  base: GrossMarginForm;
  editing: boolean;
  isOverridden: (p: string) => boolean;
  setField: (p: string, v: number | string) => void;
  resetField: (p: string) => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <div className="text-xs font-bold text-navy uppercase tracking-wider bg-surface/70 rounded px-3 py-1.5 mb-3">{title}</div>
      {children}
    </section>
  );
}

function OverrideDot({ on }: { on: boolean }) {
  if (!on) return null;
  return <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 ml-1.5 align-middle" title="Edited — differs from the synced value" />;
}

function TextField({ label, path, form, base, editing, isOverridden, setField, resetField }: FieldProps) {
  const val = String(getFormValue(form, path) ?? '');
  const overridden = isOverridden(path);
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold text-navy">{label}<OverrideDot on={overridden} /></div>
        {editing ? (
          <input className="input text-sm mt-0.5 w-full" value={val} onChange={(e) => setField(path, e.target.value)} />
        ) : (
          <div className="text-sm text-fg mt-0.5 break-words">{val || '—'}</div>
        )}
      </div>
      {editing && overridden && (
        <button onClick={() => resetField(path)} className="text-fg-2 hover:text-navy mt-4" title={`Reset to synced: ${String(getFormValue(base, path) || '—')}`}><RotateCcw size={13} /></button>
      )}
    </div>
  );
}

/** Controlled number input with a text buffer so a parent reset flows in but
 *  in-progress typing (e.g. a trailing ".") isn't clobbered on every keystroke.
 *  `scale` lets the percent field edit in whole-percent units while storing the
 *  fraction. */
function NumberInput({ value, onChange, scale = 1, className = '' }: {
  value: number; onChange: (n: number) => void; scale?: number; className?: string;
}) {
  const display = value * scale;
  const [text, setText] = useState(String(display));
  // Sync the buffer when the external value changes (e.g. a Reset), but leave
  // in-progress typing (like a trailing ".") untouched on each keystroke.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { if ((parseFloat(text) || 0) !== display) setText(String(display)); }, [display]);
  return (
    <input type="number" step="0.01" className={`input text-sm font-mono text-right ${className}`}
      value={text}
      onChange={(e) => { setText(e.target.value); onChange((parseFloat(e.target.value) || 0) / scale); }} />
  );
}

function NumericField({ label, path, form, base, editing, isOverridden, setField, resetField, render, scale }: FieldProps & {
  render: (n: number) => string; scale?: number;
}) {
  const num = Number(getFormValue(form, path) ?? 0);
  const overridden = isOverridden(path);
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold text-navy">{label}<OverrideDot on={overridden} /></div>
        {editing ? (
          <NumberInput value={num} scale={scale} className="mt-0.5 w-full" onChange={(n) => setField(path, n)} />
        ) : (
          <div className="text-sm text-fg mt-0.5 font-mono">{render(num)}</div>
        )}
      </div>
      {editing && overridden && (
        <button onClick={() => resetField(path)} className="text-fg-2 hover:text-navy mt-4" title={`Reset to synced: ${render(Number(getFormValue(base, path) ?? 0))}`}><RotateCcw size={13} /></button>
      )}
    </div>
  );
}

function UsdField(p: FieldProps) {
  return <NumericField {...p} render={usd} />;
}
function PctField(p: FieldProps) {
  // Stored fractional (0.0725); edited / shown as percent.
  return <NumericField {...p} render={(n) => `${(n * 100).toFixed(2)}%`} scale={100} />;
}

// ── Quote table rows ─────────────────────────────────────────────────────────
function moneyInput(value: number, onChange: (n: number) => void) {
  return <NumberInput value={value} onChange={onChange} className="w-full py-1" />;
}

function AmountRow({ label, form, editing, isOverridden, setField, resetField, hoursPath, costPath, pricePath }: {
  label: string; form: GrossMarginForm; editing: boolean;
  isOverridden: (p: string) => boolean; setField: (p: string, v: number) => void; resetField: (p: string) => void;
  hoursPath?: string; costPath: string; pricePath: string;
}) {
  const cost = Number(getFormValue(form, costPath) ?? 0);
  const price = Number(getFormValue(form, pricePath) ?? 0);
  const hours = hoursPath ? Number(getFormValue(form, hoursPath) ?? 0) : undefined;
  const anyOver = (hoursPath ? isOverridden(hoursPath) : false) || isOverridden(costPath) || isOverridden(pricePath);
  return (
    <tr className="border-t border-border/60">
      <td className="py-1.5 text-fg">
        {label}<OverrideDot on={anyOver} />
        {editing && anyOver && (
          <button onClick={() => { if (hoursPath) resetField(hoursPath); resetField(costPath); resetField(pricePath); }}
            className="text-fg-2 hover:text-navy ml-2 align-middle" title="Reset row to synced"><RotateCcw size={12} /></button>
        )}
      </td>
      <td className="py-1.5 text-right font-mono text-fg-2">
        {hoursPath ? (editing ? moneyInput(hours ?? 0, (n) => setField(hoursPath, n)) : hrsFmt(hours)) : ''}
      </td>
      <td className="py-1.5 text-right font-mono">{editing ? moneyInput(cost, (n) => setField(costPath, n)) : usd(cost)}</td>
      <td className="py-1.5 text-right font-mono">{editing ? moneyInput(price, (n) => setField(pricePath, n)) : usd(price)}</td>
    </tr>
  );
}

function DerivedRow({ label, hours, cost, price, strong }: { label: string; hours?: number; cost: number; price: number; strong?: boolean }) {
  return (
    <tr className={`border-t ${strong ? 'border-navy/30' : 'border-border'}`}>
      <td className={`py-1.5 ${strong ? 'font-bold text-navy' : 'font-semibold text-navy'}`}>{label}</td>
      <td className="py-1.5 text-right font-mono text-fg-2">{hours != null ? hrsFmt(hours) : ''}</td>
      <td className={`py-1.5 text-right font-mono ${strong ? 'font-bold text-navy' : 'font-semibold'}`}>{usd(cost)}</td>
      <td className={`py-1.5 text-right font-mono ${strong ? 'font-bold text-navy' : 'font-semibold'}`}>{usd(price)}</td>
    </tr>
  );
}

function SpacerRow() { return <tr><td className="py-1" colSpan={4} /></tr>; }

// ── Overrides helper ───────────────────────────────────────────────────────
/** Keep only the edits that actually differ from the freshly-computed base, so
 *  a field nudged back to its synced value drops out of the stored overrides. */
function diffFromBase(base: GrossMarginForm, edits: Edits): Edits {
  const out: Edits = {};
  for (const [path, value] of Object.entries(edits)) {
    if (value !== getFormValue(base, path)) out[path] = value;
  }
  return out;
}
