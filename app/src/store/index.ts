import { create } from 'zustand';
import type {
  Project, Submittal, SubmittalItem, RFI, CloseoutPackage,
  Warranty, PunchItem, SignOffSheet, OwnerManual, ManualSection, ManualDevice,
  ProjectBoMItem, BomItemType, AsBuiltDrawing, LaborBreakdownEntry,
  QuickStartRoom, QuickStartStep,
  ItemCategory,
  SubmittalItemLocation,
  ReviewRun, ReviewFlag, ReviewRunStatus, ReviewFlagStatus,
  BidLevelingSession, BidLevelingMappingTemplate,
  ProjectMilestone, MilestoneTier, MilestoneType,
  SubmittalItemApprovalState,
  Warehouse,
  PurchasingModule, PurchasingItem, PurchasingFreight, PurchasingManufacturerDefault,
  PurchaseStatus,
  ProjectComment, CommentReaction,
  ProjectChangeOrder,
  ProjectDocument, ProjectDocumentType,
} from '../types';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { isExcludedFromSubmittal, mergeLocations } from '../utils/submittalExclusions';
import {
  parseCsv, mapRow, runRules, applyDiff, buildBomRows, buildReviewConfig,
} from '../utils/reviewEngine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short random ID for demo/offline mode */
function uid(): string {
  return Math.random().toString(36).slice(2, 11);
}

/** Generate a proper UUID (used when Supabase is configured) */
function genId(): string {
  if (isSupabaseConfigured()) return crypto.randomUUID();
  return uid();
}

const now = () => new Date().toISOString().split('T')[0];

// ---------------------------------------------------------------------------
// Supabase row ↔ TypeScript mappers
// ---------------------------------------------------------------------------

// --- Projects ---
// Postgres timestamps come back as full ISO strings ("2026-03-30T02:02:09.5Z").
// The UI only needs the date portion — strip the time component.
function toDate(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.slice(0, 10);
}

