// Pre-Sales / Post-Sales engineering effort surveys.
//
// Phase 1: localStorage-backed only. Question copy ported verbatim from the
// design mockup. Phase 2 will move persistence to Supabase + tie revisions to
// concrete project checkpoints (e.g. "25% drawings complete").
//
// Each project gets one of each survey kind. The author can submit once, then
// produce one revision at a defined checkpoint. Both versions are retained.

import { Fragment, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ClipboardCheck, Sparkles, Check } from 'lucide-react';
import { useStore } from '../store';
import { useAuth } from '../contexts/AuthContext';
import { ProjectHeader } from '../components/ProjectHeader';
import { PhaseRibbon } from '../components/PhaseRibbon';
import type { Project, ProjectPhase } from '../types';

// =============================================================================
// Survey kind + persistence
// =============================================================================

export type SurveyKind = 'pre-sales' | 'post-sales';

export interface SurveyState {
  data: Record<string, unknown>;
  submitted: boolean;
  submittedAt?: string;
  submittedBy?: string;
  revision: null | {
    data: Record<string, unknown>;
    submittedAt: string | null;
    submittedBy?: string;
  };
}

const KEY = (projectId: string, kind: SurveyKind) => `instrata-survey-${kind}-${projectId}`;

export function loadSurveyState(projectId: string, kind: SurveyKind): SurveyState {
  try {
    const raw = localStorage.getItem(KEY(projectId, kind));
    if (raw) return JSON.parse(raw) as SurveyState;
  } catch { /* ignore */ }
  return { data: {}, submitted: false, revision: null };
}

function saveSurveyState(projectId: string, kind: SurveyKind, state: SurveyState) {
  try { localStorage.setItem(KEY(projectId, kind), JSON.stringify(state)); }
  catch { /* ignore */ }
}

// =============================================================================
// Field configuration
// =============================================================================

type FieldType = 'text' | 'number' | 'date' | 'textarea' | 'checkboxes' | 'radio' | 'yesno';

interface FieldDef {
  id: string;
  type: FieldType;
  label?: string;
  placeholder?: string;
  hint?: string;
  options?: string[];
  /** Auto-fill from a project field, e.g. 'project.name' */
  prefill?: string;
  span?: 1 | 2 | 3;
  mono?: boolean;
}

interface SectionDef {
  id: string;
  title: string;
  subtitle?: string;
  note?: string;
  optional?: boolean;
  fields: FieldDef[];
}

interface SurveyConfig {
  title: string;
  phase: ProjectPhase;
  purpose: string;
  when: string;
  time: string;
  revisionCheckpoint: string;
  sections: SectionDef[];
}

