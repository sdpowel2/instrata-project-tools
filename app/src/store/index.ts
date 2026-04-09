import { create } from 'zustand';
import type {
  Project, Submittal, SubmittalItem, RFI, CloseoutPackage,
  Warranty, PunchItem, SignOffSheet, OwnerManual, ManualSection, ManualDevice,
  ProjectBoMItem, AsBuiltDrawing,
  ItemCategory,
  SubmittalItemLocation,
  ReviewRun, ReviewFlag, ReviewRunStatus, ReviewFlagStatus,
  BidLevelingSession, BidLevelingMappingTemplate,
} from '../types';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
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
function rowToProject(r: any): Project {
  return {
    id: r.id, name: r.name, number: r.number, client: r.client,
    address: r.address, businessUnit: r.business_unit ?? '', status: r.status,
    mondayItemId: r.monday_item_id ?? undefined,
    dtoolsProjectId: r.dtools_project_id ?? undefined,
    dtoolsBomStatus: r.dtools_bom_status ?? '',
    createdAt: r.created_at, updatedAt: r.updated_at,
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
    locations: r.locations ?? [], notes: r.notes ?? '', sortOrder: r.sort_order ?? 0,
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
  if (item.locations !== undefined) row.locations = item.locations;
  if (item.notes !== undefined) row.notes = item.notes;
  if (item.sortOrder !== undefined) row.sort_order = item.sortOrder;
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
function rowToCloseout(r: any): Omit<CloseoutPackage, 'warranties' | 'punchItems' | 'signOffSheets' | 'asBuiltDrawings'> {
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
  { id: 'p1', name: 'One Vanderbilt - Level 60 AV Buildout', number: 'INS-2026-001', client: 'SL Green Realty', address: '1 Vanderbilt Ave, New York, NY 10017', businessUnit: 'Instrata NE', status: 'Active', dtoolsBomStatus: '', createdAt: '2026-01-15', updatedAt: '2026-03-20' },
  { id: 'p2', name: 'Hudson Yards Tower 30 - Conference Center', number: 'INS-2026-002', client: 'Related Companies', address: '30 Hudson Yards, New York, NY 10001', businessUnit: 'Instrata NE', status: 'Active', dtoolsBomStatus: '', createdAt: '2026-02-01', updatedAt: '2026-03-18' },
  { id: 'p3', name: 'Brookfield Place - Trading Floor Refresh', number: 'INS-2026-003', client: 'Brookfield Asset Mgmt', address: '250 Vesey St, New York, NY 10281', businessUnit: 'Instrata MA', status: 'Pending Closeout', dtoolsBomStatus: '', createdAt: '2025-10-10', updatedAt: '2026-03-10' },
  { id: 'p4', name: '75 Rockefeller - Lobby Experience Center', number: 'INS-2025-018', client: 'RXR Realty', address: '75 Rockefeller Plaza, New York, NY 10019', businessUnit: 'Instrata NE', status: 'Closed', dtoolsBomStatus: '', createdAt: '2025-06-01', updatedAt: '2025-12-15' },
  { id: 'p5', name: 'WTC 3 - Executive Boardroom Suite', number: 'INS-2026-004', client: 'Silverstein Properties', address: '175 Greenwich St, New York, NY 10007', businessUnit: 'Instrata SE', status: 'Active', dtoolsBomStatus: '', createdAt: '2026-03-01', updatedAt: '2026-03-25' },
];

const seedProjectBoM: ProjectBoMItem[] = [
  { id: 'bom1', projectId: 'p1', manufacturer: 'Samsung', model: 'QM85C', description: '85" QLED 4K Display', category: 'Display', qty: 4, locations: [{ room: 'Conference Room A', qty: 2 }, { room: 'Conference Room B', qty: 2 }], notes: 'Conference room primary displays', sortOrder: 0 },
  { id: 'bom2', projectId: 'p1', manufacturer: 'Crestron', model: 'DM-NVX-363', description: 'DM NVX 4K60 Network AV Encoder/Decoder', category: 'Control', qty: 8, locations: [{ room: 'Conference Room A', qty: 4 }, { room: 'Conference Room B', qty: 4 }], notes: '', sortOrder: 1 },
  { id: 'bom3', projectId: 'p1', manufacturer: 'Shure', model: 'MXA920', description: 'Ceiling Array Microphone', category: 'Audio', qty: 6, locations: [{ room: 'Conference Room A', qty: 2 }, { room: 'Conference Room B', qty: 2 }, { room: 'Executive Boardroom', qty: 2 }], notes: 'White finish to match ceiling', sortOrder: 2 },
  { id: 'bom4', projectId: 'p1', manufacturer: 'QSC', model: 'Core 110f', description: 'Q-SYS Unified Core', category: 'Audio', qty: 1, locations: [{ room: 'AV Rack Room', qty: 1 }], notes: 'Main DSP processor', sortOrder: 3 },
  { id: 'bom5', projectId: 'p1', manufacturer: 'Belden', model: '10GXW13', description: 'Cat6A Plenum Cable', category: 'Cabling', qty: 50, locations: [], notes: '50 boxes - blue', sortOrder: 4 },
  { id: 'bom6', projectId: 'p1', manufacturer: 'Liberty', model: 'DERA2P-015M', description: 'Plenum AOC HDMI Cable 15m', category: 'Cabling', qty: 12, locations: [], notes: '', sortOrder: 5 },
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

  // Loading state
  isLoading: boolean;
  isInitialized: boolean;

  // Hydrate from Supabase
  fetchAllData: () => Promise<void>;

  // Project actions
  addProject: (p: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateProject: (id: string, p: Partial<Project>) => void;
  deleteProject: (id: string) => void;

  // DTools sync
  syncDToolsBoM: (projectId: string) => Promise<void>;

  // Project BoM actions
  addBoMItem: (projectId: string, item: Omit<ProjectBoMItem, 'id' | 'projectId'>) => string;
  updateBoMItem: (itemId: string, updates: Partial<ProjectBoMItem>) => void;
  deleteBoMItem: (itemId: string) => void;
  importBoMItems: (projectId: string, items: { manufacturer: string; model: string; description: string; category: ItemCategory; qty: number; notes: string; locations: SubmittalItemLocation[]; cutSheetData?: string; cutSheetName?: string }[]) => void;

  // Submittal actions
  addSubmittal: (s: Omit<Submittal, 'id' | 'createdAt' | 'items'>) => string;
  updateSubmittal: (id: string, s: Partial<Submittal>) => void;
  deleteSubmittal: (id: string) => void;
  addSubmittalItem: (submittalId: string, item: Omit<SubmittalItem, 'id' | 'submittalId'>) => void;
  updateSubmittalItem: (submittalId: string, itemId: string, item: Partial<SubmittalItem>) => void;
  deleteSubmittalItem: (submittalId: string, itemId: string) => void;
  reorderSubmittalItems: (submittalId: string, itemIds: string[]) => void;
  populateSubmittalFromBoM: (submittalId: string, projectId: string) => void;

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
        supabase.from('owner_manuals').select('*'),
        // Review runs — summary only (no csv_snapshot, no flags)
        supabase.from('review_runs').select('id,project_id,run_number,triggered_at,status,reviewed_by,reviewed_at,created_at').order('run_number', { ascending: false }),
        // Bid Leveling
        supabase.from('bid_leveling_sessions').select('*'),
        supabase.from('bid_leveling_mapping_templates').select('*'),
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
        manualsRes,
        reviewRunsRes,
        bidLevelingSessionsRes,
        bidLevelingTemplatesRes,
      ] = await Promise.race([fetchWithTimeout, timeout]);

      // Log any errors but continue with whatever data we got
      for (const res of [projectsRes, bomRes, submittalsRes, submittalItemsRes, rfisRes, closeoutsRes, warrantiesRes, punchItemsRes, signOffSheetsRes, asBuiltDrawingsRes, manualsRes, reviewRunsRes, bidLevelingSessionsRes, bidLevelingTemplatesRes]) {
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

      const closeouts: CloseoutPackage[] = (closeoutsRes.data ?? []).map((r) => ({
        ...rowToCloseout(r),
        warranties: warrantiesByCloseout.get(r.id) ?? [],
        punchItems: punchByCloseout.get(r.id) ?? [],
        signOffSheets: signOffByCloseout.get(r.id) ?? [],
        asBuiltDrawings: drawingsByCloseout.get(r.id) ?? [],
      }));

      set({
        projects, projectBoM, submittals, rfis, closeouts, manuals, reviewRuns,
        bidLevelingSessions, bidLevelingTemplates,
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
    set((s) => ({ projects: [...s.projects, project] }));

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

  updateProject: (id, p) => {
    const updatedAt = now();
    set((s) => ({
      projects: s.projects.map((x) => x.id === id ? { ...x, ...p, updatedAt } : x),
    }));
    dbExec(() => supabase.from('projects').update(projectToRow({ ...p, updatedAt })).eq('id', id));
  },

  deleteProject: (id) => {
    set((s) => ({
      projects: s.projects.filter((x) => x.id !== id),
      projectBoM: s.projectBoM.filter((x) => x.projectId !== id),
      submittals: s.submittals.filter((x) => x.projectId !== id),
      rfis: s.rfis.filter((x) => x.projectId !== id),
      closeouts: s.closeouts.filter((x) => x.projectId !== id),
      manuals: s.manuals.filter((x) => x.projectId !== id),
    }));
    // DB cascade deletes will handle child rows if FK ON DELETE CASCADE is set.
    // If not, we delete explicitly.
    dbExec(() => supabase.from('projects').delete().eq('id', id));
  },

  // =========================================================================
  // DTools Sync
  // =========================================================================
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

      // Refresh project and BoM from Supabase
      const [projRes, bomRes] = await Promise.all([
        supabase.from('projects').select('*').eq('id', projectId).single(),
        supabase.from('project_bom_items').select('*').eq('project_id', projectId),
      ]);

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
    set((s) => ({
      submittals: s.submittals.map((x) => x.id === id ? { ...x, ...sub } : x),
    }));
    // Don't send nested `items` to the submittals table
    const { items, ...rest } = sub;
    if (Object.keys(rest).length > 0) {
      dbExec(() => supabase.from('submittals').update(submittalToRow(rest)).eq('id', id));
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
    const newItem: SubmittalItem = { ...item, id, submittalId };
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
    const bomItems = get().projectBoM.filter((b) => b.projectId === projectId);
    const map = new Map<string, { manufacturer: string; model: string; description: string; category: ItemCategory; qty: number; notes: string; locations: SubmittalItemLocation[]; cutSheetData?: string; cutSheetName?: string }>();
    for (const item of bomItems) {
      const key = `${item.manufacturer.toLowerCase()}|||${item.model.toLowerCase()}`;
      const existing = map.get(key);
      if (existing) {
        existing.qty += item.qty;
      } else {
        map.set(key, { manufacturer: item.manufacturer, model: item.model, description: item.description, category: item.category, qty: item.qty, notes: item.notes, locations: [...item.locations], cutSheetData: item.cutSheetData, cutSheetName: item.cutSheetName });
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
      notes: c.notes,
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
      warranties: [], punchItems: [], signOffSheets: [], asBuiltDrawings: [],
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
}));