function rowToProject(r: any): Project {
  return {
    id: r.id, name: r.name, number: r.number, client: r.client,
    address: r.address, businessUnit: r.business_unit ?? '', status: r.status,
    phase: r.phase ?? 'Pre-Sales',
    value: r.value ?? '',
    ownerId: r.owner_id ?? undefined,
    legacyEngineerId: r.legacy_engineer_id ?? undefined,
    projectCode: r.project_code ?? undefined,
    mondayPresalesItemId: r.monday_presales_item_id ?? undefined,
    mondayPostsalesItemId: r.monday_postsales_item_id ?? undefined,
    mondayItemId: r.monday_item_id ?? undefined,
    dtoolsProjectId: r.dtools_project_id ?? undefined,
    dtoolsBomStatus: r.dtools_bom_status ?? '',
    dtoolsCost: r.dtools_cost != null ? Number(r.dtools_cost) : undefined,
    dtoolsPriceWithoutTax: r.dtools_price_without_tax != null ? Number(r.dtools_price_without_tax) : undefined,
    dtoolsTax: r.dtools_tax != null ? Number(r.dtools_tax) : undefined,
    dtoolsPrice: r.dtools_price != null ? Number(r.dtools_price) : undefined,
    dtoolsHours: r.dtools_hours != null ? Number(r.dtools_hours) : undefined,
    dtoolsSyncedAt: r.dtools_synced_at ?? undefined,
    dtoolsSyncDelta: r.dtools_sync_delta ?? undefined,
    dtoolsGmMeta: r.dtools_gm_meta ?? undefined,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}
function projectToRow(p: Partial<Project> & { createdBy?: string }): Record<string, any> {
  const row: any = {};
  if (p.id !== undefined) row.id = p.id;
  if (p.name !== undefined) row.name = p.name;
  if (p.number !== undefined) row.number = p.number;
  if (p.client !== undefined) row.client = p.client;
  if (p.address !== undefined) row.address = p.address;
  if (p.businessUnit !== undefined) row.business_unit = p.businessUnit;
  if (p.status !== undefined) row.status = p.status;
  if (p.phase !== undefined) row.phase = p.phase;
  if (p.value !== undefined) row.value = p.value;
  if (p.ownerId !== undefined) row.owner_id = p.ownerId;
  if (p.legacyEngineerId !== undefined) row.legacy_engineer_id = p.legacyEngineerId;
  if (p.projectCode !== undefined) row.project_code = p.projectCode;
  if (p.mondayPresalesItemId !== undefined) row.monday_presales_item_id = p.mondayPresalesItemId;
  if (p.mondayPostsalesItemId !== undefined) row.monday_postsales_item_id = p.mondayPostsalesItemId;
  if (p.mondayItemId !== undefined) row.monday_item_id = p.mondayItemId;
  if (p.dtoolsProjectId !== undefined) row.dtools_project_id = p.dtoolsProjectId;
  if (p.dtoolsBomStatus !== undefined) row.dtools_bom_status = p.dtoolsBomStatus;
  if (p.createdAt !== undefined) row.created_at = p.createdAt;
  if (p.updatedAt !== undefined) row.updated_at = p.updatedAt;
  if ((p as any).createdBy !== undefined) row.created_by = (p as any).createdBy;
  return row;
}

// --- ProjectBoMItem ---
function rowToBoMItem(r: any): ProjectBoMItem {
  return {
    id: r.id, projectId: r.project_id, manufacturer: r.manufacturer, model: r.model,
    description: r.description, category: r.category, qty: r.qty, notes: r.notes ?? '',
    locations: r.locations ?? [], cutSheetData: r.cut_sheet_url ?? undefined,
    cutSheetName: r.cut_sheet_name ?? undefined, sortOrder: r.sort_order ?? 0,
    itemType: r.item_type ?? 'Product',
    unitCost: Number(r.unit_cost) || 0,
    unitPrice: Number(r.unit_price) || 0,
    laborHours: Number(r.labor_hours) || 0,
    laborUnitCost: Number(r.labor_unit_cost) || 0,
    laborUnitPrice: Number(r.labor_unit_price) || 0,
    fixedLaborCost: Number(r.fixed_labor_cost) || 0,
    fixedLaborPrice: Number(r.fixed_labor_price) || 0,
    marginPct: Number(r.margin_pct) || 0,
    ownerFurnished: r.owner_furnished ?? false,
    optional: r.optional ?? false,
    pricedFrom: r.priced_from ?? undefined,
    laborType: r.labor_type ?? '',
    laborBreakdown: r.labor_breakdown ?? [],
    includedInPhase: r.included_in_phase ?? false,
  };
}
function bomItemToRow(item: Partial<ProjectBoMItem>): Record<string, any> {
  const row: any = {};
  if (item.id !== undefined) row.id = item.id;
  if (item.projectId !== undefined) row.project_id = item.projectId;
  if (item.manufacturer !== undefined) row.manufacturer = item.manufacturer;
  if (item.model !== undefined) row.model = item.model;
  if (item.description !== undefined) row.description = item.description;
  if (item.category !== undefined) row.category = item.category;
  if (item.qty !== undefined) row.qty = item.qty;
  if (item.notes !== undefined) row.notes = item.notes;
  if (item.locations !== undefined) row.locations = item.locations;
  if (item.cutSheetData !== undefined) row.cut_sheet_url = item.cutSheetData;
  if (item.cutSheetName !== undefined) row.cut_sheet_name = item.cutSheetName;
  if (item.sortOrder !== undefined) row.sort_order = item.sortOrder;
  if (item.itemType !== undefined) row.item_type = item.itemType;
  if (item.unitCost !== undefined) row.unit_cost = item.unitCost;
  if (item.unitPrice !== undefined) row.unit_price = item.unitPrice;
  if (item.laborHours !== undefined) row.labor_hours = item.laborHours;
  if (item.laborUnitCost !== undefined) row.labor_unit_cost = item.laborUnitCost;
  if (item.laborUnitPrice !== undefined) row.labor_unit_price = item.laborUnitPrice;
  if (item.fixedLaborCost !== undefined) row.fixed_labor_cost = item.fixedLaborCost;
  if (item.fixedLaborPrice !== undefined) row.fixed_labor_price = item.fixedLaborPrice;
  if (item.marginPct !== undefined) row.margin_pct = item.marginPct;
  if (item.ownerFurnished !== undefined) row.owner_furnished = item.ownerFurnished;
  if (item.optional !== undefined) row.optional = item.optional;
  if (item.pricedFrom !== undefined) row.priced_from = item.pricedFrom || null;
  if (item.laborType !== undefined) row.labor_type = item.laborType;
  if (item.laborBreakdown !== undefined) row.labor_breakdown = item.laborBreakdown;
  if (item.includedInPhase !== undefined) row.included_in_phase = item.includedInPhase;
  return row;
}

// --- Submittals ---
function rowToSubmittal(r: any): Omit<Submittal, 'items'> {
  return {
    id: r.id, projectId: r.project_id, title: r.title, revision: r.revision,
    preparedBy: r.prepared_by ?? '', submittedTo: r.submitted_to ?? '',
    status: r.status, notes: r.notes ?? '', createdAt: r.created_at,
  } as any;
}
function submittalToRow(s: Partial<Submittal>): Record<string, any> {
  const row: any = {};
  if (s.id !== undefined) row.id = s.id;
  if (s.projectId !== undefined) row.project_id = s.projectId;
  if (s.title !== undefined) row.title = s.title;
  if (s.revision !== undefined) row.revision = s.revision;
  if (s.preparedBy !== undefined) row.prepared_by = s.preparedBy;
  if (s.submittedTo !== undefined) row.submitted_to = s.submittedTo;
  if (s.status !== undefined) row.status = s.status;
  if (s.notes !== undefined) row.notes = s.notes;
  if (s.createdAt !== undefined) row.created_at = s.createdAt;
  return row;
}

// --- SubmittalItem ---
function rowToSubmittalItem(r: any): SubmittalItem {
  return {
    id: r.id, submittalId: r.submittal_id, manufacturer: r.manufacturer, model: r.model,
    description: r.description, category: r.category, qty: r.qty,
    cutSheetData: r.cut_sheet_url ?? undefined, cutSheetName: r.cut_sheet_name ?? undefined,
    cutsheetRepositoryId: r.cutsheet_repository_id ?? undefined,
    cutsheetStagingId: r.cutsheet_staging_id ?? undefined,
    locations: r.locations ?? [], notes: r.notes ?? '', sortOrder: r.sort_order ?? 0,
    approvalState: (r.approval_state as SubmittalItemApprovalState) ?? 'pending',
    approvalChangedAt: r.approval_changed_at ? toDate(r.approval_changed_at) : undefined,
  };
}
function submittalItemToRow(item: Partial<SubmittalItem>): Record<string, any> {
  const row: any = {};
  if (item.id !== undefined) row.id = item.id;
  if (item.submittalId !== undefined) row.submittal_id = item.submittalId;
  if (item.manufacturer !== undefined) row.manufacturer = item.manufacturer;
  if (item.model !== undefined) row.model = item.model;
  if (item.description !== undefined) row.description = item.description;
  if (item.category !== undefined) row.category = item.category;
  if (item.qty !== undefined) row.qty = item.qty;
  if (item.cutSheetData !== undefined) row.cut_sheet_url = item.cutSheetData;
  if (item.cutSheetName !== undefined) row.cut_sheet_name = item.cutSheetName;
  if (item.cutsheetRepositoryId !== undefined) row.cutsheet_repository_id = item.cutsheetRepositoryId;
  if (item.cutsheetStagingId !== undefined) row.cutsheet_staging_id = item.cutsheetStagingId;
  if (item.locations !== undefined) row.locations = item.locations;
  if (item.notes !== undefined) row.notes = item.notes;
  if (item.sortOrder !== undefined) row.sort_order = item.sortOrder;
  if (item.approvalState !== undefined) row.approval_state = item.approvalState;
  if (item.approvalChangedAt !== undefined) row.approval_changed_at = item.approvalChangedAt;
  return row;
}

// --- RFIs ---
function rowToRFI(r: any): RFI {
  return {
    id: r.id, projectId: r.project_id, number: r.number, subject: r.subject,
    specSection: r.spec_section ?? '', description: r.description, status: r.status,
    responseDue: r.response_due ?? '', answeredAt: r.answered_at ?? undefined,
    answeredBy: r.answered_by ?? undefined, responseSummary: r.response_summary ?? undefined,
    createdAt: r.created_at, attachments: [],
    locationRef: r.location_ref ?? undefined, productRef: r.product_ref ?? undefined,
  };
}
function rfiToRow(r: Partial<RFI>): Record<string, any> {
  const row: any = {};
  if (r.id !== undefined) row.id = r.id;
  if (r.projectId !== undefined) row.project_id = r.projectId;
  if (r.number !== undefined) row.number = r.number;
  if (r.subject !== undefined) row.subject = r.subject;
  if (r.specSection !== undefined) row.spec_section = r.specSection;
  if (r.description !== undefined) row.description = r.description;
  if (r.status !== undefined) row.status = r.status;
  if (r.responseDue !== undefined) row.response_due = r.responseDue;
  if (r.answeredAt !== undefined) row.answered_at = r.answeredAt;
  if (r.answeredBy !== undefined) row.answered_by = r.answeredBy;
  if (r.responseSummary !== undefined) row.response_summary = r.responseSummary;
  if (r.createdAt !== undefined) row.created_at = r.createdAt;
  if (r.locationRef !== undefined) row.location_ref = r.locationRef;
  if (r.productRef !== undefined) row.product_ref = r.productRef;
  return row;
}

// --- CloseoutPackage ---
function rowToCloseout(r: any): Omit<CloseoutPackage, 'warranties' | 'punchItems' | 'signOffSheets' | 'asBuiltDrawings' | 'quickStartRooms'> {
  return {
    id: r.id, projectId: r.project_id, status: r.status, createdAt: r.created_at,
    productManualUrl: r.product_manual_url ?? undefined,
    productManualName: r.product_manual_name ?? undefined,
  } as any;
}
function closeoutToRow(c: Partial<CloseoutPackage>): Record<string, any> {
  const row: any = {};
  if (c.id !== undefined) row.id = c.id;
  if (c.projectId !== undefined) row.project_id = c.projectId;
  if (c.status !== undefined) row.status = c.status;
  if (c.createdAt !== undefined) row.created_at = c.createdAt;
  if (c.productManualUrl !== undefined) row.product_manual_url = c.productManualUrl;
  if (c.productManualName !== undefined) row.product_manual_name = c.productManualName;
  return row;
}

// --- Warranty ---
function rowToWarranty(r: any): Warranty {
  return {
    id: r.id, closeoutId: r.closeout_id, bomItemId: r.bom_item_id ?? undefined,
    system: r.system ?? '', manufacturer: r.manufacturer ?? '', model: r.model ?? '',
    vendor: r.vendor ?? '', startDate: r.start_date ?? '',
    durationMonths: r.duration_months ?? 12, contactName: r.contact_name ?? '',
    contactEmail: r.contact_email ?? '', contactPhone: r.contact_phone ?? '',
    coverageNotes: r.coverage_notes ?? '',
  };
}
function warrantyToRow(w: Partial<Warranty>): Record<string, any> {
  const row: any = {};
  if (w.id !== undefined) row.id = w.id;
  if (w.closeoutId !== undefined) row.closeout_id = w.closeoutId;
  if (w.bomItemId !== undefined) row.bom_item_id = w.bomItemId;
  if (w.system !== undefined) row.system = w.system;
  if (w.manufacturer !== undefined) row.manufacturer = w.manufacturer;
  if (w.model !== undefined) row.model = w.model;
  if (w.vendor !== undefined) row.vendor = w.vendor;
  if (w.startDate !== undefined) row.start_date = w.startDate;
  if (w.durationMonths !== undefined) row.duration_months = w.durationMonths;
  if (w.contactName !== undefined) row.contact_name = w.contactName;
  if (w.contactEmail !== undefined) row.contact_email = w.contactEmail;
  if (w.contactPhone !== undefined) row.contact_phone = w.contactPhone;
  if (w.coverageNotes !== undefined) row.coverage_notes = w.coverageNotes;
  return row;
}

// --- PunchItem ---
function rowToPunchItem(r: any): PunchItem {
  return {
    id: r.id, closeoutId: r.closeout_id, description: r.description ?? '',
    location: r.location ?? '', assignedTo: r.assigned_to ?? '',
    status: r.status, priority: r.priority, resolvedAt: r.resolved_at ?? undefined,
    productRef: r.product_ref ?? undefined,
  };
}
function punchItemToRow(p: Partial<PunchItem>): Record<string, any> {
  const row: any = {};
  if (p.id !== undefined) row.id = p.id;
  if (p.closeoutId !== undefined) row.closeout_id = p.closeoutId;
  if (p.description !== undefined) row.description = p.description;
  if (p.location !== undefined) row.location = p.location;
  if (p.assignedTo !== undefined) row.assigned_to = p.assignedTo;
  if (p.status !== undefined) row.status = p.status;
  if (p.priority !== undefined) row.priority = p.priority;
  if (p.resolvedAt !== undefined) row.resolved_at = p.resolvedAt;
  if (p.productRef !== undefined) row.product_ref = p.productRef;
  return row;
}

// --- SignOffSheet ---
function rowToSignOffSheet(r: any): SignOffSheet {
  return {
    id: r.id, closeoutId: r.closeout_id, zone: r.zone ?? '', system: r.system ?? '',
    testedBy: r.tested_by ?? '', testedDate: r.tested_date ?? '',
    witnessedBy: r.witnessed_by ?? '', status: r.status, notes: r.notes ?? '',
    customItems: r.custom_items ?? [],
  };
}
function signOffSheetToRow(s: Partial<SignOffSheet>): Record<string, any> {
  const row: any = {};
  if (s.id !== undefined) row.id = s.id;
  if (s.closeoutId !== undefined) row.closeout_id = s.closeoutId;
  if (s.zone !== undefined) row.zone = s.zone;
  if (s.system !== undefined) row.system = s.system;
  if (s.testedBy !== undefined) row.tested_by = s.testedBy;
  if (s.testedDate !== undefined) row.tested_date = s.testedDate;
  if (s.witnessedBy !== undefined) row.witnessed_by = s.witnessedBy;
  if (s.status !== undefined) row.status = s.status;
  if (s.notes !== undefined) row.notes = s.notes;
  if (s.customItems !== undefined) row.custom_items = s.customItems;
  return row;
}

// --- QuickStartRoom / QuickStartStep ---
function rowToQuickStartRoom(r: any, steps: QuickStartStep[]): QuickStartRoom {
  return {
    id: r.id, closeoutId: r.closeout_id, name: r.name ?? '',
    sortOrder: r.sort_order ?? 0, steps,
  };
}
function quickStartRoomToRow(r: Partial<QuickStartRoom>): Record<string, any> {
  const row: any = {};
  if (r.id !== undefined) row.id = r.id;
  if (r.closeoutId !== undefined) row.closeout_id = r.closeoutId;
  if (r.name !== undefined) row.name = r.name;
  if (r.sortOrder !== undefined) row.sort_order = r.sortOrder;
  return row;
}
function rowToQuickStartStep(r: any): QuickStartStep {
  return {
    id: r.id, roomId: r.room_id, text: r.text ?? '', note: r.note ?? '',
    sortOrder: r.sort_order ?? 0,
  };
}
function quickStartStepToRow(s: Partial<QuickStartStep>): Record<string, any> {
  const row: any = {};
  if (s.id !== undefined) row.id = s.id;
  if (s.roomId !== undefined) row.room_id = s.roomId;
  if (s.text !== undefined) row.text = s.text;
  if (s.note !== undefined) row.note = s.note;
  if (s.sortOrder !== undefined) row.sort_order = s.sortOrder;
  return row;
}

// --- AsBuiltDrawing ---
function rowToAsBuiltDrawing(r: any): AsBuiltDrawing {
  return {
    id: r.id, closeoutId: r.closeout_id, title: r.title ?? '',
    fileName: r.file_name ?? '', fileData: r.file_url ?? '',
    revision: r.revision ?? '', uploadedAt: r.uploaded_at ?? '',
  };
}
function asBuiltDrawingToRow(d: Partial<AsBuiltDrawing>): Record<string, any> {
  const row: any = {};
  if (d.id !== undefined) row.id = d.id;
  if (d.closeoutId !== undefined) row.closeout_id = d.closeoutId;
  if (d.title !== undefined) row.title = d.title;
  if (d.fileName !== undefined) row.file_name = d.fileName;
  if (d.fileData !== undefined) row.file_url = d.fileData;
  if (d.revision !== undefined) row.revision = d.revision;
  if (d.uploadedAt !== undefined) row.uploaded_at = d.uploadedAt;
  return row;
}

// --- OwnerManual ---
function rowToManual(r: any): OwnerManual {
  return {
    id: r.id, projectId: r.project_id, title: r.title ?? '',
    revision: r.revision ?? '', overviewText: r.overview_text ?? '',
    createdAt: r.created_at, sections: r.sections ?? [],
  };
}
function manualToRow(m: Partial<OwnerManual>): Record<string, any> {
  const row: any = {};
  if (m.id !== undefined) row.id = m.id;
  if (m.projectId !== undefined) row.project_id = m.projectId;
  if (m.title !== undefined) row.title = m.title;
  if (m.revision !== undefined) row.revision = m.revision;
  if (m.overviewText !== undefined) row.overview_text = m.overviewText;
  if (m.createdAt !== undefined) row.created_at = m.createdAt;
  if (m.sections !== undefined) row.sections = m.sections;
  return row;
}

// ---------------------------------------------------------------------------
// Fire-and-forget Supabase helper — logs errors but never blocks
// ---------------------------------------------------------------------------
function dbExec(fn: () => PromiseLike<{ error: any }>): void {
  if (!isSupabaseConfigured()) return;
  fn().then(({ error }) => {
    if (error) console.error('[Supabase sync error]', error);
  });
}

// ---------------------------------------------------------------------------
// Seed data — only used in demo mode (Supabase not configured)
// ---------------------------------------------------------------------------

const seedProjects: Project[] = [
  { id: 'p1', name: 'One Vanderbilt - Level 60 AV Buildout', number: 'INS-2026-001', client: 'SL Green Realty', address: '1 Vanderbilt Ave, New York, NY 10017', businessUnit: 'Instrata NE', status: 'In Progress', phase: 'Post-Sales', value: '$482K', dtoolsBomStatus: '', createdAt: '2026-01-15', updatedAt: '2026-03-20' },
  { id: 'p2', name: 'Hudson Yards Tower 30 - Conference Center', number: 'INS-2026-002', client: 'Related Companies', address: '30 Hudson Yards, New York, NY 10001', businessUnit: 'Instrata NE', status: 'Install', phase: 'Post-Sales', value: '$1.2M', dtoolsBomStatus: '', createdAt: '2026-02-01', updatedAt: '2026-03-18' },
  { id: 'p3', name: 'Brookfield Place - Trading Floor Refresh', number: 'INS-2026-003', client: 'Brookfield Asset Mgmt', address: '250 Vesey St, New York, NY 10281', businessUnit: 'Instrata MA', status: 'Close Out', phase: 'Post-Sales', value: '$890K', dtoolsBomStatus: '', createdAt: '2025-10-10', updatedAt: '2026-03-10' },
  { id: 'p4', name: '75 Rockefeller - Lobby Experience Center', number: 'INS-2025-018', client: 'RXR Realty', address: '75 Rockefeller Plaza, New York, NY 10019', businessUnit: 'Instrata NE', status: 'Won', phase: 'Post-Sales', value: '$340K', dtoolsBomStatus: '', createdAt: '2025-06-01', updatedAt: '2025-12-15' },
  { id: 'p5', name: 'WTC 3 - Executive Boardroom Suite', number: 'INS-2026-004', client: 'Silverstein Properties', address: '175 Greenwich St, New York, NY 10007', businessUnit: 'Instrata SE', status: 'Review', phase: 'Pre-Sales', value: '$612K', dtoolsBomStatus: '', createdAt: '2026-03-01', updatedAt: '2026-03-25' },
];

const bomDefaults = { itemType: 'Product' as const, unitCost: 0, unitPrice: 0, laborHours: 0, laborUnitCost: 0, laborUnitPrice: 0, fixedLaborCost: 0, fixedLaborPrice: 0, marginPct: 0, ownerFurnished: false, optional: false, laborType: '', laborBreakdown: [], includedInPhase: false };

const seedProjectBoM: ProjectBoMItem[] = [
  { ...bomDefaults, id: 'bom1', projectId: 'p1', manufacturer: 'Samsung', model: 'QM85C', description: '85" QLED 4K Display', category: 'Display', qty: 4, locations: [{ room: 'Conference Room A', qty: 2 }, { room: 'Conference Room B', qty: 2 }], notes: 'Conference room primary displays', sortOrder: 0 },
  { ...bomDefaults, id: 'bom2', projectId: 'p1', manufacturer: 'Crestron', model: 'DM-NVX-363', description: 'DM NVX 4K60 Network AV Encoder/Decoder', category: 'Control', qty: 8, locations: [{ room: 'Conference Room A', qty: 4 }, { room: 'Conference Room B', qty: 4 }], notes: '', sortOrder: 1 },
  { ...bomDefaults, id: 'bom3', projectId: 'p1', manufacturer: 'Shure', model: 'MXA920', description: 'Ceiling Array Microphone', category: 'Audio', qty: 6, locations: [{ room: 'Conference Room A', qty: 2 }, { room: 'Conference Room B', qty: 2 }, { room: 'Executive Boardroom', qty: 2 }], notes: 'White finish to match ceiling', sortOrder: 2 },
  { ...bomDefaults, id: 'bom4', projectId: 'p1', manufacturer: 'QSC', model: 'Core 110f', description: 'Q-SYS Unified Core', category: 'Audio', qty: 1, locations: [{ room: 'AV Rack Room', qty: 1 }], notes: 'Main DSP processor', sortOrder: 3 },
  { ...bomDefaults, id: 'bom5', projectId: 'p1', manufacturer: 'Belden', model: '10GXW13', description: 'Cat6A Plenum Cable', category: 'Cabling', qty: 50, locations: [], notes: '50 boxes - blue', sortOrder: 4 },
  { ...bomDefaults, id: 'bom6', projectId: 'p1', manufacturer: 'Liberty', model: 'DERA2P-015M', description: 'Plenum AOC HDMI Cable 15m', category: 'Cabling', qty: 12, locations: [], notes: '', sortOrder: 5 },
];

const seedSubmittals: Submittal[] = [
  {
    id: 's1', projectId: 'p1', title: 'AV Equipment Submittal - Level 60', revision: 'Rev 0', preparedBy: 'Mike Torres', submittedTo: 'SL Green - Facilities', status: 'Submitted', notes: 'Initial submittal for review', createdAt: '2026-02-10',
    items: [
      { id: 'si1', submittalId: 's1', manufacturer: 'Samsung', model: 'QM85C', description: '85" QLED 4K Display', category: 'Display', qty: 4, locations: [{ room: 'Conference Room A', qty: 2 }, { room: 'Conference Room B', qty: 2 }], notes: 'Conference room primary displays', sortOrder: 0 },
      { id: 'si2', submittalId: 's1', manufacturer: 'Crestron', model: 'DM-NVX-363', description: 'DM NVX 4K60 Network AV Encoder/Decoder', category: 'Control', qty: 8, locations: [{ room: 'Conference Room A', qty: 4 }, { room: 'Conference Room B', qty: 4 }], notes: '', sortOrder: 1 },
      { id: 'si3', submittalId: 's1', manufacturer: 'Shure', model: 'MXA920', description: 'Ceiling Array Microphone', category: 'Audio', qty: 6, locations: [{ room: 'Conference Room A', qty: 2 }, { room: 'Conference Room B', qty: 2 }, { room: 'Executive Boardroom', qty: 2 }], notes: 'White finish to match ceiling', sortOrder: 2 },
      { id: 'si4', submittalId: 's1', manufacturer: 'QSC', model: 'Core 110f', description: 'Q-SYS Unified Core', category: 'Audio', qty: 1, locations: [{ room: 'AV Rack Room', qty: 1 }], notes: 'Main DSP processor', sortOrder: 3 },
    ],
  },
  {
    id: 's2', projectId: 'p1', title: 'Cabling Infrastructure Submittal', revision: 'Rev 1', preparedBy: 'Mike Torres', submittedTo: 'SL Green - Facilities', status: 'Approved', notes: 'Revised per GC feedback', createdAt: '2026-02-20',
    items: [
      { id: 'si5', submittalId: 's2', manufacturer: 'Belden', model: '10GXW13', description: 'Cat6A Plenum Cable', category: 'Cabling', qty: 50, locations: [], notes: '50 boxes - blue', sortOrder: 0 },
      { id: 'si6', submittalId: 's2', manufacturer: 'Liberty', model: 'DERA2P-015M', description: 'Plenum AOC HDMI Cable 15m', category: 'Cabling', qty: 12, locations: [], notes: '', sortOrder: 1 },
    ],
  },
  {
    id: 's3', projectId: 'p2', title: 'Conference Center AV Package', revision: 'Rev 0', preparedBy: 'Sarah Chen', submittedTo: 'Related Cos - PM Team', status: 'Draft', notes: '', createdAt: '2026-03-15',
    items: [
      { id: 'si7', submittalId: 's3', manufacturer: 'LG', model: 'LAEC018', description: 'LED Signage Display 1.8mm', category: 'Display', qty: 1, locations: [{ room: 'Main Lobby', qty: 1 }], notes: 'Main lobby video wall', sortOrder: 0 },
    ],
  },
];

const seedRFIs: RFI[] = [
  { id: 'r1', projectId: 'p1', number: 'RFI-001', subject: 'Conduit routing above ceiling grid', specSection: 'Section 27 41 00', description: 'Existing HVAC ductwork conflicts with planned conduit path for AV cabling in zones 3 and 4. Requesting revised routing guidance or approval for alternate pathway below duct.', status: 'Open', responseDue: '2026-03-25', createdAt: '2026-03-10', attachments: [] },
  { id: 'r2', projectId: 'p1', number: 'RFI-002', subject: 'Display mounting backing requirement', specSection: 'Section 27 41 16', description: 'Architectural drawings show glass partition at Conference Room B location. Need confirmation on structural backing spec for 85" display mount point.', status: 'Answered', responseDue: '2026-03-20', answeredAt: '2026-03-18', answeredBy: 'John Park (Structural)', responseSummary: 'Install 3/4" marine plywood backing behind glass. See attached detail SK-AV-001.', createdAt: '2026-03-08', attachments: [] },
  { id: 'r3', projectId: 'p1', number: 'RFI-003', subject: 'Network switch port allocation', specSection: 'Section 27 15 00', description: 'IT drawing allocates 12 ports for AV. Current design requires 18 ports. Request additional 6-port allocation or approval for dedicated AV switch.', status: 'Open', responseDue: '2026-04-01', createdAt: '2026-03-15', attachments: [] },
  { id: 'r4', projectId: 'p2', number: 'RFI-001', subject: 'Power circuit availability for LED wall', specSection: 'Section 26 05 00', description: 'LED video wall requires dedicated 30A/208V circuit. Electrical plan does not show dedicated AV power in lobby area. Requesting coordination.', status: 'Open', responseDue: '2026-03-30', createdAt: '2026-03-18', attachments: [] },
  { id: 'r5', projectId: 'p3', number: 'RFI-001', subject: 'Floor box locations - trading desk clusters', specSection: 'Section 27 05 00', description: 'Trading desk layout has changed from 6-desk to 8-desk clusters. Need revised floor box locations per updated furniture plan.', status: 'Closed', responseDue: '2026-01-15', answeredAt: '2026-01-12', answeredBy: 'Architect - GKV', responseSummary: 'Revised floor plan RFP-008 issued. All floor box locations updated.', createdAt: '2026-01-05', attachments: [] },
];

const seedCloseouts: CloseoutPackage[] = [
  {
    id: 'c1', projectId: 'p3', status: 'In Progress', createdAt: '2026-02-15',
    warranties: [
      { id: 'w1', closeoutId: 'c1', system: 'Trading Floor Display Array', manufacturer: 'Samsung', model: 'QM55C', vendor: 'Almo Pro AV', startDate: '2026-02-01', durationMonths: 36, contactName: 'Jim Rhodes', contactEmail: 'jrhodes@almo.com', contactPhone: '215-555-0142', coverageNotes: 'Standard commercial warranty, advance replacement' },
      { id: 'w2', closeoutId: 'c1', system: 'Audio DSP System', manufacturer: 'Biamp', model: 'TesiraFORTE AI', vendor: 'Starin', startDate: '2026-02-01', durationMonths: 60, contactName: 'Lisa Tran', contactEmail: 'ltran@starin.com', contactPhone: '320-555-0198', coverageNotes: '5-year factory warranty' },
    ],
    punchItems: [
      { id: 'pi1', closeoutId: 'c1', description: 'Display 3-4 in Zone B showing slight color mismatch', location: 'Trading Floor - Zone B', assignedTo: 'Mike Torres', status: 'Open', priority: 'Standard' },
      { id: 'pi2', closeoutId: 'c1', description: 'Ceiling mic in Huddle Room 2 not responding to mute commands', location: 'Huddle Room 2', assignedTo: 'Tech Team', status: 'In Progress', priority: 'Critical' },
      { id: 'pi3', closeoutId: 'c1', description: 'Cable labels missing on patch panel ports 13-24', location: 'AV Rack Room', assignedTo: 'Field Crew', status: 'Complete', priority: 'Standard', resolvedAt: '2026-03-05' },
    ],
    signOffSheets: [],
    asBuiltDrawings: [],
    quickStartRooms: [],
  },
];

const seedManuals: OwnerManual[] = [
  {
    id: 'm1', projectId: 'p3', title: 'Trading Floor AV Systems - Owner Operations Manual', revision: 'Rev 0', overviewText: 'This manual covers the audiovisual systems installed on the Brookfield Place Trading Floor, including display arrays, audio conferencing, and the centralized control system. All systems are managed via the Crestron touch panels located at each trading desk cluster.', createdAt: '2026-03-01',
    sections: [
      {
        id: 'ms1', manualId: 'm1', title: 'Display Systems', type: 'System Section', sortOrder: 0,
        devices: [
          { id: 'md1', sectionId: 'ms1', manufacturer: 'Samsung', model: 'QM55C', location: 'Trading Floor - All Zones', purpose: 'Primary trading displays mounted above desk clusters', operationNotes: 'Displays power on/off via Crestron automation. Manual power button on bottom-right edge for emergency override. Input is locked to NVX decoder — do not change.', sortOrder: 0 },
          { id: 'md2', sectionId: 'ms1', manufacturer: 'LG', model: '86UQ8000', location: 'Trading Floor - Break Area', purpose: 'News/market feed display', operationNotes: 'Tuned to Bloomberg by default. Use Crestron panel to switch between presets: Bloomberg, CNBC, Custom HDMI.', sortOrder: 1 },
        ],
      },
      {
        id: 'ms2', manualId: 'm1', title: 'Audio Conferencing', type: 'System Section', sortOrder: 1,
        devices: [
          { id: 'md3', sectionId: 'ms2', manufacturer: 'Biamp', model: 'TesiraFORTE AI', location: 'AV Rack Room', purpose: 'Central DSP for all huddle room and conference audio', operationNotes: 'Managed via Biamp TesiraFORTE software. IP: 10.1.50.10. Contact Instrata for any DSP configuration changes.', ipAddress: '10.1.50.10', sortOrder: 0 },
        ],
      },
    ],
  },
];

// Demo change orders — pulled read-only from DTools alongside the BoM.
// p1 (Vanderbilt) showcases all three groups so the UI is exercised; other
// projects stay quiet so empty / single-state cases also render cleanly.
const seedChangeOrders: ProjectChangeOrder[] = [
  { id: 'co1', projectId: 'p1', number: 'COR-001', title: 'Wireless mic upgrade',           description: 'Upgrade from MXW1 to MXW2 transmitters across 6 conference rooms.', amount: 6200,  status: 'Approved', category: 'External', requestedAt: '2026-03-04', resolvedAt: '2026-03-08', dToolsId: 'DT-CO-22041' },
  { id: 'co2', projectId: 'p1', number: 'COR-002', title: 'Added rooms 21B & 21C',          description: 'Owner-requested addition of two huddle rooms to the original scope.', amount: 18400, status: 'Approved', category: 'External', requestedAt: '2026-04-02', resolvedAt: '2026-04-11', dToolsId: 'DT-CO-22128' },
  { id: 'co3', projectId: 'p1', number: 'COR-003', title: 'Acoustic treatment — Boardroom A', description: 'GPR found beam interference; acoustic panels needed for ceiling array performance.', amount: 4800, status: 'Pending', category: 'External', requestedAt: '2026-04-21', dToolsId: 'DT-CO-22241' },
  { id: 'co4', projectId: 'p1', number: 'COR-004', title: 'Network upgrade — IDF-3',        description: 'Switch upgrade to support PoE++ requirements for revised camera spec.', amount: 13600, status: 'Pending',  category: 'Internal', requestedAt: '2026-04-24', dToolsId: 'DT-CO-22288' },
  { id: 'co5', projectId: 'p1', number: 'COR-005', title: 'Premium DSP option',             description: 'Client requested premium DSP — cost prohibitive, withdrawn.',     amount: 9200,  status: 'Rejected', category: 'External', requestedAt: '2026-04-08', resolvedAt: '2026-04-14', dToolsId: 'DT-CO-22155' },
  { id: 'co6', projectId: 'p2', number: 'COR-001', title: 'Replace damaged display',         description: 'Display damaged during freight; covered by claim, no contract impact.', amount: 0, status: 'Approved', category: 'Internal', requestedAt: '2026-03-15', resolvedAt: '2026-03-18', dToolsId: 'DT-CO-21712' },
  { id: 'co7', projectId: 'p4', number: 'COR-001', title: 'Add lobby video wall',            description: 'Owner-requested 3x2 video wall addition to lobby scope.', amount: 42000, status: 'Pending', category: 'External', requestedAt: '2026-04-26', dToolsId: 'DT-CO-22301' },
];

// Demo milestones — anchored off today so the status badges (upcoming /
// at_risk / overdue) demo correctly without needing fresh seeds.
const seedMilestones: ProjectMilestone[] = (() => {
  const t = new Date();
  const offset = (days: number) => {
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const today = offset(0);
  return [
    { id: 'm-seed-1', projectId: 'p1', title: 'Submittal package due',     description: '', milestoneType: 'submittal_due',          tier: 'project', dueDate: offset(-3), notes: '', createdAt: today, updatedAt: today },
    { id: 'm-seed-2', projectId: 'p1', title: 'Material order deadline',   description: 'Hit longest lead time (Crestron NVX).', milestoneType: 'material_order_deadline', tier: 'project', dueDate: offset(5),  notes: '', createdAt: today, updatedAt: today },
    { id: 'm-seed-3', projectId: 'p1', title: 'Substantial completion',    description: '', milestoneType: 'substantial_completion', tier: 'project', dueDate: offset(60), notes: '', createdAt: today, updatedAt: today },
    { id: 'm-seed-4', projectId: 'p1', title: 'Bench staging complete',    description: '', milestoneType: 'bench_staging_complete', tier: 'phase',   phase: 'all', dueDate: offset(20), notes: '', createdAt: today, updatedAt: today },
    { id: 'm-seed-5', projectId: 'p1', title: 'Programming complete',      description: '', milestoneType: 'programming_complete',   tier: 'phase',   phase: 'all', dueDate: offset(45), completedDate: offset(-1), notes: '', createdAt: today, updatedAt: today },
  ];
})();

// Demo warehouses — visible only when Supabase isn't configured.
const seedWarehouses: Warehouse[] = [
  { id: 'wh1', name: 'Instrata HQ Warehouse',  addressLine1: '125 Industrial Blvd',  addressLine2: '', city: 'Long Island City', state: 'NY', postalCode: '11101', notes: '', isActive: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  { id: 'wh2', name: 'Instrata SE Warehouse',   addressLine1: '4400 Logistics Way', addressLine2: '', city: 'Atlanta',           state: 'GA', postalCode: '30318', notes: '', isActive: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
];

// ---------------------------------------------------------------------------
// Review row mappers
// ---------------------------------------------------------------------------

function rowToReviewRun(r: any): ReviewRun {
  return {
    id: r.id, projectId: r.project_id, runNumber: r.run_number,
    triggeredAt: r.triggered_at, status: r.status,
    reviewedBy: r.reviewed_by ?? undefined, reviewedAt: r.reviewed_at ?? undefined,
    createdAt: r.created_at,
  };
}

function rowToReviewFlag(r: any): ReviewFlag {
  return {
    id: r.id, reviewRunId: r.review_run_id, ruleId: r.rule_id,
    severity: r.severity, category: r.category, flagName: r.flag_name,
    description: r.description, lineItemRef: r.line_item_ref ?? undefined,
    status: r.status, managerComment: r.manager_comment ?? undefined,
    resolvedBy: r.resolved_by ?? undefined, resolvedAt: r.resolved_at ?? undefined,
    diffStatus: r.diff_status ?? undefined, createdAt: r.created_at,
  };
}

// --- Bid Leveling ---
function rowToBidLevelingSession(r: any): BidLevelingSession {
  return {
    id: r.id, projectId: r.project_id,
    bomCsvUrl: r.bom_csv_url ?? undefined,
    templateXlsxUrl: r.template_xlsx_url ?? undefined,
    mappingTemplateId: r.mapping_template_id ?? undefined,
    cellMappingsSnapshot: r.cell_mappings_snapshot ?? undefined,
    generatedXlsxUrl: r.generated_xlsx_url ?? undefined,
    generationReport: r.generation_report ?? undefined,
    status: r.status,
    createdBy: r.created_by ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function bidLevelingSessionToRow(s: Partial<BidLevelingSession> & { createdBy?: string }): Record<string, any> {
  const row: any = {};
  if (s.id !== undefined) row.id = s.id;
  if (s.projectId !== undefined) row.project_id = s.projectId;
  if (s.bomCsvUrl !== undefined) row.bom_csv_url = s.bomCsvUrl;
  if (s.templateXlsxUrl !== undefined) row.template_xlsx_url = s.templateXlsxUrl;
  if (s.mappingTemplateId !== undefined) row.mapping_template_id = s.mappingTemplateId;
  if (s.cellMappingsSnapshot !== undefined) row.cell_mappings_snapshot = s.cellMappingsSnapshot;
  if (s.generatedXlsxUrl !== undefined) row.generated_xlsx_url = s.generatedXlsxUrl;
  if (s.generationReport !== undefined) row.generation_report = s.generationReport;
  if (s.status !== undefined) row.status = s.status;
  if (s.createdBy !== undefined) row.created_by = s.createdBy;
  if (s.createdAt !== undefined) row.created_at = s.createdAt;
  if (s.updatedAt !== undefined) row.updated_at = s.updatedAt;
  return row;
}
function rowToBidLevelingTemplate(r: any): BidLevelingMappingTemplate {
  return {
    id: r.id, name: r.name,
    gcConsultantName: r.gc_consultant_name ?? undefined,
    cellMappings: r.cell_mappings ?? [],
    createdBy: r.created_by ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function bidLevelingTemplateToRow(t: Partial<BidLevelingMappingTemplate> & { createdBy?: string }): Record<string, any> {
  const row: any = {};
  if (t.id !== undefined) row.id = t.id;
  if (t.name !== undefined) row.name = t.name;
  if (t.gcConsultantName !== undefined) row.gc_consultant_name = t.gcConsultantName;
  if (t.cellMappings !== undefined) row.cell_mappings = t.cellMappings;
  if (t.createdBy !== undefined) row.created_by = t.createdBy;
  if (t.createdAt !== undefined) row.created_at = t.createdAt;
  if (t.updatedAt !== undefined) row.updated_at = t.updatedAt;
  return row;
}

// --- Project Milestones ---
function rowToMilestone(r: any): ProjectMilestone {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title ?? '',
    description: r.description ?? '',
    milestoneType: r.milestone_type as MilestoneType,
    tier: r.tier as MilestoneTier,
    phase: r.phase ?? undefined,
    dueDate: toDate(r.due_date),
    completedDate: r.completed_date ? toDate(r.completed_date) : undefined,
    ownerId: r.owner_id ?? undefined,
    notes: r.notes ?? '',
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}
function milestoneToRow(m: Partial<ProjectMilestone> & { createdBy?: string }): Record<string, any> {
  const row: any = {};
  if (m.id !== undefined)            row.id = m.id;
  if (m.projectId !== undefined)     row.project_id = m.projectId;
  if (m.title !== undefined)         row.title = m.title;
  if (m.description !== undefined)   row.description = m.description;
  if (m.milestoneType !== undefined) row.milestone_type = m.milestoneType;
  if (m.tier !== undefined)          row.tier = m.tier;
  if (m.phase !== undefined)         row.phase = m.phase || null;
  if (m.dueDate !== undefined)       row.due_date = m.dueDate || null;
  if (m.completedDate !== undefined) row.completed_date = m.completedDate || null;
  if (m.ownerId !== undefined)       row.owner_id = m.ownerId || null;
  if (m.notes !== undefined)         row.notes = m.notes;
  if ((m as any).createdBy !== undefined) row.created_by = (m as any).createdBy;
  return row;
}

// --- Change Orders ---
// COs are read-only on the client — the dtools-project-lookup Edge Function
// is the only writer. We never need a *ToRow helper; only the row → object
// mapper used to hydrate the store from Supabase.
function rowToChangeOrder(r: any): ProjectChangeOrder {
  const itemRows: any[] = Array.isArray(r.change_order_items) ? r.change_order_items : [];
  return {
    id: r.id,
    projectId: r.project_id,
    number: r.number ?? '',
    title: r.title ?? '',
    description: r.description ?? '',
    amount: typeof r.amount === 'number' ? r.amount : Number(r.amount ?? 0),
    status: r.status,
    category: r.category,
    requestedAt: r.requested_at ? toDate(r.requested_at) : '',
    resolvedAt: r.resolved_at ? toDate(r.resolved_at) : undefined,
    dToolsId: r.dtools_id ?? '',
    cost: r.cost != null ? Number(r.cost) : undefined,
    tax: r.tax != null ? Number(r.tax) : undefined,
    laborHours: r.labor_hours != null ? Number(r.labor_hours) : undefined,
    dtoolsVerified: r.dtools_verified ?? undefined,
    items: itemRows.length > 0
      ? itemRows
          .slice()
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((it) => ({
            id: it.id,
            changeType: it.change_type ?? 'Other',
            manufacturer: it.manufacturer ?? '',
            model: it.model ?? '',
            description: it.description ?? '',
            qty: Number(it.qty) || 0,
            unitCost: Number(it.unit_cost) || 0,
            unitPrice: Number(it.unit_price) || 0,
            itemType: it.item_type ?? 'Product',
            location: it.location ?? '',
            laborHours: Number(it.labor_hours) || 0,
            laborCost: Number(it.labor_cost) || 0,
            laborPrice: Number(it.labor_price) || 0,
          }))
      : undefined,
  };
}

// --- Warehouses ---
function rowToWarehouse(r: any): Warehouse {
  return {
    id: r.id,
    name: r.name ?? '',
    addressLine1: r.address_line1 ?? '',
    addressLine2: r.address_line2 ?? '',
    city: r.city ?? '',
    state: r.state ?? '',
    postalCode: r.postal_code ?? '',
    notes: r.notes ?? '',
    isActive: r.is_active ?? true,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}
function warehouseToRow(w: Partial<Warehouse>): Record<string, any> {
  const row: any = {};
  if (w.id !== undefined) row.id = w.id;
  if (w.name !== undefined) row.name = w.name;
  if (w.addressLine1 !== undefined) row.address_line1 = w.addressLine1;
  if (w.addressLine2 !== undefined) row.address_line2 = w.addressLine2;
  if (w.city !== undefined) row.city = w.city;
  if (w.state !== undefined) row.state = w.state;
  if (w.postalCode !== undefined) row.postal_code = w.postalCode;
  if (w.notes !== undefined) row.notes = w.notes;
  if (w.isActive !== undefined) row.is_active = w.isActive;
  return row;
}

// --- Purchasing Modules ---
function rowToPurchasingModule(r: any, submittalIds: string[] = []): PurchasingModule {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title ?? '',
    notes: r.notes ?? '',
    submittalIds,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}
function purchasingModuleToRow(m: Partial<PurchasingModule>): Record<string, any> {
  const row: any = {};
  if (m.id !== undefined) row.id = m.id;
  if (m.projectId !== undefined) row.project_id = m.projectId;
  if (m.title !== undefined) row.title = m.title;
  if (m.notes !== undefined) row.notes = m.notes;
  return row;
}

// --- Purchasing Items ---
function rowToPurchasingItem(r: any): PurchasingItem {
  return {
    id: r.id,
    purchasingModuleId: r.purchasing_module_id,
    submittalItemId: r.submittal_item_id,
    purchaseUnitPrice: r.purchase_unit_price !== null && r.purchase_unit_price !== undefined ? Number(r.purchase_unit_price) : undefined,
    shipToWarehouseId: r.ship_to_warehouse_id ?? undefined,
    shipToCustomAddress: r.ship_to_custom_address ?? undefined,
    needByDate: r.need_by_date ? toDate(r.need_by_date) : undefined,
    purchaseStatus: (r.purchase_status as PurchaseStatus) ?? 'not_ordered',
    orderedDate: r.ordered_date ? toDate(r.ordered_date) : undefined,
    receivedDate: r.received_date ? toDate(r.received_date) : undefined,
    poNumber: r.po_number ?? undefined,
    notes: r.notes ?? '',
  };
}
function purchasingItemToRow(p: Partial<PurchasingItem>): Record<string, any> {
  const row: any = {};
  if (p.id !== undefined) row.id = p.id;
  if (p.purchasingModuleId !== undefined) row.purchasing_module_id = p.purchasingModuleId;
  if (p.submittalItemId !== undefined) row.submittal_item_id = p.submittalItemId;
  if (p.purchaseUnitPrice !== undefined) row.purchase_unit_price = p.purchaseUnitPrice ?? null;
  if (p.shipToWarehouseId !== undefined) row.ship_to_warehouse_id = p.shipToWarehouseId || null;
  if (p.shipToCustomAddress !== undefined) row.ship_to_custom_address = p.shipToCustomAddress || null;
  if (p.needByDate !== undefined) row.need_by_date = p.needByDate || null;
  if (p.purchaseStatus !== undefined) row.purchase_status = p.purchaseStatus;
  if (p.orderedDate !== undefined) row.ordered_date = p.orderedDate || null;
  if (p.receivedDate !== undefined) row.received_date = p.receivedDate || null;
  if (p.poNumber !== undefined) row.po_number = p.poNumber || null;
  if (p.notes !== undefined) row.notes = p.notes;
  return row;
}

// --- Purchasing Freight ---
function rowToPurchasingFreight(r: any): PurchasingFreight {
  return {
    id: r.id,
    purchasingModuleId: r.purchasing_module_id,
    manufacturer: r.manufacturer,
    purchaseUnitPrice: r.purchase_unit_price !== null && r.purchase_unit_price !== undefined ? Number(r.purchase_unit_price) : undefined,
    shipToWarehouseId: r.ship_to_warehouse_id ?? undefined,
    shipToCustomAddress: r.ship_to_custom_address ?? undefined,
    needByDate: r.need_by_date ? toDate(r.need_by_date) : undefined,
    purchaseStatus: (r.purchase_status as PurchaseStatus) ?? 'not_ordered',
    orderedDate: r.ordered_date ? toDate(r.ordered_date) : undefined,
    receivedDate: r.received_date ? toDate(r.received_date) : undefined,
    poNumber: r.po_number ?? undefined,
    notes: r.notes ?? '',
  };
}
function purchasingFreightToRow(f: Partial<PurchasingFreight>): Record<string, any> {
  const row: any = {};
  if (f.id !== undefined) row.id = f.id;
  if (f.purchasingModuleId !== undefined) row.purchasing_module_id = f.purchasingModuleId;
  if (f.manufacturer !== undefined) row.manufacturer = f.manufacturer;
  if (f.purchaseUnitPrice !== undefined) row.purchase_unit_price = f.purchaseUnitPrice ?? null;
  if (f.shipToWarehouseId !== undefined) row.ship_to_warehouse_id = f.shipToWarehouseId || null;
  if (f.shipToCustomAddress !== undefined) row.ship_to_custom_address = f.shipToCustomAddress || null;
  if (f.needByDate !== undefined) row.need_by_date = f.needByDate || null;
  if (f.purchaseStatus !== undefined) row.purchase_status = f.purchaseStatus;
  if (f.orderedDate !== undefined) row.ordered_date = f.orderedDate || null;
  if (f.receivedDate !== undefined) row.received_date = f.receivedDate || null;
  if (f.poNumber !== undefined) row.po_number = f.poNumber || null;
  if (f.notes !== undefined) row.notes = f.notes;
  return row;
}

// --- Manufacturer Defaults ---
function rowToMfrDefault(r: any): PurchasingManufacturerDefault {
  return {
    id: r.id,
    purchasingModuleId: r.purchasing_module_id,
    manufacturer: r.manufacturer,
    shipToWarehouseId: r.ship_to_warehouse_id ?? undefined,
    shipToCustomAddress: r.ship_to_custom_address ?? undefined,
    needByDate: r.need_by_date ? toDate(r.need_by_date) : undefined,
  };
}
function mfrDefaultToRow(d: Partial<PurchasingManufacturerDefault>): Record<string, any> {
  const row: any = {};
  if (d.id !== undefined) row.id = d.id;
  if (d.purchasingModuleId !== undefined) row.purchasing_module_id = d.purchasingModuleId;
  if (d.manufacturer !== undefined) row.manufacturer = d.manufacturer;
  if (d.shipToWarehouseId !== undefined) row.ship_to_warehouse_id = d.shipToWarehouseId || null;
  if (d.shipToCustomAddress !== undefined) row.ship_to_custom_address = d.shipToCustomAddress || null;
  if (d.needByDate !== undefined) row.need_by_date = d.needByDate || null;
  return row;
}

// ---------------------------------------------------------------------------
// Store Interface
// ---------------------------------------------------------------------------

interface AppState {
  // Data
  projects: Project[];
  projectBoM: ProjectBoMItem[];
  submittals: Submittal[];
  rfis: RFI[];
  closeouts: CloseoutPackage[];
  manuals: OwnerManual[];
  reviewRuns: ReviewRun[];
  bidLevelingSessions: BidLevelingSession[];
  bidLevelingTemplates: BidLevelingMappingTemplate[];
  milestones: ProjectMilestone[];
  changeOrders: ProjectChangeOrder[];
  warehouses: Warehouse[];
  purchasingModules: PurchasingModule[];
  purchasingItems: PurchasingItem[];
  purchasingFreight: PurchasingFreight[];
  purchasingMfrDefaults: PurchasingManufacturerDefault[];

  // Project comments — lazy-loaded per project. Fetched the first time a
  // user opens the Comments tab; subsequent visits hit the cache and a
  // background refresh pulls anything posted by other users.
  projectComments: ProjectComment[];
  commentsLoadedFor: Set<string>;

  // Project documents (Gross Margin Form, …) — lazy-loaded per project the
  // first time the Project Documentation card is opened. Stores only manual
  // overrides; the form's defaults are computed live from the BoM.
  projectDocuments: ProjectDocument[];
  documentsLoadedFor: Set<string>;

  // Current user's project_members rows — set of project ids the logged-in
  // user is on. Drives Dashboard "My Projects" + scoped pipeline counts.
  // In demo mode this is filled with every seed project id so the feature
  // demos cleanly.
  myProjectIds: Set<string>;

  // Loading state
  isLoading: boolean;
  isInitialized: boolean;

  // Hydrate from Supabase
  fetchAllData: () => Promise<void>;

  // Project actions
  addProject: (p: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateProject: (id: string, p: Partial<Project>) => void;
  deleteProject: (id: string) => void;
  /** Insert a project_members row for the current user, then update
   *  myProjectIds. Idempotent: no-op if already a member. Used by the
   *  "Add me" action on the global Projects page. */
  addSelfToProject: (projectId: string) => Promise<void>;

  // DTools sync
  syncDToolsBoM: (projectId: string) => Promise<void>;
  /** Link an existing (non-DTools) project to a chosen DTools project, then
   *  pull its BoM. Used by the "Sync from DTools" button on projects that
   *  came from Monday and have no DTools id yet. */
  linkDToolsAndSyncBoM: (
    projectId: string,
    dtools: { dtoolsId: string; number: string; projectTotal: number },
  ) => Promise<void>;

  // Project BoM actions
  addBoMItem: (projectId: string, item: Omit<ProjectBoMItem, 'id' | 'projectId'>) => string;
  updateBoMItem: (itemId: string, updates: Partial<ProjectBoMItem>) => void;
  deleteBoMItem: (itemId: string) => void;
  importBoMItems: (projectId: string, items: { manufacturer: string; model: string; description: string; category: ItemCategory; qty: number; notes: string; locations: SubmittalItemLocation[]; cutSheetData?: string; cutSheetName?: string; itemType?: BomItemType; unitCost?: number; unitPrice?: number; laborHours?: number; laborUnitCost?: number; laborUnitPrice?: number; fixedLaborCost?: number; fixedLaborPrice?: number; marginPct?: number; ownerFurnished?: boolean; optional?: boolean; laborType?: string; laborBreakdown?: LaborBreakdownEntry[]; includedInPhase?: boolean }[]) => void;

  // Submittal actions
  addSubmittal: (s: Omit<Submittal, 'id' | 'createdAt' | 'items'>) => string;
  updateSubmittal: (id: string, s: Partial<Submittal>) => void;
  deleteSubmittal: (id: string) => void;
  addSubmittalItem: (submittalId: string, item: Omit<SubmittalItem, 'id' | 'submittalId'>) => void;
  updateSubmittalItem: (submittalId: string, itemId: string, item: Partial<SubmittalItem>) => void;
  deleteSubmittalItem: (submittalId: string, itemId: string) => void;
  reorderSubmittalItems: (submittalId: string, itemIds: string[]) => void;
  populateSubmittalFromBoM: (submittalId: string, projectId: string) => void;
  /** Look up each item's manufacturer + model in the SharePoint cutsheet
   *  repository and attach the matching repo cutsheet ID. Safe to call
   *  multiple times — only updates items that don't already have a cutsheet
   *  attached. */
  attachRepoCutsheetsToSubmittal: (submittalId: string) => Promise<{ attached: number; checked: number }>;

  // RFI actions
  addRFI: (r: Omit<RFI, 'id' | 'number' | 'createdAt' | 'attachments'>) => string;
  updateRFI: (id: string, r: Partial<RFI>) => void;
  deleteRFI: (id: string) => void;

  // Closeout actions
  getOrCreateCloseout: (projectId: string) => string;
  updateCloseout: (id: string, c: Partial<CloseoutPackage>) => void;
  addWarranty: (closeoutId: string, w: Omit<Warranty, 'id' | 'closeoutId'>) => void;
  updateWarranty: (closeoutId: string, wId: string, w: Partial<Warranty>) => void;
  deleteWarranty: (closeoutId: string, wId: string) => void;
  populateWarrantiesFromBoM: (closeoutId: string, projectId: string) => void;
  addPunchItem: (closeoutId: string, p: Omit<PunchItem, 'id' | 'closeoutId'>) => void;
  updatePunchItem: (closeoutId: string, pId: string, p: Partial<PunchItem>) => void;
  deletePunchItem: (closeoutId: string, pId: string) => void;
  addSignOffSheet: (closeoutId: string, s: Omit<SignOffSheet, 'id' | 'closeoutId'>) => void;
  updateSignOffSheet: (closeoutId: string, sId: string, s: Partial<SignOffSheet>) => void;
  deleteSignOffSheet: (closeoutId: string, sId: string) => void;
  addSignOffCustomItem: (closeoutId: string, sheetId: string, text: string) => void;
  updateSignOffCustomItem: (closeoutId: string, sheetId: string, itemId: string, text: string) => void;
  deleteSignOffCustomItem: (closeoutId: string, sheetId: string, itemId: string) => void;
  addAsBuiltDrawing: (closeoutId: string, d: Omit<AsBuiltDrawing, 'id' | 'closeoutId' | 'uploadedAt'>) => void;
  deleteAsBuiltDrawing: (closeoutId: string, dId: string) => void;
  setProductManual: (closeoutId: string, url: string, name: string) => void;
  clearProductManual: (closeoutId: string) => void;

  // Quick Start Guide actions
  addQuickStartRoom: (closeoutId: string, name: string) => string;
  updateQuickStartRoom: (closeoutId: string, roomId: string, updates: Partial<QuickStartRoom>) => void;
  deleteQuickStartRoom: (closeoutId: string, roomId: string) => void;
  addQuickStartStep: (closeoutId: string, roomId: string, step: Omit<QuickStartStep, 'id' | 'roomId' | 'sortOrder'>) => string;
  updateQuickStartStep: (closeoutId: string, roomId: string, stepId: string, updates: Partial<QuickStartStep>) => void;
  deleteQuickStartStep: (closeoutId: string, roomId: string, stepId: string) => void;

  // Manual actions
  addManual: (m: Omit<OwnerManual, 'id' | 'createdAt' | 'sections'>) => string;
  updateManual: (id: string, m: Partial<OwnerManual>) => void;
  deleteManual: (id: string) => void;
  addManualSection: (manualId: string, s: Omit<ManualSection, 'id' | 'manualId' | 'devices'>) => void;
  updateManualSection: (manualId: string, sId: string, s: Partial<ManualSection>) => void;
  deleteManualSection: (manualId: string, sId: string) => void;
  addManualDevice: (manualId: string, sectionId: string, d: Omit<ManualDevice, 'id' | 'sectionId'>) => void;
  updateManualDevice: (manualId: string, sectionId: string, dId: string, d: Partial<ManualDevice>) => void;
  deleteManualDevice: (manualId: string, sectionId: string, dId: string) => void;

  // Review actions
  fetchProjectFlags: (runId: string) => Promise<ReviewFlag[]>;
  updateRunStatus: (runId: string, status: ReviewRunStatus, reviewedBy?: string) => Promise<void>;
  updateFlagStatus: (flagId: string, status: ReviewFlagStatus, comment?: string) => Promise<void>;
  createReviewRunFromCsv: (projectId: string, csvText: string) => Promise<{ runId: string; flagCount: number }>;

  // Bid Leveling actions
  addBidLevelingSession: (s: Omit<BidLevelingSession, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateBidLevelingSession: (id: string, s: Partial<BidLevelingSession>) => void;
  deleteBidLevelingSession: (id: string) => void;
  addBidLevelingTemplate: (t: Omit<BidLevelingMappingTemplate, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateBidLevelingTemplate: (id: string, t: Partial<BidLevelingMappingTemplate>) => void;
  deleteBidLevelingTemplate: (id: string) => void;

  // Milestone actions
  addMilestone: (m: Omit<ProjectMilestone, 'id' | 'createdAt' | 'updatedAt'>) => string;
  addMilestonesBatch: (items: Omit<ProjectMilestone, 'id' | 'createdAt' | 'updatedAt'>[]) => void;
  updateMilestone: (id: string, m: Partial<ProjectMilestone>) => void;
  deleteMilestone: (id: string) => void;
  markMilestoneComplete: (id: string, note?: string) => void;

  // Submittal item-level approval — separate action so the package status
  // can auto-advance (all items approved → package Approved; one item
  // reverted → package R&R) without leaking that logic into every caller.
  setSubmittalItemApproval: (submittalId: string, itemId: string, state: SubmittalItemApprovalState) => void;

  // Warehouse actions (admin-only on the DB, gated client-side too)
  addWarehouse: (w: Omit<Warehouse, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateWarehouse: (id: string, w: Partial<Warehouse>) => void;
  deleteWarehouse: (id: string) => void;

  // Purchasing actions
  addPurchasingModule: (m: { projectId: string; title: string; submittalIds: string[] }) => string;
  updatePurchasingModule: (id: string, m: Partial<PurchasingModule>) => void;
  deletePurchasingModule: (id: string) => void;
  linkSubmittalToPurchasingModule: (purchasingModuleId: string, submittalId: string) => void;
  unlinkSubmittalFromPurchasingModule: (purchasingModuleId: string, submittalId: string) => void;
  /** Insert or update the persisted purchasing row for a given submittal item.
   *  No-op rows aren't worth saving — caller should pass meaningful data. */
  upsertPurchasingItem: (input: { purchasingModuleId: string; submittalItemId: string; updates: Partial<PurchasingItem> }) => void;
  upsertPurchasingFreight: (input: { purchasingModuleId: string; manufacturer: string; updates: Partial<PurchasingFreight> }) => void;
  upsertMfrDefault: (input: { purchasingModuleId: string; manufacturer: string; updates: Partial<PurchasingManufacturerDefault> }) => void;

  // Project comment actions — lazy-loaded per project. fetchProjectComments
  // is safe to call on every tab open; it short-circuits on the cached
  // projectId and refreshes silently in the background.
  fetchProjectComments: (projectId: string) => Promise<void>;
  addProjectComment: (input: { projectId: string; parentId: string | null; body: string }) => Promise<string | null>;
  // Project documents (Gross Margin Form). Lazy fetch + upsert of overrides.
  fetchProjectDocuments: (projectId: string) => Promise<void>;
  saveProjectDocument: (input: { projectId: string; docType: ProjectDocumentType; overrides: Record<string, number | string>; status?: string }) => Promise<void>;
  updateProjectComment: (commentId: string, body: string) => Promise<void>;
  deleteProjectComment: (commentId: string) => Promise<void>;
  toggleCommentReaction: (commentId: string, emoji: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

const DB = isSupabaseConfigured();

export const useStore = create<AppState>((set, get) => ({
  // In demo mode, start with seeds. In Supabase mode, start empty (fetchAllData fills it).
  projects: DB ? [] : seedProjects,
  projectBoM: DB ? [] : seedProjectBoM,
  submittals: DB ? [] : seedSubmittals,
  rfis: DB ? [] : seedRFIs,
  closeouts: DB ? [] : seedCloseouts,
  manuals: DB ? [] : seedManuals,
  reviewRuns: [],
  bidLevelingSessions: [],
  bidLevelingTemplates: [],
  milestones: DB ? [] : seedMilestones,
  changeOrders: DB ? [] : seedChangeOrders,
  warehouses: DB ? [] : seedWarehouses,
  purchasingModules: [],
  purchasingItems: [],
  purchasingFreight: [],
  purchasingMfrDefaults: [],

  projectComments: [],
  commentsLoadedFor: new Set<string>(),

  projectDocuments: [],
  documentsLoadedFor: new Set<string>(),

  // Demo mode: pretend the demo user is on every seed project. Supabase mode
  // starts empty; fetchAllData populates it from project_members.
  myProjectIds: DB ? new Set<string>() : new Set(seedProjects.map((p) => p.id)),

  isLoading: DB,      // start loading if Supabase is configured
  isInitialized: !DB, // already initialized in demo mode

  // =========================================================================
  // fetchAllData — loads everything from Supabase into the store
  // =========================================================================
  fetchAllData: async () => {
    if (!isSupabaseConfigured()) {
      set({ isLoading: false, isInitialized: true });
      return;
    }

    // Prevent double-fetching
    if (get().isInitialized) return;
    set({ isLoading: true });

    // Current user is needed before we can pull their project_members rows.
    // Failure here is non-fatal — we proceed with an empty myProjectIds set
    // so the rest of the app still hydrates.
    const { data: { user: authUser } } = await supabase.auth.getUser();
    const currentUserId = authUser?.id ?? null;

    try {
      // Fetch all tables in parallel (with 10s timeout to prevent infinite spinner)
      const fetchWithTimeout = Promise.all([
        supabase.from('projects').select('*'),
        supabase.from('project_bom_items').select('*'),
        supabase.from('submittals').select('*'),
        supabase.from('submittal_items').select('*'),
        supabase.from('rfis').select('*'),
        supabase.from('closeout_packages').select('*'),
        supabase.from('warranties').select('*'),
        supabase.from('punch_items').select('*'),
        supabase.from('sign_off_sheets').select('*'),
        supabase.from('as_built_drawings').select('*'),
        supabase.from('quick_start_rooms').select('*'),
        supabase.from('quick_start_steps').select('*'),
        supabase.from('owner_manuals').select('*'),
        // Review runs — summary only (no csv_snapshot, no flags)
        supabase.from('review_runs').select('id,project_id,run_number,triggered_at,status,reviewed_by,reviewed_at,created_at').order('run_number', { ascending: false }),
        // Bid Leveling
        supabase.from('bid_leveling_sessions').select('*'),
        supabase.from('bid_leveling_mapping_templates').select('*'),
        // Milestones
        supabase.from('project_milestones').select('*'),
        // Change orders — read-only, populated by the dtools-project-lookup
        // Edge Function alongside the BoM. Nested select pulls each CO's
        // signed line-item deltas in the same round trip.
        supabase.from('change_orders').select('*, change_order_items(*)'),
        // Warehouses (org-wide)
        supabase.from('warehouses').select('*'),
        // Purchasing
        supabase.from('purchasing_modules').select('*'),
        supabase.from('purchasing_module_submittals').select('*'),
        supabase.from('purchasing_items').select('*'),
        supabase.from('purchasing_freight').select('*'),
        supabase.from('purchasing_manufacturer_defaults').select('*'),
        // Current user's project memberships — drives the Dashboard scope.
        // Filtered server-side so we only pay for the rows we need.
        currentUserId
          ? supabase.from('project_members').select('project_id').eq('user_id', currentUserId)
          : Promise.resolve({ data: [] as Array<{ project_id: string }>, error: null }),
      ]);

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Data fetch timed out')), 10000),
      );

      const [
        projectsRes,
        bomRes,
        submittalsRes,
        submittalItemsRes,
        rfisRes,
        closeoutsRes,
        warrantiesRes,
        punchItemsRes,
        signOffSheetsRes,
        asBuiltDrawingsRes,
        quickStartRoomsRes,
        quickStartStepsRes,
        manualsRes,
        reviewRunsRes,
        bidLevelingSessionsRes,
        bidLevelingTemplatesRes,
        milestonesRes,
        changeOrdersRes,
        warehousesRes,
        purchasingModulesRes,
        purchasingModSubsRes,
        purchasingItemsRes,
        purchasingFreightRes,
        purchasingMfrDefaultsRes,
        myMembershipsRes,
      ] = await Promise.race([fetchWithTimeout, timeout]);

      // Log any errors but continue with whatever data we got
      for (const res of [projectsRes, bomRes, submittalsRes, submittalItemsRes, rfisRes, closeoutsRes, warrantiesRes, punchItemsRes, signOffSheetsRes, asBuiltDrawingsRes, quickStartRoomsRes, quickStartStepsRes, manualsRes, reviewRunsRes, bidLevelingSessionsRes, bidLevelingTemplatesRes, milestonesRes, changeOrdersRes, warehousesRes, purchasingModulesRes, purchasingModSubsRes, purchasingItemsRes, purchasingFreightRes, purchasingMfrDefaultsRes, myMembershipsRes]) {
        if (res.error) console.warn('[Supabase fetch]', res.error.message);
      }

      // Map rows
      const projects = (projectsRes.data ?? []).map(rowToProject);
      const projectBoM = (bomRes.data ?? []).map(rowToBoMItem);
      const rfis = (rfisRes.data ?? []).map(rowToRFI);
      const manuals = (manualsRes.data ?? []).map(rowToManual);
      const reviewRuns = (reviewRunsRes.data ?? []).map(rowToReviewRun);
      const bidLevelingSessions = (bidLevelingSessionsRes.data ?? []).map(rowToBidLevelingSession);
      const bidLevelingTemplates = (bidLevelingTemplatesRes.data ?? []).map(rowToBidLevelingTemplate);
      const milestones = (milestonesRes.data ?? []).map(rowToMilestone);
      const changeOrders = (changeOrdersRes.data ?? []).map(rowToChangeOrder);
      const warehouses = (warehousesRes.data ?? []).map(rowToWarehouse);

      // Purchasing — collapse junction rows into submittalIds[] on each module
      const modSubByModule = new Map<string, string[]>();
      for (const link of (purchasingModSubsRes.data ?? [])) {
        const arr = modSubByModule.get(link.purchasing_module_id) ?? [];
        arr.push(link.submittal_id);
        modSubByModule.set(link.purchasing_module_id, arr);
      }
      const purchasingModules = (purchasingModulesRes.data ?? []).map((r: any) =>
        rowToPurchasingModule(r, modSubByModule.get(r.id) ?? []),
      );
      const purchasingItems = (purchasingItemsRes.data ?? []).map(rowToPurchasingItem);
      const purchasingFreight = (purchasingFreightRes.data ?? []).map(rowToPurchasingFreight);
      const purchasingMfrDefaults = (purchasingMfrDefaultsRes.data ?? []).map(rowToMfrDefault);

      // Nest submittal items into submittals
      const submittalItems = (submittalItemsRes.data ?? []).map(rowToSubmittalItem);
      const submittalItemsBySubmittalId = new Map<string, SubmittalItem[]>();
      for (const item of submittalItems) {
        const arr = submittalItemsBySubmittalId.get(item.submittalId) ?? [];
        arr.push(item);
        submittalItemsBySubmittalId.set(item.submittalId, arr);
      }
      const submittals: Submittal[] = (submittalsRes.data ?? []).map((r) => ({
        ...rowToSubmittal(r),
        items: (submittalItemsBySubmittalId.get(r.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder),
      }));

      // Nest closeout children
      const warranties = (warrantiesRes.data ?? []).map(rowToWarranty);
      const punchItems = (punchItemsRes.data ?? []).map(rowToPunchItem);
      const signOffSheets = (signOffSheetsRes.data ?? []).map(rowToSignOffSheet);
      const asBuiltDrawings = (asBuiltDrawingsRes.data ?? []).map(rowToAsBuiltDrawing);

      const warrantiesByCloseout = new Map<string, Warranty[]>();
      for (const w of warranties) {
        const arr = warrantiesByCloseout.get(w.closeoutId) ?? [];
        arr.push(w);
        warrantiesByCloseout.set(w.closeoutId, arr);
      }
      const punchByCloseout = new Map<string, PunchItem[]>();
      for (const p of punchItems) {
        const arr = punchByCloseout.get(p.closeoutId) ?? [];
        arr.push(p);
        punchByCloseout.set(p.closeoutId, arr);
      }
      const signOffByCloseout = new Map<string, SignOffSheet[]>();
      for (const s of signOffSheets) {
        const arr = signOffByCloseout.get(s.closeoutId) ?? [];
        arr.push(s);
        signOffByCloseout.set(s.closeoutId, arr);
      }
      const drawingsByCloseout = new Map<string, AsBuiltDrawing[]>();
      for (const d of asBuiltDrawings) {
        const arr = drawingsByCloseout.get(d.closeoutId) ?? [];
        arr.push(d);
        drawingsByCloseout.set(d.closeoutId, arr);
      }

      // Quick Start: rooms keyed by closeout_id, with their nested steps.
      const quickStartSteps = (quickStartStepsRes.data ?? []).map(rowToQuickStartStep);
      const stepsByRoom = new Map<string, QuickStartStep[]>();
      for (const s of quickStartSteps) {
        const arr = stepsByRoom.get(s.roomId) ?? [];
        arr.push(s);
        stepsByRoom.set(s.roomId, arr);
      }
      const quickStartRoomsRaw = (quickStartRoomsRes.data ?? []);
      const roomsByCloseout = new Map<string, QuickStartRoom[]>();
      for (const r of quickStartRoomsRaw) {
        const steps = (stepsByRoom.get(r.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
        const room = rowToQuickStartRoom(r, steps);
        const arr = roomsByCloseout.get(room.closeoutId) ?? [];
        arr.push(room);
        roomsByCloseout.set(room.closeoutId, arr);
      }
      // Sort each closeout's rooms once
      for (const arr of roomsByCloseout.values()) {
        arr.sort((a, b) => a.sortOrder - b.sortOrder);
      }

      const closeouts: CloseoutPackage[] = (closeoutsRes.data ?? []).map((r) => ({
        ...rowToCloseout(r),
        warranties: warrantiesByCloseout.get(r.id) ?? [],
        punchItems: punchByCloseout.get(r.id) ?? [],
        signOffSheets: signOffByCloseout.get(r.id) ?? [],
        asBuiltDrawings: drawingsByCloseout.get(r.id) ?? [],
        quickStartRooms: roomsByCloseout.get(r.id) ?? [],
      }));

      const myProjectIds = new Set<string>(
        (myMembershipsRes.data ?? []).map((r: { project_id: string }) => r.project_id),
      );

      set({
        projects, projectBoM, submittals, rfis, closeouts, manuals, reviewRuns,
        bidLevelingSessions, bidLevelingTemplates, milestones, changeOrders,
        warehouses, purchasingModules, purchasingItems, purchasingFreight, purchasingMfrDefaults,
        myProjectIds,
        isLoading: false, isInitialized: true,
      });
    } catch (err) {
      console.error('[Supabase fetchAllData failed]', err);
      set({ isLoading: false, isInitialized: true });
    }
  },

  // =========================================================================
  // Project actions
  // =========================================================================
  addProject: (p) => {
    const id = genId();
    const today = now();
    const project: Project = { ...p, id, createdAt: today, updatedAt: today };
    // Creator is auto-added as a member (both in demo mode and via the DB
    // insert below), so the new project shows up in their My Projects view
    // without waiting for a refetch.
    set((s) => ({
      projects: [...s.projects, project],
      myProjectIds: new Set(s.myProjectIds).add(id),
    }));

    dbExec(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id;
      const res = await supabase.from('projects').insert(projectToRow({ ...project, createdBy: userId } as any));
      // Also add the creator as a project member
      if (!res.error && userId) {
        const { error: memberError } = await supabase
          .from('project_members')
          .insert({ project_id: id, user_id: userId });
        if (memberError) console.error('[Supabase] Failed to add creator as project member:', memberError);
      }
      return res;
    });

    return id;
  },

  addSelfToProject: async (projectId) => {
    // Optimistic local update — the Set is immutable for React equality,
    // so we clone before adding.
    set((s) => {
      if (s.myProjectIds.has(projectId)) return s;
      const next = new Set(s.myProjectIds);
      next.add(projectId);
      return { myProjectIds: next };
    });

    if (!isSupabaseConfigured()) return;

    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;
    if (!userId) return;

    // Plain INSERT, not upsert. PostgREST upsert emits ON CONFLICT DO UPDATE,
    // which makes Postgres evaluate the UPDATE policy ("must already be a
    // member") even on a first-time add — the chicken-and-egg that silently
    // blocked non-admins. A bare insert hits only the self-add INSERT policy
    // (user_id = auth.uid()). A duplicate (already a member) is a harmless
    // no-op, so we swallow the unique-violation code 23505.
    const { error } = await supabase
      .from('project_members')
      .insert({ project_id: projectId, user_id: userId });
    if (error && error.code !== '23505') {
      console.error('[Supabase] addSelfToProject failed:', error);
      // Roll back the optimistic update so the UI reflects reality.
      set((s) => {
        const next = new Set(s.myProjectIds);
        next.delete(projectId);
        return { myProjectIds: next };
      });
    }
  },

  updateProject: (id, p) => {
    const updatedAt = now();
    set((s) => ({
      projects: s.projects.map((x) => x.id === id ? { ...x, ...p, updatedAt } : x),
    }));
    dbExec(() => supabase.from('projects').update(projectToRow({ ...p, updatedAt })).eq('id', id));
  },

  deleteProject: (id) => {
    const purgedModuleIds = new Set(
      get().purchasingModules.filter((m) => m.projectId === id).map((m) => m.id),
    );
    set((s) => ({
      projects: s.projects.filter((x) => x.id !== id),
      projectBoM: s.projectBoM.filter((x) => x.projectId !== id),
      submittals: s.submittals.filter((x) => x.projectId !== id),
      rfis: s.rfis.filter((x) => x.projectId !== id),
      closeouts: s.closeouts.filter((x) => x.projectId !== id),
      manuals: s.manuals.filter((x) => x.projectId !== id),
      milestones: s.milestones.filter((x) => x.projectId !== id),
      changeOrders: s.changeOrders.filter((x) => x.projectId !== id),
      purchasingModules: s.purchasingModules.filter((x) => x.projectId !== id),
      purchasingItems: s.purchasingItems.filter((x) => !purgedModuleIds.has(x.purchasingModuleId)),
      purchasingFreight: s.purchasingFreight.filter((x) => !purgedModuleIds.has(x.purchasingModuleId)),
      purchasingMfrDefaults: s.purchasingMfrDefaults.filter((x) => !purgedModuleIds.has(x.purchasingModuleId)),
    }));
    // DB cascade deletes will handle child rows if FK ON DELETE CASCADE is set.
    // If not, we delete explicitly.
    dbExec(() => supabase.from('projects').delete().eq('id', id));
  },

  // =========================================================================
  // DTools Sync
  // =========================================================================
  linkDToolsAndSyncBoM: async (projectId, dtools) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;

    // Format the DTools project total into the canonical `value` string the
    // app uses elsewhere (matches `formatValue` in dtools-import-project).
    const formattedValue = dtools.projectTotal && dtools.projectTotal > 0
      ? '$' + dtools.projectTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : project.value;

    // Optimistic local update so the BoM sync (which reads project.number)
    // sees the DTools number on the next render.
    set((s) => ({
      projects: s.projects.map((p) => p.id === projectId ? {
        ...p,
        dtoolsProjectId: dtools.dtoolsId,
        number: dtools.number || p.number,
        value: formattedValue,
        dtoolsBomStatus: 'loading' as const,
      } : p),
    }));

    const { error: updateErr } = await supabase
      .from('projects')
      .update({
        dtools_project_id: dtools.dtoolsId,
        number: dtools.number || project.number,
        value: formattedValue,
        dtools_bom_status: 'loading',
      })
      .eq('id', projectId);

    if (updateErr) {
      console.error('[DTools link failed]', updateErr);
      set((s) => ({
        projects: s.projects.map((p) => p.id === projectId ? { ...p, dtoolsBomStatus: 'error' as const } : p),
      }));
      throw updateErr;
    }

    await get().syncDToolsBoM(projectId);
  },

  syncDToolsBoM: async (projectId) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project || !project.number) return;

    // Set loading state
    set((s) => ({
      projects: s.projects.map((p) => p.id === projectId ? { ...p, dtoolsBomStatus: 'loading' as const } : p),
    }));

    try {
      const { data, error } = await supabase.functions.invoke('dtools-project-lookup', {
        body: { projectId, projectNumber: project.number },
      });

      console.log('[DTools sync] response:', { data, error });

      // supabase.functions.invoke sets error for non-2xx OR relay errors;
      // also check if the data itself indicates an error
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      // Server succeeded — flip the button out of "Syncing…" immediately so
      // a slow post-refresh query can't leave the UI stuck on loading.
      set((s) => ({
        projects: s.projects.map((p) => p.id === projectId ? { ...p, dtoolsBomStatus: 'found' as const } : p),
      }));

      // Refresh project + BoM from Supabase, but race against a 15s timeout so
      // a hung query (rare, but we've seen session-level timeouts) doesn't
      // block anything else. If it does time out the data on screen is stale
      // but accurate after a page reload.
      const refreshWithTimeout = Promise.race([
        Promise.all([
          supabase.from('projects').select('*').eq('id', projectId).single(),
          supabase.from('project_bom_items').select('*').eq('project_id', projectId),
          supabase.from('change_orders').select('*, change_order_items(*)').eq('project_id', projectId),
        ]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('post-sync refresh timed out')), 15000),
        ),
      ]);

      try {
        const [projRes, bomRes, coRes] = await refreshWithTimeout;
        if (projRes.data) {
          const updated = rowToProject(projRes.data);
          set((s) => ({
            projects: s.projects.map((p) => p.id === projectId ? updated : p),
          }));
        }
        if (bomRes.data) {
          const newBom = bomRes.data.map(rowToBoMItem);
          set((s) => ({
            projectBoM: [
              ...s.projectBoM.filter((b) => b.projectId !== projectId),
              ...newBom,
            ],
          }));
        }
        if (coRes.data) {
          const newCOs = coRes.data.map(rowToChangeOrder);
          set((s) => ({
            changeOrders: [
              ...s.changeOrders.filter((c) => c.projectId !== projectId),
              ...newCOs,
            ],
          }));
        }
      } catch (refreshErr) {
        console.warn('[DTools sync] refresh after import failed — reload the page to see updated BoM:', refreshErr);
      }
    } catch (err) {
      console.error('[DTools sync failed]', err);
      set((s) => ({
        projects: s.projects.map((p) => p.id === projectId ? { ...p, dtoolsBomStatus: 'error' as const } : p),
      }));
      dbExec(() => supabase.from('projects').update({ dtools_bom_status: 'error' }).eq('id', projectId));
    }
  },

  // =========================================================================
  // Project BoM
  // =========================================================================
  addBoMItem: (projectId, item) => {
    const id = genId();
    const bomItem: ProjectBoMItem = { ...item, id, projectId };
    set((s) => ({ projectBoM: [...s.projectBoM, bomItem] }));
    dbExec(() => supabase.from('project_bom_items').insert(bomItemToRow(bomItem)));
    return id;
  },

  updateBoMItem: (itemId, updates) => {
    set((s) => ({
      projectBoM: s.projectBoM.map((x) => x.id === itemId ? { ...x, ...updates } : x),
    }));
    dbExec(() => supabase.from('project_bom_items').update(bomItemToRow(updates)).eq('id', itemId));
  },

  deleteBoMItem: (itemId) => {
    set((s) => ({ projectBoM: s.projectBoM.filter((x) => x.id !== itemId) }));
    dbExec(() => supabase.from('project_bom_items').delete().eq('id', itemId));
  },

  importBoMItems: (projectId, items) => {
    const existing = get().projectBoM.filter((x) => x.projectId === projectId);
    const maxSort = existing.length > 0 ? Math.max(...existing.map((x) => x.sortOrder)) + 1 : 0;
    const newItems: ProjectBoMItem[] = items.map((item, idx) => ({
      id: genId(),
      projectId,
      manufacturer: item.manufacturer,
      model: item.model,
      description: item.description,
      category: item.category,
      qty: item.qty,
      notes: item.notes,
      locations: item.locations,
      cutSheetData: item.cutSheetData,
      cutSheetName: item.cutSheetName,
      sortOrder: maxSort + idx,
      itemType: item.itemType ?? 'Product',
      unitCost: item.unitCost ?? 0,
      unitPrice: item.unitPrice ?? 0,
      laborHours: item.laborHours ?? 0,
      laborUnitCost: item.laborUnitCost ?? 0,
      laborUnitPrice: item.laborUnitPrice ?? 0,
      fixedLaborCost: item.fixedLaborCost ?? 0,
      fixedLaborPrice: item.fixedLaborPrice ?? 0,
      marginPct: item.marginPct ?? 0,
      ownerFurnished: item.ownerFurnished ?? false,
      optional: item.optional ?? false,
      laborType: item.laborType ?? '',
      laborBreakdown: item.laborBreakdown ?? [],
      includedInPhase: item.includedInPhase ?? false,
    }));
    set((s) => ({ projectBoM: [...s.projectBoM, ...newItems] }));
    dbExec(() => supabase.from('project_bom_items').insert(newItems.map(bomItemToRow)));
  },

  // =========================================================================
  // Submittals
  // =========================================================================
  addSubmittal: (sub) => {
    const id = genId();
    const submittal: Submittal = { ...sub, id, createdAt: now(), items: [] };
    set((s) => ({ submittals: [...s.submittals, submittal] }));
    dbExec(() => supabase.from('submittals').insert(submittalToRow(submittal)));
    return id;
  },

  updateSubmittal: (id, sub) => {
    // Package status changes can cascade to per-item approval states:
    //   * → Approved  : every item becomes 'approved'
    //   * → Draft     : every item resets to 'pending' (nothing has been submitted)
    //   * → Submitted : preserve existing item marks (intentional — supports
    //                    Approved → Submitted reverts that keep history)
    //   * → R&R       : preserve existing item marks (same reason)
    const cascadeAllItems: SubmittalItemApprovalState | null =
      sub.status === 'Approved' ? 'approved'
      : sub.status === 'Draft'  ? 'pending'
      : null;

    const today = now();
    set((s) => ({
      submittals: s.submittals.map((x) => {
        if (x.id !== id) return x;
        const items = cascadeAllItems
          ? x.items.map((i) => ({ ...i, approvalState: cascadeAllItems, approvalChangedAt: today }))
          : x.items;
        return { ...x, ...sub, items };
      }),
    }));

    const { items: _ignoredItems, ...rest } = sub;
    if (Object.keys(rest).length > 0) {
      dbExec(() => supabase.from('submittals').update(submittalToRow(rest)).eq('id', id));
    }
    if (cascadeAllItems) {
      dbExec(() =>
        supabase
          .from('submittal_items')
          .update({ approval_state: cascadeAllItems, approval_changed_at: new Date().toISOString() })
          .eq('submittal_id', id),
      );
    }
  },

  deleteSubmittal: (id) => {
    set((s) => ({ submittals: s.submittals.filter((x) => x.id !== id) }));
    // Delete child items first (in case no cascade), then the submittal
    dbExec(async () => {
      await supabase.from('submittal_items').delete().eq('submittal_id', id);
      return supabase.from('submittals').delete().eq('id', id);
    });
  },

  addSubmittalItem: (submittalId, item) => {
    const id = genId();
    const newItem: SubmittalItem = {
      ...item,
      id,
      submittalId,
      approvalState: item.approvalState ?? 'pending',
    };
    set((s) => ({
      submittals: s.submittals.map((x) => x.id === submittalId ? { ...x, items: [...x.items, newItem] } : x),
    }));
    dbExec(() => supabase.from('submittal_items').insert(submittalItemToRow(newItem)));
  },

  updateSubmittalItem: (submittalId, itemId, item) => {
    set((s) => ({
      submittals: s.submittals.map((x) => x.id === submittalId ? {
        ...x, items: x.items.map((i) => i.id === itemId ? { ...i, ...item } : i),
      } : x),
    }));
    dbExec(() => supabase.from('submittal_items').update(submittalItemToRow(item)).eq('id', itemId));
  },

  deleteSubmittalItem: (submittalId, itemId) => {
    // Block deletion if any linked purchasing module has already ordered or
    // received this item. Caller should surface the error to the user.
    const ordered = get().purchasingItems.some(
      (p) => p.submittalItemId === itemId && p.purchaseStatus !== 'not_ordered',
    );
    if (ordered) {
      throw new Error(
        'Cannot delete this submittal item — it has already been ordered through a Purchasing module. Cancel the PO first or revert the purchasing status to Not Ordered.',
      );
    }
    set((s) => ({
      submittals: s.submittals.map((x) => x.id === submittalId ? {
        ...x, items: x.items.filter((i) => i.id !== itemId),
      } : x),
    }));
    dbExec(() => supabase.from('submittal_items').delete().eq('id', itemId));
  },

  reorderSubmittalItems: (submittalId, itemIds) => {
    set((s) => ({
      submittals: s.submittals.map((x) => {
        if (x.id !== submittalId) return x;
        const ordered = itemIds.map((id, idx) => {
          const item = x.items.find((i) => i.id === id)!;
          return { ...item, sortOrder: idx };
        });
        return { ...x, items: ordered };
      }),
    }));
    // Update sort_order for each item in parallel
    if (isSupabaseConfigured()) {
      itemIds.forEach((id, idx) => {
        dbExec(() => supabase.from('submittal_items').update({ sort_order: idx }).eq('id', id));
      });
    }
  },

  populateSubmittalFromBoM: (submittalId, projectId) => {
    // Filter out items the submittal flow always excludes (labor + house
    // manufacturers — see utils/submittalExclusions.ts). The SubmittalDetail
    // page surfaces the excluded list separately so users can opt anything
    // back in case-by-case.
    const bomItems = get().projectBoM
      .filter((b) => b.projectId === projectId)
      .filter((b) => !isExcludedFromSubmittal(b));
    const map = new Map<string, { manufacturer: string; model: string; description: string; category: ItemCategory; qty: number; locations: SubmittalItemLocation[]; cutSheetData?: string; cutSheetName?: string }>();
    for (const item of bomItems) {
      const key = `${item.manufacturer.toLowerCase()}|||${item.model.toLowerCase()}`;
      const existing = map.get(key);
      if (existing) {
        existing.qty += item.qty;
        // The DTools sync groups BoM rows by manufacturer+model+unitCost, so
        // the same part priced two ways (e.g. a $0 OFE/CO copy alongside the
        // priced row) arrives as separate rows, each with its own room list.
        // Merge the rooms too — otherwise the printed "BoM by Room" only
        // shows the first row's rooms and silently drops the rest.
        existing.locations = mergeLocations(existing.locations, item.locations);
        if (!existing.cutSheetData && item.cutSheetData) {
          existing.cutSheetData = item.cutSheetData;
          existing.cutSheetName = item.cutSheetName;
        }
      } else {
        map.set(key, { manufacturer: item.manufacturer, model: item.model, description: item.description, category: item.category, qty: item.qty, locations: [...item.locations], cutSheetData: item.cutSheetData, cutSheetName: item.cutSheetName });
      }
    }
    const consolidated = Array.from(map.values());
    const newItems: SubmittalItem[] = consolidated.map((c, idx) => ({
      id: genId(),
      submittalId,
      manufacturer: c.manufacturer,
      model: c.model,
      description: c.description,
      category: c.category,
      qty: c.qty,
      // Notes start blank. The project BoM's notes field is populated by the
      // DTools sync (e.g. "Phase: Install"), which is internal estimating
      // metadata — not something that belongs on a client-facing submittal.
      // Users add their own notes per item after the BoM is pulled in.
      notes: '',
      locations: c.locations,
      cutSheetData: c.cutSheetData,
      cutSheetName: c.cutSheetName,
      sortOrder: idx,
    }));

    set((s) => ({
      submittals: s.submittals.map((x) => {
        if (x.id !== submittalId) return x;
        return { ...x, items: newItems };
      }),
    }));

    // Sync: delete old items, insert new
    if (isSupabaseConfigured()) {
      dbExec(async () => {
        await supabase.from('submittal_items').delete().eq('submittal_id', submittalId);
        return supabase.from('submittal_items').insert(newItems.map(submittalItemToRow));
      });
    }

    // Fire-and-forget: try to auto-attach cutsheets from the SharePoint
    // repository in the background. Failures (function not deployed, no
    // matches, network issue) are non-fatal — submittal still populates.
    if (isSupabaseConfigured()) {
      void (async () => {
        try { await get().attachRepoCutsheetsToSubmittal(submittalId); }
        catch (err) { console.warn('[populateSubmittalFromBoM] auto-attach failed (non-fatal):', err); }
      })();
    }
  },

  attachRepoCutsheetsToSubmittal: async (submittalId) => {
    const submittal = get().submittals.find((s) => s.id === submittalId);
    if (!submittal) return { attached: 0, checked: 0 };

    // Only check items that don't already have a cutsheet (uploaded or repo).
    const candidates = submittal.items.filter((it) => !it.cutSheetData && !it.cutsheetRepositoryId);
    if (candidates.length === 0) return { attached: 0, checked: 0 };

    const pairs = candidates.map((it) => ({ manufacturer: it.manufacturer, model: it.model }));
    const { data, error } = await supabase.functions.invoke<{
      matches: Record<string, { id: string; sharepoint_path: string }>;
    }>('sharepoint-cutsheet', { body: { op: 'lookupBatch', pairs } });

    if (error) throw error;
    const matches = data?.matches ?? {};

    let attached = 0;
    const projectId = submittal.projectId;
    const { data: { user } } = await supabase.auth.getUser();

    for (const item of candidates) {
      const key = `${item.manufacturer.trim().toLowerCase()}|||${item.model.trim().toLowerCase()}`;
      const hit = matches[key];
      if (!hit) continue;
      // Update both store and DB. cutSheetName carries the SharePoint path
      // for display; cutsheetRepositoryId is the durable link.
      const path = hit.sharepoint_path.split('/').pop() ?? hit.sharepoint_path;
      set((s) => ({
        submittals: s.submittals.map((sb) => sb.id === submittalId ? {
          ...sb,
          items: sb.items.map((it) => it.id === item.id
            ? { ...it, cutsheetRepositoryId: hit.id, cutSheetName: path }
            : it),
        } : sb),
      }));
      dbExec(() => supabase.from('submittal_items')
        .update(submittalItemToRow({ cutsheetRepositoryId: hit.id, cutSheetName: path }))
        .eq('id', item.id));
      // Record usage so analytics reflect which repo cutsheets are getting
      // pulled by which projects. Fire-and-forget — failures are non-fatal.
      dbExec(() => supabase.from('cutsheet_project_usage').insert({
        cutsheet_id: hit.id,
        project_id: projectId,
        used_in: 'submittal',
        used_by_user_id: user?.id ?? null,
      }));
      attached++;
    }
    return { attached, checked: candidates.length };
  },

  // =========================================================================
  // RFIs
  // =========================================================================
  addRFI: (r) => {
    const id = genId();
    const projectRFIs = get().rfis.filter((x) => x.projectId === r.projectId);
    const num = projectRFIs.length + 1;
    const number = `RFI-${String(num).padStart(3, '0')}`;
    const rfi: RFI = { ...r, id, number, createdAt: now(), attachments: [] };
    set((s) => ({ rfis: [...s.rfis, rfi] }));
    dbExec(() => supabase.from('rfis').insert(rfiToRow(rfi)));
    return id;
  },

  updateRFI: (id, r) => {
    set((s) => ({
      rfis: s.rfis.map((x) => x.id === id ? { ...x, ...r } : x),
    }));
    const { attachments, ...rest } = r;
    if (Object.keys(rest).length > 0) {
      dbExec(() => supabase.from('rfis').update(rfiToRow(rest)).eq('id', id));
    }
  },

  deleteRFI: (id) => {
    set((s) => ({ rfis: s.rfis.filter((x) => x.id !== id) }));
    dbExec(() => supabase.from('rfis').delete().eq('id', id));
  },

  // =========================================================================
  // Closeout
  // =========================================================================
  getOrCreateCloseout: (projectId) => {
    const existing = get().closeouts.find((c) => c.projectId === projectId);
    if (existing) return existing.id;

    const id = genId();
    const closeout: CloseoutPackage = {
      id, projectId, status: 'Draft', createdAt: now(),
      warranties: [], punchItems: [], signOffSheets: [], asBuiltDrawings: [], quickStartRooms: [],
    };
    set((s) => ({ closeouts: [...s.closeouts, closeout] }));
    dbExec(() => supabase.from('closeout_packages').insert(closeoutToRow(closeout)));
    return id;
  },

  updateCloseout: (id, c) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === id ? { ...x, ...c } : x),
    }));
    // Only send scalar fields to DB, not nested arrays
    const { warranties, punchItems, signOffSheets, asBuiltDrawings, ...rest } = c;
    if (Object.keys(rest).length > 0) {
      dbExec(() => supabase.from('closeout_packages').update(closeoutToRow(rest)).eq('id', id));
    }
  },

  addWarranty: (closeoutId, w) => {
    const id = genId();
    const warranty: Warranty = { ...w, id, closeoutId };
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? { ...x, warranties: [...x.warranties, warranty] } : x),
    }));
    dbExec(() => supabase.from('warranties').insert(warrantyToRow(warranty)));
  },

  updateWarranty: (closeoutId, wId, w) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x, warranties: x.warranties.map((wr) => wr.id === wId ? { ...wr, ...w } : wr),
      } : x),
    }));
    dbExec(() => supabase.from('warranties').update(warrantyToRow(w)).eq('id', wId));
  },

  deleteWarranty: (closeoutId, wId) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x, warranties: x.warranties.filter((wr) => wr.id !== wId),
      } : x),
    }));
    dbExec(() => supabase.from('warranties').delete().eq('id', wId));
  },

  populateWarrantiesFromBoM: (closeoutId, projectId) => {
    const bomItems = get().projectBoM.filter((b) => b.projectId === projectId);
    const existing = get().closeouts.find((c) => c.id === closeoutId);
    if (!existing) return;
    const existingBomIds = new Set(existing.warranties.filter((w) => w.bomItemId).map((w) => w.bomItemId));
    const seen = new Set<string>();
    const newWarranties: Warranty[] = [];
    for (const item of bomItems) {
      const key = `${item.manufacturer.toLowerCase()}|||${item.model.toLowerCase()}`;
      if (seen.has(key) || existingBomIds.has(item.id)) continue;
      seen.add(key);
      newWarranties.push({
        id: genId(), closeoutId, bomItemId: item.id,
        system: `${item.manufacturer} ${item.model}`, manufacturer: item.manufacturer, model: item.model,
        vendor: '', startDate: '', durationMonths: 12,
        contactName: '', contactEmail: '', contactPhone: '', coverageNotes: '',
      });
    }
    if (newWarranties.length > 0) {
      set((s) => ({
        closeouts: s.closeouts.map((x) => x.id === closeoutId ? { ...x, warranties: [...x.warranties, ...newWarranties] } : x),
      }));
      dbExec(() => supabase.from('warranties').insert(newWarranties.map(warrantyToRow)));
    }
  },

  addPunchItem: (closeoutId, p) => {
    const id = genId();
    const punchItem: PunchItem = { ...p, id, closeoutId };
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? { ...x, punchItems: [...x.punchItems, punchItem] } : x),
    }));
    dbExec(() => supabase.from('punch_items').insert(punchItemToRow(punchItem)));
  },

  updatePunchItem: (closeoutId, pId, p) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x, punchItems: x.punchItems.map((pi) => pi.id === pId ? { ...pi, ...p } : pi),
      } : x),
    }));
    dbExec(() => supabase.from('punch_items').update(punchItemToRow(p)).eq('id', pId));
  },

  deletePunchItem: (closeoutId, pId) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x, punchItems: x.punchItems.filter((pi) => pi.id !== pId),
      } : x),
    }));
    dbExec(() => supabase.from('punch_items').delete().eq('id', pId));
  },

  addSignOffSheet: (closeoutId, s2) => {
    const id = genId();
    const sheet: SignOffSheet = { ...s2, id, closeoutId };
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x, signOffSheets: [...(x.signOffSheets || []), sheet],
      } : x),
    }));
    dbExec(() => supabase.from('sign_off_sheets').insert(signOffSheetToRow(sheet)));
  },

  updateSignOffSheet: (closeoutId, sId, s2) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x, signOffSheets: (x.signOffSheets || []).map((sh) => sh.id === sId ? { ...sh, ...s2 } : sh),
      } : x),
    }));
    dbExec(() => supabase.from('sign_off_sheets').update(signOffSheetToRow(s2)).eq('id', sId));
  },

  deleteSignOffSheet: (closeoutId, sId) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x, signOffSheets: (x.signOffSheets || []).filter((sh) => sh.id !== sId),
      } : x),
    }));
    dbExec(() => supabase.from('sign_off_sheets').delete().eq('id', sId));
  },

  addSignOffCustomItem: (closeoutId, sheetId, text) => {
    const itemId = genId();
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x, signOffSheets: (x.signOffSheets || []).map((sh) => sh.id === sheetId ? {
          ...sh, customItems: [...(sh.customItems || []), { id: itemId, signOffSheetId: sheetId, text, sortOrder: (sh.customItems || []).length }],
        } : sh),
      } : x),
    }));
    // customItems is JSONB on sign_off_sheets, so we update the whole column
    if (isSupabaseConfigured()) {
      const closeout = get().closeouts.find((c) => c.id === closeoutId);
      const sheet = closeout?.signOffSheets?.find((sh) => sh.id === sheetId);
      if (sheet) {
        dbExec(() => supabase.from('sign_off_sheets').update({ custom_items: sheet.customItems }).eq('id', sheetId));
      }
    }
  },

  updateSignOffCustomItem: (closeoutId, sheetId, itemId, text) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x, signOffSheets: (x.signOffSheets || []).map((sh) => sh.id === sheetId ? {
          ...sh, customItems: (sh.customItems || []).map((ci) => ci.id === itemId ? { ...ci, text } : ci),
        } : sh),
      } : x),
    }));
    if (isSupabaseConfigured()) {
      const closeout = get().closeouts.find((c) => c.id === closeoutId);
      const sheet = closeout?.signOffSheets?.find((sh) => sh.id === sheetId);
      if (sheet) {
        dbExec(() => supabase.from('sign_off_sheets').update({ custom_items: sheet.customItems }).eq('id', sheetId));
      }
    }
  },

  deleteSignOffCustomItem: (closeoutId, sheetId, itemId) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x, signOffSheets: (x.signOffSheets || []).map((sh) => sh.id === sheetId ? {
          ...sh, customItems: (sh.customItems || []).filter((ci) => ci.id !== itemId),
        } : sh),
      } : x),
    }));
    if (isSupabaseConfigured()) {
      const closeout = get().closeouts.find((c) => c.id === closeoutId);
      const sheet = closeout?.signOffSheets?.find((sh) => sh.id === sheetId);
      if (sheet) {
        dbExec(() => supabase.from('sign_off_sheets').update({ custom_items: sheet.customItems }).eq('id', sheetId));
      }
    }
  },

  addAsBuiltDrawing: (closeoutId, d) => {
    const id = genId();
    const drawing: AsBuiltDrawing = { ...d, id, closeoutId, uploadedAt: now() };
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x, asBuiltDrawings: [...(x.asBuiltDrawings || []), drawing],
      } : x),
    }));
    dbExec(() => supabase.from('as_built_drawings').insert(asBuiltDrawingToRow(drawing)));
  },

  setProductManual: (closeoutId, url, name) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId
        ? { ...x, productManualUrl: url, productManualName: name }
        : x),
    }));
    dbExec(() => supabase.from('closeout_packages').update({
      product_manual_url: url, product_manual_name: name,
    }).eq('id', closeoutId));
  },

  clearProductManual: (closeoutId) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId
        ? { ...x, productManualUrl: undefined, productManualName: undefined }
        : x),
    }));
    dbExec(() => supabase.from('closeout_packages').update({
      product_manual_url: null, product_manual_name: null,
    }).eq('id', closeoutId));
  },

  deleteAsBuiltDrawing: (closeoutId, dId) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x, asBuiltDrawings: (x.asBuiltDrawings || []).filter((d) => d.id !== dId),
      } : x),
    }));
    dbExec(() => supabase.from('as_built_drawings').delete().eq('id', dId));
  },

  // =========================================================================
  // Quick Start Guide
  // =========================================================================
  addQuickStartRoom: (closeoutId, name) => {
    const id = genId();
    const closeout = get().closeouts.find((c) => c.id === closeoutId);
    const sortOrder = (closeout?.quickStartRooms?.length ?? 0);
    const room: QuickStartRoom = { id, closeoutId, name, sortOrder, steps: [] };
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId
        ? { ...x, quickStartRooms: [...(x.quickStartRooms ?? []), room] }
        : x),
    }));
    dbExec(() => supabase.from('quick_start_rooms').insert(quickStartRoomToRow(room)));
    return id;
  },

  updateQuickStartRoom: (closeoutId, roomId, updates) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x,
        quickStartRooms: (x.quickStartRooms ?? []).map((r) => r.id === roomId ? { ...r, ...updates } : r),
      } : x),
    }));
    dbExec(() => supabase.from('quick_start_rooms').update(quickStartRoomToRow(updates)).eq('id', roomId));
  },

  deleteQuickStartRoom: (closeoutId, roomId) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x,
        quickStartRooms: (x.quickStartRooms ?? []).filter((r) => r.id !== roomId),
      } : x),
    }));
    // Steps cascade-delete via FK
    dbExec(() => supabase.from('quick_start_rooms').delete().eq('id', roomId));
  },

  addQuickStartStep: (closeoutId, roomId, partial) => {
    const id = genId();
    const closeout = get().closeouts.find((c) => c.id === closeoutId);
    const room = closeout?.quickStartRooms?.find((r) => r.id === roomId);
    const sortOrder = room?.steps.length ?? 0;
    const step: QuickStartStep = { id, roomId, text: partial.text, note: partial.note, sortOrder };
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x,
        quickStartRooms: (x.quickStartRooms ?? []).map((r) => r.id === roomId
          ? { ...r, steps: [...r.steps, step] }
          : r),
      } : x),
    }));
    dbExec(() => supabase.from('quick_start_steps').insert(quickStartStepToRow(step)));
    return id;
  },

  updateQuickStartStep: (closeoutId, roomId, stepId, updates) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x,
        quickStartRooms: (x.quickStartRooms ?? []).map((r) => r.id === roomId ? {
          ...r,
          steps: r.steps.map((st) => st.id === stepId ? { ...st, ...updates } : st),
        } : r),
      } : x),
    }));
    dbExec(() => supabase.from('quick_start_steps').update(quickStartStepToRow(updates)).eq('id', stepId));
  },

  deleteQuickStartStep: (closeoutId, roomId, stepId) => {
    set((s) => ({
      closeouts: s.closeouts.map((x) => x.id === closeoutId ? {
        ...x,
        quickStartRooms: (x.quickStartRooms ?? []).map((r) => r.id === roomId ? {
          ...r,
          steps: r.steps.filter((st) => st.id !== stepId),
        } : r),
      } : x),
    }));
    dbExec(() => supabase.from('quick_start_steps').delete().eq('id', stepId));
  },

  // =========================================================================
  // Manuals (sections stored as JSONB in the manuals table)
  // =========================================================================
  addManual: (m) => {
    const id = genId();
    const manual: OwnerManual = { ...m, id, createdAt: now(), sections: [] };
    set((s) => ({ manuals: [...s.manuals, manual] }));
    dbExec(() => supabase.from('owner_manuals').insert(manualToRow(manual)));
    return id;
  },

  updateManual: (id, m) => {
    set((s) => ({
      manuals: s.manuals.map((x) => x.id === id ? { ...x, ...m } : x),
    }));
    dbExec(() => supabase.from('owner_manuals').update(manualToRow(m)).eq('id', id));
  },

  deleteManual: (id) => {
    set((s) => ({ manuals: s.manuals.filter((x) => x.id !== id) }));
    dbExec(() => supabase.from('owner_manuals').delete().eq('id', id));
  },

  addManualSection: (manualId, sec) => {
    const id = genId();
    set((s) => ({
      manuals: s.manuals.map((x) => x.id === manualId ? {
        ...x, sections: [...x.sections, { ...sec, id, manualId, devices: [] }],
      } : x),
    }));
    // Sections are JSONB — write the whole sections array
    if (isSupabaseConfigured()) {
      const manual = get().manuals.find((m) => m.id === manualId);
      if (manual) {
        dbExec(() => supabase.from('owner_manuals').update({ sections: manual.sections }).eq('id', manualId));
      }
    }
  },

  updateManualSection: (manualId, sId, sec) => {
    set((s) => ({
      manuals: s.manuals.map((x) => x.id === manualId ? {
        ...x, sections: x.sections.map((sc) => sc.id === sId ? { ...sc, ...sec } : sc),
      } : x),
    }));
    if (isSupabaseConfigured()) {
      const manual = get().manuals.find((m) => m.id === manualId);
      if (manual) {
        dbExec(() => supabase.from('owner_manuals').update({ sections: manual.sections }).eq('id', manualId));
      }
    }
  },

  deleteManualSection: (manualId, sId) => {
    set((s) => ({
      manuals: s.manuals.map((x) => x.id === manualId ? {
        ...x, sections: x.sections.filter((sc) => sc.id !== sId),
      } : x),
    }));
    if (isSupabaseConfigured()) {
      const manual = get().manuals.find((m) => m.id === manualId);
      if (manual) {
        dbExec(() => supabase.from('owner_manuals').update({ sections: manual.sections }).eq('id', manualId));
      }
    }
  },

  addManualDevice: (manualId, sectionId, d) => {
    const id = genId();
    set((s) => ({
      manuals: s.manuals.map((x) => x.id === manualId ? {
        ...x, sections: x.sections.map((sc) => sc.id === sectionId ? {
          ...sc, devices: [...sc.devices, { ...d, id, sectionId }],
        } : sc),
      } : x),
    }));
    if (isSupabaseConfigured()) {
      const manual = get().manuals.find((m) => m.id === manualId);
      if (manual) {
        dbExec(() => supabase.from('owner_manuals').update({ sections: manual.sections }).eq('id', manualId));
      }
    }
  },

  updateManualDevice: (manualId, sectionId, dId, d) => {
    set((s) => ({
      manuals: s.manuals.map((x) => x.id === manualId ? {
        ...x, sections: x.sections.map((sc) => sc.id === sectionId ? {
          ...sc, devices: sc.devices.map((dv) => dv.id === dId ? { ...dv, ...d } : dv),
        } : sc),
      } : x),
    }));
    if (isSupabaseConfigured()) {
      const manual = get().manuals.find((m) => m.id === manualId);
      if (manual) {
        dbExec(() => supabase.from('owner_manuals').update({ sections: manual.sections }).eq('id', manualId));
      }
    }
  },

  deleteManualDevice: (manualId, sectionId, dId) => {
    set((s) => ({
      manuals: s.manuals.map((x) => x.id === manualId ? {
        ...x, sections: x.sections.map((sc) => sc.id === sectionId ? {
          ...sc, devices: sc.devices.filter((dv) => dv.id !== dId),
        } : sc),
      } : x),
    }));
    if (isSupabaseConfigured()) {
      const manual = get().manuals.find((m) => m.id === manualId);
      if (manual) {
        dbExec(() => supabase.from('owner_manuals').update({ sections: manual.sections }).eq('id', manualId));
      }
    }
  },

  // =========================================================================
  // Review actions
  // =========================================================================

  fetchProjectFlags: async (runId) => {
    if (!isSupabaseConfigured()) return [];
    const { data, error } = await supabase
      .from('review_flags')
      .select('*')
      .eq('review_run_id', runId)
      .order('severity', { ascending: true }) // high → low (alphabetically: high < low < moderate)
      .order('created_at', { ascending: true });
    if (error) { console.error('[review] fetchProjectFlags error:', error); return []; }
    // Sort by severity weight: high → moderate → low
    const weight = (s: string) => s === 'high' ? 0 : s === 'moderate' ? 1 : 2;
    return (data ?? []).map(rowToReviewFlag).sort((a, b) => weight(a.severity) - weight(b.severity));
  },

  updateRunStatus: async (runId, status, reviewedBy) => {
    if (!isSupabaseConfigured()) return;
    const updates: any = { status };
    if (status === 'approved' || status === 'changes_requested') {
      updates.reviewed_at = new Date().toISOString();
      if (reviewedBy) updates.reviewed_by = reviewedBy;
    }
    const { error } = await supabase.from('review_runs').update(updates).eq('id', runId);
    if (error) { console.error('[review] updateRunStatus error:', error); return; }
    set((s) => ({
      reviewRuns: s.reviewRuns.map((r) => r.id === runId ? { ...r, status, reviewedAt: updates.reviewed_at } : r),
    }));
  },

  updateFlagStatus: async (flagId, status, comment) => {
    if (!isSupabaseConfigured()) return;
    const updates: any = { status };
    if (comment !== undefined) updates.manager_comment = comment;
    if (status === 'resolved' || status === 'waived') updates.resolved_at = new Date().toISOString();
    const { error } = await supabase.from('review_flags').update(updates).eq('id', flagId);
    if (error) console.error('[review] updateFlagStatus error:', error);
  },

  createReviewRunFromCsv: async (projectId, csvText) => {
    if (!isSupabaseConfigured()) throw new Error('Supabase not configured');

    console.log('[review] Starting createReviewRunFromCsv for project', projectId);

    // 0. Verify the project exists in Supabase before doing anything
    const { data: projectCheck, error: projectCheckError } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .maybeSingle();

    if (projectCheckError) {
      console.error('[review] Project lookup error:', projectCheckError);
      throw new Error(`Project lookup failed: ${projectCheckError.message}`);
    }
    if (!projectCheck) {
      throw new Error('This project has not been saved to the database yet. Please ensure the project was created via Monday.com before running a review.');
    }
    console.log('[review] Project confirmed in DB');

    // 1. Fetch review config and product catalog.
    //    Labor cost/price now comes directly from the CSV columns — no separate
    //    labor rates table needed for the rules engine.
    // Fetch review config
    const configRes = await supabase.from('review_config').select('key,value');

    // Fetch full product catalog (paginated — Supabase defaults to 1000 row limit)
    const catalog: { model_number: string; cost: number | null; list_price: number | null }[] = [];
    const PAGE = 5000;
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from('product_catalog')
        .select('model_number,cost,list_price')
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      catalog.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    console.log('[review] Config rows:', configRes.data?.length ?? 0,
      '| Catalog items:', catalog.length);

    const configMap: Record<string, string> = {};
    for (const r of configRes.data ?? []) configMap[r.key] = r.value;
    const reviewConfig = buildReviewConfig(configMap);

    // 2. Parse CSV and run rules engine
    const rawRows = parseCsv(csvText);
    const rows    = rawRows.map(mapRow);
    console.log('[review] CSV parsed:', rawRows.length, 'rows →',
      rows.filter(r => r.itemType === 'Product').length, 'products,',
      rows.filter(r => r.itemType === 'Labor').length, 'labor rows');
    let flags = runRules(rows, reviewConfig, catalog);
    console.log('[review] Rules engine generated', flags.length, 'flags');

    // 3. Get prior runs for run_number and diff
    const { data: priorRuns, error: priorRunsError } = await supabase
      .from('review_runs')
      .select('id,run_number,status')
      .eq('project_id', projectId)
      .order('run_number', { ascending: false })
      .limit(1);

    if (priorRunsError) console.warn('[review] Could not fetch prior runs:', priorRunsError.message);

    const latestPrior    = priorRuns?.[0];
    const runNumber      = latestPrior ? latestPrior.run_number + 1 : 1;
    const isResubmission = latestPrior?.status === 'changes_requested';
    console.log('[review] Run number:', runNumber, '| Resubmission:', isResubmission);

    // 4a. Always fetch prior run flags to carry forward resolved/waived status
    let priorFlagMap: Map<string, { status: string; description: string; manager_comment: string | null; resolved_by: string | null; resolved_at: string | null }> | null = null;
    if (latestPrior) {
      const { data: priorFlags } = await supabase
        .from('review_flags')
        .select('rule_id,line_item_ref,id,status,description,manager_comment,resolved_by,resolved_at')
        .eq('review_run_id', latestPrior.id);

      if (priorFlags?.length) {
        // Build lookup for carrying forward resolved/waived status
        priorFlagMap = new Map();
        for (const pf of priorFlags) {
          const key = `${pf.rule_id}::${pf.line_item_ref ?? ''}`;
          priorFlagMap.set(key, {
            status: pf.status,
            description: pf.description,
            manager_comment: pf.manager_comment,
            resolved_by: pf.resolved_by,
            resolved_at: pf.resolved_at,
          });
        }

        // 4b. Apply diff labels only for formal resubmissions (changes_requested)
        if (isResubmission) {
          flags = applyDiff(flags, priorFlags);
          const newKeys = new Set(flags.map(f => `${f.rule_id}::${f.line_item_ref ?? ''}`));
          const resolvedIds = priorFlags
            .filter(pf => !newKeys.has(`${pf.rule_id}::${pf.line_item_ref ?? ''}`))
            .map((pf: any) => pf.id);
          if (resolvedIds.length) {
            await supabase.from('review_flags').update({ diff_status: 'resolved' }).in('id', resolvedIds);
          }
        }
      }
    }

    // 5. Rebuild BoM — delete existing items, insert fresh from CSV
    const { error: deleteError } = await supabase
      .from('project_bom_items')
      .delete()
      .eq('project_id', projectId);
    if (deleteError) console.warn('[review] BoM delete warning:', deleteError.message);

    const bomRows = buildBomRows(rows, projectId);
    console.log('[review] BoM rows to insert:', bomRows.length);

    let newBomData: any[] = [];
    if (bomRows.length > 0) {
      const { data: bomInsert, error: bomError } = await supabase
        .from('project_bom_items')
        .insert(bomRows)
        .select();
      if (bomError) console.warn('[review] BoM insert warning:', bomError.message);
      newBomData = bomInsert ?? [];
    }
    console.log('[review] BoM rebuilt with', newBomData.length, 'items');

    // 6. Insert review_run record
    console.log('[review] Inserting review_run...');
    const { data: runData, error: runError } = await supabase
      .from('review_runs')
      .insert({
        project_id:   projectId,
        run_number:   runNumber,
        csv_snapshot: csvText,
        status:       'pending_review',
        triggered_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (runError || !runData) {
      console.error('[review] review_runs insert failed:', runError);
      throw new Error(runError?.message ?? 'Failed to insert review run — check browser console for details');
    }
    console.log('[review] review_run created:', runData.id);

    // 7. Insert flags — carry forward resolved/waived status for recurring flags
    //    whose description is identical (same exact issue, not just same rule).
    if (flags.length > 0) {
      const flagRows = flags.map(f => {
        const row: Record<string, any> = {
          review_run_id: runData.id,
          rule_id:       f.rule_id,
          severity:      f.severity,
          category:      f.category,
          flag_name:     f.flag_name,
          description:   f.description,
          line_item_ref: f.line_item_ref,
          diff_status:   f.diff_status,
          status:        'open',
        };
        // Carry forward resolved/waived from prior run if the issue is unchanged.
        // Works for any re-run, not just formal resubmissions.
        if (priorFlagMap) {
          const key = `${f.rule_id}::${f.line_item_ref ?? ''}`;
          const prior = priorFlagMap.get(key);
          if (prior && (prior.status === 'resolved' || prior.status === 'waived')
              && prior.description === f.description) {
            row.status          = prior.status;
            row.manager_comment = prior.manager_comment;
            row.resolved_by     = prior.resolved_by;
            row.resolved_at     = prior.resolved_at;
          }
        }
        return row;
      });
      const { error: flagError } = await supabase.from('review_flags').insert(flagRows);
      if (flagError) console.error('[review] Failed to insert flags:', flagError);
      else console.log('[review] Inserted', flagRows.length, 'flags',
        `(${flagRows.filter(r => r.status !== 'open').length} carried forward)`);
    }

    // 8. Update local store state
    const newRun: ReviewRun = {
      id: runData.id, projectId, runNumber,
      triggeredAt: new Date().toISOString(),
      status: 'pending_review',
      createdAt: new Date().toISOString(),
    };
    set(s => ({
      projectBoM: [
        ...s.projectBoM.filter(b => b.projectId !== projectId),
        ...(newBomData ?? []).map(rowToBoMItem),
      ],
      reviewRuns: [newRun, ...s.reviewRuns],
    }));

    return { runId: runData.id, flagCount: flags.length };
  },

  // =========================================================================
  // Bid Leveling actions
  // =========================================================================

  addBidLevelingSession: (s) => {
    const id = genId();
    const today = now();
    const session: BidLevelingSession = { ...s, id, createdAt: today, updatedAt: today };
    set((st) => ({ bidLevelingSessions: [...st.bidLevelingSessions, session] }));

    dbExec(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const row = bidLevelingSessionToRow({ ...session, createdBy: user?.id });
      return supabase.from('bid_leveling_sessions').insert(row);
    });
    return id;
  },

  updateBidLevelingSession: (id, updates) => {
    set((st) => ({
      bidLevelingSessions: st.bidLevelingSessions.map((s) =>
        s.id === id ? { ...s, ...updates, updatedAt: now() } : s,
      ),
    }));

    dbExec(async () => {
      const row = bidLevelingSessionToRow({ ...updates, updatedAt: now() });
      return supabase.from('bid_leveling_sessions').update(row).eq('id', id);
    });
  },

  deleteBidLevelingSession: (id) => {
    set((st) => ({
      bidLevelingSessions: st.bidLevelingSessions.filter((s) => s.id !== id),
    }));

    dbExec(async () => {
      return supabase.from('bid_leveling_sessions').delete().eq('id', id);
    });
  },

  addBidLevelingTemplate: (t) => {
    const id = genId();
    const today = now();
    const template: BidLevelingMappingTemplate = { ...t, id, createdAt: today, updatedAt: today };
    set((st) => ({ bidLevelingTemplates: [...st.bidLevelingTemplates, template] }));

    dbExec(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const row = bidLevelingTemplateToRow({ ...template, createdBy: user?.id });
      return supabase.from('bid_leveling_mapping_templates').insert(row);
    });
    return id;
  },

  updateBidLevelingTemplate: (id, updates) => {
    set((st) => ({
      bidLevelingTemplates: st.bidLevelingTemplates.map((t) =>
        t.id === id ? { ...t, ...updates, updatedAt: now() } : t,
      ),
    }));

    dbExec(async () => {
      const row = bidLevelingTemplateToRow({ ...updates, updatedAt: now() });
      return supabase.from('bid_leveling_mapping_templates').update(row).eq('id', id);
    });
  },

  deleteBidLevelingTemplate: (id) => {
    set((st) => ({
      bidLevelingTemplates: st.bidLevelingTemplates.filter((t) => t.id !== id),
    }));

    dbExec(async () => {
      return supabase.from('bid_leveling_mapping_templates').delete().eq('id', id);
    });
  },

  // =========================================================================
  // Project Milestones
  // =========================================================================
  addMilestone: (m) => {
    const id = genId();
    const today = now();
    const milestone: ProjectMilestone = { ...m, id, createdAt: today, updatedAt: today };
    set((s) => ({ milestones: [...s.milestones, milestone] }));

    dbExec(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id;
      return supabase
        .from('project_milestones')
        .insert(milestoneToRow({ ...milestone, createdBy: userId } as any));
    });

    return id;
  },

  addMilestonesBatch: (items) => {
    if (items.length === 0) return;
    const today = now();
    const newOnes: ProjectMilestone[] = items.map((m) => ({
      ...m, id: genId(), createdAt: today, updatedAt: today,
    }));
    set((s) => ({ milestones: [...s.milestones, ...newOnes] }));

    dbExec(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id;
      const rows = newOnes.map((m) => milestoneToRow({ ...m, createdBy: userId } as any));
      return supabase.from('project_milestones').insert(rows);
    });
  },

  updateMilestone: (id, updates) => {
    const updatedAt = now();
    set((s) => ({
      milestones: s.milestones.map((m) => m.id === id ? { ...m, ...updates, updatedAt } : m),
    }));
    dbExec(() =>
      supabase.from('project_milestones').update(milestoneToRow({ ...updates, updatedAt })).eq('id', id),
    );
  },

  deleteMilestone: (id) => {
    set((s) => ({ milestones: s.milestones.filter((m) => m.id !== id) }));
    dbExec(() => supabase.from('project_milestones').delete().eq('id', id));
  },

  markMilestoneComplete: (id, note) => {
    const today = now();
    set((s) => ({
      milestones: s.milestones.map((m) => m.id === id
        ? { ...m, completedDate: today, notes: note ? (m.notes ? `${m.notes}\n\n${note}` : note) : m.notes, updatedAt: today }
        : m,
      ),
    }));
    const m = get().milestones.find((x) => x.id === id);
    if (!m) return;
    dbExec(() =>
      supabase
        .from('project_milestones')
        .update(milestoneToRow({ completedDate: today, notes: m.notes, updatedAt: today }))
        .eq('id', id),
    );
  },

  // =========================================================================
  // Submittal item-level approval — handles auto promote/demote of the
  // package status. Rules (mirroring the spec the user spelled out):
  //   * All items 'approved' → package auto-promotes to 'Approved'
  //   * Any item 'revise'    → package auto-demotes to 'Revise & Resubmit'
  //   * Otherwise            → leave package status alone
  // =========================================================================
  setSubmittalItemApproval: (submittalId, itemId, state) => {
    const today = now();
    const sub = get().submittals.find((s) => s.id === submittalId);
    if (!sub) return;

    // Compute next item set + derived package status BEFORE we set state, so
    // the same calculation drives both the local update and the DB writes.
    const nextItems = sub.items.map((i) =>
      i.id === itemId ? { ...i, approvalState: state, approvalChangedAt: today } : i,
    );
    const allApproved = nextItems.length > 0 && nextItems.every((i) => i.approvalState === 'approved');
    const anyRevise  = nextItems.some((i) => i.approvalState === 'revise');
    const nextStatus =
      allApproved      ? 'Approved' as const
      : anyRevise      ? 'Revise & Resubmit' as const
      : sub.status;

    set((s) => ({
      submittals: s.submittals.map((x) => x.id === submittalId
        ? { ...x, items: nextItems, status: nextStatus }
        : x,
      ),
    }));

    dbExec(() =>
      supabase
        .from('submittal_items')
        .update({ approval_state: state, approval_changed_at: new Date().toISOString() })
        .eq('id', itemId),
    );
    if (nextStatus !== sub.status) {
      dbExec(() => supabase.from('submittals').update({ status: nextStatus }).eq('id', submittalId));
    }
  },

  // =========================================================================
  // Warehouses
  // =========================================================================
  addWarehouse: (w) => {
    const id = genId();
    const today = now();
    const wh: Warehouse = { ...w, id, createdAt: today, updatedAt: today };
    set((s) => ({ warehouses: [...s.warehouses, wh] }));
    dbExec(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const row = warehouseToRow(wh);
      if (user?.id) row.created_by = user.id;
      return supabase.from('warehouses').insert(row);
    });
    return id;
  },

  updateWarehouse: (id, updates) => {
    const today = now();
    set((s) => ({
      warehouses: s.warehouses.map((w) => w.id === id ? { ...w, ...updates, updatedAt: today } : w),
    }));
    dbExec(() =>
      supabase.from('warehouses').update({ ...warehouseToRow(updates), updated_at: new Date().toISOString() }).eq('id', id),
    );
  },

  deleteWarehouse: (id) => {
    set((s) => ({ warehouses: s.warehouses.filter((w) => w.id !== id) }));
    dbExec(() => supabase.from('warehouses').delete().eq('id', id));
  },

  // =========================================================================
  // Purchasing
  // =========================================================================
  addPurchasingModule: ({ projectId, title, submittalIds }) => {
    const id = genId();
    const today = now();
    const module: PurchasingModule = {
      id, projectId, title, notes: '', submittalIds: [...submittalIds],
      createdAt: today, updatedAt: today,
    };
    set((s) => ({ purchasingModules: [...s.purchasingModules, module] }));

    dbExec(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id;
      const moduleRow: any = purchasingModuleToRow(module);
      if (userId) moduleRow.created_by = userId;
      const insertRes = await supabase.from('purchasing_modules').insert(moduleRow);
      if (insertRes.error) return insertRes;
      if (submittalIds.length > 0) {
        const linkRows = submittalIds.map((sid) => ({
          purchasing_module_id: id,
          submittal_id: sid,
          linked_by: userId ?? null,
        }));
        const linkRes = await supabase.from('purchasing_module_submittals').insert(linkRows);
        if (linkRes.error) return linkRes;
      }
      return { error: null } as any;
    });

    return id;
  },

  updatePurchasingModule: (id, updates) => {
    const today = now();
    set((s) => ({
      purchasingModules: s.purchasingModules.map((m) => m.id === id ? { ...m, ...updates, updatedAt: today } : m),
    }));
    const { submittalIds: _ignored, ...persistable } = updates;
    if (Object.keys(persistable).length > 0) {
      dbExec(() =>
        supabase.from('purchasing_modules').update({ ...purchasingModuleToRow(persistable), updated_at: new Date().toISOString() }).eq('id', id),
      );
    }
  },

  deletePurchasingModule: (id) => {
    set((s) => ({
      purchasingModules: s.purchasingModules.filter((m) => m.id !== id),
      purchasingItems: s.purchasingItems.filter((p) => p.purchasingModuleId !== id),
      purchasingFreight: s.purchasingFreight.filter((p) => p.purchasingModuleId !== id),
      purchasingMfrDefaults: s.purchasingMfrDefaults.filter((p) => p.purchasingModuleId !== id),
    }));
    dbExec(() => supabase.from('purchasing_modules').delete().eq('id', id));
  },

  linkSubmittalToPurchasingModule: (purchasingModuleId, submittalId) => {
    set((s) => ({
      purchasingModules: s.purchasingModules.map((m) => m.id === purchasingModuleId
        ? { ...m, submittalIds: m.submittalIds.includes(submittalId) ? m.submittalIds : [...m.submittalIds, submittalId] }
        : m,
      ),
    }));
    dbExec(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      return supabase.from('purchasing_module_submittals').insert({
        purchasing_module_id: purchasingModuleId,
        submittal_id: submittalId,
        linked_by: user?.id ?? null,
      });
    });
  },

  unlinkSubmittalFromPurchasingModule: (purchasingModuleId, submittalId) => {
    // Drop both the link and any persisted purchasing rows for items that
    // belonged to that submittal — they have no display anchor anymore.
    const purgedItemIds = new Set(
      get().submittals
        .filter((s) => s.id === submittalId)
        .flatMap((s) => s.items.map((i) => i.id)),
    );
    set((s) => ({
      purchasingModules: s.purchasingModules.map((m) => m.id === purchasingModuleId
        ? { ...m, submittalIds: m.submittalIds.filter((id) => id !== submittalId) }
        : m,
      ),
      purchasingItems: s.purchasingItems.filter((p) =>
        !(p.purchasingModuleId === purchasingModuleId && purgedItemIds.has(p.submittalItemId)),
      ),
    }));
    dbExec(async () => {
      await supabase
        .from('purchasing_module_submittals')
        .delete()
        .eq('purchasing_module_id', purchasingModuleId)
        .eq('submittal_id', submittalId);
      return { error: null } as any;
    });
  },

  upsertPurchasingItem: ({ purchasingModuleId, submittalItemId, updates }) => {
    const existing = get().purchasingItems.find(
      (p) => p.purchasingModuleId === purchasingModuleId && p.submittalItemId === submittalItemId,
    );
    if (existing) {
      const merged: PurchasingItem = { ...existing, ...updates };
      set((s) => ({
        purchasingItems: s.purchasingItems.map((p) => p.id === existing.id ? merged : p),
      }));
      dbExec(() =>
        supabase.from('purchasing_items').update({ ...purchasingItemToRow(updates), updated_at: new Date().toISOString() }).eq('id', existing.id),
      );
    } else {
      const id = genId();
      const fresh: PurchasingItem = {
        id,
        purchasingModuleId,
        submittalItemId,
        purchaseStatus: 'not_ordered',
        notes: '',
        ...updates,
      };
      set((s) => ({ purchasingItems: [...s.purchasingItems, fresh] }));
      dbExec(async () => {
        const { data: { user } } = await supabase.auth.getUser();
        const row = purchasingItemToRow(fresh);
        if (user?.id) row.updated_by = user.id;
        return supabase.from('purchasing_items').insert(row);
      });
    }
  },

  upsertPurchasingFreight: ({ purchasingModuleId, manufacturer, updates }) => {
    const existing = get().purchasingFreight.find(
      (f) => f.purchasingModuleId === purchasingModuleId && f.manufacturer === manufacturer,
    );
    if (existing) {
      const merged: PurchasingFreight = { ...existing, ...updates };
      set((s) => ({
        purchasingFreight: s.purchasingFreight.map((f) => f.id === existing.id ? merged : f),
      }));
      dbExec(() =>
        supabase.from('purchasing_freight').update({ ...purchasingFreightToRow(updates), updated_at: new Date().toISOString() }).eq('id', existing.id),
      );
    } else {
      const id = genId();
      const fresh: PurchasingFreight = {
        id,
        purchasingModuleId,
        manufacturer,
        purchaseStatus: 'not_ordered',
        notes: '',
        ...updates,
      };
      set((s) => ({ purchasingFreight: [...s.purchasingFreight, fresh] }));
      dbExec(() => supabase.from('purchasing_freight').insert(purchasingFreightToRow(fresh)));
    }
  },

  upsertMfrDefault: ({ purchasingModuleId, manufacturer, updates }) => {
    const existing = get().purchasingMfrDefaults.find(
      (d) => d.purchasingModuleId === purchasingModuleId && d.manufacturer === manufacturer,
    );
    if (existing) {
      const merged: PurchasingManufacturerDefault = { ...existing, ...updates };
      set((s) => ({
        purchasingMfrDefaults: s.purchasingMfrDefaults.map((d) => d.id === existing.id ? merged : d),
      }));
      dbExec(() =>
        supabase.from('purchasing_manufacturer_defaults').update({ ...mfrDefaultToRow(updates), updated_at: new Date().toISOString() }).eq('id', existing.id),
      );
    } else {
      const id = genId();
      const fresh: PurchasingManufacturerDefault = {
        id,
        purchasingModuleId,
        manufacturer,
        ...updates,
      };
      set((s) => ({ purchasingMfrDefaults: [...s.purchasingMfrDefaults, fresh] }));
      dbExec(() => supabase.from('purchasing_manufacturer_defaults').insert(mfrDefaultToRow(fresh)));
    }
  },

  // =========================================================================
  // Project comments — chat thread on the Project Overview page.
  //
  // Loaded lazily per project (only when the Comments tab opens) so we
  // don't pay for every project's chat history on app boot. Reactions live
  // on the same row as a JSONB array of `{emoji, userIds}`.
  // =========================================================================
  fetchProjectComments: async (projectId) => {
    if (!isSupabaseConfigured()) return;

    const { data, error } = await supabase
      .from('project_comments')
      .select('id, project_id, parent_id, author_id, body, reactions, edited, created_at, updated_at, profiles:author_id(email, full_name)')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[fetchProjectComments]', error);
      return;
    }

    const mapped: ProjectComment[] = (data ?? []).map((r: any) => ({
      id: r.id,
      projectId: r.project_id,
      parentId: r.parent_id ?? null,
      authorId: r.author_id,
      authorName: r.profiles?.full_name || r.profiles?.email || 'Unknown',
      authorEmail: r.profiles?.email ?? '',
      body: r.body ?? '',
      reactions: Array.isArray(r.reactions) ? r.reactions : [],
      edited: !!r.edited,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    set((s) => {
      // Drop any cached comments for this project so deletes from other
      // sessions get reflected — then merge in the freshly fetched rows.
      const others = s.projectComments.filter((c) => c.projectId !== projectId);
      const loaded = new Set(s.commentsLoadedFor);
      loaded.add(projectId);
      return { projectComments: [...others, ...mapped], commentsLoadedFor: loaded };
    });
  },

  // =========================================================================
  // Project documents — Gross Margin Form (and future report types).
  // Lazy-loaded per project; only manual per-field overrides are persisted,
  // so the form keeps re-deriving fresh defaults from the BoM on every sync.
  // =========================================================================
  fetchProjectDocuments: async (projectId) => {
    if (!isSupabaseConfigured()) return;
    const { data, error } = await supabase
      .from('project_documents')
      .select('*')
      .eq('project_id', projectId);
    if (error) {
      console.error('[fetchProjectDocuments]', error);
      return;
    }
    const mapped: ProjectDocument[] = (data ?? []).map((r: any) => ({
      id: r.id,
      projectId: r.project_id,
      docType: r.doc_type,
      overrides: (r.overrides && typeof r.overrides === 'object') ? r.overrides : {},
      status: r.status ?? 'draft',
      editedBy: r.edited_by ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    set((s) => {
      const others = s.projectDocuments.filter((d) => d.projectId !== projectId);
      const loaded = new Set(s.documentsLoadedFor);
      loaded.add(projectId);
      return { projectDocuments: [...others, ...mapped], documentsLoadedFor: loaded };
    });
  },

  saveProjectDocument: async ({ projectId, docType, overrides, status }) => {
    if (!isSupabaseConfigured()) return;
    const { data: { user } } = await supabase.auth.getUser();
    const row: Record<string, unknown> = {
      project_id: projectId,
      doc_type: docType,
      overrides,
      edited_by: user?.id ?? null,
    };
    if (status !== undefined) row.status = status;
    const { data, error } = await supabase
      .from('project_documents')
      .upsert(row, { onConflict: 'project_id,doc_type' })
      .select('*')
      .single();
    if (error || !data) {
      console.error('[saveProjectDocument]', error);
      return;
    }
    const saved: ProjectDocument = {
      id: data.id,
      projectId: data.project_id,
      docType: data.doc_type,
      overrides: (data.overrides && typeof data.overrides === 'object') ? data.overrides : {},
      status: data.status ?? 'draft',
      editedBy: data.edited_by ?? undefined,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
    set((s) => ({
      projectDocuments: [...s.projectDocuments.filter((d) => !(d.projectId === projectId && d.docType === docType)), saved],
    }));
  },

  addProjectComment: async ({ projectId, parentId, body }) => {
    if (!isSupabaseConfigured()) return null;
    const trimmed = body.trim();
    if (!trimmed) return null;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const { data, error } = await supabase
      .from('project_comments')
      .insert({
        project_id: projectId,
        parent_id: parentId,
        author_id: user.id,
        body: trimmed,
      })
      .select('id, project_id, parent_id, author_id, body, reactions, edited, created_at, updated_at, profiles:author_id(email, full_name)')
      .single();

    if (error || !data) {
      console.error('[addProjectComment]', error);
      return null;
    }

    const fresh: ProjectComment = {
      id: data.id,
      projectId: data.project_id,
      parentId: data.parent_id ?? null,
      authorId: data.author_id,
      authorName: (data as any).profiles?.full_name || (data as any).profiles?.email || 'You',
      authorEmail: (data as any).profiles?.email ?? '',
      body: data.body ?? '',
      reactions: Array.isArray(data.reactions) ? data.reactions : [],
      edited: !!data.edited,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
    set((s) => ({ projectComments: [...s.projectComments, fresh] }));
    return fresh.id;
  },

  updateProjectComment: async (commentId, body) => {
    if (!isSupabaseConfigured()) return;
    const trimmed = body.trim();
    if (!trimmed) return;

    const updatedAt = new Date().toISOString();
    set((s) => ({
      projectComments: s.projectComments.map((c) =>
        c.id === commentId ? { ...c, body: trimmed, edited: true, updatedAt } : c,
      ),
    }));

    const { error } = await supabase
      .from('project_comments')
      .update({ body: trimmed, edited: true, updated_at: updatedAt })
      .eq('id', commentId);
    if (error) console.error('[updateProjectComment]', error);
  },

  deleteProjectComment: async (commentId) => {
    if (!isSupabaseConfigured()) return;
    // Optimistically drop the comment and any replies (cascade matches the DB).
    set((s) => ({
      projectComments: s.projectComments.filter(
        (c) => c.id !== commentId && c.parentId !== commentId,
      ),
    }));
    const { error } = await supabase.from('project_comments').delete().eq('id', commentId);
    if (error) console.error('[deleteProjectComment]', error);
  },

  toggleCommentReaction: async (commentId, emoji) => {
    if (!isSupabaseConfigured()) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const existing = get().projectComments.find((c) => c.id === commentId);
    if (!existing) return;

    // Build the next reactions array: toggle this user in/out of the
    // emoji's bucket. If the bucket goes empty, drop it entirely.
    const next: CommentReaction[] = [];
    let touched = false;
    for (const r of existing.reactions) {
      if (r.emoji === emoji) {
        touched = true;
        const has = r.userIds.includes(user.id);
        const userIds = has ? r.userIds.filter((id) => id !== user.id) : [...r.userIds, user.id];
        if (userIds.length > 0) next.push({ emoji, userIds });
      } else {
        next.push(r);
      }
    }
    if (!touched) next.push({ emoji, userIds: [user.id] });

    set((s) => ({
      projectComments: s.projectComments.map((c) =>
        c.id === commentId ? { ...c, reactions: next } : c,
      ),
    }));

    const { error } = await supabase
      .from('project_comments')
      .update({ reactions: next })
      .eq('id', commentId);
    if (error) console.error('[toggleCommentReaction]', error);
  },
}));