const POST_SALES_SURVEY: SurveyConfig = {
  title: 'Post-Sales Effort Level Survey',
  phase: 'Post-Sales',
  purpose: 'Capture structured complexity and effort data so we can plan workload and team capacity.',
  when: 'After contract execution and initial project review, before detailed design work begins.',
  time: '30–60 minutes of review before answering.',
  revisionCheckpoint: 'at 25% drawings complete',
  sections: [
    { id: 'basics', title: 'Project Basics', subtitle: "Pre-populated from Monday — confirm and add what's missing.", fields: [
      { id: 'projectName',   type: 'text',     label: 'Project Name',           prefill: 'project.name' },
      { id: 'jobNumber',     type: 'text',     label: 'Job Number',             prefill: 'project.number', mono: true },
      { id: 'client',        type: 'text',     label: 'Client',                 prefill: 'project.client' },
      { id: 'location',      type: 'text',     label: 'Location',               placeholder: 'e.g. Denver, CO' },
      { id: 'contractValue', type: 'text',     label: 'Contracted Value',       prefill: 'project.value', mono: true },
      { id: 'substCompDate', type: 'date',     label: 'Target Substantial Completion' },
      { id: 'scopeSummary',  type: 'textarea', label: 'Confirmed Scope Summary', hint: '1–2 sentences — what are we building?', span: 2 },
    ] },
    { id: 'rooms', title: 'Room Inventory', subtitle: 'The single highest-signal section. Drives the unique-vs-total duplication ratio.', note: 'A "unique room type" is a distinct design that needs its own drawings. A typical applied to 10 rooms counts as 1 unique type.', fields: [
      { id: 'uniqueRoomTypes', type: 'number', label: 'Unique Room Types', hint: 'e.g. 3' },
      { id: 'totalRooms',      type: 'number', label: 'Total Rooms', hint: 'e.g. 30' },
      { id: 'customRooms',     type: 'number', label: 'Rooms Requiring Custom Design', hint: "Rooms that don't fit any typical" },
    ] },
    { id: 'deliverables', title: 'Deliverables Required', subtitle: 'Check everything this project will require from engineering.', note: "If you're not sure, check it — better to overestimate than miss scope.", fields: [
      { id: 'deliverables', type: 'checkboxes', options: [
        'Line diagrams / signal flow',
        'Floor plans',
        'Reflected ceiling plans (RCP)',
        'Rack elevations',
        'Cable schedules',
        'Control system details / GUI layouts',
        'AutoCAD symbol development',
        'Mounting details / custom brackets',
        'Submittals package',
        'Engineering narrative / SOW',
        'Programming documentation',
        'As-builts',
        'Closeout documentation',
        'O&M manuals',
      ] },
    ] },
    { id: 'coordination', title: 'Coordination Factors', subtitle: 'Select anything that will consume engineering time beyond the design work itself.', fields: [
      { id: 'coordination', type: 'checkboxes', options: [
        'GC coordination required (meetings, schedule)',
        'Consultant review cycles expected',
        'AHJ / permitting involvement',
        'Owner design review meetings',
        'Integration with other trades',
        'Existing conditions survey required',
        'Commissioning agent involvement',
        'Unusual logistical factors (secure facility, active ops, after-hours)',
      ] },
    ] },
    { id: 'duration', title: 'Duration Estimate', subtitle: 'Estimate in hours, as if this were your only project.', note: 'The likely estimate is not a commitment. Wide spreads are a useful signal, not a sign of poor estimation.', fields: [
      { id: 'hoursOptimistic',  type: 'number', label: 'Optimistic (hours)',  hint: 'Everything goes smoothly' },
      { id: 'hoursLikely',      type: 'number', label: 'Likely (hours)',      hint: 'Best guess under normal conditions' },
      { id: 'hoursPessimistic', type: 'number', label: 'Pessimistic (hours)', hint: 'Revisions + coordination issues' },
    ] },
    { id: 'complexity', title: 'Complexity Notes', optional: true, subtitle: 'Optional — catch anything the structured fields miss.', fields: [
      { id: 'complexityNotes', type: 'textarea', label: 'Notes', placeholder: 'Unusual client dynamics, site conditions, novel system design, unclear scope…', span: 2 },
    ] },
    { id: 'resources', title: 'Resource Needs', optional: true, subtitle: 'Surface help needs early, not at crisis.', fields: [
      { id: 'needsHelp',     type: 'yesno',    label: 'Will you need help from another engineer?' },
      { id: 'helpPortion',   type: 'text',     label: 'If yes, which portion?', placeholder: 'e.g. DSP programming' },
      { id: 'secondOpinion', type: 'textarea', label: "Subject-matter areas where you'd like a second opinion", span: 2 },
      { id: 'trainingNeeds', type: 'textarea', label: 'Training or documentation that would help', span: 2 },
    ] },
  ],
};

const PRE_SALES_SURVEY: SurveyConfig = {
  title: 'Pre-Sales Effort Level Survey',
  phase: 'Pre-Sales',
  purpose: 'Capture structured effort data to drive workload estimation, go/no-go decisions, and calibration.',
  when: 'Immediately after triage assignment, before substantive quoting work begins.',
  time: '10–15 minutes based on skimming the RFP / design package.',
  revisionCheckpoint: 'if an addendum significantly changes scope',
  sections: [
    { id: 'basics', title: 'Project Basics', fields: [
      { id: 'projectName', type: 'text', label: 'Project Name',   prefill: 'project.name' },
      { id: 'client',      type: 'text', label: 'Client',         prefill: 'project.client' },
      { id: 'location',    type: 'text', label: 'Location',       placeholder: 'e.g. Denver, CO' },
      { id: 'leadSource',  type: 'text', label: 'Lead Source',    placeholder: 'Monday / referral / repeat client' },
      { id: 'budgetRange', type: 'text', label: 'Budget Range',   placeholder: 'e.g. $150K–$250K', mono: true },
      { id: 'dueDate',     type: 'date', label: 'Due / Bid Date', hint: 'Flag if less than 5 business days out' },
    ] },
    { id: 'projectType', title: 'Project Type', subtitle: 'Pick the closest match. Drives downstream logic.', fields: [
      { id: 'projectType', type: 'radio', options: [
        'RFP / public bid',
        'Private bid / invited bid',
        'Design project',
        'Design-build',
        'Budgetary quote',
        'Re-quote / revision of prior quote',
      ] },
    ] },
    { id: 'inventory', title: 'Room & System Inventory', note: 'Systems-per-room-type is often the biggest driver of quoting time.', fields: [
      { id: 'uniqueRoomTypes', type: 'number',   label: 'Unique Room Types' },
      { id: 'totalRooms',      type: 'number',   label: 'Total Rooms' },
      { id: 'systemsPerType',  type: 'textarea', label: 'Systems per room type', placeholder: 'e.g. Standard conf: display + soundbar + single camera. Boardroom: dual display + DSP + PTZ + control.', span: 3 },
    ] },
    { id: 'pricing', title: 'Pricing Complexity', subtitle: 'Manufacturer-direct pricing is the biggest hidden time sink in quoting.', fields: [
      { id: 'lineItemBucket', type: 'radio', label: 'Estimated line item count', options: ['< 50', '50–150', '150–400', '400+'] },
      { id: 'mfrDirectCount', type: 'number', label: 'Items requiring MFR-direct pricing' },
      { id: 'dealRegCount',   type: 'number', label: 'Items requiring project / deal registration' },
      { id: 'longLeadCount',  type: 'number', label: 'Items with unclear or long lead times' },
      { id: 'allocatedNotes', type: 'textarea', label: 'Known long-lead or allocated products', placeholder: 'Anything needing early commitment', span: 2 },
    ] },
    { id: 'docs', title: 'Document Complexity', subtitle: 'For RFP/bid projects. If this is a design project, the design-specific block below applies.', fields: [
      { id: 'rfpPages',          type: 'radio',      label: 'RFP page count',    options: ['< 25', '25–75', '75–200', '200+'] },
      { id: 'specDivisions',     type: 'checkboxes', label: 'Specification divisions', options: ['Div 26 (Electrical)', 'Div 27 (Communications)', 'Div 28 (Safety/Security)', 'Other'] },
      { id: 'drawingSheetCount', type: 'number',     label: 'Drawing sheet count' },
      { id: 'qaWindow',          type: 'text',       label: 'Q&A deadline vs. bid deadline window', placeholder: 'e.g. 7 days' },
      { id: 'addendaExpected',   type: 'yesno',      label: 'Addenda expected?' },
      { id: 'complianceDocs',    type: 'checkboxes', label: 'Required compliance documents', options: ['Bonds', 'Insurance', 'References', 'Qualifications', 'Bid form', 'Exceptions list'] },
    ] },
    { id: 'designBlock', title: 'Design Project Specifics', optional: true, subtitle: 'Fill out if this is a design project, design-build, or design assist.', fields: [
      { id: 'existingDrawings',     type: 'yesno',      label: 'Existing drawings provided?' },
      { id: 'drawingTypesProvided', type: 'checkboxes', label: 'Types provided', options: ['Architectural', 'MEP', 'Structural', 'Other'] },
      { id: 'siteVisitRequired',    type: 'yesno',      label: 'Site visit required?' },
      { id: 'narrativeProvided',    type: 'yesno',      label: 'Programming / narrative provided?' },
      { id: 'relationship',         type: 'radio',      label: 'Relationship', options: ['Consultant', 'Direct-to-owner', 'Unsure'] },
    ] },
    { id: 'deliverables', title: 'Deliverables Required', subtitle: 'Check everything this response will require.', note: 'Bid forms and exceptions lists often consume more time than people expect.', fields: [
      { id: 'deliverables', type: 'checkboxes', options: [
        'Line item quote / pricing schedule',
        'Narrative / scope of work',
        'Bid form completion',
        'Preliminary line diagrams',
        'Preliminary floor plans',
        'Alternates / options pricing',
        'Value engineering proposal',
        'Exceptions / clarifications list',
        'Bonds and insurance documentation',
        'References / qualifications package',
        'Presentation materials (shortlist interview)',
      ] },
    ] },
    { id: 'duration', title: 'Duration Estimate', subtitle: 'Estimate in hours, not days. Likely estimate feeds capacity planning.', note: 'This is not a commitment. You will not be held to these numbers.', fields: [
      { id: 'hoursOptimistic',  type: 'number', label: 'Optimistic (hours)' },
      { id: 'hoursLikely',      type: 'number', label: 'Likely (hours)' },
      { id: 'hoursPessimistic', type: 'number', label: 'Pessimistic (hours)' },
    ] },
    { id: 'fit', title: 'Subject Matter & Assignment Fit', note: "A reassignment in the first day is cheap. At the midway point, it's expensive.", fields: [
      { id: 'domainFit',   type: 'radio', label: 'Does this project fall within your typical domain?', options: ['Yes', 'Adjacent', 'Unfamiliar'] },
      { id: 'betterMatch', type: 'text',  label: 'Is there another engineer better matched?', placeholder: 'Optional — name or leave blank' },
      { id: 'smeInput',    type: 'text',  label: 'Need SME input? From whom?', placeholder: 'Optional' },
    ] },
    { id: 'pursuit', title: 'Pursuit Considerations', optional: true, subtitle: 'Your read on this matters. Management decides, but engineer perspective is useful.', fields: [
      { id: 'redFlags',       type: 'textarea', label: 'Red flags in the RFP or client relationship', span: 2 },
      { id: 'winProbability', type: 'radio',    label: 'Win probability gut feel', options: ['High', 'Medium', 'Low', 'No idea'] },
      { id: 'strategicValue', type: 'textarea', label: 'Strategic value beyond this project', placeholder: 'New client, new market, reference project…', span: 2 },
    ] },
    { id: 'complexity', title: 'Complexity Notes', optional: true, subtitle: 'Anything the structured fields miss.', fields: [
      { id: 'complexityNotes', type: 'textarea', label: 'Notes', span: 3 },
    ] },
  ],
};

// =============================================================================
// Page
// =============================================================================

export function EffortSurveyPage({ kind }: { kind: SurveyKind }) {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const { user } = useAuth();

  const config = kind === 'pre-sales' ? PRE_SALES_SURVEY : POST_SALES_SURVEY;
  const [state, setState] = useState<SurveyState>(() =>
    projectId ? loadSurveyState(projectId, kind) : { data: {}, submitted: false, revision: null },
  );
  const [editing, setEditing] = useState(!state.submitted);
  const [revising, setRevising] = useState(false);

  if (!project) {
    return (
      <div className="px-8 pt-7 pb-10">
        <div className="text-fg-2 text-sm">Project not found.</div>
        <button onClick={() => navigate('/projects')} className="btn-secondary mt-4">
          Back to projects
        </button>
      </div>
    );
  }

  const resolvePrefill = (f: FieldDef): string => {
    if (!f.prefill) return '';
    const [obj, key] = f.prefill.split('.');
    if (obj === 'project' && key) {
      const v = (project as unknown as Record<string, unknown>)[key];
      return typeof v === 'string' ? v : v == null ? '' : String(v);
    }
    return '';
  };

  const activeVersion: 'original' | 'revision' = revising || state.revision ? 'revision' : 'original';
  const data = activeVersion === 'revision'
    ? (state.revision?.data ?? {})
    : state.data;

  const setField = (id: string, val: unknown) => {
    if (!projectId) return;
    setState((prev) => {
      const next: SurveyState = { ...prev };
      if (revising) {
        next.revision = next.revision ?? { data: { ...prev.data }, submittedAt: null };
        next.revision = { ...next.revision, data: { ...next.revision.data, [id]: val } };
      } else {
        next.data = { ...prev.data, [id]: val };
      }
      saveSurveyState(projectId, kind, next);
      return next;
    });
  };

  const handleSubmit = () => {
    if (!projectId) return;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const submittedBy = user?.fullName || user?.email || 'Unknown';
    setState((prev) => {
      const next: SurveyState = { ...prev };
      if (revising) {
        next.revision = { ...(next.revision ?? { data: { ...prev.data }, submittedAt: null }), submittedAt: stamp, submittedBy };
      } else {
        next.submitted = true;
        next.submittedAt = stamp;
        next.submittedBy = submittedBy;
      }
      saveSurveyState(projectId, kind, next);
      return next;
    });
    setEditing(false);
    setRevising(false);
  };

  const accent = kind === 'pre-sales' ? '#0072CE' : '#E07A1A';
  const accentBg = kind === 'pre-sales' ? 'rgba(0,114,206,0.08)' : 'rgba(246,141,46,0.08)';
  const canRevise = state.submitted && !state.revision && !revising;
  const hasRevision = !!state.revision?.submittedAt;

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1100px]">
      <ProjectHeader project={project} />
      <div className="mt-5">
        <PhaseRibbon phase={config.phase} toolLabel="Effort Level Survey" toolIcon={ClipboardCheck} />
      </div>

      {/* Survey header card */}
      <div className="bg-white border border-border rounded-xl shadow-sm p-5 flex items-start gap-4">
        <div
          className="w-12 h-12 rounded-[10px] flex items-center justify-center flex-shrink-0"
          style={{ background: accentBg, color: accent }}
        >
          <ClipboardCheck size={24} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-bold tracking-[0.15em] uppercase" style={{ color: accent }}>
            {config.phase}
          </div>
          <h1 className="text-[22px] font-bold text-navy m-0 mt-0.5">{config.title}</h1>
          <p className="text-[13px] text-fg-2 m-0 mt-1.5 leading-[1.5]">{config.purpose}</p>
          <div className="flex gap-5 mt-3 flex-wrap text-xs text-fg-2">
            <span><strong className="text-fg">When:</strong> {config.when}</span>
            <span><strong className="text-fg">Time:</strong> {config.time}</span>
          </div>
        </div>
        <div className="flex flex-col gap-2 items-end flex-shrink-0">
          <SurveyStatusChip state={state} revising={revising} />
          {canRevise && (
            <button
              className="btn-secondary text-sm"
              onClick={() => { setRevising(true); setEditing(true); }}
            >
              <Sparkles size={14} /> Start Revision
            </button>
          )}
        </div>
      </div>

      {/* Version pills */}
      {(state.submitted || revising) && (
        <div className="mt-3.5 flex gap-2.5 items-center text-xs text-fg-2">
          <VersionPill
            label="Original"
            active={activeVersion === 'original'}
            subtitle={state.submitted ? `Submitted ${state.submittedAt}` : 'Draft'}
          />
          {(hasRevision || revising) && (
            <>
              <span className="text-fg-2">→</span>
              <VersionPill
                label="Revision"
                active={activeVersion === 'revision'}
                subtitle={hasRevision ? `Submitted ${state.revision!.submittedAt}` : 'Draft'}
              />
            </>
          )}
          <span className="ml-auto italic">One revision allowed {config.revisionCheckpoint}.</span>
        </div>
      )}

      {/* Sections */}
      <div className="flex flex-col gap-4 mt-4.5" style={{ marginTop: 18 }}>
        {config.sections.map((section, i) => (
          <SurveySection
            key={section.id}
            number={i + 1}
            section={section}
            data={data}
            editing={editing}
            accent={accent}
            setField={setField}
            resolvePrefill={resolvePrefill}
          />
        ))}
      </div>

      {/* Footer actions */}
      <div className="mt-5 px-5 py-4 bg-white border border-border rounded-xl shadow-sm flex items-center justify-between flex-wrap gap-3">
        <div className="text-xs text-fg-2">
          {editing ? (
            <>Answers autosave as you go. Submit to lock in this version.</>
          ) : (
            <>
              Submitted {activeVersion === 'revision' ? state.revision?.submittedAt : state.submittedAt}
              {' by '}
              {activeVersion === 'revision' ? state.revision?.submittedBy : state.submittedBy}.
            </>
          )}
        </div>
        <div className="flex gap-2">
          {!editing && !canRevise && !revising && !hasRevision && (
            <button onClick={() => setEditing(true)} className="btn-secondary text-sm">Unlock to edit</button>
          )}
          {editing && (
            <>
              <button onClick={() => setEditing(false)} className="btn-secondary text-sm">Save Draft</button>
              <button onClick={handleSubmit} className="btn-orange text-sm">
                <Check size={14} /> {revising ? 'Submit Revision' : 'Submit Survey'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function VersionPill({ label, active, subtitle }: { label: string; active: boolean; subtitle: string }) {
  return (
    <div
      className="px-3 py-1.5 rounded-lg text-xs"
      style={{
        border: active ? '1px solid var(--color-navy)' : '1px solid var(--color-border)',
        background: active ? 'rgba(34,50,110,0.04)' : '#fff',
      }}
    >
      <div className="font-semibold" style={{ color: active ? 'var(--color-navy)' : 'var(--color-fg-2)' }}>{label}</div>
      <div className="text-[10px] text-fg-2 mt-px">{subtitle}</div>
    </div>
  );
}

function SurveyStatusChip({ state, revising }: { state: SurveyState; revising: boolean }) {
  let label: string;
  let bg: string;
  let fg: string;
  if (revising)                       { label = 'Revising';    bg = 'rgba(246,141,46,0.1)'; fg = '#E07A1A'; }
  else if (state.revision?.submittedAt) { label = 'Revised';   bg = '#DCFCE7';              fg = '#15803D'; }
  else if (state.submitted)           { label = 'Submitted';   bg = '#DCFCE7';              fg = '#15803D'; }
  else                                { label = 'Not started'; bg = '#F3F4F6';              fg = '#4B5563'; }
  return (
    <span
      className="inline-flex px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap"
      style={{ background: bg, color: fg }}
    >
      {label}
    </span>
  );
}

interface SurveySectionProps {
  number: number;
  section: SectionDef;
  data: Record<string, unknown>;
  editing: boolean;
  accent: string;
  setField: (id: string, val: unknown) => void;
  resolvePrefill: (f: FieldDef) => string;
}

function SurveySection({ number, section, data, editing, accent, setField, resolvePrefill }: SurveySectionProps) {
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border flex items-start gap-3">
        <div
          className="w-7 h-7 rounded-md text-white flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{ background: accent }}
        >
          {number}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[15px] font-semibold text-navy m-0">
            {section.title}
            {section.optional && <span className="ml-2 text-[11px] font-medium text-fg-2 italic">Optional</span>}
          </h3>
          {section.subtitle && <p className="text-[13px] text-fg-2 m-0 mt-0.5">{section.subtitle}</p>}
        </div>
      </div>

      {section.note && (
        <div
          className="px-5 py-2.5 border-b border-border text-xs text-fg-2 flex gap-2 items-start"
          style={{ background: 'rgba(246,141,46,0.06)' }}
        >
          <Sparkles size={14} className="text-orange mt-0.5 flex-shrink-0" />
          <span>{section.note}</span>
        </div>
      )}

      <div className="p-5 grid grid-cols-3 gap-4">
        {section.fields.map((f) => (
          <SurveyField
            key={f.id}
            field={f}
            value={data[f.id]}
            editing={editing}
            onChange={(v) => setField(f.id, v)}
            prefillValue={resolvePrefill(f)}
          />
        ))}
      </div>
    </div>
  );
}

interface SurveyFieldProps {
  field: FieldDef;
  value: unknown;
  editing: boolean;
  onChange: (v: unknown) => void;
  prefillValue: string;
}

function SurveyField({ field, value, editing, onChange, prefillValue }: SurveyFieldProps) {
  const span = field.span ?? 1;
  const display = (value ?? prefillValue ?? '') as string;
  const wrapperStyle = { gridColumn: `span ${span}` };
  const labelEl = field.label && (
    <label className="block text-xs font-semibold text-fg-2 mb-1.5">
      {field.label}
      {field.hint && <span className="font-normal text-fg-2 ml-1.5 italic">· {field.hint}</span>}
    </label>
  );

  if (field.type === 'checkboxes') {
    const arr = (Array.isArray(value) ? value : []) as string[];
    const toggle = (opt: string) => {
      if (!editing) return;
      onChange(arr.includes(opt) ? arr.filter((x) => x !== opt) : [...arr, opt]);
    };
    return (
      <div style={{ ...wrapperStyle, gridColumn: 'span 3' }}>
        {labelEl}
        <div className="grid grid-cols-2 gap-2">
          {field.options?.map((opt) => (
            <Fragment key={opt}>
              <button
                type="button"
                onClick={() => toggle(opt)}
                disabled={!editing}
                className="flex items-center gap-2.5 px-3 py-2.5 border border-border rounded-lg text-[13px] text-fg text-left"
                style={{
                  background: arr.includes(opt) ? 'rgba(34,50,110,0.04)' : '#fff',
                  cursor: editing ? 'pointer' : 'default',
                }}
              >
                <span
                  className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
                  style={{
                    background: arr.includes(opt) ? 'var(--color-navy)' : '#fff',
                    border: arr.includes(opt) ? '1px solid var(--color-navy)' : '1px solid var(--color-border)',
                  }}
                >
                  {arr.includes(opt) && <Check size={11} className="text-white" />}
                </span>
                <span>{opt}</span>
              </button>
            </Fragment>
          ))}
        </div>
      </div>
    );
  }

  if (field.type === 'radio') {
    return (
      <div style={{ ...wrapperStyle, gridColumn: 'span 3' }}>
        {labelEl}
        <div className="flex flex-wrap gap-2">
          {field.options?.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => editing && onChange(opt)}
              disabled={!editing}
              className="px-3.5 py-2 text-[13px] font-medium rounded-lg"
              style={{
                background: value === opt ? 'var(--color-navy)' : '#fff',
                color: value === opt ? '#fff' : 'var(--color-fg-2)',
                border: value === opt ? '1px solid var(--color-navy)' : '1px solid var(--color-border)',
                cursor: editing ? 'pointer' : 'default',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (field.type === 'yesno') {
    return (
      <div style={wrapperStyle}>
        {labelEl}
        <div className="flex gap-2">
          {(['Yes', 'No'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => editing && onChange(opt)}
              disabled={!editing}
              className="flex-1 px-3.5 py-2 text-[13px] font-medium rounded-lg"
              style={{
                background: value === opt ? 'var(--color-navy)' : '#fff',
                color: value === opt ? '#fff' : 'var(--color-fg-2)',
                border: value === opt ? '1px solid var(--color-navy)' : '1px solid var(--color-border)',
                cursor: editing ? 'pointer' : 'default',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <div style={{ ...wrapperStyle, gridColumn: `span ${span}` }}>
        {labelEl}
        <textarea
          value={display}
          disabled={!editing}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          className="w-full px-3 py-2.5 border border-border rounded-lg text-[13px] text-fg outline-none resize-y"
          style={{ background: editing ? '#fff' : 'var(--color-surface)' }}
        />
      </div>
    );
  }

  return (
    <div style={wrapperStyle}>
      {labelEl}
      <input
        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
        value={display}
        disabled={!editing}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className="w-full px-3 py-2.5 border border-border rounded-lg text-[13px] text-fg outline-none"
        style={{
          background: editing ? '#fff' : 'var(--color-surface)',
          fontFamily: field.mono ? 'var(--font-mono)' : 'inherit',
        }}
      />
    </div>
  );
}

// =============================================================================
// Banner + footer link strip — reused on Project Overview
// =============================================================================

export function EffortSurveyPrompt({ project, onNavigate }: { project: Project; onNavigate: (path: string) => void }) {
  const isPre = project.phase === 'Pre-Sales';
  const kind: SurveyKind = isPre ? 'pre-sales' : 'post-sales';
  const state = loadSurveyState(project.id, kind);

  if (state.submitted) return null;

  const accent = isPre ? '#0072CE' : '#E07A1A';
  const accentBg = isPre ? 'rgba(0,114,206,0.06)' : 'rgba(246,141,46,0.06)';
  const toolPath = isPre ? 'pre-survey' : 'post-survey';
  const mins = isPre ? '10–15 min' : '30–60 min';
  const purpose = isPre
    ? 'quick scoping for the triage discussion before substantive quoting'
    : 'project complexity and hour estimate before detailed design begins';

  return (
    <div
      className="mt-5 rounded-[10px] px-4.5 py-3.5 flex items-center gap-4"
      style={{
        background: '#fff',
        border: `1px solid ${accent}40`,
        borderLeft: `3px solid ${accent}`,
        paddingLeft: 18,
        paddingRight: 18,
      }}
    >
      <div
        className="w-8.5 h-8.5 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: accentBg, color: accent, width: 34, height: 34 }}
      >
        <ClipboardCheck size={17} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-navy">
          {project.phase} effort survey — not started
        </div>
        <div className="text-xs text-fg-2 mt-0.5">
          Fill out once to record {purpose}. About {mins}.
        </div>
      </div>
      <button
        onClick={() => onNavigate(`/projects/${project.id}/${toolPath}`)}
        className="btn-secondary text-sm"
        style={{ borderColor: accent, color: accent }}
      >
        Fill out survey
      </button>
    </div>
  );
}

export function EffortSurveyFooter({ project, onNavigate }: { project: Project; onNavigate: (path: string) => void }) {
  const preState = loadSurveyState(project.id, 'pre-sales');
  const postState = loadSurveyState(project.id, 'post-sales');

  const entries: { kind: SurveyKind; path: string; label: string; state: SurveyState; accent: string }[] = [
    { kind: 'pre-sales',  path: 'pre-survey',  label: 'Pre-sales effort survey',  state: preState,  accent: '#0072CE' },
    { kind: 'post-sales', path: 'post-survey', label: 'Post-sales effort survey', state: postState, accent: '#E07A1A' },
  ];

  if (!entries.some((e) => e.state.submitted)) return null;

  const describe = (s: SurveyState) => {
    if (s.revision?.submittedAt) return `Revised ${s.revision.submittedAt}`;
    if (s.submitted) return `Submitted ${s.submittedAt}`;
    return 'Not started';
  };

  return (
    <div
      className="mt-7 px-4.5 py-3.5 border-t border-dashed border-border flex items-center justify-between gap-5 flex-wrap text-xs text-fg-2"
      style={{ paddingLeft: 18, paddingRight: 18 }}
    >
      <div className="flex items-center gap-2">
        <ClipboardCheck size={13} className="text-fg-2" />
        <span className="text-fg-2 tracking-[0.02em]">Engineering effort surveys</span>
      </div>
      <div className="flex items-center gap-5 flex-wrap">
        {entries.map((e) => (
          <div key={e.kind} className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: e.accent }} />
            <span className="text-fg">{e.label}</span>
            <span className="text-fg-2">·</span>
            <span>{describe(e.state)}</span>
            <a
              href="#"
              onClick={(ev) => { ev.preventDefault(); onNavigate(`/projects/${project.id}/${e.path}`); }}
              className="font-medium no-underline"
              style={{ color: e.accent }}
            >
              {e.state.submitted ? (e.state.revision?.submittedAt ? 'View' : 'Review / revise') : 'Fill out'}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
